'use strict';
const crypto=require('crypto');
const express=require('express');
const {handleMessage,users:defaultUsers,normalizePhone}=require('../whatsappBot');

function getWahaUrl(){return process.env.WAHA_URL||'http://127.0.0.1:3001';}
function getWahaSession(){return process.env.WAHA_SESSION||'default';}
function getWahaApiKey(){return process.env.WAHA_API_KEY||'';}
function getPublicBaseUrl(){
  return String(process.env.PUBLIC_BASE_URL||process.env.SITE_URL||(process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:'')).replace(/\/+$/,'');
}

function toChatId(phone){return String(phone).replace(/^\+/,'')+'@c.us';}

function apiHeaders(extra={}){
  const headers={...extra};
  const key=getWahaApiKey();
  if(key)headers['X-Api-Key']=key;
  return headers;
}

async function wahaRequest(path,options={},fetchImpl){
  const doFetch=fetchImpl||global.fetch;
  const headers=apiHeaders(options.headers||{});
  return doFetch(`${getWahaUrl()}${path}`,{...options,headers});
}

async function getWahaSessionInfo(fetchImpl){
  const res=await wahaRequest(`/api/sessions/${encodeURIComponent(getWahaSession())}`,{},fetchImpl);
  const data=await res.json().catch(()=>({}));
  return {res,data};
}

async function recreateUnpairedFailedSession(fetchImpl){
  const {res,data}=await getWahaSessionInfo(fetchImpl);
  if(!res.ok)return {ok:false,status:res.status,data};
  if(data.status!=='FAILED')return {ok:true,status:data.status,data,recreated:false};
  if(data.me&&data.me.id)return {ok:true,status:data.status,data,recreated:false,preserved:true};

  const restart=await wahaRequest(`/api/sessions/${encodeURIComponent(getWahaSession())}/restart`,{
    method:'POST',
    headers:{'Content-Type':'application/json'}
  },fetchImpl);

  if(restart.ok){
    await new Promise(r=>setTimeout(r,3000));
    const afterRestart=await getWahaSessionInfo(fetchImpl);
    if(afterRestart.res.ok&&afterRestart.data.status!=='FAILED'){
      return {ok:true,status:afterRestart.data.status,data:afterRestart.data,restarted:true};
    }
  }

  const remove=await wahaRequest(`/api/sessions/${encodeURIComponent(getWahaSession())}`,{
    method:'DELETE'
  },fetchImpl);
  if(!remove.ok&&remove.status!==404){
    return {ok:false,status:remove.status,data};
  }

  const create=await wahaRequest('/api/sessions',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      name:getWahaSession(),
      start:true,
      config:{
        noweb:{
          markOnline:true
        }
      }
    })
  },fetchImpl);

  if(!create.ok&&create.status!==409){
    const body=await create.text().catch(()=>'');
    return {ok:false,status:create.status,data:{error:'session-recreate-failed',message:body||'Could not recreate WAHA session.'}};
  }

  return {ok:true,status:'STARTING',data,recreated:true};
}

async function resetWahaSession(fetchImpl){
  const session=getWahaSession();
  try{
    const current=await getWahaSessionInfo(fetchImpl);
    if(current.res.ok&&current.data.status==='WORKING'&&current.data.me?.id){
      return {ok:false,status:'WORKING',message:'Session is already connected; refusing to delete a working WhatsApp session.'};
    }
  }catch{}
  try{
    const remove=await wahaRequest('/api/sessions/'+encodeURIComponent(session),{method:'DELETE'},fetchImpl);
    if(!remove.ok&&remove.status!==404){
      return {ok:false,status:remove.status,message:await remove.text().catch(()=>'')||'Could not delete failed WAHA session.'};
    }
  }catch(e){ return {ok:false,status:502,message:e.message}; }

  const create=await wahaRequest('/api/sessions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({name:session,start:true,config:{
      webhooks:(()=>{const url=getPublicBaseUrl();const secret=process.env.WAHA_WEBHOOK_SECRET||process.env.WHATSAPP_HOOK_HMAC_KEY;const events=String(process.env.WHATSAPP_HOOK_EVENTS||'message,message.any').split(',').map(v=>v.trim()).filter(Boolean);if(!events.includes('session.status'))events.push('session.status');return url?[{url,events,...(secret?{hmac:{key:secret}}:{}),retries:{policy:'exponential',delaySeconds:2,attempts:8}}]:[]})(),
      noweb:{markOnline:true}
    }})
  },fetchImpl);
  if(!create.ok&&create.status!==409){
    return {ok:false,status:create.status,message:await create.text().catch(()=>'')||'Could not create fresh WAHA session.'};
  }
  return {ok:true,status:'STARTING'};
}

