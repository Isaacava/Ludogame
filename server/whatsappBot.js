'use strict';
const crypto=require('crypto');
const express=require('express');
const twilio=require('twilio');
const {MessagingResponse}=twilio.twiml;
const {ConfigStore}=require('./config/configStore');
const botConfig=new ConfigStore();
const SITE_URL=process.env.SITE_URL||'https://codeplay.com';
const LOGIN_CODE_TTL_MS=10*60*1000;

class UserStore{
  constructor(persistence=null){this.byPhone=new Map();this.byCode=new Map();this.persistence=persistence;}
  get(phone){return this.byPhone.get(phone);}
  async getAsync(phone){
    const cached=this.get(phone);if(cached||!this.persistence?.enabled)return cached;
    const loaded=await this.persistence.loadUser(phone);
    if(loaded){this.byPhone.set(phone,loaded);if(loaded.loginCode)this.byCode.set(loaded.loginCode,phone);}
    return loaded||undefined;
  }
  upsert(phone,patch){
    const existing=this.byPhone.get(phone)||{phone,stage:'new',name:null,loginCode:null,loginCodeExpiresAt:null,createdAt:Date.now()};
    const updated={...existing,...patch};this.byPhone.set(phone,updated);
    if(patch.loginCode)this.byCode.set(patch.loginCode,phone);
    if(this.persistence?.enabled)this.persistence.saveUser(updated).catch(err=>console.error('Mongo user save failed:',err.message));
    return updated;
  }
  redeemCode(code){
    const phone=this.byCode.get(code);if(!phone)return null;
    const user=this.byPhone.get(phone);if(!user||user.loginCode!==code)return null;
    if(Date.now()>user.loginCodeExpiresAt){this.byCode.delete(code);return null;}
    this.byCode.delete(code);this.upsert(phone,{loginCode:null,loginCodeExpiresAt:null});return user;
  }
  async redeemCodeAsync(code){
    const cached=this.redeemCode(code);if(cached||!this.persistence?.enabled)return cached;
    const user=await this.persistence.findUserByLoginCode(code);if(!user)return null;
    const consumed=await this.persistence.consumeLoginCode(user.phone,code);if(!consumed)return null;
    this.byCode.delete(code);this.byPhone.set(user.phone,{...user,loginCode:null,loginCodeExpiresAt:null});return user;
  }
}
class SessionStore{
  constructor(persistence=null){this.byToken=new Map();this.persistence=persistence;}
  create(phone){
    const token=crypto.randomBytes(24).toString('hex'),session={phone,createdAt:Date.now()};
    this.byToken.set(token,session);
    if(this.persistence?.enabled)this.persistence.saveSession({token,...session}).catch(err=>console.error('Mongo session save failed:',err.message));
    return token;
  }
  async createAsync(phone){return this.create(phone);}
  get(token){return this.byToken.get(token);}
  async getAsync(token){
    const cached=this.get(token);if(cached||!this.persistence?.enabled)return cached;
    const loaded=await this.persistence.loadSession(token);
    if(loaded){this.byToken.set(token,{phone:loaded.phone,createdAt:loaded.createdAt});return this.byToken.get(token);}
    return undefined;
  }
}
const users=new UserStore(),sessions=new SessionStore();
function normalizePhone(raw){const digits=String(raw||'').replace(/\D/g,'');return '+'+digits;}
function generateLoginCode(){return Math.floor(100000+Math.random()*900000).toString();}
const GAME_MENU=`Which game do you want to play?
1. 🎲 Ludo
2. 🃏 Whot
3. ♟️ Chess (coming soon)

Reply with a number.`;
const WHOT_MODE_MENU=`Whot — how do you want to play?
1. 🤖 vs Computer
2. 👥 vs Friends (create a room & get a code)

Reply with a number.`;
function getWhotConfig(){return botConfig.get('whot')||{enabled:true,playerCounts:[2,3,4]}}
function getWhotCountMenu(){const allowed=Array.isArray(getWhotConfig().playerCounts)&&getWhotConfig().playerCounts.length?getWhotConfig().playerCounts:[2,3,4];return `How many players?\n${allowed.includes(2)?'2 — classic 2-player game\n':''}${allowed.includes(3)?'3 — 3 players\n':''}${allowed.includes(4)?'4 — 4 players\n':''}\nReply with one of the enabled numbers.`;}
const MODE_MENU=`Ludo — how do you want to play?
1. 🤖 vs Computer
2. 👥 vs Friends (create a room & get a code)

Reply with a number. Already have a room code? Reply JOIN followed by the code, e.g. JOIN K7QP`;
const COUNT_MENU=`How many players?
2 — teams (you get 2 colours each)
3 — one colour each
4 — one colour each

Reply 2, 3 or 4.`;

