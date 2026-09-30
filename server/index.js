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

const PORT=process.env.PORT||3001;
const configStore=new ConfigStore();
const rooms=new RoomManager(configStore);
const persistence=new MongoPersistence();
const users=new UserStore(persistence);
const sessions=new SessionStore(persistence);

const app=express();
const {router:adminRouter}=createAdminRoutes(configStore);
app.use('/api/admin',adminRouter);
app.use(createMetaWhatsAppApp({users}));
app.use(createBotApp({users,sessions}));
app.use(createWahaApp({users}));
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
  socket.on('create-room',({playerCount,name,color})=>{
    const allowedPlayerCounts=configStore.get('rules')?.playerCounts||[2,3,4];
    if(!allowedPlayerCounts.includes(playerCount))return socket.emit('error-msg','player-count-disabled');
    const room=rooms.createRoom(playerCount,socket.id,{name,color});socket.join(room.code);
    socket.emit('room-created',{code:room.code,playerCount,joined:room.players.filter(p=>p.socketId).length,needed:playerCount,playerToken:room.players[0].playerToken});
    socket.emit('you-are-player',{index:0,playerToken:room.players[0].playerToken});
  });
  socket.on('join-room',({code,name,color})=>{
    const result=rooms.joinRoom(code,socket.id,{name,color});if(result.error)return socket.emit('error-msg',result.error);
    const room=result.room;socket.join(room.code);
    const myIndex=rooms.playerIndexOf(room,socket.id);
    socket.emit('you-are-player',{index:myIndex,playerToken:rooms.playerTokenAt(room,myIndex)});
    io.to(room.code).emit('player-joined',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount});
    if(room.engine)io.to(room.code).emit('game-ready',{code:room.code,state:room.engine.toJSON()});
  });
  socket.on('reconnect-player',({code,playerToken})=>{
    const room=rooms.getRoom(code);if(!room||!playerToken)return socket.emit('error-msg','room-not-found');
    const result=rooms.reconnect(room,socket.id,playerToken);if(result.error)return socket.emit('error-msg',result.error);
    socket.join(room.code);socket.emit('you-are-player',{index:result.index,playerToken:result.playerToken,reconnected:true});
    socket.emit('room-status',{code:room.code,joined:room.players.filter(p=>p.socketId).length,needed:room.playerCount,started:!!room.engine});
    if(room.engine)socket.emit('game-ready',{code:room.code,state:room.engine.toJSON()});
  });
  socket.on('roll-dice',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    try{
      const {dice,options}=room.engine.rollDice();
      io.to(room.code).emit('dice-rolled',{dice,options,turn:room.engine.turn});
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
      const remaining=result.consumedDice||[];
      const allDiceConsumed=remaining.length>0&&remaining.every(v=>!v);
      if(allDiceConsumed||result.gameOver){
        const endResult=room.engine.endTurn();
        io.to(room.code).emit('turn-passed',{...endResult,state:room.engine.toJSON()});
      }
    }catch(e){socket.emit('error-msg',e.message);}
  });
  socket.on('end-turn',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('error-msg','room not ready');
    const pIdx=rooms.playerIndexOf(room,socket.id);if(pIdx!==room.engine.turn)return socket.emit('error-msg','not your turn');
    const options=room.engine.legalOptions();
    if(room.engine.dice&&(options.canSplit||options.canCombine))return socket.emit('error-msg','cannot-end-turn-yet');
    const endResult=room.engine.endTurn();io.to(room.code).emit('turn-passed',{...endResult,state:room.engine.toJSON()});
  });
  socket.on('disconnect',()=>rooms.removeSocket(socket.id));
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
startServer();

module.exports={httpServer,io,rooms,configStore,app,persistence,users,sessions,startServer};
