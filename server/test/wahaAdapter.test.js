'use strict';
const assert=require('assert');
const crypto=require('crypto');

process.env.WAHA_API_KEY='test-api-key';
process.env.WAHA_WEBHOOK_SECRET='test-webhook-secret';

const {sendWahaText,verifyWebhook,toChatId}=require('../bot/wahaAdapter');

async function run(){
  assert.strictEqual(toChatId('+2348012345678'),'2348012345678@c.us');

  const raw=Buffer.from(JSON.stringify({event:'message',payload:{body:'HI'}}));
  const hmac=crypto.createHmac('sha512',process.env.WAHA_WEBHOOK_SECRET).update(raw).digest('hex');
  assert.strictEqual(verifyWebhook(raw,{get:(name)=>name==='x-webhook-hmac'?hmac:null}),true);
  assert.strictEqual(verifyWebhook(raw,{get:()=>hmac.slice(0,-1)+'0'}),false);
  assert.strictEqual(verifyWebhook(raw,{get:()=>null}),false);

  let captured=null;
  const result=await sendWahaText('2348012345678@c.us','Hello',async(url,opts)=>{
    captured={url,opts};
    return {ok:true,json:async()=>({ok:true})};
  });
  assert.deepStrictEqual(result,{ok:true});
  assert.strictEqual(captured.url,'http://localhost:3000/api/sendText');
  assert.strictEqual(captured.opts.headers['X-Api-Key'],'test-api-key');
  const body=JSON.parse(captured.opts.body);
  assert.strictEqual(body.chatId,'2348012345678@c.us');
  assert.strictEqual(body.session,'default');
}

run().then(()=>console.log('WhatsApp WAHA adapter tests passed')).catch(err=>{console.error(err);process.exit(1);});
