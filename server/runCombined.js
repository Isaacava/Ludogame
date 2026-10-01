'use strict';
const {spawn}=require('child_process');

const codeplayDir='/codeplay';
const wahaPort=String(process.env.WAHA_API_PORT||'3001');
const wahaUrl=process.env.WAHA_URL||`http://127.0.0.1:${wahaPort}`;
const session=process.env.WAHA_SESSION||'default';
const apiKey=process.env.WAHA_API_KEY||'';

const app=spawn(process.execPath,['server/startAll.js'],{
  cwd:codeplayDir,
  env:{...process.env},
  stdio:'inherit'
});

const waha=spawn('/entrypoint.sh',[],{
  cwd:'/app',
  env:{
    ...process.env,
    WHATSAPP_DEFAULT_ENGINE:'NOWEB',
    WAHA_NOWEB_WA_VERSION:process.env.WAHA_NOWEB_WA_VERSION||'auto-web',
    WAHA_NOWEB_WA_VERSION_FORCE:process.env.WAHA_NOWEB_WA_VERSION_FORCE||'False',
    PORT:wahaPort,
    WHATSAPP_API_PORT:wahaPort,
    WAHA_BASE_URL:wahaUrl,
    WAHA_LOG_LEVEL:process.env.WAHA_LOG_LEVEL||'info'
  },
  stdio:'inherit'
});

let shuttingDown=false;
function stopChild(child){
  if(child&&child.exitCode===null){
    try{child.kill('SIGTERM');}catch{}
  }
}
function shutdown(code){
  if(shuttingDown)return;
  shuttingDown=true;
  stopChild(app);
  stopChild(waha);
  setTimeout(()=>process.exit(code),1000).unref();
}
process.on('SIGTERM',()=>shutdown(0));
process.on('SIGINT',()=>shutdown(0));

app.on('exit',(code,signal)=>{
  if(!shuttingDown){
    console.error(`CodePlay exited: code=${code} signal=${signal||'none'}`);
    shutdown(typeof code==='number'&&code!==0?code:1);
  }
});
waha.on('exit',(code,signal)=>{
  if(!shuttingDown){
    console.error(`WAHA exited: code=${code} signal=${signal||'none'}`);
    shutdown(typeof code==='number'&&code!==0?code:1);
  }
});

function buildSessionConfig(){
  const webhookUrl=process.env.WHATSAPP_HOOK_URL;
  const secret=process.env.WAHA_WEBHOOK_SECRET||process.env.WHATSAPP_HOOK_HMAC_KEY;
  const events=String(process.env.WHATSAPP_HOOK_EVENTS||'message,session.status').split(',').map(v=>v.trim()).filter(Boolean);
  const webhook=webhookUrl?{
    url:webhookUrl,
    events,
    ...(secret?{hmac:{key:secret}}:{}),
    retries:{
      policy:process.env.WHATSAPP_HOOK_RETRIES_POLICY||'exponential',
      delaySeconds:Number(process.env.WHATSAPP_HOOK_RETRIES_DELAY_SECONDS||2),
      attempts:Number(process.env.WHATSAPP_HOOK_RETRIES_ATTEMPTS||8)
    }
  }:null;
  return {
    ...(webhook?{webhooks:[webhook]}:{}),
    noweb:{markOnline:true},
    ...(process.env.WAHA_SESSION_DEBUG==='true'?{debug:true}:{})
  };
}

async function waitForWaha(){
  if(!apiKey){
    console.error('WAHA_API_KEY is not set; refusing to bootstrap the WAHA session.');
    return false;
  }
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){
    try{
      const res=await fetch(`${wahaUrl}/api/sessions/${encodeURIComponent(session)}`,{
        headers:{'X-Api-Key':apiKey}
      });
      if(res.status===200||res.status===404)return true;
    }catch{}
    await new Promise(r=>setTimeout(r,1500));
  }
  console.error('WAHA did not become ready within 60 seconds.');
  return false;
}

async function updateSessionConfig(){
  const config=buildSessionConfig();
  if(!Object.keys(config).length)return true;
  const update=await fetch(`${wahaUrl}/api/sessions/${encodeURIComponent(session)}`,{
    method:'PUT',
    headers:{'X-Api-Key':apiKey,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({name:session,config})
  });
  if(!update.ok){
    console.error('WAHA session config update failed:',update.status,await update.text().catch(()=>''));
    return false;
  }
  return true;
}

async function ensureSession(){
  if(!await waitForWaha())return;
  try{
    const get=await fetch(`${wahaUrl}/api/sessions/${encodeURIComponent(session)}`,{
      headers:{'X-Api-Key':apiKey}
    });
    if(get.ok){
      const data=await get.json().catch(()=>({}));
      if(data.status!=='WORKING'){
        await updateSessionConfig();
        await fetch(`${wahaUrl}/api/sessions/${encodeURIComponent(session)}/start`,{
          method:'POST',
          headers:{'X-Api-Key':apiKey,'Content-Type':'application/json'}
        });
      }
      return;
    }
    if(get.status!==404){
      console.error('WAHA session lookup failed:',get.status);
      return;
    }
    const create=await fetch(`${wahaUrl}/api/sessions`,{
      method:'POST',
      headers:{'X-Api-Key':apiKey,'Content-Type':'application/json'},
      body:JSON.stringify({
        name:session,
        start:true,
        config:buildSessionConfig()
      })
    });
    if(!create.ok&&create.status!==409){
      console.error('WAHA session creation failed:',create.status,await create.text().catch(()=>''));
      return;
    }
    console.log(`WAHA session "${session}" is ready for pairing.`);
  }catch(e){
    console.error('WAHA session bootstrap failed:',e.message);
  }
}

setTimeout(()=>{ensureSession().catch(e=>console.error('WAHA bootstrap error:',e));},3000);
