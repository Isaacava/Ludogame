'use strict';
const crypto=require('crypto');
const express=require('express');
const WebSocket=require('ws');
const {handleMessage,users:defaultUsers,normalizePhone}=require('../whatsappBot');

function getWahaUrl(){return process.env.WAHA_URL||'http://127.0.0.1:3001';}
function getWahaSession(){return process.env.WAHA_SESSION||'default';}
function getWahaApiKey(){return process.env.WAHA_API_KEY||'';}

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

async function resolveInboundChatId(payload,fetchImpl){
  const participant=String(payload?.participant||'');
  const candidate=(participant.endsWith('@c.us')&&String(payload?.from||'').endsWith('@lid'))
    ? participant
    : String(payload?.chatId||payload?.from||'');
  if(!candidate)return {chatId:null,phone:null};

  if(candidate.endsWith('@lid')){
    const lid=encodeURIComponent(candidate);
    const response=await wahaRequest(`/api/${encodeURIComponent(getWahaSession())}/lids/${lid}`,{},fetchImpl);
    const data=await response.json().catch(()=>({}));
    const phoneChatId=String(data?.pn||'');
    if(response.ok&&phoneChatId.endsWith('@c.us')){
      return {chatId:phoneChatId,phone:normalizePhone(phoneChatId)};
    }
    // Keep the original id for diagnostics, but do not try to send to @lid.
    return {chatId:null,phone:null,lid:candidate};
  }

  if(candidate.endsWith('@c.us')){
    return {chatId:candidate,phone:normalizePhone(candidate)};
  }

  if(candidate.endsWith('@g.us')||candidate.endsWith('@newsletter')){
    return {chatId:candidate,phone:null};
  }

  return {chatId:candidate,phone:normalizePhone(candidate)};
}

const processedMessageIds=new Map();
const EVENT_WS_RECONNECT_MS=3000;

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

async function processWahaMessage(body,userStore,fetchImpl){
  if(body?.event==='session.status'){
    console.warn('WAHA session.status:',JSON.stringify(body));
    return;
  }
  if(body?.event!=='message'&&body?.event!=='message.any')return;
  const payload=body.payload||{};
  if(payload.fromMe)return;
  const messageKey=payload.id||`${payload.from||''}|${payload.timestamp||''}|${payload.body||''}`;
  if(rememberMessage(messageKey))return;

  const resolved=await resolveInboundChatId(payload,fetchImpl);
  const chatId=resolved.chatId;
  if(!chatId)return;

  const phone=resolved.phone;
  const text=payload.body||'';
  if(!text)return;

  try{
    const existing=phone?await userStore.getAsync(phone):undefined;
    const {reply,patch}=handleMessage(existing,text);
    if(phone)userStore.upsert(phone,patch);
    await sendWahaText(chatId,reply,fetchImpl);
  }catch(e){
    console.error('WAHA message handling failed:',e.stack||e.message);
  }
}

function startWahaEventSocket(userStore,fetchImpl){
  if(String(process.env.WAHA_EVENT_WS_ENABLED||'true').toLowerCase()==='false')return;
  let stopped=false;
  let timer=null;

  const connect=()=>{
    if(stopped)return;
    const key=getWahaApiKey();
    if(!key){
      console.error('WAHA event WebSocket disabled: WAHA_API_KEY is missing.');
      return;
    }
    const params=new URLSearchParams();
    params.append('session',getWahaSession());
    params.append('events','message');
    params.append('events','message.any');
    params.append('events','session.status');
    params.set('x-api-key',key);
    const ws=new WebSocket(`${getWahaUrl().replace(/^http/,'ws')}/ws?${params.toString()}`);
    ws.on('open',()=>console.log('WAHA event WebSocket connected.'));
    ws.on('message',raw=>{
      try{
        const body=JSON.parse(raw.toString());
        Promise.resolve(processWahaMessage(body,userStore,fetchImpl)).catch(err=>console.error('WAHA event handling failed:',err.message));
      }catch(e){
        console.error('WAHA event WebSocket payload error:',e.message);
      }
    });
    ws.on('error',err=>console.error('WAHA event WebSocket error:',err.message));
    ws.on('close',()=>{
      if(stopped)return;
      console.warn('WAHA event WebSocket closed; reconnecting.');
      clearTimeout(timer);
      timer=setTimeout(connect,EVENT_WS_RECONNECT_MS);
    });
  };

  setTimeout(connect,5000);
  return ()=>{stopped=true;clearTimeout(timer);};
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
  const secret=process.env.WAHA_WEBHOOK_SECRET;
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
<p id="help" class="muted"></p>
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
    if(s.status==='WORKING'){
      status.textContent='✅ WhatsApp is connected.';
      status.className='ok';
      qr.style.display='none';
      help.textContent=s.me&&s.me.id?('Connected number: '+s.me.id.split('@')[0]):'';
      return;
    }
    status.textContent='Session status: '+(s.status||'UNKNOWN');
    status.className='muted';
    if(s.status==='SCAN_QR_CODE'){
      qr.src='/waha/qr?ts='+Date.now();
      qr.style.display='block';
      help.textContent='On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this QR.';
    }else if(s.status==='RESTARTING'||s.status==='STARTING'){
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
  const fetchImpl=opts.fetchImpl,userStore=opts.users||defaultUsers,app=express();
  startWahaEventSocket(userStore,fetchImpl);

  app.post('/waha/webhook',express.raw({type:['application/json','application/*+json']}),async(req,res)=>{
    const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||'');
    console.log('WAHA webhook received', {
      hmacPresent: Boolean(req.get('x-webhook-hmac')),
      bytes: rawBody.length
    });
    if(!verifyWebhook(rawBody,req)){
      console.warn('WAHA webhook rejected: invalid HMAC');
      return res.sendStatus(401);
    }

    let body={};
    try{body=JSON.parse(rawBody.toString('utf8')||'{}');}
    catch{return res.sendStatus(400);}

    await processWahaMessage(body,userStore,fetchImpl);
    return res.sendStatus(200);
  });

  app.get('/waha/pairing',pairingAuth,(req,res)=>res.type('html').send(createPairingHtml()));

  app.get('/waha/status',pairingAuth,async(req,res)=>{
    try{
      const current=await getWahaSessionInfo(fetchImpl);
      if(!current.res.ok)return res.status(current.res.status).json(current.data);

      if(current.data.status==='FAILED'){
        const now=Date.now();
        if(now-lastAutoRestartAt>AUTO_RESTART_COOLDOWN_MS){
          lastAutoRestartAt=now;
          const recovery=await recreateUnpairedFailedSession(fetchImpl);
          if(recovery.ok){
            return res.json({...recovery.data,status:recovery.status,autoRecovered:true});
          }
        }
      }

      return res.json(current.data);
    }catch(e){
      return res.status(502).json({error:'waha-unavailable',message:e.message});
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

module.exports={createWahaApp,normalizePhone,toChatId,sendWahaText,verifyWebhook,wahaRequest,resolveInboundChatId,processWahaMessage,startWahaEventSocket};
