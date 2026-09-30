'use strict';

const crypto=require('crypto');

const IDENTITY_SECRET=process.env.WHATSAPP_GAME_LINK_SECRET||'';

function base64url(value){
  return Buffer.from(value,'utf8').toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function fromBase64url(value){
  const normalized=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=normalized+'='.repeat((4-normalized.length%4)%4);
  return Buffer.from(padded,'base64').toString('utf8');
}
function sign(value){
  return crypto.createHmac('sha256',IDENTITY_SECRET).update(value).digest('base64url');
}
function createWhatsAppGameToken(phone){
  if(!IDENTITY_SECRET) return '';
  const payload=JSON.stringify({phone:String(phone),iat:Date.now()});
  const body=base64url(payload);
  return body+'.'+sign(body);
}
function resolveWhatsAppGameToken(token){
  if(!IDENTITY_SECRET||!token)return null;
  const [body,signature]=String(token).split('.');
  if(!body||!signature)return null;
  const expected=sign(body);
  const a=Buffer.from(expected),b=Buffer.from(signature);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
  try{
    const payload=JSON.parse(fromBase64url(body));
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
    ? `🏆 You won!\\n\\nYou beat ${opponentText}.`
    : `😔 You lost.\\n\\n${opponentText} beat you.`;
}

async function notifyGameResults(room,{winnerIndex,gameName='game'}={}){
  if(!room||!Array.isArray(room.players)||room.whatsappResultsSent)return;
  if(winnerIndex==null||!room.players[winnerIndex])return;
  room.whatsappResultsSent=true;
  const winner=room.players[winnerIndex];
  const humanPlayers=room.players.filter(p=>!p.bot);
  const tasks=humanPlayers.filter(p=>p.whatsappPhone).map(player=>{
    const playerIndex=room.players.indexOf(player);
    const won=player===winner;
    const opponents=won
      ? room.players.filter((p,i)=>i!==playerIndex&&p.name).map(p=>p.name)
      : [winner.name||'the winner'];
    return sendWhatsAppText(player.whatsappPhone,
      gameResultMessage({won,playerName:player.name,opponents})
        +`\\n\\n— CodePlay ${gameName}`
    ).catch(err=>console.error('WhatsApp result notification failed:',err.message));
  });
  await Promise.all(tasks);
}

module.exports={createWhatsAppGameToken,resolveWhatsAppGameToken,sendWhatsAppText,buildGameIdentityQuery,notifyGameResults,gameResultMessage};
