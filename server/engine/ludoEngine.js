'use strict';
const PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],
  [14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],
  [8,1],[8,0],[7,0],[6,0]
];
const START_INDEX = { green:0, red:13, yellow:26, blue:39 };
const HOME_COLS = {
  green:[[7,1],[7,2],[7,3],[7,4],[7,5]],
  red:[[1,7],[2,7],[3,7],[4,7],[5,7]],
  yellow:[[7,13],[7,12],[7,11],[7,10],[7,9]],
  blue:[[13,7],[12,7],[11,7],[10,7],[9,7]]
};
const TEAM_SETUPS = {
  2:[{name:'p1',colors:['red','blue']},{name:'p2',colors:['yellow','green']}],
  3:[{name:'p1',colors:['red']},{name:'p2',colors:['green']},{name:'p3',colors:['yellow']}],
  4:[{name:'p1',colors:['red']},{name:'p2',colors:['green']},{name:'p3',colors:['yellow']},{name:'p4',colors:['blue']}]
};
const SAFE_CELLS = new Set([0,8,13,21,26,34,39,47]);
const DEFAULT_RULES = {
  safeZonesEnabled:false,
  blockadesEnabled:false,
  extraTurnValues:[6],
  doubleValueGrantsExtraTurn:true,
  captureSendsCapturerHome:true, // Naija Ludo default: the capturing token is removed/finished after a capture
  captureGrantsExtraTurn:false, // Optional Naija variant: a successful capture grants another turn
  exactRollToFinish:true
};
function pathIdx(rel,color){ return (START_INDEX[color]+rel)%52; }

