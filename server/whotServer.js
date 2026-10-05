'use strict';
const {io,configStore}=require('./index');
const {WhotRoomManager}=require('./rooms/whotRoomManager');
const {resolveWhatsAppGameToken,notifyGameResults}=require('./bot/whatsappBridge');
const {registerGameManager}=require('./bot/gameControl');
const {startTurnTimers,normalizeTurnSeconds}=require('./realtime/turnTimer');

const rooms=new WhotRoomManager(configStore);
registerGameManager('whot',rooms);
const reactions=new Set(['😂','🔥','👏','😭','Omo!','Sharp!']);
function emitWhotAudio(room,playerIndex,cue){const player=room&&room.players[playerIndex];if(player&&player.socketId)io.to(player.socketId).emit('game-audio',{game:'whot',cue});}
function emitWhotRoomAudio(room,cue){if(!room)return;room.players.forEach((_,index)=>emitWhotAudio(room,index,cue));if(room.spectators)room.spectators.forEach((_,sid)=>io.to(sid).emit('game-audio',{game:'whot',cue}));}
function emitWhotResultAudio(room,playerIndex,result){if(!room||!result)return;const kind=result.resolution&&result.resolution.kind;const cue={normal:'whot-card','hold-on':'whot-hold-on','pick-two':'whot-pick2','pick-three':'whot-pick3',suspension:'whot-suspension','general-market':'whot-general-market',whot:'whot-wild'}[kind]||'whot-card';emitWhotRoomAudio(room,cue);if(result.gameOver){const winner=result.state&&result.state.winner!=null?result.state.winner:playerIndex;room.players.forEach((_,index)=>emitWhotAudio(room,index,index===winner?'game-winner':'game-loser'));notifyGameResults(room,{winnerIndex:winner,gameName:'Whot'}).catch(()=>{});}}
const humanRoom=(room)=>room.players.map((p,index)=>({index,name:p.name||`Player ${index+1}`,connected:!!p.socketId,bot:!!p.bot}));