async function resolveInboundChatId(payload,fetchImpl){
  const from=String(payload?.from||'');
  const chatId=String(payload?.chatId||from||'');
  const participant=String(payload?.participant||'');
  const key=payload?._data?.key||{};
  const senderPn=String(key.senderPn||key.participantPn||'');
  const remoteJidAlt=String(key.remoteJidAlt||'');
  if(!chatId)return {chatId:null,phone:null,reason:'missing-chat-id'};

  if(chatId.endsWith('@g.us')||chatId.endsWith('@newsletter')||chatId.endsWith('@broadcast')){
    return {chatId:null,phone:null,reason:'ignored-non-private-chat',originalChatId:chatId};
  }

  if(chatId.endsWith('@c.us')){
    return {chatId,phone:normalizePhone(chatId)};
  }

  const directPhoneCandidates=[participant,senderPn,remoteJidAlt]
    .map(v=>String(v||''))
    .filter(v=>v.endsWith('@c.us'));
  if(directPhoneCandidates.length){
    const phoneChatId=directPhoneCandidates[0];
    return {chatId:phoneChatId,phone:normalizePhone(phoneChatId),lid:chatId,source:'payload-mapping'};
  }

  if(chatId.endsWith('@lid')){
    const lid=encodeURIComponent(chatId);
    try{
      const response=await wahaRequest(`/api/${encodeURIComponent(getWahaSession())}/lids/${lid}`,{},fetchImpl);
      const data=await response.json().catch(()=>({}));
      const phoneChatId=String(data?.pn||'');
      if(response.ok&&phoneChatId.endsWith('@c.us')){
        return {chatId:phoneChatId,phone:normalizePhone(phoneChatId),lid:chatId,source:'lid-api'};
      }
    }catch{}
    // WAHA supports sending directly to @lid. Keep the exact chatId when a phone mapping is unavailable.
    return {chatId,phone:null,lid:chatId,source:'lid-direct'};
  }

  return {chatId,phone:normalizePhone(chatId),source:'fallback'};
}

const processedMessageIds=new Map();
const stats={webhooksReceived:0,lastWebhookAt:null,lastEvent:null,repliesSent:0,lastReplyAt:null,lastError:null,lastRejected:null,lastMessageReceived:null,lastIgnored:null};

function rememberMessage(id){
  const key=String(id||'');
  if(!key)return false;
  const now=Date.now();
  for(const [k,t] of processedMessageIds){
    if(now-t>5*60*1000)processedMessageIds.delete(k);
  }
  if(processedMessageIds.has(key))return true;
  processedMessageIds.set(key,now);
  return false;
}