class LudoEngine {
  constructor(playerCount,diceRoller,rules){
    if(![2,3,4].includes(playerCount)) throw new Error('playerCount must be 2, 3, or 4');
    this.rollD6=diceRoller||(()=>1+Math.floor(Math.random()*6));
    this.rules={...DEFAULT_RULES,...(rules||{})};
    this.players=TEAM_SETUPS[playerCount].map(p=>({name:p.name,colors:p.colors,tokens:Object.fromEntries(p.colors.map(c=>[c,[-1,-1,-1,-1]]))}));
    this.turn=0; this.dice=null; this.remainingDice=null; this.finishOrder=[]; this.gameOver=false; this.log=[]; this.captureBonusPending=false;
  }
  _log(msg){this.log.push(msg);}
  _ensureDiceState(){if(this.dice&&!this.remainingDice)this.remainingDice=[true,true];}
  currentPlayer(){return this.players[this.turn];}
  _blockedByOtherColor(abs,movingColor){
    if(!this.rules.blockadesEnabled)return false;
    const counts={};
    this.players.forEach(p=>p.colors.forEach(c=>p.tokens[c].forEach(t=>{
      if(t>=0&&t<=50&&pathIdx(t,c)===abs)counts[c]=(counts[c]||0)+1;
    })));
    return Object.entries(counts).some(([c,n])=>c!==movingColor&&n>=2);
  }
  _canUseValue(pos,value,isDie,color){
    if(pos===56)return false;
    if(pos===-1){if(!(isDie&&value===6))return false;return !this._blockedByOtherColor(pathIdx(0,color),color);}
    const newPos=pos+value;
    if(newPos>56 && this.rules.exactRollToFinish)return false;
    if(this.rules.blockadesEnabled){
      const steps=Math.min(value,Math.max(0,50-pos));
      for(let s=1;s<=steps;s++)if(this._blockedByOtherColor(pathIdx(pos+s,color),color))return false;
    }
    return true;
  }
  rollDice(){
    if(this.gameOver)throw new Error('game is over');
    if(this.dice)throw new Error('dice already rolled this turn — resolve current moves first');
    let d1=this.rollD6(),d2=this.rollD6();
    if(d2===6&&d1!==6){const t=d1;d1=d2;d2=t;}
    this.dice=[d1,d2];this.remainingDice=[true,true];this.actionSeq=(this.actionSeq||0)+1;
    return {dice:this.dice,options:this.legalOptions()};
  }
  legalOptions(){
    this._ensureDiceState();
    if(!this.dice||!this.remainingDice)return {split:{d1:[],d2:[]},combine:[],canSplit:false,canCombine:false};
    const [d1,d2]=this.dice;
    const split={d1:this.remainingDice[0]?this._legalMoves(d1,true):[],d2:this.remainingDice[1]?this._legalMoves(d2,true):[]};
    const both=this.remainingDice[0]&&this.remainingDice[1];
    const combine=both?this._legalMoves(d1+d2,false):[];
    return {split,combine,canSplit:split.d1.length>0||split.d2.length>0,canCombine:combine.length>0};
  }
  _legalMoves(value,isDie){
    const p=this.currentPlayer(),out=[];
    p.colors.forEach(color=>p.tokens[color].forEach((pos,idx)=>{if(this._canUseValue(pos,value,isDie,color))out.push({color,idx});}));
    return out;
  }
  _wouldCapture(move,value){
    const p=this.currentPlayer();
    let pos=p.tokens[move.color][move.idx];
    pos=pos===-1?0:pos+value;
    if(pos>50)return false;
    const g=pathIdx(pos,move.color);
    if(this.rules.safeZonesEnabled&&SAFE_CELLS.has(g))return false;
    return this.players.some((opp,oi)=>oi!==this.turn&&opp.colors.some(oc=>opp.tokens[oc].some(t=>t>=0&&t<=50&&pathIdx(t,oc)===g)));
  }
  applyMove(move,value,mode){
    this.actionSeq=(this.actionSeq||0)+1;
    this._ensureDiceState();
    const p=this.currentPlayer(),arr=p.tokens[move.color];
    if(!arr||!Number.isInteger(move.idx)||move.idx<0||move.idx>3)throw new Error('illegal move');
    if(!this.dice){
      if(arr[move.idx]===-1)throw new Error('illegal move');
      if(!this._canUseValue(arr[move.idx],value,false,move.color))throw new Error('illegal move');
      arr[move.idx]+=value;
      let newPos=arr[move.idx];
      if(newPos>56 && !this.rules.exactRollToFinish)newPos=56;
      arr[move.idx]=newPos;
      let captured=[];
      if(newPos<=50&&!(this.rules.safeZonesEnabled&&SAFE_CELLS.has(pathIdx(newPos,move.color)))){
        const g=pathIdx(newPos,move.color);
        let capturedOne=false;
        for(const [oi,opp] of this.players.entries()){
          if(capturedOne||oi===this.turn)continue;
          for(const oc of opp.colors){
            for(let ti=0;ti<opp.tokens[oc].length;ti++){
              const t=opp.tokens[oc][ti];
              if(t>=0&&t<=50&&pathIdx(t,oc)===g){
                opp.tokens[oc][ti]=-1;
                captured.push({player:oi,color:oc,idx:ti});
                capturedOne=true;
                break;
              }
            }
            if(capturedOne)break;
          }
        }
        if(captured.length&&this.rules.captureSendsCapturerHome){arr[move.idx]=56;newPos=56;}
        if(captured.length&&this.rules.captureGrantsExtraTurn)this.captureBonusPending=true;
      }
      const finishedNow=newPos===56,teamFinished=this._checkWinner(this.turn);
      return {captured,finishedNow,teamFinished,gameOver:this.gameOver,newPos,mode:'direct',consumedDice:null,capturerFinishedByCapture:captured.length>0&&this.rules.captureSendsCapturerHome,capturerColor:captured.length&&this.rules.captureSendsCapturerHome?move.color:null,capturerIdx:captured.length&&this.rules.captureSendsCapturerHome?move.idx:null};
    }
    const [a,b]=this.dice,available=this.remainingDice,both=available[0]&&available[1],sum=a+b;
    let resolvedMode=mode,dieIndex=-1;
    if(resolvedMode!=='split'&&resolvedMode!=='combine'){
      if(available[0]&&value===a){resolvedMode='split';dieIndex=0;}
      else if(available[1]&&value===b){resolvedMode='split';dieIndex=1;}
      else if(both&&value===sum)resolvedMode='combine';
      else throw new Error('illegal move: value does not match the roll or remaining dice');
    }
    if(resolvedMode==='combine'){
      if(!both||value!==sum)throw new Error('illegal move: combined move requires both dice');
      if(arr[move.idx]===-1)throw new Error('illegal move: entering needs a die showing 6');
    }else{
      if(dieIndex===-1){
        if(available[0]&&value===a)dieIndex=0;
        else if(available[1]&&value===b)dieIndex=1;
      }
      if(dieIndex===-1)throw new Error('illegal move: die has already been used');
      if(arr[move.idx]===-1&&value!==6)throw new Error('illegal move: entering needs a die showing 6');
    }
    const isDie=resolvedMode==='split';
    const legal=this._canUseValue(arr[move.idx]===-1?-1:arr[move.idx],value,isDie,move.color);
    if(!legal)throw new Error('illegal move');
    if(resolvedMode==='combine'){this.remainingDice[0]=false;this.remainingDice[1]=false;}
    else this.remainingDice[dieIndex]=false;
    arr[move.idx]=arr[move.idx]===-1?0:arr[move.idx]+value;
    let newPos=arr[move.idx];
    if(newPos>56 && !this.rules.exactRollToFinish)newPos=56;
    arr[move.idx]=newPos;
    let captured=[];
    if(newPos<=50&&!(this.rules.safeZonesEnabled&&SAFE_CELLS.has(pathIdx(newPos,move.color)))){
      const g=pathIdx(newPos,move.color);
      let capturedOne=false;
      for(const [oi,opp] of this.players.entries()){
        if(capturedOne||oi===this.turn)continue;
        for(const oc of opp.colors){
          for(let ti=0;ti<opp.tokens[oc].length;ti++){
            const t=opp.tokens[oc][ti];
            if(t>=0&&t<=50&&pathIdx(t,oc)===g){
              opp.tokens[oc][ti]=-1;
              captured.push({player:oi,color:oc,idx:ti});
              this._log(p.name+' captured '+oc);
              capturedOne=true;
              break;
            }
          }
          if(capturedOne)break;
        }
      }
      if(captured.length&&this.rules.captureSendsCapturerHome){arr[move.idx]=56;newPos=56;this._log(`${p.name}'s ${move.color} token was removed after the capture!`);}
      if(captured.length&&this.rules.captureGrantsExtraTurn)this.captureBonusPending=true;
    }
    const finishedNow=newPos===56;
    if(finishedNow&&!(captured.length&&this.rules.captureSendsCapturerHome))this._log(`${p.name}'s ${move.color} token reached home`);
    const teamFinished=this._checkWinner(this.turn);
    return {captured,finishedNow,teamFinished,gameOver:this.gameOver,newPos,mode:resolvedMode,consumedDice:this.remainingDice.map(Boolean),capturerFinishedByCapture:captured.length>0&&this.rules.captureSendsCapturerHome,capturerColor:captured.length&&this.rules.captureSendsCapturerHome?move.color:null,capturerIdx:captured.length&&this.rules.captureSendsCapturerHome?move.idx:null};
  }
  _checkWinner(pIdx){
    const p=this.players[pIdx],allDone=p.colors.every(c=>p.tokens[c].every(t=>t===56));
    if(allDone&&!this.finishOrder.includes(pIdx)){
      this.finishOrder.push(pIdx);this._log(`${p.name} finished — place ${this.finishOrder.length}`);
      if(this.finishOrder.length===this.players.length-1){
        const lastIdx=this.players.findIndex((_,i)=>!this.finishOrder.includes(i));
        this.finishOrder.push(lastIdx);this.gameOver=true;
      }
      return true;
    }
    return false;
  }
  endTurn(){
    this._ensureDiceState();this.actionSeq=(this.actionSeq||0)+1;
    const [d1,d2]=this.dice||[0,0];
    const doubleValueExtra=this.rules.doubleValueGrantsExtraTurn&&d1===d2&&this.rules.extraTurnValues.includes(d1);
    const captureExtra=!!this.captureBonusPending;
    const extraTurn=doubleValueExtra||captureExtra;
    this.dice=null;this.remainingDice=null;this.captureBonusPending=false;
    if(this.gameOver)return {doubleSix:doubleValueExtra,captureExtra,extraTurn:false,nextTurn:this.turn,gameOver:true,finishOrder:this.finishOrder};
    if(!extraTurn){do{this.turn=(this.turn+1)%this.players.length;}while(this.finishOrder.includes(this.turn));}
    return {doubleSix:doubleValueExtra,captureExtra,extraTurn,nextTurn:this.turn,gameOver:this.gameOver,finishOrder:this.finishOrder};
  }
  chooseAiMoves(){
    const [d1,d2]=this.dice,opts=this.legalOptions();
    const combineCaptures=opts.combine.filter(m=>this._wouldCapture(m,d1+d2));
    const splitCaptures=[...opts.split.d1.filter(m=>this._wouldCapture(m,d1)),...opts.split.d2.filter(m=>this._wouldCapture(m,d2))];
    const pick=(legal)=>legal.reduce((best,m)=>{const p=this.currentPlayer();return p.tokens[m.color][m.idx]>p.tokens[best.color][best.idx]?m:best;},legal[0]);
    const plan=[];
    if(combineCaptures.length&&!splitCaptures.length)plan.push({move:pick(combineCaptures),value:d1+d2});
    else if(opts.split.d1.length||opts.split.d2.length){
      if(opts.split.d1.length){const enter=opts.split.d1.find(m=>this.currentPlayer().tokens[m.color][m.idx]===-1),cap1=opts.split.d1.find(m=>this._wouldCapture(m,d1));plan.push({move:cap1||enter||pick(opts.split.d1),value:d1,mode:'split'});}
      plan.push({value:d2,recomputeD2:true,mode:'split'});
    }else if(opts.combine.length)plan.push({move:pick(opts.combine),value:d1+d2,mode:'combine'});
    return plan;
  }
  toJSON(){return {players:this.players.map(p=>({name:p.name,colors:p.colors,tokens:p.tokens})),turn:this.turn,dice:this.dice,remainingDice:this.remainingDice,finishOrder:this.finishOrder,gameOver:this.gameOver,rules:this.rules};}
}
module.exports={LudoEngine,PATH,HOME_COLS,START_INDEX,pathIdx,SAFE_CELLS,DEFAULT_RULES};