function spectatorState(room){
  if(!room?.engine)return null;
  const state=room.engine.toJSON();
  // Opponents' cards are only revealed when the host switched "Show players' cards" on (default: hidden, to stop spectators relaying hands to players).
  state.players=state.players.map((p,index)=>({
    ...p,
    cards:room.showHands?(room.engine.players[index]?.cards||[]).map(card=>({...card})):undefined
  }));
  state.showHands=!!room.showHands;
  return state;
}
const SHAPE_ICON={circle:'●',triangle:'▲',cross:'✚',square:'■',star:'★'};
const nameOf=(room,i)=>(room.players[i]&&room.players[i].name)||`Player ${Number(i)+1}`;
function cardLabel(c){if(!c)return 'a card';return c.isWhot?'20 WHOT':`${c.number} ${SHAPE_ICON[c.shape]||c.shape}`}
// Plain-language line for the live move feed.
function feedLine(room,extra){
  if(!room.engine||extra.actor==null||extra.actor<0)return null;
  const who=nameOf(room,extra.actor);
  if(extra.drawn){const n=extra.drawn.length;return {kind:'draw',text:`${who} picked ${n} card${n===1?'':'s'} from the Market`}}
  if(!extra.played)return null;
  const eng=room.engine,top=eng.toJSON().top,kind=extra.resolution&&extra.resolution.kind;
  let text=`${who} played ${cardLabel(top)}`;
  if(top&&top.isWhot&&eng.whotCall)text+=` and called ${eng.whotCall.mode==='shape'?(SHAPE_ICON[eng.whotCall.value]||eng.whotCall.value):eng.whotCall.value}`;
  const tag={'hold-on':'Hold On!','pick-two':'Pick Two!','pick-three':'Pick Three!',suspension:'Suspension!','general-market':'General Market!'}[kind];
  if(tag)text+=` · ${tag}`;
  if(eng.gameOver)return {kind:'win',text:`${who} played ${cardLabel(top)} and wins the round! 🏆`};
  return {kind:tag?'special':'play',text};
}
function recordFeed(room,extra){
  if(!extra)return;
  const line=feedLine(room,extra);if(!line)return;
  const item=rooms.addFeed(room,line.text,line.kind);
  io.to(`WHOT_${room.code}`).emit('whot:feed',item);
}
function evictSpectators(room){
  rooms.spectatorsToEvict(room).forEach(sid=>{
    io.to(sid).emit('whot:spectator-ended',{reason:room.visibility==='private'?'spectating-disabled':'link-only'});
    const sock=io.sockets.sockets.get(sid);if(sock){sock.leave(`WHOT_${room.code}`);sock.data.role=null}
    rooms.removeSpectator(room,sid);
  });
}
function hostOnly(socket,room){
  if(!room){socket.emit('whot:error',{message:'room-not-found'});return false}
  if(rooms.playerIndexOf(room,socket.id)!==0){socket.emit('whot:error',{message:'not-host'});return false}
  return true;
}
function emitState(room,extra={}){
  if(!room.engine)return;
  room.lastActivityAt=Date.now();
  room.players.forEach((p,index)=>{
    if(p.bot||!p.socketId)return;
    io.to(p.socketId).emit('whot:state',{code:room.code,index,playerToken:p.playerToken,state:room.engine.stateFor(index),...extra});
  });
  if(room.spectators){
    room.spectators.forEach((_,socketId)=>{
      io.to(socketId).emit('whot:state',{code:room.code,index:-1,spectator:true,state:spectatorState(room),...extra});
    });
  }
  recordFeed(room,extra);
}
function emitRoomWaiting(room,text){
  io.to(`WHOT_${room.code}`).emit('whot:status',{roomCode:room.code,waiting:true,needed:room.playerCount,joined:room.players.filter(p=>!p.bot&&p.socketId).length,text,players:humanRoom(room)});
}
function scheduleBot(room){
  if(!room.engine||room.engine.gameOver||room.botTimer)return;
  const index=room.engine.turn,player=room.players[index];
  if(!player||!player.bot)return;
  room.botTimer=setTimeout(()=>{
    room.botTimer=null;
    if(!room.engine||room.engine.gameOver||room.engine.turn!==index)return;
    try{
      const action=room.engine.chooseComputerMove(index);
      if(action.type==='draw'){
        const result=room.engine.draw(index);
        emitState(room,{drawn:result.cards.map(c=>c.id),actor:index,bot:true});
        emitWhotRoomAudio(room,'whot-draw');
      }else{
        const cardIndex=room.engine.players[index].cards.findIndex(c=>c.id===action.cardId);
        const result=room.engine.playCard(index,cardIndex,action.call,action.lastCall);
        emitState(room,{played:result.card.id,actor:index,resolution:result.resolution,bot:true});
        emitWhotResultAudio(room,index,result);
      }
    }catch(err){emitState(room,{botError:err.message});}
    if(!room.engine.gameOver)scheduleBot(room);
  },650);
}

// A player whose clock ran out: play like the computer would (best legal card, otherwise take from the Market).
function whotAutoPlay(room,seat){
  const eng=room.engine;if(!eng||eng.gameOver||eng.turn!==seat)return;
  try{
    const action=eng.chooseComputerMove(seat);
    if(action.type==='draw'){
      const r=eng.draw(seat);emitState(room,{drawn:r.cards.map(c=>c.id),actor:seat,auto:true});emitWhotRoomAudio(room,'whot-draw');
    }else{
      const ci=eng.players[seat].cards.findIndex(c=>c.id===action.cardId);
      const r=eng.playCard(seat,ci,action.call,action.lastCall);
      emitState(room,{played:r.card.id,actor:seat,resolution:r.resolution,auto:true});emitWhotResultAudio(room,seat,r);
    }
  }catch(err){emitState(room,{autoError:err.message});}
  if(!eng.gameOver)scheduleBot(room);
}
startTurnTimers({
  rooms:()=>rooms.rooms.values(),
  active:room=>!!room.engine&&!room.engine.gameOver&&room.engine.started!==false,
  signature:room=>`${room.engine.turn}:${room.engine.actionSeq||0}:${room.engine.gameOver?1:0}`,
  seat:room=>room.engine.turn,
  emit:(room,_event,payload)=>io.to(`WHOT_${room.code}`).emit('whot:turn-timer',payload),
  autoPlay:whotAutoPlay,
  announce:(room,text)=>{const item=rooms.addFeed(room,text,'timeout');io.to(`WHOT_${room.code}`).emit('whot:feed',item);}
});

