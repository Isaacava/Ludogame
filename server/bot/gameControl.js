'use strict';

const managers={ludo:null,whot:null};

function registerGameManager(game,manager){
  const key=String(game||'').toLowerCase();
  if(!Object.prototype.hasOwnProperty.call(managers,key))throw new Error('unsupported-game:'+key);
  managers[key]=manager;
}

function getManager(game){
  return managers[String(game||'').toLowerCase()]||null;
}

function createReservedRoom(game,{playerCount,name,phone,mode='friends'}={}){
  const key=String(game||'').toLowerCase();
  const manager=getManager(key);
  if(!manager)throw new Error('game-manager-not-ready');
  const count=Number(playerCount);
  if(!Number.isInteger(count)||!manager)throw new Error('invalid-player-count');

  const room=manager.createRoom(count,null,{
    name:name||'Player 1',
    whatsappPhone:phone||null
  },mode);
  return room;
}

function findRoom(game,code){
  const key=String(game||'').toLowerCase();
  const manager=getManager(key);
  return manager?manager.getRoom(code):null;
}

function findOpenRoom(code,game){
  if(game){
    const room=findRoom(game,code);
    return room&&roomHasOpenSeat(room)?{game:String(game).toLowerCase(),room}:null;
  }
  for(const key of ['ludo','whot']){
    const room=findRoom(key,code);
    if(room&&roomHasOpenSeat(room))return {game:key,room};
  }
  return null;
}

function roomHasOpenSeat(room){
  if(!room||room.engine)return false;
  const humanPlayers=(room.players||[]).filter(p=>!p.bot);
  return humanPlayers.length<Number(room.playerCount||0);
}

function roomIsReadyToStart(room){
  if(!room)return false;
  const humans=(room.players||[]).filter(p=>!p.bot);
  return humans.length===Number(room.playerCount||0)&&humans.every(p=>!!p.socketId);
}

function roomSummary(room){
  const humans=(room&&room.players||[]).filter(p=>!p.bot);
  return {
    code:room?.code||null,
    playerCount:Number(room?.playerCount||humans.length||0),
    reserved:h​​umans.length,
    connected:humans.filter(p=>!!p.socketId).length,
    open:roomHasOpenSeat(room),
    started:!!room?.engine,
    gameOver:!!room?.engine?.gameOver
  };
}

module.exports={registerGameManager,getManager,createReservedRoom,findRoom,findOpenRoom,roomHasOpenSeat,roomIsReadyToStart,roomSummary};