function handleMessage(user,text){
  const t=(text||'').trim().toLowerCase();
  if(user&&user.stage!=='new'&&t==='menu')return{reply:GAME_MENU,patch:{stage:'game_menu'}};
  const joinMatch=t.match(/^join\s+([a-z0-9]{4})$/);
  if(user&&user.stage!=='new'&&user.stage!=='awaiting_name'&&joinMatch){
    const code=joinMatch[1].toUpperCase();
    return{reply:`Joining room *${code}* — tap to open the board:\n${SITE_URL}/play.html?mode=friends&action=join&code=${code}`,patch:{stage:'game_menu'}};
  }
  if(!user||user.stage==='new')return{reply:botConfig.get('bot').welcomeMessage,patch:{stage:'awaiting_name'}};
  if(user.stage==='awaiting_name'){
    const name=text.trim().slice(0,40);if(!name)return{reply:'Just your name is fine — what should we call you?',patch:{}};
    const loginCode=generateLoginCode();
    return{reply:`Nice to meet you, ${name}! 🎉\n\nYour CodePlay login code: *${loginCode}* (valid 10 minutes)\n\nGo to ${SITE_URL}/signin and enter this code to connect your WhatsApp — or just keep playing right here.\n\n${GAME_MENU}`,patch:{stage:'game_menu',name,loginCode,loginCodeExpiresAt:Date.now()+LOGIN_CODE_TTL_MS}};
  }
  if(user.stage==='game_menu'){
    if(t==='1'||t.includes('ludo'))return{reply:MODE_MENU,patch:{stage:'ludo_mode_menu'}};
    if(t==='2'||t.includes('whot')){if(getWhotConfig().enabled===false)return{reply:`Whot is temporarily disabled.\n\n${GAME_MENU}`,patch:{}};return{reply:WHOT_MODE_MENU,patch:{stage:'whot_mode_menu'}};}
    if(t==='3'||t.includes('chess'))return{reply:`Chess is coming soon! ♟️ Want to play Ludo instead?\n\n${GAME_MENU}`,patch:{}};
    return{reply:`Didn't catch that.\n\n${GAME_MENU}`,patch:{}};
  }
  if(user.stage==='whot_mode_menu'){
    if(t==='1'||t.includes('computer')){const cfg=getWhotConfig();if(cfg.enabled===false||!(cfg.playerCounts||[2,3,4]).includes(2))return{reply:'2-player Whot is currently disabled.',patch:{stage:'game_menu'}};return{reply:'Whot vs Computer is a 2-player game.\n\nTap to play:\n'+SITE_URL+'/whot.html?mode=computer&players=2&name='+encodeURIComponent(user.name||'Guest'),patch:{stage:'game_menu'}};}
    if(t==='2'||t.includes('friend'))return{reply:getWhotCountMenu(),patch:{stage:'whot_count',pendingMode:'friends'}};
    return{reply:`Didn't catch that.\n\n${WHOT_MODE_MENU}`,patch:{stage:'whot_mode_menu'}};
  }
  if(user.stage==='whot_count'){
    const allowed=(getWhotConfig().playerCounts||[2,3,4]).map(String);if(!allowed.includes(t))return{reply:`Didn't catch that.\n\n${getWhotCountMenu()}`,patch:{stage:'whot_count'}};
    const link=`${SITE_URL}/whot.html?mode=friends&action=create&players=${t}&name=${encodeURIComponent(user.name||'Guest')}`;
    return{reply:`Tap to create your Whot room — you'll get a 4-letter code:\n${link}\n\nShare the code with your friends.`,patch:{stage:'game_menu',pendingMode:null}};
  }
  if(user.stage==='ludo_mode_menu'){
    if(t==='1'||t.includes('computer'))return{reply:COUNT_MENU,patch:{stage:'ludo_count',pendingMode:'computer'}};
    if(t==='2'||t.includes('friend'))return{reply:COUNT_MENU,patch:{stage:'ludo_count',pendingMode:'friends'}};
    return{reply:`Didn't catch that.\n\n${MODE_MENU}`,patch:{}};
  }
  if(user.stage==='ludo_count'){
    if(!['2','3','4'].includes(t))return{reply:`Didn't catch that.\n\n${COUNT_MENU}`,patch:{}};
    if(user.pendingMode==='friends'){
      const link=`${SITE_URL}/play.html?mode=friends&action=create&players=${t}`;
      return{reply:`Tap to create your room — you'll get a 4-letter code on screen:\n${link}\n\nShare the code in your WhatsApp group. Friends can open the site and enter it, or message me: JOIN <code>`,patch:{stage:'game_menu',pendingMode:null}};
    }
    const link=`${SITE_URL}/play.html?players=${t}`;
    return{reply:`Here you go — tap to play vs the computer:\n${link}`,patch:{stage:'game_menu',pendingMode:null}};
  }
  return{reply:`Reply "menu" any time to see game options.\n\n${GAME_MENU}`,patch:{stage:'game_menu'}};
}

