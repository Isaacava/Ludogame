'use strict';
const path=require('path');
const http=require('http');
const express=require('express');
const {Server}=require('socket.io');
const {RoomManager}=require('./rooms/roomManager');
const {ConfigStore}=require('./config/configStore');
const {createAdminRoutes}=require('./admin/adminRoutes');
const {createBotApp,UserStore,SessionStore}=require('./whatsappBot');
const {createWahaApp}=require('./bot/wahaAdapter');
const {createMetaWhatsAppApp}=require('./bot/metaWhatsAppAdapter');
const {MongoPersistence}=require('./db/mongoPersistence');
const {resolveWhatsAppGameToken,notifyGameResults}=require('./bot/whatsappBridge');
const {registerGameManager}=require('./bot/gameControl');

const PORT=process.env.PORT||3001;
const configStore=new ConfigStore();
const rooms=new RoomManager(configStore);
registerGameManager('ludo',rooms);
const persistence=new MongoPersistence();
const users=new UserStore(persistence);
const sessions=new SessionStore(persistence);
const roomPlayers=(room)=>room.players.map((p,index)=>({index,name:p.name||`Player ${index+1}`,color:p.color||null,connected:!!p.socketId}));
const SAFE_REACTIONS=new Set(['😂','🔥','👏','😭','😎','😳','Omo!','Sharp!']);

function emitGameAudio(room,playerIndex,cue){
  const player=room&&room.players[playerIndex];
  if(player&&player.socketId)io.to(player.socketId).emit('game-audio',{game:'ludo',cue});
}
function emitRoomAudio(room,cue){
  if(!room)return;
  room.players.forEach((_,index)=>emitGameAudio(room,index,cue));
}
function emitLudoResultAudio(room,playerIndex,result){
  if(!room||!result)return;
  if(result.captured&&result.captured.length){
    emitGameAudio(room,playerIndex,'ludo-capture-attacker');
    result.captured.forEach(c=>emitGameAudio(room,c.player,'ludo-capture-victim'));
    if(result.capturerFinishedByCapture)emitGameAudio(room,playerIndex,'ludo-capture-finished');
  }else if(result.finishedNow){
    emitGameAudio(room,playerIndex,'ludo-piece-home');
  }
  if(result.gameOver){
    const winnerIndex=Array.isArray(result.finishOrder)&&result.finishOrder.length?result.finishOrder[0]:playerIndex;
    room.players.forEach((_,index)=>emitGameAudio(room,index,index===winnerIndex?'game-winner':'game-loser'));
  }
}


const app=express();
const {router:adminRouter}=createAdminRoutes(configStore);
app.use('/api/admin',adminRouter);
app.use(createMetaWhatsAppApp({users,configStore}));
app.use(createWahaApp({users}));
app.use(createBotApp({users,sessions,configStore}));
app.use(express.static(path.join(__dirname,'..','web'),{extensions:['html']}));
app.get('/health',(req,res)=>res.send('ok'));
app.get('/api/live-rooms',(req,res)=>{res.set('Cache-Control','no-store');res.json({rooms:require('./bot/gameControl').listLiveRooms()})});
app.get('/api/config/public',(req,res)=>{
  const cfg=configStore.getAll();
  const railwayDomain=process.env.RAILWAY_PUBLIC_DOMAIN||'codeplay-ludo-production.up.railway.app';
  res.json({
    bot:{whatsappNumber:process.env.WHATSAPP_PUBLIC_NUMBER||cfg.bot.whatsappNumber},
    maintenance:cfg.maintenance,
    monetization:cfg.monetization,
    socketUrl:`https://${railwayDomain}`,
    rules:{
      playerCounts:cfg.rules.playerCounts,
      safeZonesEnabled:!!cfg.rules.safeZonesEnabled,
      blockadesEnabled:!!cfg.rules.blockadesEnabled,
      extraTurnValues:Array.isArray(cfg.rules.extraTurnValues)?cfg.rules.extraTurnValues:[6],
      doubleValueGrantsExtraTurn:!!cfg.rules.doubleValueGrantsExtraTurn,
      captureSendsCapturerHome:!!cfg.rules.captureSendsCapturerHome,
      captureGrantsExtraTurn:!!cfg.rules.captureGrantsExtraTurn,
      exactRollToFinish:cfg.rules.exactRollToFinish!==false
    },
    whot:{
      enabled:cfg.whot?.enabled!==false,
      playerCounts:Array.isArray(cfg.whot?.playerCounts)?cfg.whot.playerCounts:[2,3,4],
      handSize:Number(cfg.whot?.handSize)||6
    }
  });
});

