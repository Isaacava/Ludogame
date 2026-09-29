'use strict';
const crypto = require('crypto');
const { LudoEngine } = require('../engine/ludoEngine');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = c => String(c || '').trim().toUpperCase();
function generateCode() { let c=''; for(let i=0;i<4;i++) c += CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]; return c; }
class RoomManager {
  constructor(configStore) { this.rooms = new Map(); this.configStore = configStore; }
  createRoom(playerCount, hostSocketId) {
    let code; do { code = generateCode(); } while (this.rooms.has(code));
    const room = { code, playerCount, players:[{socketId:hostSocketId,playerToken:crypto.randomBytes(16).toString('hex'),connected:true}], engine:null, createdAt:Date.now() };
    this.rooms.set(code, room); return room;
  }
  joinRoom(code, socketId) {
    const room = this.rooms.get(normCode(code)); if(!room) return {error:'room-not-found'}; if(room.engine) return {error:'room-full'};
    const seat = room.players.find(p=>!p.socketId);
    if(room.players.length >= room.playerCount && !seat) return {error:'room-full'};
    const player = seat || {socketId:null,playerToken:crypto.randomBytes(16).toString('hex'),connected:false};
    if(seat) player.playerToken = crypto.randomBytes(16).toString('hex');
    player.socketId=socketId; player.connected=true;
    if(!seat) room.players.push(player);
    if(room.players.length===room.playerCount && room.players.every(p=>p.socketId)) {
      const rules=this.configStore?this.configStore.get('rules'):undefined;
      room.engine=new LudoEngine(room.playerCount,undefined,rules);
    }
    return {room};
  }
  getRoom(code){ return this.rooms.get(normCode(code)); }
  playerIndexOf(room,socketId){ return room.players.findIndex(p=>p.socketId===socketId); }
  playerTokenAt(room,index){ return room.players[index]?room.players[index].playerToken:null; }
  reconnect(room,socketId,playerToken){
    const index=room.players.findIndex(p=>p.playerToken===playerToken);
    if(index===-1) return {error:'invalid-reconnect-token'};
    const player=room.players[index]; player.socketId=socketId; player.connected=true;
    return {index,playerToken:player.playerToken,room};
  }
  removeSocket(socketId){
    for(const room of this.rooms.values()){
      const player=room.players.find(p=>p.socketId===socketId);
      if(player){ player.socketId=null; player.connected=false; }
    }
  }
  sweepExpired(maxAgeMs=30*60*1000){
    const now=Date.now();
    for(const [code,room] of this.rooms){ if(!room.engine && now-room.createdAt>maxAgeMs) this.rooms.delete(code); }
  }
}
module.exports = {RoomManager};
