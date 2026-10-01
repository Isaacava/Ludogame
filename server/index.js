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

io.on('connection',socket=>{
  socket.on('create-room',({playerCount,name,color,whatsappToken})=>{
    const whatsapp=resolveWhatsAppGameToken(whatsappToken);
    const allowedPlayerCounts=configStore.get('rules')?.playerCounts||[2,3,4];
    if(!allowedPlayerCounts.includes(playerCount))return socket.emit('error-msg','player-count-disabled');
    const room=rooms.createRoom(playerCount,socket.id,{name,color,whatsappPhone:whatsapp?.phone||null});socket.join(room.code);
    socket.emit('room-created',{code:room.code,playerCount,joined:room.players.filter(p=>p.socketId).length,needed:playerCount,playerToken:room.players[0].playerToken,players:roomPlayers(room)});
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
        socket.join(room.code);
        socket.emit('you-are-player',{index:resumed.index,playerToken:resumed.playerToken,reconnected:true});
        io.to(room.code).emit('player-connection',{index:resumed.index,name:room.players[resumed.index].name||`Player ${resumed.index+1}`,connected:true,players:roomPlayers(room)});
        socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:!!room.engine,players:roomPlayers(room)});
        if(room.engine)socket.emit('game-ready',{code:room.code,state:room.engine.toJSON()});
        return;
      }
    }
    const result=rooms.joinRoom(normalizedCode,socket.id,{name,color,whatsappPhone:whatsapp?.phone||null});if(result.error)return socket.emit('error-msg',result.error);
    const room=result.room;socket.join(room.code);
    const myIndex=rooms.playerIndexOf(room,socket.id);
    socket.emit('you-are-player',{index:myIndex,playerToken:rooms.playerTokenAt(room,myIndex)});
    io.to(room.code).emit('player-joined',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,players:roomPlayers(room)});
    if(room.engine)io.to(room.code).emit('game-ready',{code:room.code,state:room.engine.toJSON()});
  });
  socket.on('reconnect-player',({code,playerToken})=>{
    const room=rooms.getRoom(code);if(!room||!playerToken)return socket.emit('error-msg','room-not-found');
    const result=rooms.reconnect(room,socket.id,playerToken);if(result.error)return socket.emit('error-msg',result.error);
    socket.join(room.code);socket.emit('you-are-player',{index:result.index,playerToken:result.playerToken,reconnected:true});io.to(room.code).emit('player-connection',{index:result.index,name:room.players[result.index].name||`Player ${result.index+1}`,connected:true,players:roomPlayers(room)});
    socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:!!room.engine,players:roomPlayers(room)});
    if(room.engine)socket.emit('game-ready',{code:room.code,state:room.engine.toJSON()});
  });
  socket.on('roll-dice',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    try{
      const {dice,options}=room.engine.rollDice();
      io.to(room.code).emit('dice-rolled',{dice,options,turn:room.engine.turn});
      emitRoomAudio(room,'ludo-dice');
      if(!options.canSplit&&!options.canCombine){const endResult=room.engine.endTurn();io.to(room.code).emit('turn-passed',{reason:'no-legal-moves',...endResult,state:room.engine.toJSON()});}
    }catch(e){socket.emit('error-msg',e.message);}
  });
  socket.on('play-move',({code,move,value,mode,isLastMoveThisTurn})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    if(!room.engine.dice)return socket.emit('error-msg','roll the dice first');
    try{
      const result=room.engine.applyMove(move,value,mode);
      io.to(room.code).emit('move-applied',{move,value,...result,state:room.engine.toJSON()});
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
    }catch(e){socket.emit('error-msg',e.message);}
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
  socket.on('disconnect',()=>{
    const removed=rooms.removeSocket(socket.id);
    if(removed){
      io.to(removed.room.code).emit('player-connection',{index:removed.index,name:removed.player.name||`Player ${removed.index+1}`,connected:false,players:roomPlayers(removed.room)});
    }
  });
});
setInterval(()=>rooms.sweepExpired(),60*1000);

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
