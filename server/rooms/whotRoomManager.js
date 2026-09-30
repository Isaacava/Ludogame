'use strict';
const crypto=require('crypto');
const {WhotEngine}=require('../engine/whotEngine');
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECONNECT_GRACE_MS=2*60*1000;
const normCode=c=>String(c||'').trim().toUpperCase();
function generateCode(){let c='';for(let i=0;i<4;i++)c+=CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)];return c;}
class WhotRoomManager{
  constructor(configStore){this.rooms=new Map();this.configStore=configStore;}
  createRoom(playerCount,hostSocketId,profile={},mode='friends'){
    let code;do{code=generateCode()}while(this.rooms.has(code));
    const room={code,playerCount,mode,players:[{socketId:hostSocketId,playerToken:crypto.randomBytes(16).toString('hex'),connected:true,disconnectedAt:null,name:profile.name||'Player 1',bot:false}],engine:null,rematchVotes:new Set(),createdAt:Date.now(),botTimer:null};
    if(mode==='computer'){
      for(let i=1;i<playerCount;i++)room.players.push({socketId:null,playerToken:crypto.randomBytes(16).toString('hex'),connected:true,disconnectedAt:null,name:`CPU ${i}`,bot:true});
      this.resetEngine(room);
    }
    this.rooms.set(code,room);return room;
  }
  joinRoom(code,socketId,profile={}){
    const room=this.rooms.get(normCode(code));if(!room)return {error:'room-not-found'};
    const now=Date.now();
    room.players=room.players.filter(p=>p.bot||p.socketId||!p.disconnectedAt||now-p.disconnectedAt<=RECONNECT_GRACE_MS);
    if(room.engine||room.players.length>=room.playerCount)return {error:'room-full'};
    room.players.push({socketId,playerToken:crypto.randomBytes(16).toString('hex'),connected:true,disconnectedAt:null,name:profile.name||`Player ${room.players.length+1}`,bot:false});
    if(room.players.filter(p=>!p.bot).length===room.playerCount)this.resetEngine(room);
    return {room};
  }
  resetEngine(room){
    room.engine=new WhotEngine(room.playerCount,undefined,this.configStore&&this.configStore.get('whot'));
    room.players.forEach((p,i)=>room.engine.players[i].name=p.name||`Player ${i+1}`);
    room.rematchVotes=new Set();
    room.engine.start();
    return room.engine;
  }
  getRoom(code){return this.rooms.get(normCode(code))}
  playerIndexOf(room,socketId){return room.players.findIndex(p=>p.socketId===socketId&&!p.bot)}
  playerTokenAt(room,index){return room.players[index]?room.players[index].playerToken:null}
  reconnect(room,socketId,playerToken){
    const index=room.players.findIndex(p=>p.playerToken===playerToken&&!p.bot);if(index<0)return {error:'invalid-reconnect-token'};
    const player=room.players[index];if(player.connected&&player.socketId&&player.socketId!==socketId)return {error:'seat-already-connected'};
    player.socketId=socketId;player.connected=true;player.disconnectedAt=null;return {index,playerToken:player.playerToken,room};
  }
  removeSocket(socketId){
    for(const room of this.rooms.values()){
      const index=room.players.findIndex(p=>p.socketId===socketId&&!p.bot);
      if(index>=0){const player=room.players[index];player.socketId=null;player.connected=false;player.disconnectedAt=Date.now();return {room,index,player};}
    }
    return null;
  }
  requestRematch(code,socketId){
    const room=this.getRoom(code);if(!room||!room.engine)return {error:'room-not-found'};
    if(!room.engine.gameOver)return {error:'game-not-over'};
    const index=this.playerIndexOf(room,socketId);if(index<0)return {error:'not-in-room'};
    const humans=room.players.filter(p=>!p.bot);if(!humans.every(p=>p.connected))return {error:'players-disconnected'};
    room.rematchVotes.add(index);
    if(room.rematchVotes.size===humans.length){this.resetEngine(room);return {room,started:true,requested:room.rematchVotes.size}}
    return {room,started:false,requested:room.rematchVotes.size};
  }
  sweepExpired(maxAgeMs=30*60*1000){const now=Date.now();for(const [code,room] of this.rooms)if(!room.engine&&now-room.createdAt>maxAgeMs)this.rooms.delete(code)}
}
module.exports={WhotRoomManager,RECONNECT_GRACE_MS};
