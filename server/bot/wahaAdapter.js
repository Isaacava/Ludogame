'use strict';
const crypto=require('crypto');
const express=require('express');
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
</div>
<script>
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

  app.post('/waha/webhook',express.raw({type:['application/json','application/*+json']}),async(req,res)=>{
    const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body||'');
    if(!verifyWebhook(rawBody,req))return res.sendStatus(401);

    let body={};
    try{body=JSON.parse(rawBody.toString('utf8')||'{}');}
    catch{return res.sendStatus(400);}

    if(body.event!=='message')return res.sendStatus(200);
    const payload=body.payload||{};
    if(payload.fromMe)return res.sendStatus(200);

    const chatId=payload.from;
    if(!chatId)return res.sendStatus(200);

    const phone=normalizePhone(chatId);
    const text=payload.body||'';
    if(!text)return res.sendStatus(200);

    try{
      const existing=await userStore.getAsync(phone);
      const {reply,patch}=handleMessage(existing,text);
      userStore.upsert(phone,patch);
      await sendWahaText(chatId,reply,fetchImpl);
    }catch(e){
      console.error('WAHA webhook handling failed:',e.message);
    }
    return res.sendStatus(200);
  });

  app.get('/waha/pairing',pairingAuth,(req,res)=>res.type('html').send(createPairingHtml()));

  app.get('/waha/status',pairingAuth,async(req,res)=>{
    try{
      const sessionPath=`/api/sessions/${encodeURIComponent(getWahaSession())}`;
      const response=await wahaRequest(sessionPath,{},fetchImpl);
      const data=await response.json().catch(()=>({}));
      if(!response.ok)return res.status(response.status).json(data);

      if(data.status==='FAILED'){
        const now=Date.now();
        if(now-lastAutoRestartAt>AUTO_RESTART_COOLDOWN_MS){
          lastAutoRestartAt=now;
          const restart=await wahaRequest(`${sessionPath}/restart`,{
            method:'POST',
            headers:{'Content-Type':'application/json'}
          },fetchImpl);
          if(restart.ok){
            return res.json({...data,status:'RESTARTING',autoRestarted:true});
          }
        }
      }

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

module.exports={createWahaApp,normalizePhone,toChatId,sendWahaText,verifyWebhook,wahaRequest};
