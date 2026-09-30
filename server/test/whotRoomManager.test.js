'use strict';
const assert=require('assert');
const {WhotRoomManager}=require('../rooms/whotRoomManager');

(function friendsRoomsSupport2to4Players(){
  const manager=new WhotRoomManager({get:()=>({whot:{playerCounts:[2,3,4],handSize:6}})});
  for(const count of [2,3,4]){
    const room=manager.createRoom(count,'socket-host-'+count,{name:'Host '+count},'friends');
    assert.equal(room.playerCount,count);
    assert.equal(room.players.length,1);
    for(let i=1;i<count;i++){
      const joined=manager.joinRoom(room.code,'socket-'+count+'-'+i,{name:'Player '+(i+1)});
      assert(!joined.error,'player '+(i+1)+' should join a '+count+'-player room');
    }
    assert.equal(room.players.length,count);
    assert(room.engine,count+'-player room should start when full');
    assert.equal(room.engine.playerCount,count);
    assert.equal(room.engine.players.length,count);
  }
})();

(function computerRoomsSupport2to4Players(){
  const manager=new WhotRoomManager({get:()=>({whot:{playerCounts:[2,3,4],handSize:6}})});
  for(const count of [2,3,4]){
    const room=manager.createRoom(count,'human-'+count,{name:'Human '+count},'computer');
    assert.equal(room.playerCount,count);
    assert.equal(room.players.length,count);
    assert.equal(room.players.filter(p=>p.bot).length,count-1);
    assert(room.engine);
    assert.equal(room.engine.playerCount,count);
    assert.equal(room.engine.players.length,count);
  }
})();

(function reconnectPreservesSeat(){
  const manager=new WhotRoomManager({get:()=>({whot:{playerCounts:[2,3,4]}})});
  const room=manager.createRoom(3,'a',{name:'A'},'friends');
  const token=room.players[0].playerToken;
  const joined=manager.joinRoom(room.code,'b',{name:'B'}); assert(!joined.error);
  const resumed=manager.reconnect(room,'a2',token);
  assert(!resumed.error);
  assert.equal(resumed.index,0);
  assert.equal(room.players[0].socketId,'a2');
})();

console.log('whotRoomManager.test.js passed');
