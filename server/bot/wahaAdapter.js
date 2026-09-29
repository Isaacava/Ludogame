'use strict';
const express=require('express');
const {handleMessage,users:defaultUsers,normalizePhone}=require('../whatsappBot');
const WAHA_URL=process.env.WAHA_URL||'http://localhost:3000';
const WAHA_SESSION=process.env.WAHA_SESSION||'default';
function toChatId(phone){return String(phone).replace(/^\+/,'')+'@c.us';}
async function sendWahaText(chatId,text,fetchImpl){
  const doFetch=fetchImpl||global.fetch;
  const res=await doFetch(`${WAHA_URL}/api/sendText`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId,text,session:WAHA_SESSION})});
  if(!res.ok)throw new Error(`WAHA sendText failed: ${res.status}`);
  return res.json().catch(()=>null);
}
function createWahaApp(opts={}){
  const fetchImpl=opts.fetchImpl,userStore=opts.users||defaultUsers,app=express();
  app.use(express.json());
  app.post('/waha/webhook',async(req,res)=>{
    const expectedSecret=process.env.WAHA_WEBHOOK_SECRET;
    if(expectedSecret&&req.get('x-waha-secret')!==expectedSecret)return res.sendStatus(401);
    const body=req.body||{};if(body.event!=='message')return res.sendStatus(200);
    const payload=body.payload||{};if(payload.fromMe)return res.sendStatus(200);
    const chatId=payload.from;if(!chatId)return res.sendStatus(200);
    const phone=normalizePhone(chatId),text=payload.body||'';
    const existing=await userStore.getAsync(phone);
    const {reply,patch}=handleMessage(existing,text);
    userStore.upsert(phone,patch);
    try{await sendWahaText(chatId,reply,fetchImpl);}catch(e){console.error('WAHA send failed:',e.message);}
    res.sendStatus(200);
  });
  app.get('/health',(req,res)=>res.send('ok'));
  return app;
}
module.exports={createWahaApp,normalizePhone,toChatId,sendWahaText};
