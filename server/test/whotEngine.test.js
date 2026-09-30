'use strict';
const assert=require('assert');
const {WhotEngine,makeDeck}=require('../engine/whotEngine');
const rnd=(()=>{let n=0;return()=>((n=n+0.61803398875)%1)})();

(function(){
  const deck=makeDeck({starScoreMultiplier:3,whotScore:25});
  assert.equal(deck.length,54);
  assert.equal(new Set(deck.map(c=>c.id)).size,54);
  assert.equal(deck.filter(c=>c.isWhot).length,5);
  assert.equal(deck.find(c=>c.id==='star-5').score,15);
  assert.equal(deck.find(c=>c.id==='whot-1').score,25);
})();

(function(){
  const game=new WhotEngine(4,rnd());
  game.start();
  assert(game.players.every(p=>p.cards.length===6));
  assert.equal(game.market.length+game.played.length+game.players.reduce((n,p)=>n+p.cards.length,0),54);
  assert(Array.isArray(game.stateFor(0).players[0].cards));
  assert.equal(game.stateFor(0).players[1].cards,undefined);
})();

(function(){
  const g=new WhotEngine(2,rnd(),{handSize:1,allowDrawWithPlayable:true});
  g.started=true;
  g.players=[{name:'A',cards:[{id:'circle-2',shape:'circle',number:2,isWhot:false,score:2},{id:'circle-9',shape:'circle',number:9,isWhot:false,score:9}]},{name:'B',cards:[{id:'triangle-2',shape:'triangle',number:2,isWhot:false,score:2},{id:'triangle-9',shape:'triangle',number:9,isWhot:false,score:9}]}];
  g.played=[{id:'circle-7',shape:'circle',number:7,isWhot:false,score:7}];g.activeShape='circle';
  g.playCard(0,0);assert.equal(g.pendingPick.amount,2);assert.equal(g.turn,1);
  g.playCard(1,0);assert.equal(g.pendingPick.amount,4);assert.equal(g.turn,0);
})();

(function(){
  const g=new WhotEngine(2,rnd(),{handSize:1});
  g.started=true;
  g.players=[{name:'A',cards:[{id:'whot-1',shape:'whot',number:20,isWhot:true,score:20},{id:'circle-9',shape:'circle',number:9,isWhot:false,score:9}]},{name:'B',cards:[{id:'triangle-7',shape:'triangle',number:7,isWhot:false,score:7},{id:'triangle-9',shape:'triangle',number:9,isWhot:false,score:9}]}];
  g.played=[{id:'circle-7',shape:'circle',number:7,isWhot:false,score:7}];g.activeShape='circle';
  g.playCard(0,0,'triangle');
  assert.equal(g.whotCall.value,'triangle');
  assert.equal(g.canPlay(1,0),true);
  assert.throws(()=>g.playCard(1,0,'not-a-shape'),/illegal-card|invalid/);
})();

(function(){
  const g=new WhotEngine(3,rnd(),{handSize:1,generalMarketExtraTurn:true});
  g.started=true;
  g.players=[{name:'A',cards:[{id:'circle-14',shape:'circle',number:14,isWhot:false,score:14},{id:'circle-9',shape:'circle',number:9,isWhot:false,score:9}]},{name:'B',cards:[]},{name:'C',cards:[]}];
  g.market=[{id:'triangle-1',shape:'triangle',number:1,isWhot:false,score:1},{id:'square-2',shape:'square',number:2,isWhot:false,score:2}];
  g.played=[{id:'circle-7',shape:'circle',number:7,isWhot:false,score:7}];g.activeShape='circle';
  const result=g.playCard(0,0);
  assert.equal(result.resolution.kind,'general-market');
  assert.equal(g.players[1].cards.length,1);assert.equal(g.players[2].cards.length,1);assert.equal(g.turn,0);
})();

(function(){
  const g=new WhotEngine(2,rnd(),{handSize:1});
  g.started=true;
  g.players=[{name:'A',cards:[{id:'circle-2',shape:'circle',number:2,isWhot:false,score:2},{id:'circle-9',shape:'circle',number:9,isWhot:false,score:9}]},{name:'B',cards:[{id:'triangle-9',shape:'triangle',number:9,isWhot:false,score:9}]}];
  g.market=[{id:'triangle-1',shape:'triangle',number:1,isWhot:false,score:1},{id:'square-3',shape:'square',number:3,isWhot:false,score:3}];
  g.played=[{id:'circle-7',shape:'circle',number:7,isWhot:false,score:7}];g.activeShape='circle';
  g.playCard(0,0);
  const result=g.draw(1);
  assert.equal(result.cards.length,2);assert.equal(g.players[1].cards.length,3);assert.equal(g.turn,0);
})();

console.log('whotEngine.test.js passed');

(function(){
  const g=new WhotEngine(2,rnd(),{handSize:1,enforceLastCardCall:true});
  g.started=true;
  g.players=[{name:'A',cards:[{id:'circle-7',shape:'circle',number:7,isWhot:false,score:7},{id:'circle-9',shape:'circle',number:9,isWhot:false,score:9}]},{name:'B',cards:[{id:'triangle-9',shape:'triangle',number:9,isWhot:false,score:9}]}];
  g.played=[{id:'circle-2',shape:'circle',number:2,isWhot:false,score:2}];g.activeShape='circle';
  assert.throws(()=>g.playCard(0,0),/last-card-call-required/);
  const result=g.playCard(0,0,null,true);
  assert.equal(result.gameOver,false);
  assert.equal(g.players[0].cards.length,1);
  assert.equal(g.stateFor(1).lastCallRequired,false);
})();
