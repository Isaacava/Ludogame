'use strict';
const {io,configStore}=require('./index');
const {WhotRoomManager}=require('./rooms/whotRoomManager');

const rooms=new WhotRoomManager(configStore);
const reactions=new Set(['😂','🔥','👏','😭','Omo!','Sharp!']);
const humanRoom=(room)=>room.players.map((p,index)=>({index,name:p.name||`Player ${index+1}`,connected:!!p.socketId,bot:!!p.bot}));

function emitState(room,extra={}){
  if(!room.engine)return;
  room.players.forEach((p,index)=>{
    if(p.bot||!p.socketId)return;
    io.to(p.socketId).emit('whot:state',{code:room.code,index,playerToken:p.playerToken,state:room.engine.stateFor(index),...extra});
  });
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
        emitState(room,{drawn:result.cards.map(c=>c.id),bot:true});
      }else{
        const cardIndex=room.engine.players[index].cards.findIndex(c=>c.id===action.cardId);
        const result=room.engine.playCard(index,cardIndex,action.call);
        emitState(room,{played:result.card.id,resolution:result.resolution,bot:true});
      }
    }catch(err){emitState(room,{botError:err.message});}
    if(!room.engine.gameOver)scheduleBot(room);
  },650);
}

io.on('connection',socket=>{
  socket.on('whot:create-room',({playerCount,name,mode})=>{
    const count=Number(playerCount);
    if(![2,3,4].includes(count))return socket.emit('whot:error',{message:'player-count-invalid'});
    if(mode==='computer'&&count!==2)return socket.emit('whot:error',{message:'computer-mode-supports-2-players'});
    const room=rooms.createRoom(count,socket.id,{name},mode==='computer'?'computer':'friends');
    socket.join(`WHOT_${room.code}`);
    socket.emit('whot:created',{code:room.code,index:0,playerToken:room.players[0].playerToken,joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(0):null});
    if(room.engine){emitState(room);scheduleBot(room)}else emitRoomWaiting(room,'Waiting for players…');
  });
  socket.on('whot:join-room',({code,name})=>{
    const result=rooms.joinRoom(code,socket.id,{name});
    if(result.error)return socket.emit('whot:error',{message:result.error});
    const room=result.room,index=rooms.playerIndexOf(room,socket.id);socket.join(`WHOT_${room.code}`);
    socket.emit('whot:joined',{code:room.code,index,playerToken:rooms.playerTokenAt(room,index),joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(index):null});
    if(room.engine)emitState(room);else emitRoomWaiting(room,'Waiting for players…');
  });
  socket.on('whot:reconnect',({code,playerToken})=>{
    const room=rooms.getRoom(code);if(!room)return socket.emit('whot:error',{message:'room-not-found'});
    const result=rooms.reconnect(room,socket.id,playerToken);if(result.error)return socket.emit('whot:error',{message:result.error});
    const {index}=result;socket.join(`WHOT_${room.code}`);
    socket.emit('whot:joined',{code:room.code,index,playerToken:result.playerToken,joined:room.players.filter(p=>!p.bot&&p.socketId).length,needed:room.playerCount,started:!!room.engine,state:room.engine?room.engine.stateFor(index):null,reconnected:true});
    emitState(room);if(room.engine&&!room.engine.gameOver)scheduleBot(room);
  });
  socket.on('whot:play-card',({code,cardId,call})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('whot:error',{message:'room-not-ready'});
    const index=rooms.playerIndexOf(room,socket.id);if(index<0)return socket.emit('whot:error',{message:'not-in-room'});
    if(index!==room.engine.turn)return socket.emit('whot:error',{message:'not-your-turn'});
    const cardIndex=room.engine.players[index].cards.findIndex(c=>c.id===cardId);if(cardIndex<0)return socket.emit('whot:error',{message:'card-not-found'});
    try{const result=room.engine.playCard(index,cardIndex,call);emitState(room,{played:result.card.id,resolution:result.resolution});if(!room.engine.gameOver)scheduleBot(room)}catch(err){socket.emit('whot:error',{message:err.message})}
  });
  socket.on('whot:draw',({code})=>{
    const room=rooms.getRoom(code);if(!room||!room.engine)return socket.emit('whot:error',{message:'room-not-ready'});
    const index=rooms.playerIndexOf(room,socket.id);if(index<0)return socket.emit('whot:error',{message:'not-in-room'});
    if(index!==room.engine.turn)return socket.emit('whot:error',{message:'not-your-turn'});
    try{const result=room.engine.draw(index);emitState(room,{drawn:result.cards.map(c=>c.id)});scheduleBot(room)}catch(err){socket.emit('whot:error',{message:err.message})}
  });
  socket.on('whot:reaction',({code,reaction})=>{
    if(!reactions.has(reaction))return;
    const room=rooms.getRoom(code),index=room&&rooms.playerIndexOf(room,socket.id);if(!room||index<0)return;
    const now=Date.now();if(socket.data.whotReactionAt&&now-socket.data.whotReactionAt<500)return;socket.data.whotReactionAt=now;
    io.to(`WHOT_${room.code}`).emit('whot:reaction',{name:room.players[index].name||`Player ${index+1}`,reaction});
  });
  socket.on('whot:rematch',({code})=>{
    const result=rooms.requestRematch(code,socket.id);if(result.error)return socket.emit('whot:error',{message:result.error});
    io.to(`WHOT_${result.room.code}`).emit('whot:rematch-status',{requested:result.requested,needed:result.room.players.filter(p=>!p.bot).length});
    if(result.started){emitState(result.room);scheduleBot(result.room);io.to(`WHOT_${result.room.code}`).emit('whot:rematch',{state:result.room.engine.toJSON()})}
  });
  socket.on('disconnect',()=>{
    const removed=rooms.removeSocket(socket.id);if(!removed)return;
    const room=removed.room;io.to(`WHOT_${room.code}`).emit('whot:status',{roomCode:room.code,waiting:false,players:humanRoom(room),text:`${removed.player.name||'Player'} disconnected`});
  });
});

setInterval(()=>rooms.sweepExpired(),60*1000);
module.exports={rooms};