function createBotApp(options={}){
  const userStore=options.users||users,sessionStore=options.sessions||sessions,app=express();
  app.use(express.urlencoded({extended:false}));app.use(express.json());
  app.use((req,res,next)=>{
    res.header('Access-Control-Allow-Origin',process.env.SITE_ORIGIN||'*');
    res.header('Access-Control-Allow-Headers','Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if(req.method==='OPTIONS')return res.sendStatus(204);next();
  });
  app.post('/whatsapp/webhook',async(req,res)=>{
    const twilioAuthToken=process.env.TWILIO_AUTH_TOKEN;
    if(twilioAuthToken){
      const signature=req.get('x-twilio-signature')||'';
      const baseUrl=process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`;
      const webhookUrl=`${baseUrl}${req.originalUrl}`;
      if(!twilio.validateRequest(twilioAuthToken,signature,webhookUrl,req.body))return res.sendStatus(403);
    }
    const phone=normalizePhone(req.body.From),body=req.body.Body||'',existing=await userStore.getAsync(phone);
    const {reply,patch}=handleMessage(existing,body);userStore.upsert(phone,patch);
    const twiml=new MessagingResponse();twiml.message(reply);res.type('text/xml').send(twiml.toString());
  });
  app.post('/api/auth/verify',async(req,res)=>{
    const {code}=req.body||{};if(!/^\d{6}$/.test(code||''))return res.status(400).json({error:'invalid-code-format'});
    const user=await userStore.redeemCodeAsync(code);if(!user)return res.status(401).json({error:'invalid-or-expired-code'});
    const token=await sessionStore.createAsync(user.phone);res.json({token,user:{phone:user.phone,name:user.name}});
  });
  app.get('/api/auth/session',async(req,res)=>{
    const auth=req.headers.authorization||'',token=auth.startsWith('Bearer ')?auth.slice(7):null;
    const session=token?await sessionStore.getAsync(token):null;if(!session)return res.status(401).json({error:'no-session'});
    const user=await userStore.getAsync(session.phone);res.json({user:{phone:user.phone,name:user.name}});
  });
  app.get('/health',(req,res)=>res.send('ok'));
  return app;
}
module.exports={createBotApp,handleMessage,users,sessions,UserStore,SessionStore,normalizePhone};
if(require.main===module){const PORT=process.env.BOT_PORT||3002;createBotApp().listen(PORT,()=>console.log(`WhatsApp bot webhook listening on :${PORT}`));}