io.on('connection',socket=>{
  socket.on('whot:create-room',({playerCount,name,mode,whatsappToken,visibility,showHands,chatEnabled,turnSeconds})=>{
    const whatsapp=resolveWhatsAppGameToken(whatsappToken);
    const count=Number(playerCount),cfg=configStore.get('whot')||{};
    if(cfg.enabled===false)return socket.emit('whot:error',{message:'whot-disabled'});
    const allowed=Array.isArray(cfg.playerCounts)&&cfg.playerCounts.length?cfg.playerCounts:[2,3,4];
    if(!allowed.includes(count))return socket.emit('whot:error',{message:'player-count-disabled'});
    const room=rooms.createRoom(count,socket.id,{name,whatsappPhone:whatsapp?.phone||null},mode==='computer'?'computer':'friends');
    rooms.applyOptions(room,{visibility,showHands,chatEnabled});
    room.turnSeconds=mode==='computer'?0:normalizeTurnSeconds(turnSeconds);
    socket.data.role='player';socket.data.game='whot';socket.data.roomCode=room.code;
    socket.join(`WHOT_${room.code}`);
    socket.emit('whot:created',{code:room.code,index:0,turnSeconds:room.turnSeconds,playerToken:room.players[0].playerToken,joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(0):null,audience:rooms.audienceInfo(room,true,true),whatsappBotNumber:String(process.env.WHATSAPP_PUBLIC_NUMBER||'').replace(/\D/g,'')});
    if(room.engine){emitState(room);scheduleBot(room)}else emitRoomWaiting(room,'Waiting for players…');
  });
  socket.on('whot:join-room',({code,name,playerToken,whatsappToken})=>{
    const whatsapp=resolveWhatsAppGameToken(whatsappToken);
    const existing=rooms.getRoom(code);
    if(existing&&playerToken){
      const resumed=rooms.reconnect(existing,socket.id,playerToken);
      if(!resumed.error){
        const room=existing,index=resumed.index;socket.data.role='player';socket.data.game='whot';socket.data.roomCode=room.code;socket.join(`WHOT_${room.code}`);
        socket.emit('whot:joined',{code:room.code,index,playerToken:resumed.playerToken,joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(index):null,reconnected:true,audience:rooms.audienceInfo(room,true,true),whatsappBotNumber:String(process.env.WHATSAPP_PUBLIC_NUMBER||'').replace(/\D/g,'')});
        emitState(room);if(room.engine&&!room.engine.gameOver)scheduleBot(room);return;
      }
    }
    if((configStore.get('whot')||{}).enabled===false)return socket.emit('whot:error',{message:'whot-disabled'});
    const result=rooms.joinRoom(code,socket.id,{name,whatsappPhone:whatsapp?.phone||null});
    if(result.error)return socket.emit('whot:error',{message:result.error});
    const room=result.room,index=rooms.playerIndexOf(room,socket.id);socket.data.role='player';socket.data.game='whot';socket.data.roomCode=room.code;socket.join(`WHOT_${room.code}`);
    socket.emit('whot:joined',{code:room.code,index,playerToken:rooms.playerTokenAt(room,index),joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(index):null,audience:rooms.audienceInfo(room,true,true),whatsappBotNumber:String(process.env.WHATSAPP_PUBLIC_NUMBER||'').replace(/\D/g,'')});
    if(room.engine)emitState(room);else emitRoomWaiting(room,'Waiting for players…');
  });
  socket.on('whot:reconnect',({code,playerToken})=>{
    const room=rooms.getRoom(code);if(!room)return socket.emit('whot:error',{message:'room-not-found'});
    const result=rooms.reconnect(room,socket.id,playerToken);if(result.error)return socket.emit('whot:error',{message:result.error});
    const {index}=result;socket.data.role='player';socket.data.game='whot';socket.data.roomCode=room.code;socket.join(`WHOT_${room.code}`);
    socket.emit('whot:joined',{code:room.code,index,playerToken:result.playerToken,joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(index):null,reconnected:true,audience:rooms.audienceInfo(room,true,true)});
    emitState(room);if(room.engine&&!room.engine.gameOver)scheduleBot(room);
  });
  socket.on('whot:spectate',({code,watchToken,name,viewerId})=>{
    const room=rooms.getRoom(code);
    if(!room)return socket.emit('whot:error',{message:'room-not-found'});
    const deny=rooms.spectateDenyReason(room,watchToken);
    if(deny)return socket.emit('whot:error',{message:deny});
    if(room.spectators&&room.spectators.size>=200&&!room.spectators.has(socket.id))return socket.emit('whot:error',{message:'audience-full'});
    const viaToken=!!watchToken&&String(watchToken)===room.spectatorToken;
    const spectator=rooms.addSpectator(room,socket.id,{name,viewerId,viaToken,reservedNames:room.players.map(p=>p.name)});
    socket.data.role='spectator';socket.data.game='whot';socket.data.roomCode=room.code;socket.data.spectatorName=spectator.name;socket.data.spectatorKey=spectator.key;
    socket.join(`WHOT_${room.code}`);
    socket.emit('whot:spectator-joined',{code:room.code,started:!!room.engine,you:{key:spectator.key,name:spectator.name},players:humanRoom(room),playerCount:room.playerCount,audience:rooms.audienceInfo(room,false,true)});
    if(room.engine)socket.emit('whot:state',{code:room.code,index:-1,spectator:true,state:spectatorState(room)});
    else socket.emit('whot:status',{roomCode:room.code,waiting:true,needed:room.playerCount,joined:room.players.filter(p=>!p.bot&&p.socketId).length,text:'Waiting for players…',players:humanRoom(room)});
    io.to(`WHOT_${room.code}`).emit('whot:audience-info',rooms.audienceInfo(room,false));
  });
  // Host controls: who can watch, whether spectators see cards, whether spectators can chat.
  function applyAudienceOptions(socket,payload){
    const room=rooms.getRoom(payload&&payload.code);if(!hostOnly(socket,room))return;
    rooms.applyOptions(room,{visibility:payload.visibility,showHands:payload.showHands,chatEnabled:payload.chatEnabled});
    evictSpectators(room);
    io.to(`WHOT_${room.code}`).emit('whot:audience-info',rooms.audienceInfo(room,false));
    socket.emit('whot:audience-host',rooms.audienceInfo(room,true));
    if(room.engine)emitState(room);
  }
  socket.on('whot:set-audience-options',payload=>applyAudienceOptions(socket,payload));
  socket.on('whot:set-room-visibility',({code,visibility})=>applyAudienceOptions(socket,{code,visibility}));
  socket.on('whot:mute-viewer',({code,key,muted})=>{
    const room=rooms.getRoom(code);if(!hostOnly(socket,room))return;
    rooms.setMuted(room,key,muted!==false);
    socket.emit('whot:audience-host',rooms.audienceInfo(room,true));
  });
  socket.on('whot:chat-message',({code,text})=>{
    const room=rooms.getRoom(code);if(!room)return socket.emit('whot:error',{message:'room-not-found'});
    let role='spectator',name=socket.data.spectatorName||'Guest',key=socket.data.spectatorKey;
    const index=rooms.playerIndexOf(room,socket.id);
    if(index>=0){role=index===0?'host':'player';name=room.players[index].name||('Player '+(index+1));key=null;}
    else if(!room.spectators?.has(socket.id))return socket.emit('whot:error',{message:'not-in-room'});
    const result=rooms.addChatMessage(room,socket.id,{name,role,text,key});
    if(result.error)return socket.emit('whot:error',{message:result.error});
    io.to(`WHOT_${room.code}`).emit('whot:chat-message',result.message);
  });

  socket.on('whot:play-card',({code,cardId,call,lastCall})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('whot:error',{message:'room-not-ready'});
    const index=rooms.playerIndexOf(room,socket.id);if(index<0)return socket.emit('whot:error',{message:'not-in-room'});
    if(index!==room.engine.turn)return socket.emit('whot:error',{message:'not-your-turn'});
    const cardIndex=room.engine.players[index].cards.findIndex(c=>c.id===cardId);if(cardIndex<0)return socket.emit('whot:error',{message:'card-not-found'});
    try{const result=room.engine.playCard(index,cardIndex,call,!!lastCall);emitState(room,{played:result.card.id,actor:index,resolution:result.resolution});emitWhotResultAudio(room,index,result);if(!room.engine.gameOver)scheduleBot(room)}catch(err){socket.emit('whot:error',{message:err.message})}
  });
  socket.on('whot:draw',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('whot:error',{message:'room-not-ready'});
    const index=rooms.playerIndexOf(room,socket.id);if(index<0)return socket.emit('whot:error',{message:'not-in-room'});
    if(index!==room.engine.turn)return socket.emit('whot:error',{message:'not-your-turn'});
    try{const result=room.engine.draw(index);emitState(room,{drawn:result.cards.map(c=>c.id),actor:index});emitWhotRoomAudio(room,'whot-draw');scheduleBot(room)}catch(err){socket.emit('whot:error',{message:err.message})}
  });
  socket.on('whot:reaction',({code,reaction})=>{
    if(!reactions.has(reaction))return;
    const room=rooms.getRoom(code);if(!room)return;
    const index=rooms.playerIndexOf(room,socket.id);
    let name=socket.data.spectatorName||'Guest';
    if(index>=0)name=room.players[index].name||`Player ${index+1}`;
    else if(!room.spectators?.has(socket.id))return;
    const now=Date.now();if(socket.data.whotReactionAt&&now-socket.data.whotReactionAt<500)return;socket.data.whotReactionAt=now;
    room.reactionTotal=(room.reactionTotal||0)+1;
    io.to(`WHOT_${room.code}`).emit('whot:reaction',{name,reaction,role:index>=0?'player':'spectator'});
  });
  socket.on('whot:rematch',({code})=>{
    const result=rooms.requestRematch(code,socket.id);if(result.error)return socket.emit('whot:error',{message:result.error});
    io.to(`WHOT_${result.room.code}`).emit('whot:rematch-status',{requested:result.requested,needed:result.room.players.filter(p=>!p.bot).length});
    if(result.started){emitState(result.room);scheduleBot(result.room)}
  });
  socket.on('disconnect',()=>{
    const roomCode=socket.data.roomCode;
    if(socket.data.role==='spectator'&&roomCode){
      const room=rooms.getRoom(roomCode);
      if(room&&rooms.removeSpectator(room,socket.id))io.to(`WHOT_${room.code}`).emit('whot:audience-info',rooms.audienceInfo(room,false));
      return;
    }
    const removed=rooms.removeSocket(socket.id);if(!removed)return;
    const room=removed.room;io.to(`WHOT_${room.code}`).emit('whot:status',{roomCode:room.code,waiting:false,players:humanRoom(room),text:(removed.player.name||'Player')+' disconnected'});
    io.to(`WHOT_${room.code}`).emit('whot:audience-info',rooms.audienceInfo(room,false));
  });
});

setInterval(()=>rooms.sweepExpired(),60*1000);
module.exports={rooms};
