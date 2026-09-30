'use strict';
const crypto=require('crypto');
const express=require('express');
const {handleMessage,users:defaultUsers,normalizePhone}=require('../whatsappBot');

function getWahaUrl(){return process.env.WAHA_URL||'http://localhost:3000';}
function getWahaSession(){return process.env.WAHA_SESSION||'default';}
function getWahaApiKey(){return process.env.WAHA_API_KEY||'';}

function toChatId(phone){return String(phone).replace(/^\+/,'')+'@c.us';}

function apiHeaders(extra={}){
  const headers={'Content-Type':'application/json',...extra};
  const key=getWahaApiKey();
  if(key)headers['X-Api-Key']=key;
  return headers;
}

async function sendWahaText(chatId,text,fetchImpl){
  const doFetch=fetchImpl||global.fetch;
  const res=await doFetch(`${getWahaUrl()}/api/sendText`,{
    method:'POST',
    headers:apiHeaders(),
    body:JSON.stringify({chatId,text,session:getWahaSession()})
  });
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

  app.get('/health',(req,res)=>res.send('ok'));
  return app;
}

module.exports={createWahaApp,normalizePhone,toChatId,sendWahaText,verifyWebhook};
