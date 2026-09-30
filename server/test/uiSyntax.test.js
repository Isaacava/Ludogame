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
console.log('uiSyntax.test.js passed');
