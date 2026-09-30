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
    PORT:wahaPort,
    WHATSAPP_API_PORT:wahaPort,
    WAHA_BASE_URL:wahaUrl
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

async function ensureSession(){
  if(!await waitForWaha())return;
  try{
    const get=await fetch(`${wahaUrl}/api/sessions/${encodeURIComponent(session)}`,{
      headers:{'X-Api-Key':apiKey}
    });
    if(get.ok){
      const data=await get.json().catch(()=>({}));
      if(data.status==='STOPPED'||data.status==='FAILED'){
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
        config:{
          client:{deviceName:'CodePlay',browserName:'Chrome'}
        }
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