async function processWahaMessage(body,userStore,fetchImpl,cfgStore){
  stats.lastEvent=body?.event||null;
  if(body?.event==='session.status'){
    console.warn('WAHA session.status:',JSON.stringify(body));
    return;
  }
  if(body?.event!=='message'&&body?.event!=='message.any')return;
  const payload=body.payload||{};
  const messageId=payload.id&&typeof payload.id==='object'?(payload.id._serialized||payload.id.id):payload.id;
  stats.lastMessageReceived={
    at:new Date().toISOString(),
    event:body.event,
    id:messageId||null,
    from:payload.from||null,
    chatId:payload.chatId||null,
    fromMe:Boolean(payload.fromMe),
    body:String(payload.body||'').slice(0,200),
    source:payload.source||null
  };

  if(payload.fromMe){
    stats.lastIgnored={at:Date.now(),reason:'fromMe',chatId:payload.from||payload.chatId||null};
    console.log('[waha] ignored fromMe message');
    return;
  }

  if(rememberMessage(messageId||`${payload.from||payload.chatId||''}|${payload.timestamp||''}|${payload.body||''}`))return;

  const resolved=await resolveInboundChatId(payload,fetchImpl);
  if(!resolved.chatId){
    stats.lastIgnored={at:Date.now(),reason:resolved.reason||'no-chat-id',chatId:payload.from||payload.chatId||null};
    console.warn('[waha] ignored message:',stats.lastIgnored.reason);
    return;
  }

  const chatId=resolved.chatId;
  const text=String(payload.body??payload._data?.message?.conversation??payload._data?.message?.extendedTextMessage?.text??'').trim();
  if(!text){
    stats.lastIgnored={at:Date.now(),reason:'no-text',chatId};
    console.warn('[waha] ignored message with no text:',chatId);
    return;
  }

  const identityKey=resolved.phone||chatId;
  try{
    const existing=await userStore.getAsync(identityKey);
    const {reply,patch}=handleMessage(existing,text,cfgStore);
    userStore.upsert(identityKey,{...patch,phone:identityKey});
    await sendWahaText(chatId,reply,fetchImpl);
    stats.repliesSent++;
    stats.lastReplyAt=Date.now();
    stats.lastError=null;
    stats.lastIgnored=null;
    console.log('[waha] replied to '+chatId+' identity='+identityKey);
  }catch(e){
    stats.lastError={at:Date.now(),message:e.message};
    console.error('[waha] reply failed:',e.stack||e.message);
  }
}

async function sendWahaText(chatId,text,fetchImpl){
  const res=await wahaRequest('/api/sendText',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chatId,text,session:getWahaSession()})
  },fetchImpl);
  if(!res.ok)throw new Error(`WAHA sendText failed: ${res.status}`);
  return res.json().catch(()=>null);
}

function verifyWebhook(rawBody,req){
  const secret=process.env.WAHA_WEBHOOK_SECRET||process.env.WHATSAPP_HOOK_HMAC_KEY;
  const directSecret=req.get('x-waha-secret')||req.query.secret;
  if(secret&&String(directSecret||'')===secret)return true;
  if(!secret)return true;
  const provided=String(req.get('x-webhook-hmac')||'').trim().toLowerCase();
  if(!provided)return false;
  const expected=crypto.createHmac('sha512',secret).update(rawBody).digest('hex');
  const a=Buffer.from(provided,'utf8');
  const b=Buffer.from(expected,'utf8');
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

function pairingAuth(req,res,next){
  const password=process.env.WAHA_PAIRING_PASSWORD;
  if(!password)return res.status(503).type('text').send('WAHA pairing is disabled.');
  const header=String(req.get('authorization')||'');
  const prefix='Basic ';
  if(!header.startsWith(prefix)){
    res.set('WWW-Authenticate','Basic realm="CodePlay WhatsApp Pairing"');
    return res.sendStatus(401);
  }
  let decoded='';
  try{decoded=Buffer.from(header.slice(prefix.length),'base64').toString('utf8');}catch{decoded='';}
  const expected=`codeplay:${password}`;
  const a=Buffer.from(decoded,'utf8');
  const b=Buffer.from(expected,'utf8');
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){
    res.set('WWW-Authenticate','Basic realm="CodePlay WhatsApp Pairing"');
    return res.sendStatus(401);
  }
  return next();
}

