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
    reserved:humans.length,
    connected:humans.filter(p=>!!p.socketId).length,
    open:roomHasOpenSeat(room),
    started:!!room?.engine,
    gameOver:!!room?.engine?.gameOver,
    visibility:room?.visibility||'public',
    viewers:room?.spectators?.size||0
  };
}

// Public matches for the "Watch live" list. Only rooms the host set to Public are ever listed.
function listLiveRooms(limit=30){
  const out=[];
  for(const game of ['ludo','whot']){
    const manager=managers[game];if(!manager||!manager.rooms)continue;
    for(const room of manager.rooms.values()){
      if(!room||room.visibility!=='public')continue;
      if(room.engine&&room.engine.gameOver)continue;
      const humans=(room.players||[]).filter(p=>!p.bot);
      if(!humans.some(p=>p.socketId))continue; // nobody is actually there
      out.push({
        game,code:room.code,
        started:!!room.engine,
        playerCount:Number(room.playerCount||0),
        players:(room.players||[]).map(p=>String(p.name||'Player').slice(0,24)),
        host:String((room.players&&room.players[0]&&room.players[0].name)||'Player').slice(0,24),
        viewers:room.spectators?room.spectators.size:0,
        createdAt:room.createdAt||0
      });
    }
  }
  out.sort((a,b)=>(b.started-a.started)||(b.viewers-a.viewers)||(b.createdAt-a.createdAt));
  return out.slice(0,limit);
}

module.exports={registerGameManager,getManager,createReservedRoom,findRoom,findOpenRoom,roomHasOpenSeat,roomIsReadyToStart,roomSummary,listLiveRooms};