const httpServer=http.createServer(app);
const allowedOrigins=(process.env.CORS_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
const io=new Server(httpServer,{
  pingInterval:10000,pingTimeout:8000, // detect a dropped phone within ~18 s instead of ~45 s
  cors:{
    origin:(origin,callback)=>{
      if(!origin || allowedOrigins.includes('*') || allowedOrigins.length===0) return callback(null,true);
      if(allowedOrigins.includes(origin)) return callback(null,true);
      const siteOrigins=[process.env.SITE_URL,process.env.SITE_ORIGIN].filter(Boolean).map(v=>String(v).replace(/\/$/,''));
      if(siteOrigins.includes(origin)) return callback(null,true);
      if(origin.endsWith('.vercel.app')) return callback(null,true);
      return callback(new Error('CORS origin not allowed'));
    },
    methods:['GET','POST'],
    credentials:false
  },
  transports:['websocket','polling'],
  pingTimeout:20000,
  pingInterval:25000
});

const {startTurnTimers,normalizeTurnSeconds}=require('./realtime/turnTimer');
const pname=(room,i)=>(room.players[i]&&room.players[i].name)||`Player ${Number(i)+1}`;
function ludoEvict(room){
  rooms.spectatorsToEvict(room).forEach(sid=>{
    io.to(sid).emit('spectator-ended',{reason:room.visibility==='private'?'spectating-disabled':'link-only'});
    const sock=io.sockets.sockets.get(sid);if(sock){sock.leave(room.code);sock.data.role=null}
    rooms.removeSpectator(room,sid);
  });
}
function ludoFeed(room,text,kind){const item=rooms.addFeed(room,text,kind);io.to(room.code).emit('feed',item);}
function ludoHostOnly(socket,room){
  if(!room){socket.emit('error-msg','room-not-found');return false}
  if(rooms.playerIndexOf(room,socket.id)!==0){socket.emit('error-msg','not-host');return false}
  return true;
}
function ludoApplyAudienceOptions(socket,payload){
  const room=rooms.getRoom(payload&&payload.code);if(!ludoHostOnly(socket,room))return;
  rooms.applyOptions(room,{visibility:payload.visibility,chatEnabled:payload.chatEnabled});
  ludoEvict(room);
  const audience=rooms.audienceInfo(room,false);
  io.to(room.code).emit('watch-settings-updated',{visibility:room.visibility});
  io.to(room.code).emit('audience-info',audience);io.to(room.code).emit('audience-update',audience);
  socket.emit('audience-host',rooms.audienceInfo(room,true));
}
function ludoSpectatorJoin(socket,room,{name,watchToken,viewerId}){
  const viaToken=!!watchToken&&String(watchToken)===room.spectatorToken;
  const spectator=rooms.addSpectator(room,socket.id,{name,viewerId,viaToken,reservedNames:room.players.map(p=>p.name)});
  socket.data.role='spectator';socket.data.game='ludo';socket.data.roomCode=room.code;socket.data.spectatorName=spectator.name;socket.data.spectatorKey=spectator.key;
  socket.join(room.code);
  return spectator;
}
// A player reconnected with their token: the old (possibly half-open) socket is retired so it can never act or flag them offline.
function retireSocket(socketId,event){
  if(!socketId)return;
  const old=io.sockets.sockets.get(socketId);if(!old)return;
  old.emit(event);old.data.role=null;
  setTimeout(()=>{try{old.disconnect(true)}catch(e){}},80);
}
// Sends the current table to ONE player: state, the dice already rolled this turn and which of them are still unused.
function ludoSyncTo(socket,room){
  if(!room||!room.engine)return;
  socket.emit('game-ready',{code:room.code,state:room.engine.toJSON(),resync:true});
}
function ludoDoRoll(room){
  const {dice,options}=room.engine.rollDice();room.lastActivityAt=Date.now();
  ludoFeed(room,`${pname(room,room.engine.turn)} rolled ${Array.isArray(dice)?dice.join(' & '):dice}`,'roll');
  io.to(room.code).emit('dice-rolled',{dice,options,turn:room.engine.turn});
  emitRoomAudio(room,'ludo-dice');
  if(!options.canSplit&&!options.canCombine){const endResult=room.engine.endTurn();io.to(room.code).emit('turn-passed',{reason:'no-legal-moves',...endResult,state:room.engine.toJSON()});}
  return {dice,options};
}
function ludoDoMove(room,pIdx,move,value,mode){
  const result=room.engine.applyMove(move,value,mode);
  io.to(room.code).emit('move-applied',{move,value,...result,state:room.engine.toJSON()});room.lastActivityAt=Date.now();
  if(result.captured&&result.captured.length)ludoFeed(room,`${pname(room,pIdx)} captured ${result.captured.map(c=>c.color).join(' & ')}! 💥`,'capture');
  else if(result.finishedNow)ludoFeed(room,`${pname(room,pIdx)} brought a token home 🏠`,'home');
  if(result.gameOver)ludoFeed(room,`${pname(room,pIdx)} wins the match! 🏆`,'win');
  emitLudoResultAudio(room,pIdx,result);
  if(result.gameOver){
    const winnerIndex=Array.isArray(result.finishOrder)&&result.finishOrder.length?result.finishOrder[0]:pIdx;
    notifyGameResults(room,{winnerIndex,gameName:'Ludo'}).catch(()=>{});
  }
  const remaining=result.consumedDice||[];
  const allDiceConsumed=remaining.length>0&&remaining.every(v=>!v);
  if(allDiceConsumed||result.gameOver){
    const endResult=room.engine.endTurn();
    io.to(room.code).emit('turn-passed',{...endResult,state:room.engine.toJSON()});
    if(endResult.gameOver){
      const winnerIndex=Array.isArray(endResult.finishOrder)&&endResult.finishOrder.length?endResult.finishOrder[0]:pIdx;
      notifyGameResults(room,{winnerIndex,gameName:'Ludo'}).catch(()=>{});
    }else emitGameAudio(room,endResult.nextTurn,'ludo-turn');
  }
  return result;
}
// Plays a whole turn for a seat whose clock ran out: capture > enter the board > advance the leading token.
function ludoAutoPlay(room,seat){
  const eng=room.engine;if(!eng||eng.gameOver||eng.turn!==seat)return;
  if(!eng.dice){const r=ludoDoRoll(room);if(!r.options.canSplit&&!r.options.canCombine)return;}
  for(let guard=0;guard<4&&!eng.gameOver&&eng.turn===seat&&eng.dice;guard++){
    const opts=eng.legalOptions(),[d1,d2]=eng.dice,cand=[];
    (opts.split.d1||[]).forEach(m=>cand.push({move:m,value:d1,mode:'split'}));
    (opts.split.d2||[]).forEach(m=>cand.push({move:m,value:d2,mode:'split'}));
    if(!cand.length)(opts.combine||[]).forEach(m=>cand.push({move:m,value:d1+d2,mode:'combine'}));
    if(!cand.length){const end=eng.endTurn();io.to(room.code).emit('turn-passed',{...end,state:eng.toJSON()});if(!end.gameOver)emitGameAudio(room,end.nextTurn,'ludo-turn');return;}
    const tokens=eng.currentPlayer().tokens;
    const score=c=>{const pos=tokens[c.move.color][c.move.idx];let n=pos+c.value;if(pos===-1)n=0;let v=n;if(eng._wouldCapture&&eng._wouldCapture(c.move,c.value))v+=1000;if(pos===-1)v+=200;if(n===56)v+=400;return v;};
    cand.sort((a,b)=>score(b)-score(a));
    const best=cand[0];
    ludoDoMove(room,seat,best.move,best.value,best.mode);
  }
}

io.on('connection',socket=>{
  socket.on('create-room',({playerCount,name,color,whatsappToken,visibility,chatEnabled,turnSeconds})=>{
    const whatsapp=resolveWhatsAppGameToken(whatsappToken);
    const allowedPlayerCounts=configStore.get('rules')?.playerCounts||[2,3,4];
    if(!allowedPlayerCounts.includes(playerCount))return socket.emit('error-msg','player-count-disabled');
    const room=rooms.createRoom(playerCount,socket.id,{name,color,whatsappPhone:whatsapp?.phone||null});rooms.applyOptions(room,{visibility,chatEnabled});room.turnSeconds=normalizeTurnSeconds(turnSeconds);socket.data.role='player';socket.data.game='ludo';socket.data.roomCode=room.code;socket.join(room.code);
    socket.emit('room-created',{code:room.code,playerCount,turnSeconds:room.turnSeconds,joined:room.players.filter(p=>p.socketId).length,needed:playerCount,playerToken:room.players[0].playerToken,players:roomPlayers(room),audience:rooms.audienceInfo(room,true,true),whatsappBotNumber:String(process.env.WHATSAPP_PUBLIC_NUMBER||'').replace(/\D/g,'')});
    socket.emit('you-are-player',{index:0,playerToken:room.players[0].playerToken});
  });
  socket.on('join-room',({code,name,color,playerToken,whatsappToken})=>{
    const whatsapp=resolveWhatsAppGameToken(whatsappToken);
    const normalizedCode=String(code||'').trim().toUpperCase();
    const existingRoom=rooms.getRoom(normalizedCode);
    if(existingRoom&&playerToken){
      const resumed=rooms.reconnect(existingRoom,socket.id,playerToken);
      if(!resumed.error){
        const room=existingRoom;
        socket.data.role='player';socket.data.game='ludo';socket.data.roomCode=room.code;socket.join(room.code);
        retireSocket(resumed.replacedSocketId,'session-replaced');
        socket.emit('you-are-player',{index:resumed.index,playerToken:resumed.playerToken,reconnected:true});
        io.to(room.code).emit('player-connection',{index:resumed.index,name:room.players[resumed.index].name||`Player ${resumed.index+1}`,connected:true,players:roomPlayers(room)});
        socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:!!room.engine,players:roomPlayers(room),audience:rooms.audienceInfo(room,true,true),whatsappBotNumber:String(process.env.WHATSAPP_PUBLIC_NUMBER||'').replace(/\D/g,'')});
        if(room.engine)socket.emit('game-ready',{code:room.code,state:room.engine.toJSON()});
        return;
      }
    }
    const result=rooms.joinRoom(normalizedCode,socket.id,{name,color,whatsappPhone:whatsapp?.phone||null});if(result.error)return socket.emit('error-msg',result.error);
    const room=result.room;socket.data.role='player';socket.data.game='ludo';socket.data.roomCode=room.code;socket.join(room.code);
    const myIndex=rooms.playerIndexOf(room,socket.id);
    socket.emit('you-are-player',{index:myIndex,playerToken:rooms.playerTokenAt(room,myIndex)});
    io.to(room.code).emit('player-joined',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,players:roomPlayers(room)});
    if(room.engine)io.to(room.code).emit('game-ready',{code:room.code,state:room.engine.toJSON()});
  });
  socket.on('reconnect-player',({code,playerToken})=>{
    const room=rooms.getRoom(code);if(!room||!playerToken)return socket.emit('error-msg','room-not-found');
    const result=rooms.reconnect(room,socket.id,playerToken);if(result.error)return socket.emit('error-msg',result.error);
    retireSocket(result.replacedSocketId,'session-replaced');socket.data.role='player';socket.data.game='ludo';socket.data.roomCode=room.code;socket.join(room.code);socket.emit('you-are-player',{index:result.index,playerToken:result.playerToken,reconnected:true});io.to(room.code).emit('player-connection',{index:result.index,name:room.players[result.index].name||`Player ${result.index+1}`,connected:true,players:roomPlayers(room)});
    socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:!!room.engine,players:roomPlayers(room),audience:rooms.audienceInfo(room,true,true),whatsappBotNumber:String(process.env.WHATSAPP_PUBLIC_NUMBER||'').replace(/\D/g,'')});
    if(room.engine)socket.emit('game-ready',{code:room.code,state:room.engine.toJSON()});
  });
  socket.on('request-sync',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return;
    if(rooms.playerIndexOf(room,socket.id)<0)return;
    ludoSyncTo(socket,room);
  });
  socket.on('spectate-room',({code,watchToken,name,viewerId})=>{
    const room=rooms.getRoom(code);
    if(!room)return socket.emit('error-msg','room-not-found');
    const deny=rooms.spectateDenyReason(room,watchToken);
    if(deny)return socket.emit('error-msg',deny);
    if(room.spectators&&room.spectators.size>=200&&!room.spectators.has(socket.id))return socket.emit('error-msg','audience-full');
    const spectator=ludoSpectatorJoin(socket,room,{name,watchToken,viewerId});
    socket.emit('you-are-spectator',{code:room.code,started:!!room.engine,you:{key:spectator.key,name:spectator.name},audience:rooms.audienceInfo(room,false,true)});
    if(room.engine)socket.emit('game-ready',{code:room.code,state:room.engine.toJSON(),spectator:true});
    else socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:false,players:roomPlayers(room)});
    io.to(room.code).emit('audience-info',rooms.audienceInfo(room,false));
  });
  socket.on('set-room-visibility',({code,visibility})=>ludoApplyAudienceOptions(socket,{code,visibility}));
  socket.on('set-audience-options',payload=>ludoApplyAudienceOptions(socket,payload));
  socket.on('mute-viewer',({code,key,muted})=>{
    const room=rooms.getRoom(code);if(!ludoHostOnly(socket,room))return;
    rooms.setMuted(room,key,muted!==false);socket.emit('audience-host',rooms.audienceInfo(room,true));
  });
  function ludoChat(socket,{code,text}){
    const room=rooms.getRoom(code);if(!room)return socket.emit('error-msg','room-not-found');
    let role='spectator',name=socket.data.spectatorName||'Guest',key=socket.data.spectatorKey;
    const index=rooms.playerIndexOf(room,socket.id);
    if(index>=0){role=index===0?'host':'player';name=room.players[index].name||('Player '+(index+1));key=null;}
    else if(!room.spectators?.has(socket.id))return socket.emit('error-msg','not-in-room');
    const result=rooms.addChatMessage(room,socket.id,{name,role,text,key});
    if(result.error)return socket.emit('error-msg',result.error);
    io.to(room.code).emit('chat-message',result.message);
    return result;
  }
  socket.on('chat-message',payload=>{ludoChat(socket,payload)});

  socket.on('roll-dice',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    if(room.engine.dice){ludoSyncTo(socket,room);return;} // already rolled (e.g. before a refresh): hand the player their pending roll back
    try{ludoDoRoll(room);}catch(e){socket.emit('error-msg',e.message);}
  });
  socket.on('play-move',({code,move,value,mode})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    if(!room.engine.dice)return socket.emit('error-msg','roll the dice first');
    try{ludoDoMove(room,pIdx,move,value,mode);}catch(e){socket.emit('error-msg',e.message);}
  });
  socket.on('send-reaction',({code,reaction})=>{
    const room=rooms.getRoom(code);
    if(!room)return socket.emit('error-msg','room-not-found');
    if(!SAFE_REACTIONS.has(reaction))return;
    const pIdx=rooms.playerIndexOf(room,socket.id);
    if(pIdx<0)return;
    const now=Date.now();
    if(socket.data.lastReactionAt&&now-socket.data.lastReactionAt<500)return;
    socket.data.lastReactionAt=now;
    io.to(room.code).emit('reaction',{playerIndex:pIdx,name:room.players[pIdx].name||`Player ${pIdx+1}`,reaction});
  });
  socket.on('rematch',({code})=>{
    const result=rooms.requestRematch(code,socket.id);
    if(result.error)return socket.emit('error-msg',result.error);
    io.to(result.room.code).emit('rematch-status',{requested:result.requested,needed:result.room.playerCount});
    if(result.started)io.to(result.room.code).emit('game-rematch',{code:result.room.code,state:result.room.engine.toJSON()});
  });
  socket.on('end-turn',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    const options=room.engine.legalOptions();
    if(room.engine.dice&&(options.canSplit||options.canCombine))return socket.emit('error-msg','cannot-end-turn-yet');
    const endResult=room.engine.endTurn();io.to(room.code).emit('turn-passed',{...endResult,state:room.engine.toJSON()});
    if(!endResult.gameOver)emitGameAudio(room,endResult.nextTurn,'ludo-turn');
  });

  // Live audience compatibility/events. These aliases keep the spectator client
  // decoupled from the player-oriented event names used by the legacy UI.
  socket.on('watch-room',({code,watchToken,name,viewerId})=>{
    const room=rooms.getRoom(code);
    if(!room)return socket.emit('error-msg','room-not-found');
    const deny=rooms.spectateDenyReason(room,watchToken);
    if(deny)return socket.emit('error-msg',deny==='spectator-access-denied'?'watch-not-authorized':deny);
    if(room.spectators&&room.spectators.size>=200&&!room.spectators.has(socket.id))return socket.emit('error-msg','audience-full');
    const spectator=ludoSpectatorJoin(socket,room,{name,watchToken,viewerId});
    const audience=rooms.audienceInfo(room,false,true);
    socket.emit('spectator-ready',{code:room.code,status:room.engine?'LIVE':'WAITING',started:!!room.engine,visibility:room.visibility,you:{key:spectator.key,name:spectator.name},audience,state:room.engine?room.engine.toJSON():null,chat:room.chat.slice(-100)});
    if(!room.engine)socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:false,players:roomPlayers(room),audience});
    const live=rooms.audienceInfo(room,false);
    io.to(room.code).emit('audience-info',live);
    io.to(room.code).emit('audience-update',live);
  });

  socket.on('chat-send',payload=>{
    const result=ludoChat(socket,payload);if(!result||!result.message)return;
    const room=rooms.getRoom(payload.code);io.to(room.code).emit('audience-update',rooms.audienceInfo(room,false));
  });

  socket.on('audience-list',({code})=>{
    const room=rooms.getRoom(code);if(!room)return socket.emit('error-msg','room-not-found');
    socket.emit('audience-list',{audience:rooms.audienceInfo(room,false).audience||[]});
  });

  socket.on('reaction',({code,emoji,reaction})=>{
    const room=rooms.getRoom(code);if(!room)return socket.emit('error-msg','room-not-found');
    const allowed=new Set(['😂','🔥','😱','👏','💀','❤️','🎉','😭','😎','😳','Omo!','Sharp!']);
    const value=reaction||emoji;
    if(!allowed.has(value))return;
    const pIdx=rooms.playerIndexOf(room,socket.id);
    const isSpectator=room.spectators?.has(socket.id);
    if(pIdx<0&&!isSpectator)return socket.emit('error-msg','not-in-room');
    const now=Date.now();
    if(socket.data.lastLiveReactionAt&&now-socket.data.lastLiveReactionAt<300)return;
    socket.data.lastLiveReactionAt=now;
    room.reactionTotal=(room.reactionTotal||0)+1;
    const name=pIdx>=0?(room.players[pIdx].name||('Player '+(pIdx+1))):(socket.data.spectatorName||'Guest');
    io.to(room.code).emit('reaction',{emoji:value,reaction:value,name,total:room.reactionTotal});
    const audience=rooms.audienceInfo(room,false);
    io.to(room.code).emit('audience-info',audience);
    io.to(room.code).emit('audience-update',audience);
  });

  socket.on('set-watch-visibility',({code,visibility})=>ludoApplyAudienceOptions(socket,{code,visibility}));

  socket.on('regenerate-watch-link',({code})=>{
    const room=rooms.getRoom(code);if(!room)return socket.emit('error-msg','room-not-found');
    const index=rooms.playerIndexOf(room,socket.id);if(index!==0)return socket.emit('error-msg','not-host');
    const crypto=require('crypto');
    room.spectatorToken=crypto.randomBytes(18).toString('hex');
    io.to(room.code).emit('watch-link-updated',{visibility:room.visibility,watchToken:room.spectatorToken});
  });

  socket.on('disconnect',()=>{
    const roomCode=socket.data.roomCode;
    if(socket.data.role==='spectator'&&roomCode){
      const room=rooms.getRoom(roomCode);
      if(room&&rooms.removeSpectator(room,socket.id))io.to(room.code).emit('audience-info',rooms.audienceInfo(room,false));
      return;
    }
    const removed=rooms.removeSocket(socket.id);
    if(removed){
      io.to(removed.room.code).emit('player-connection',{index:removed.index,name:removed.player.name||`Player ${removed.index+1}`,connected:false,players:roomPlayers(removed.room)});
      io.to(removed.room.code).emit('audience-info',rooms.audienceInfo(removed.room,false));
    }
  });
});
setInterval(()=>rooms.sweepExpired(),60*1000);

startTurnTimers({
  rooms:()=>rooms.rooms.values(),
  active:room=>!!room.engine&&!room.engine.gameOver,
  signature:room=>`${room.engine.turn}:${room.engine.actionSeq||0}:${room.engine.finishOrder.length}`,
  seat:room=>room.engine.turn,
  emit:(room,_event,payload)=>io.to(room.code).emit('turn-timer',payload),
  autoPlay:ludoAutoPlay,
  announce:(room,text)=>ludoFeed(room,text,'timeout')
});

async function startServer(){
  try{
    if(persistence.enabled){
      await persistence.connect();
      await configStore.hydrateFromPersistence(persistence);
      console.log(`MongoDB connected: ${persistence.dbName}`);
    }
  }catch(err){
    console.error('MongoDB connection failed:',err.message);
    if(process.env.REQUIRE_MONGODB==='true')process.exit(1);
  }
  httpServer.listen(PORT,()=>console.log(`CodePlay Ludo server listening on :${PORT}`));
}
module.exports={httpServer,io,rooms,configStore,app,persistence,users,sessions,startServer};

// Register Whot Socket.IO handlers only after index exports are initialized.
require('./whotServer');

startServer();
