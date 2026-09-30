'use strict';

const SUITS = Object.freeze(['circle','triangle','cross','square','star']);
const NON_WHOT_DECK = Object.freeze([
  ['circle',[1,2,3,4,5,7,8,10,11,12,13,14]],
  ['triangle',[1,2,3,4,5,7,8,10,11,12,13,14]],
  ['cross',[1,2,3,5,7,10,11,13,14]],
  ['square',[1,2,3,5,7,10,11,13,14]],
  ['star',[1,2,3,4,5,7,8]]
]);
const DEFAULT_RULES = Object.freeze({
  enabled: true,
  playerCounts: [2, 3, 4],
  handSize: 6,
  // Drawing is always a legal strategic choice on your turn, even when a playable card exists.
  allowDrawWithPlayable: true,
  stackPickTwo: true,
  stackPickThree: true,
  holdOnExtraTurn: true,
  suspensionSkipsNext: true,
  generalMarketDrawsOthers: true,
  generalMarketExtraTurn: true,
  whotCallMode: 'shape',
  whotCanDefendPick: false,
  enforceLastCardCall: false,
  starScoreMultiplier: 2,
  whotScore: 20
});
function makeDeck(rules=DEFAULT_RULES){
  const deck=[];
  for(const [shape,numbers] of NON_WHOT_DECK) for(const number of numbers) deck.push({id:`${shape}-${number}`,shape,number,isWhot:false,score:shape==='star'?number*(Number(rules.starScoreMultiplier)||2):number});
  for(let i=1;i<=5;i++) deck.push({id:`whot-${i}`,shape:'whot',number:20,isWhot:true,score:Number(rules.whotScore)||20});
  return deck;
}
const cloneCard=card=>card?{...card}:null;
class WhotEngine{
  constructor(playerCount=2,random=Math.random,rules={}){
    if(![2,3,4].includes(playerCount)) throw new Error('playerCount must be 2, 3, or 4');
    this.playerCount=playerCount; this.random=typeof random==='function'?random:Math.random;
    this.rules={...DEFAULT_RULES,...(rules||{})};
    this.players=Array.from({length:playerCount},(_,index)=>({name:`Player ${index+1}`,cards:[]}));
    this.market=[]; this.played=[]; this.turn=0; this.activeShape=null; this.whotCall=null; this.pendingPick=null;
    this.gameOver=false; this.winner=null; this.roundScores=null; this.started=false; this.log=[];
  }
  _log(msg){this.log.push(msg)}
  _shuffle(cards){for(let i=cards.length-1;i>0;i--){const j=Math.floor(this.random()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]]}return cards}
  start(){
    if(this.started) throw new Error('game already started'); this.started=true; this.market=this._shuffle(makeDeck(this.rules));
    const handSize=Math.max(1,Number(this.rules.handSize)||6);
    for(let r=0;r<handSize;r++) for(let i=0;i<this.playerCount;i++) this._takeFromMarket(i,1);
    let opener=this._takeFromMarketRaw();
    while(opener&&(opener.isWhot||[1,2,5,8,14].includes(opener.number))){this.market.push(opener);this._shuffle(this.market);opener=this._takeFromMarketRaw()}
    if(!opener) throw new Error('deck setup failed');
    this.played.push(opener); this.activeShape=opener.shape; this.whotCall=null; this.turn=0; this._log(`Opened with ${opener.id}`);
    return this.toJSON();
  }
  _ensureMarket(required=1){
    while(this.market.length<required&&this.played.length>1){
      const top=this.played.pop(),recycle=this.played.splice(0,this.played.length); this._shuffle(recycle); this.market.push(...recycle); this.played.push(top);
    }
  }
  _takeFromMarketRaw(){this._ensureMarket(); return this.market.pop()||null}
  _takeFromMarket(playerIndex,count){const drawn=[];for(let i=0;i<count;i++){const card=this._takeFromMarketRaw();if(!card)break;this.players[playerIndex].cards.push(card);drawn.push(cloneCard(card))}return drawn}
  _top(){return this.played[this.played.length-1]||null}
  _nextTurn(offset=1){this.turn=(this.turn+offset)%this.playerCount}
  _isPickDefender(card){if(!this.pendingPick||!card)return false;return this.pendingPick.number===2?this.rules.stackPickTwo&&card.number===2:this.rules.stackPickThree&&card.number===5}
  _matchesWhotCall(card){if(!this.whotCall||card.isWhot)return true;return this.whotCall.mode==='shape'?card.shape===this.whotCall.value:card.number===this.whotCall.value}
  _validateWhotCall(card,call){
    if(!card.isWhot)return;
    const mode=this.rules.whotCallMode==='number'?'number':'shape',value=mode==='shape'?String(call||'').trim().toLowerCase():Number(call);
    if(mode==='shape'&&!SUITS.includes(value))throw new Error('invalid-whot-shape');
    if(mode==='number'&&(!Number.isInteger(value)||value<1||value>14))throw new Error('invalid-whot-number');
  }
  canPlay(playerIndex,cardIndex){
    if(this.gameOver||!this.started||playerIndex!==this.turn)return false;
    const card=this.players[playerIndex].cards[cardIndex];if(!card)return false;
    if(this.pendingPick){return this._isPickDefender(card)||(this.rules.whotCanDefendPick&&card.isWhot)}
    if(card.isWhot)return true;
    if(!this._matchesWhotCall(card))return false;
    const top=this._top();return !!top&&(card.shape===this.activeShape||card.number===top.number);
  }
  playableCards(playerIndex=this.turn){
    if(playerIndex<0||playerIndex>=this.playerCount)return [];
    return this.players[playerIndex].cards.map((card,index)=>this.canPlay(playerIndex,index)?{index,card:cloneCard(card)}:null).filter(Boolean);
  }
  _finishRoundIfNeeded(playerIndex){
    if(this.players[playerIndex].cards.length!==0)return false;
    this.gameOver=true; this.winner=playerIndex;
    this.roundScores=this.players.map(p=>p.cards.reduce((sum,card)=>sum+(Number.isFinite(card.score)?card.score:0),0));
    this._log(`${this.players[playerIndex].name} wins the round`); return true;
  }
  _resolveSpecial(card,playerIndex,call){
    if(card.isWhot){
      this._validateWhotCall(card,call);
      const mode=this.rules.whotCallMode==='number'?'number':'shape',value=mode==='shape'?String(call).trim().toLowerCase():Number(call);
      this.whotCall={mode,value}; this.activeShape=mode==='shape'?value:null; this.pendingPick=null; this._nextTurn();
      return {kind:'whot',call:this.whotCall};
    }
    this.whotCall=null;
    if(card.number===1){if(this.rules.holdOnExtraTurn)return {kind:'hold-on',extraTurn:true};this._nextTurn();return {kind:'hold-on',extraTurn:false}}
    if(card.number===2){const amount=(this.pendingPick?this.pendingPick.amount:0)+2;this.pendingPick={number:2,amount};this._nextTurn();return {kind:'pick-two',amount}}
    if(card.number===5){const amount=(this.pendingPick?this.pendingPick.amount:0)+3;this.pendingPick={number:5,amount};this._nextTurn();return {kind:'pick-three',amount}}
    if(card.number===8){this.pendingPick=null;this._nextTurn(this.rules.suspensionSkipsNext?2:1);return {kind:'suspension'}}
    if(card.number===14){
      this.pendingPick=null; const drawn=[];
      if(this.rules.generalMarketDrawsOthers) for(let i=0;i<this.playerCount;i++) if(i!==playerIndex) drawn.push({playerIndex:i,cards:this._takeFromMarket(i,1).length});
      if(this.rules.generalMarketDrawsOthers&&this.rules.generalMarketExtraTurn)return {kind:'general-market',drawn,extraTurn:true};
      this._nextTurn(); return {kind:'general-market',drawn,extraTurn:false};
    }
    this.pendingPick=null; this._nextTurn(); return {kind:'normal'};
  }
  chooseComputerMove(playerIndex=this.turn){
    const legal=this.playableCards(playerIndex);
    if(!legal.length)return {type:'draw'};
    const winning=legal.find(x=>this.players[playerIndex].cards.length===1); if(winning)return this._botActionFor(winning);
    const special=legal.find(x=>x.card.number===2||x.card.number===5||x.card.number===8||x.card.number===14||x.card.number===1); if(special)return this._botActionFor(special);
    const whot=legal.find(x=>x.card.isWhot); if(whot)return this._botActionFor(whot);
    return this._botActionFor(legal[0]);
  }
  _botActionFor(move){
    const lastCall=this.rules.enforceLastCardCall&&this.players[this.turn].cards.length===2;
    if(!move.card.isWhot)return {type:'play',cardId:move.card.id,lastCall};
    const counts={}; for(const c of this.players[this.turn].cards) if(!c.isWhot)counts[c.shape]=(counts[c.shape]||0)+1;
    const call=Object.keys(counts).sort((a,b)=>(counts[b]||0)-(counts[a]||0))[0]||'circle';
    return {type:'play',cardId:move.card.id,call,lastCall};
  }
  playCard(playerIndex,cardIndex,call,lastCall=false){
    if(this.gameOver)throw new Error('game-over'); if(!this.started)throw new Error('game-not-started'); if(playerIndex!==this.turn)throw new Error('not-your-turn');
    const card=this.players[playerIndex].cards[cardIndex]; if(!card)throw new Error('card-not-found'); if(!this.canPlay(playerIndex,cardIndex))throw new Error('illegal-card');
    this._validateWhotCall(card,call);
    if(this.rules.enforceLastCardCall&&this.players[playerIndex].cards.length===2&&!lastCall)throw new Error('last-card-call-required');
    this.players[playerIndex].cards.splice(cardIndex,1); this.played.push(card); this.activeShape=card.isWhot?this.activeShape:card.shape;
    const wasPending=!!this.pendingPick,resolution=this._resolveSpecial(card,playerIndex,call);
    const gameOver=this._finishRoundIfNeeded(playerIndex);
    if(!gameOver)this._log(`${this.players[playerIndex].name} played ${card.id}`);
    return {card:cloneCard(card),resolution,wasPending,gameOver,state:this.toJSON()};
  }
  draw(playerIndex){
    if(this.gameOver)throw new Error('game-over'); if(!this.started)throw new Error('game-not-started'); if(playerIndex!==this.turn)throw new Error('not-your-turn');
    // Market is always available on a player's turn. Playing a card remains fully validated by canPlay().
    const count=this.pendingPick?this.pendingPick.amount:1; this.pendingPick=null; const cards=this._takeFromMarket(playerIndex,count); this._nextTurn(); return {cards,state:this.toJSON()};
  }
  stateFor(playerIndex){
    const own=this.players[playerIndex];
    return {
      playerCount:this.playerCount,
      players:this.players.map((p,index)=>({index,name:p.name,handCount:p.cards.length,cards:index===playerIndex?p.cards.map(cloneCard):undefined})),
      turn:this.turn,activeShape:this.activeShape,whotCall:this.whotCall?{...this.whotCall}:null,top:this._top()?cloneCard(this._top()):null,
      pendingPick:this.pendingPick?{...this.pendingPick}:null,gameOver:this.gameOver,winner:this.winner,roundScores:this.roundScores?[...this.roundScores]:null,
      marketCount:this.market.length,ownHandCount:own?own.cards.length:0,lastCallRequired:!!(own&&this.rules.enforceLastCardCall&&own.cards.length===2&&this.turn===playerIndex&&!this.gameOver),rules:{...this.rules}
    };
  }
  toJSON(){return this.stateFor(-1)}
}
module.exports={WhotEngine,SUITS,DEFAULT_RULES,makeDeck};