function createPairingHtml(){
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodePlay WhatsApp Pairing</title>
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;text-align:center}
img{width:320px;max-width:100%;border:1px solid #ddd;border-radius:16px}
.card{padding:24px;border:1px solid #ddd;border-radius:18px}
.muted{color:#666}.ok{font-weight:700}
</style></head>
<body><div class="card">
<h1>CodePlay WhatsApp</h1>
<p id="status" class="muted">Checking session…</p>
<img id="qr" alt="WhatsApp QR code" style="display:none">
<p id="help" class="muted"></p><button id="showQr" onclick="showQr()" style="margin-top:10px;width:100%;padding:12px;border:1px solid #ccc;border-radius:10px;background:#fff;font-weight:700">Show QR code</button><button id="reset" onclick="resetSession()" style="margin-top:10px;width:100%;padding:12px;border:1px solid #e5e5e5;border-radius:10px;background:#fff;font-weight:700">Reset WhatsApp session</button>
<div style="margin-top:20px;text-align:left">
<label for="phone"><strong>Pair with phone number</strong></label>
<p class="muted" style="margin:6px 0 10px">Enter the bot WhatsApp number in international digits, without +, spaces or dashes.</p>
<input id="phone" inputmode="numeric" autocomplete="tel" placeholder="2348012345678" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccc;border-radius:10px">
<button id="pair" onclick="requestCode()" style="margin-top:10px;width:100%;padding:12px;border:0;border-radius:10px;background:#111;color:#fff;font-weight:700">Get pairing code</button>
<p id="codeBox" style="display:none;margin:14px 0 0;text-align:center;font-size:28px;letter-spacing:4px;font-weight:800"></p>
<p id="codeHelp" class="muted" style="display:none;text-align:center"></p>
</div>
</div>
<script>
async function showQr(){
  try{
    const r=await fetch('/waha/qr?ts='+Date.now(),{credentials:'same-origin'});
    if(!r.ok)throw new Error((await r.text())||('QR request failed: '+r.status));
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const qr=document.getElementById('qr');
    qr.onload=()=>URL.revokeObjectURL(url);
    qr.src=url;
    qr.style.display='block';
    document.getElementById('help').textContent='On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this QR. Keep this page open while scanning.';
  }catch(e){document.getElementById('help').textContent=e.message||'Could not load the QR code.';}
}
async function resetSession(){
  const button=document.getElementById('reset');
  if(!confirm('This will remove the current WAHA session and require pairing again. Continue?'))return;
  button.disabled=true;
  button.textContent='Resetting…';
  try{
    const r=await fetch('/waha/reset',{method:'POST',credentials:'same-origin'});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.message||data.error||('Reset failed: '+r.status));
    document.getElementById('status').textContent='Session status: '+(data.status||'STARTING');
    document.getElementById('help').textContent='Fresh session created. QR pairing will be available shortly.';
    document.getElementById('qr').style.display='none';
    setTimeout(refresh,2000);
  }catch(e){
    document.getElementById('help').textContent=e.message||'Could not reset the session.';
  }finally{
    button.disabled=false;
    button.textContent='Reset WhatsApp session';
  }
}
async function requestCode(){
  const phone=document.getElementById('phone').value.replace(/\D/g,'');
  const pair=document.getElementById('pair');
  const box=document.getElementById('codeBox');
  const help=document.getElementById('codeHelp');
  box.style.display='none';
  help.style.display='none';
  if(!phone){
    help.textContent='Enter the bot phone number first.';
    help.style.display='block';
    return;
  }
  pair.disabled=true;
  pair.textContent='Generating code…';
  try{
    const r=await fetch('/waha/pairing-code',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'same-origin',
      body:JSON.stringify({phoneNumber:phone})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.message||data.error||('Request failed: '+r.status));
    box.textContent=data.code||'';
    box.style.display='block';
    help.textContent='On the bot phone: WhatsApp → Settings → Linked Devices → Link with phone number instead, then enter this code.';
    help.style.display='block';
  }catch(e){
    help.textContent=e.message||'Could not generate pairing code.';
    help.style.display='block';
  }finally{
    pair.disabled=false;
    pair.textContent='Get pairing code';
  }
}
async function refresh(){
  try{
    const s=await fetch('/waha/status',{credentials:'same-origin'}).then(r=>r.json());
    const status=document.getElementById('status');
    const qr=document.getElementById('qr');
    const help=document.getElementById('help');
    const sessionStatus=s.sessionStatus||s.status||'UNKNOWN';
    if(sessionStatus==='WORKING'){
      status.textContent='✅ WhatsApp is connected.';
      status.className='ok';
      qr.style.display='none';
      help.textContent=s.me&&s.me.id?('Connected number: '+s.me.id.split('@')[0]):'';
      return;
    }
    status.textContent='Session status: '+sessionStatus;
    status.className='muted';
    if(sessionStatus==='SCAN_QR_CODE'){
      qr.src='/waha/qr?ts='+Date.now();
      qr.style.display='block';
      help.textContent='On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this QR.';
    }else if(sessionStatus==='RESTARTING'||sessionStatus==='STARTING'){
      qr.style.display='none';
      help.textContent='WAHA is restarting the unpaired session. This page refreshes automatically.';
    }else{
      qr.style.display='none';
      help.textContent='The QR may appear shortly. This page refreshes automatically.';
    }
  }catch(e){
    document.getElementById('status').textContent='Cannot reach WAHA yet.';
  }
}
refresh();setInterval(refresh,5000);
</script></body></html>`;
}

let lastAutoRestartAt=0;
const AUTO_RESTART_COOLDOWN_MS=15_000;

function createWahaApp(opts={}){
  const fetchImpl=opts.fetchImpl,userStore=opts.users||defaultUsers,cfgStore=opts.configStore,app=express();
  console.log('[waha] adapter config: url='+getWahaUrl()+' session='+getWahaSession()+' apiKey='+Boolean(getWahaApiKey())+' webhookSecret='+(Boolean(process.env.WAHA_WEBHOOK_SECRET||process.env.WHATSAPP_HOOK_HMAC_KEY)));

  app.post('/waha/webhook',express.raw({type:'*/*',limit:'2mb'}),async(req,res)=>{
    stats.webhooksReceived++;
    stats.lastWebhookAt=Date.now();
    const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||'');
    console.log('WAHA webhook received', {
      hmacPresent: Boolean(req.get('x-webhook-hmac')),
      bytes: rawBody.length
    });
    if(!verifyWebhook(rawBody,req)){
      stats.lastRejected={at:Date.now(),reason:'invalid webhook authentication'};
      console.warn('[waha] webhook rejected: invalid authentication');
      return res.sendStatus(401);
    }

    let body={};
    try{
      const parsed=JSON.parse(rawBody.toString('utf8')||'{}');
      body=(parsed&&parsed.request&&typeof parsed.request==='object')?parsed.request:parsed;
    }catch(err){
      stats.lastError={at:Date.now(),message:'Webhook JSON parse failed: '+err.message,rawPreview:rawBody.toString('utf8').slice(0,500)};
      console.error('[waha] webhook JSON parse failed:',err.message);
      return res.sendStatus(400);
    }

    stats.lastEvent=body?.event||null;
    console.log('[waha] webhook event='+String(body.event||'?')+' from='+String(body.payload?.from||body.payload?.chatId||'?')+' body="'+String(body.payload?.body||'').slice(0,40)+'"');
    res.sendStatus(200);
    Promise.resolve(processWahaMessage(body,userStore,fetchImpl,cfgStore)).catch(err=>{
      stats.lastError={at:Date.now(),message:err.message};
      console.error('[waha] async message handling failed:',err.stack||err.message);
    });
  });

  app.get('/waha/pairing',pairingAuth,(req,res)=>res.type('html').send(createPairingHtml()));

  app.get('/waha/status',async(req,res)=>{
    const out={
      wahaUrl:getWahaUrl(),
      session:getWahaSession(),
      apiKeyConfigured:Boolean(getWahaApiKey()),
      webhookSecretConfigured:Boolean(process.env.WAHA_WEBHOOK_SECRET||process.env.WHATSAPP_HOOK_HMAC_KEY),
      expectedWebhookUrl:getPublicBaseUrl()?getPublicBaseUrl()+'/waha/webhook':null,
      bot:{
        webhooksReceived:stats.webhooksReceived,
        lastWebhookAt:stats.lastWebhookAt?new Date(stats.lastWebhookAt).toISOString():null,
        lastEvent:stats.lastEvent,
        repliesSent:stats.repliesSent,
        lastReplyAt:stats.lastReplyAt?new Date(stats.lastReplyAt).toISOString():null,
        lastError:stats.lastError,
        lastRejected:stats.lastRejected,
        lastMessageReceived:stats.lastMessageReceived,
        lastIgnored:stats.lastIgnored
      },
      problems:[]
    };
    try{
      const current=await getWahaSessionInfo(fetchImpl);
      out.wahaHttpStatus=current.res?.status??null;
      if(current.res?.ok){
        const data=(current.data&&typeof current.data==='object')?current.data:{};
        out.wahaReachable=true;
        out.sessionStatus=data.status||null;
        out.engine=(data.engine&&data.engine.engine)||null;
        out.me=data.me||null;
        if(out.sessionStatus&&out.sessionStatus!=='WORKING'){
          out.problems.push(`WAHA session is "${out.sessionStatus}", not WORKING.`);
        }
      }else{
        out.wahaReachable=true;
        out.problems.push(`WAHA returned HTTP ${out.wahaHttpStatus} for session "${getWahaSession()}".`);
      }
    }catch(err){
      out.wahaReachable=false;
      out.problems.push(`Cannot reach WAHA at ${getWahaUrl()}: ${err.message}`);
    }
    if(!out.apiKeyConfigured)out.problems.push('WAHA_API_KEY is not configured.');
    if(!out.webhookSecretConfigured)out.problems.push('WAHA webhook authentication secret is not configured.');
    if(!out.bot.webhooksReceived)out.problems.push('No WAHA webhook has reached CodePlay yet.');
    if(out.bot.lastRejected)out.problems.push('The last webhook was rejected: '+out.bot.lastRejected.reason);
    if(out.bot.lastError)out.problems.push('The last reply failed: '+out.bot.lastError.message);
    res.status(200).json(out);
  });

  app.post('/waha/reset',pairingAuth,async(req,res)=>{
    try{
      const result=await resetWahaSession(fetchImpl);
      return res.status(result.ok?200:409).json(result);
    }catch(e){
      return res.status(502).json({error:'waha-reset-failed',message:e.message});
    }
  });

  app.post('/waha/pairing-code',pairingAuth,express.json(),async(req,res)=>{
    try{
      const raw=String(req.body?.phoneNumber||'');
      const phone=raw.replace(/\D/g,'');
      if(phone.length<8||phone.length>15)return res.status(400).json({error:'invalid-phone-number'});

      const current=await getWahaSessionInfo(fetchImpl);
      if(current.res.ok&&current.data.status==='FAILED'&&!current.data.me){
        const recovery=await recreateUnpairedFailedSession(fetchImpl);
        if(!recovery.ok)return res.status(502).json(recovery.data);
        if(recovery.status==='STARTING'||recovery.status==='RESTARTING'){
          await new Promise(r=>setTimeout(r,1500));
        }
      }

      const response=await wahaRequest(`/api/${encodeURIComponent(getWahaSession())}/auth/request-code`,{
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({phoneNumber:phone})
      },fetchImpl);
      const data=await response.json().catch(()=>({}));
      if(!response.ok)return res.status(response.status).json(data);
      return res.json(data);
    }catch(e){
      return res.status(502).json({error:'waha-unavailable',message:e.message});
    }
  });

  app.get('/waha/qr',pairingAuth,async(req,res)=>{
    try{
      const response=await wahaRequest(`/api/${encodeURIComponent(getWahaSession())}/auth/qr`,{headers:{Accept:'image/png'}},fetchImpl);
      if(!response.ok)return res.status(response.status).send(await response.text().catch(()=>'')); 
      res.set('Content-Type',response.headers.get('content-type')||'image/png');
      const buffer=Buffer.from(await response.arrayBuffer());
      return res.send(buffer);
    }catch(e){
      return res.status(502).send(e.message);
    }
  });

  app.get('/health',(req,res)=>res.send('ok'));
  return app;
}

module.exports={createWahaApp,normalizePhone,toChatId,sendWahaText,verifyWebhook,wahaRequest,resolveInboundChatId,processWahaMessage,resetWahaSession};
