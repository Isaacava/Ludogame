(function(){
  'use strict';
  const KEY='codeplay_sound_enabled';
  let ctx=null,enabled=localStorage.getItem(KEY)!=='0';

  function setButton(){
    const b=document.getElementById('soundToggle');
    if(b){
      b.title=enabled?'Mute game sounds':'Enable game sounds';
      if(b.dataset.svg){ // menu row with an icon + switch: keep its markup, just update the state
        b.setAttribute('aria-pressed',enabled?'true':'false');
        const sw=b.querySelector('.switch');if(sw)sw.classList.toggle('on',enabled);
        const u=b.querySelector('use');if(u)u.setAttribute('href',enabled?'#i-volume':'#i-mute');
      }else b.textContent=enabled?'🔊':'🔇';
    }
  }
  function audioContext(){
    if(!enabled)return null;
    if(!ctx){
      const C=window.AudioContext||window.webkitAudioContext;
      if(!C)return null;
      ctx=new C();
    }
    if(ctx.state==='suspended')ctx.resume().catch(()=>{});
    return ctx;
  }
  function tone(freq,duration,type='sine',gain=.06,delay=0,endFreq){
    const c=audioContext();if(!c)return;
    const o=c.createOscillator(),g=c.createGain();
    const t=c.currentTime+delay;o.type=type;o.frequency.setValueAtTime(freq,t);
    if(endFreq)o.frequency.exponentialRampToValueAtTime(Math.max(40,endFreq),t+duration);
    g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(Math.max(.001,gain),t+.015);
    g.gain.exponentialRampToValueAtTime(.0001,t+duration);
    o.connect(g);g.connect(c.destination);o.start(t);o.stop(t+duration+.03);
  }
  function noise(duration=.12,gain=.04,delay=0){
    const c=audioContext();if(!c)return;
    const buffer=c.createBuffer(1,Math.max(1,Math.floor(c.sampleRate*duration)),c.sampleRate),data=buffer.getChannelData(0);
    for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length);
    const src=c.createBufferSource(),g=c.createGain(),t=c.currentTime+delay;
    src.buffer=buffer;g.gain.setValueAtTime(gain,t);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
    src.connect(g);g.connect(c.destination);src.start(t);src.stop(t+duration+.02);
  }
  function seq(notes){notes.forEach(n=>tone(n[0],n[1],n[2]||'sine',n[3]??.06,n[4]||0,n[5]));}
  function applause(){
    for(let i=0;i<12;i++)noise(.055,.035,i*.075);
    seq([[523,.12,'sine',.04,0],[659,.14,'sine',.04,.12],[784,.2,'sine',.045,.28]]);
  }
  function laugh(){
    seq([[420,.11,'triangle',.065,0,300],[500,.11,'triangle',.065,.13,340],[430,.12,'triangle',.06,.27,300],[520,.14,'triangle',.06,.41,350]]);
  }
  const sounds={
    'ludo-dice':()=>{noise(.08,.025);noise(.08,.025,.08);seq([[240,.08,'square',.035,0],[330,.08,'square',.035,.1]]);},
    'ludo-turn':()=>seq([[520,.08,'sine',.04],[680,.12,'sine',.04,.09]]),
    'ludo-capture-attacker':()=>{noise(.1,.055);seq([[130,.16,'sawtooth',.065],[260,.16,'square',.055,.11,520],[520,.2,'sine',.055,.25]]);},
    'ludo-capture-victim':()=>{tone(180,.2,'sawtooth',.07,0,70);noise(.16,.05,.04);},
    'ludo-piece-home':()=>seq([[520,.1,'sine',.04],[660,.12,'sine',.045,.1],[820,.16,'sine',.05,.22]]),
    'ludo-capture-finished':()=>seq([[330,.08,'square',.04],[520,.1,'square',.04,.1],[780,.18,'sine',.05,.22]]),
    'whot-card':()=>{noise(.045,.018);tone(480,.07,'sine',.035,.03);},
    'whot-draw':()=>{noise(.09,.025);tone(360,.09,'sine',.035,.05);},
    'whot-pick2':()=>seq([[540,.12,'square',.06],[540,.12,'square',.06,.15],[320,.2,'sawtooth',.05,.3,180]]),
    'whot-pick3':()=>seq([[620,.11,'square',.065],[620,.11,'square',.065,.14],[620,.11,'square',.065,.28],[250,.24,'sawtooth',.055,.42,140]]),
    'whot-general-market':()=>{noise(.1,.028);seq([[300,.13,'triangle',.05],[460,.13,'triangle',.05,.14],[680,.13,'triangle',.05,.28],[880,.22,'sine',.055,.42]]);},
    'whot-hold-on':()=>tone(280,.35,'sine',.07,0,760),
    'whot-suspension':()=>{tone(180,.26,'square',.06,0,90);tone(120,.2,'sawtooth',.04,.12,70);},
    'whot-wild':()=>seq([[440,.1,'triangle',.045],[660,.12,'triangle',.045,.1],[880,.18,'sine',.055,.22]]),
    'game-winner':applause,
    'game-loser':laugh
  };
  window.CodePlayAudio={
    play(cue){if(!enabled)return;try{const fn=sounds[cue];if(fn)fn()}catch(e){}},
    enable(){enabled=true;localStorage.setItem(KEY,'1');audioContext();setButton();},
    disable(){enabled=false;localStorage.setItem(KEY,'0');setButton();},
    toggle(){enabled?this.disable():this.enable();},
    isEnabled(){return enabled;},
    unlock(){audioContext();}
  };
  document.addEventListener('DOMContentLoaded',function(){
    setButton();
    document.addEventListener('pointerdown',function(){if(enabled)audioContext()},{once:true,passive:true});
    const b=document.getElementById('soundToggle');if(b)b.onclick=function(e){e.stopPropagation();CodePlayAudio.toggle();};
  });
})();