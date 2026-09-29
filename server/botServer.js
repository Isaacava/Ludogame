'use strict';
const {createBotApp}=require('./whatsappBot');
const {createWahaApp}=require('./bot/wahaAdapter');
const PORT=process.env.BOT_PORT||3002;
const app=createBotApp();app.use(createWahaApp());
app.listen(PORT,()=>console.log(`CodePlay bot server (Twilio + WAHA) listening on :${PORT}`));
module.exports={app};
