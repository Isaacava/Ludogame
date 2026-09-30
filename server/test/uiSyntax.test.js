'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');

for(const file of ['web/index.html','web/whot.html','web/admin.html','web/play.html']){
  const html=fs.readFileSync(file,'utf8');
  const scripts=[...html.matchAll(/<script(?:[^>]*)>([\\s\\S]*?)<\\/script>/gi)].map(m=>m[1]);
  assert(scripts.length>0,`${file} has no inline script`);
  scripts.forEach((source,index)=>{
    assert.doesNotThrow(()=>new vm.Script(source,{filename:`${file}#script${index+1}`}),`${file} script ${index+1} failed to compile`);
  });
}

(function whotRegressionChecks(){
  const whot=fs.readFileSync('web/whot.html','utf8');
  const index=fs.readFileSync('web/index.html','utf8');
  const server=fs.readFileSync('server/whotServer.js','utf8');
  assert.match(whot,/const canDraw=isTurn/,'Whot Market draw guard must be defined before use');
  assert.match(whot,/const requested=Number\(params\.get\('players'\)\)\|\|2;socket\.emit\('whot:create-room',\{playerCount:requested/,'Whot create flow must preserve selected player count');
  assert.match(index,/players='\+whotCount/,'Whot home flow must preserve selected player count');
  assert.doesNotMatch(server,/computer-mode-supports-2-players/,'Whot server must not force computer games back to 2 players');
})();
console.log('uiSyntax.test.js passed');
