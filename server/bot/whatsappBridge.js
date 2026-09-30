'use strict';

const crypto=require('crypto');

const IDENTITY_SECRET=process.env.WHATSAPP_GAME_LINK_SECRET||'';

function key(){
  return crypto.createHash('sha256').update(IDENTITY_SECRET,'utf8').digest();
}
function base64url(value){
  return Buffer.from(value).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function fromBase64url(value){
  const normalized=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  return Buffer.from(padded,'base64');
}
function createWhatsAppGameToken(phone){
  if(!IDENTITY_SECRET)return '';
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  const payload=JSON.stringify({phone:String(phone),iat:Date.now()});
  const ciphertext=Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return [iv,ciphertext,tag].map(base64url).join('.');
}
function resolveWhatsAppGameToken(token){
  if(!IDENTITY_SECRET||!token)return null;
  const parts=String(token).split('.');
  if(parts.length!==3)return null;
  try{
    const iv=fromBase64url(parts[0]);
    const ciphertext=fromBase64url(parts[1]);
    const tag=fromBase64url(parts[2]);
    if(iv.length!==12||tag.length!==16)return null;
    const decipher=crypto.createDecipheriv('aes-256-gcm',key(),iv);
    decipher.setAuthTag(tag);
    const payload=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
    const phone=String(payload.phone||'');
    const issued=Number(payload.iat||0);
    if(!/^\+\d{7,15}$/.test(phone))return null;
    if(!Number.isFinite(issued)||Date.now()-issued>7*24*60*60*1000)return null;
    return {phone};
  }catch{return null}
}

async function sendWhatsAppText(to,text,fetchImpl=global.fetch){
  const graphVersion=process.env.META_GRAPH_API_VERSION||'v26.0';
  const phoneNumberId=process.env.META_WHATSAPP_PHONE_NUMBER_ID||'';
  const accessToken=process.env.META_WHATSAPP_ACCESS_TOKEN||'';
  if(!phoneNumberId||!accessToken)throw new Error('Meta WhatsApp Cloud API is not configured');
  const url=`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
  const res=await fetchImpl(url,{
    method:'POST',
    headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      messaging_product:'whatsapp',
      recipient_type:'individual',
      to:String(to).replace(/\D/g,''),
      type:'text',
      text:{preview_url:false,body:String(text||'')}
    })
  });
  if(!res.ok){
    const body=await res.text().catch(()=> '');
    throw new Error(`Meta WhatsApp send failed: ${res.status} ${body}`);
  }
  return res.json().catch(()=>null);
}

function buildGameIdentityQuery(phone){
  const token=createWhatsAppGameToken(phone);
  return token?`&wa_token=${encodeURIComponent(token)}`:'';
}

function gameResultMessage({won,playerName,opponents}){
  const names=(opponents||[]).filter(Boolean);
  const opponentText=names.length===1?names[0]:names.length===2?`${names[0]} and ${names[1]}`:names.length?`${names.slice(0,-1).join(', ')}, and ${names[names.length-1]}`:'your opponents';
  return won
    ? `🏆 You won!\n\nYou won against ${opponentText}.`
    : `😔 You lost.\n\nYou lost to ${opponentText}.`;
}

async function notifyGameResults(room,{winnerIndex,gameName='game'}={}){
  if(!room||!Array.isArray(room.players)||room.whatsappResultsSent||room.whatsappResultsPromise)return;
  if(winnerIndex==null||!room.players[winnerIndex])return;
  room.whatsappNotifiedPhones=room.whatsappNotifiedPhones||new Set();
  room.whatsappResultsPromise=(async()=>{
    const winner=room.players[winnerIndex];
    const humanPlayers=room.players.filter(p=>!p.bot&&p.whatsappPhone);
    const tasks=humanPlayers
      .filter(player=>!room.whatsappNotifiedPhones.has(player.whatsappPhone))
      .map(async player=>{
        const playerIndex=room.players.indexOf(player);
        const won=player===winner;
        const opponents=won
          ? room.players.filter((p,i)=>i!==playerIndex&&p.name).map(p=>p.name)
          : [winner.name||'the winner'];
        const message=gameResultMessage({won,playerName:player.name,opponents})+`\n\n— CodePlay ${gameName}`;
        await sendWhatsAppText(player.whatsappPhone,message);
        room.whatsappNotifiedPhones.add(player.whatsappPhone);
      });
    await Promise.all(tasks);
    if(room.whatsappNotifiedPhones.size>=humanPlayers.length)room.whatsappResultsSent=true;
  })().catch(err=>{
    room.whatsappResultsPromise=null;
    console.error('WhatsApp game result notification failed:',err.message);
    throw err;
  });
  return room.whatsappResultsPromise;
}

module.exports={createWhatsAppGameToken,resolveWhatsAppGameToken,sendWhatsAppText,buildGameIdentityQuery,notifyGameResults,gameResultMessage};
