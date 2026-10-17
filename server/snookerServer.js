'use strict';
// Snooker over Socket.IO. The server runs the physics and rules (server/engine/snookerEngine.js); clients send an aim
// angle + power, and receive the recorded frames of the shot so every screen plays back the identical result.
const { io } = require('./index');
const { SnookerRoomManager, normCode } = require('./rooms/snookerRoomManager');
const { chooseShot } = require('./engine/snookerEngine');

const rooms = new SnookerRoomManager();
const channel = room => `SNOOKER_${room.code}`;
const ABANDON_MS = 4 * 60 * 1000;           // a friends game: opponent offline this long and you win
const BOT_THINK_MS = 1100;

function retireSocket(socketId) {
  if (!socketId) return; const old = io.sockets.sockets.get(socketId); if (!old) return;
  old.emit('snooker:session-replaced'); old.data.role = null; setTimeout(() => { try { old.disconnect(true); } catch (e) { /* gone */ } }, 80);
}
function view(room, index) {
  return { code: room.code, you: index, mode: room.mode, level: room.level, started: !!room.engine, needed: 2, joined: room.players.filter(p => p.bot || p.socketId).length,
    players: room.players.map((p, i) => ({ index: i, name: p.name, connected: !!p.socketId || p.bot, bot: !!p.bot })), turnSeconds: room.turnSeconds, timeLeft: rooms.secondsLeft(room),
    locked: !!(room.versus || room.tournament), state: room.engine ? room.engine.stateFor(index) : null };
}
function emitState(room) { room.players.forEach((p, i) => { if (p.socketId) io.to(p.socketId).emit('snooker:state', view(room, i)); }); }
function emitTo(room, event, payload) { room.players.forEach(p => { if (p.socketId) io.to(p.socketId).emit(event, payload); }); }
function guard(socket, code) {
  const room = rooms.getRoom(normCode(code)); if (!room) { socket.emit('snooker:error', { message: 'room-not-found' }); return null; }
  const index = rooms.indexOf(room, socket.id); if (index < 0) { socket.emit('snooker:error', { message: 'not-in-room' }); return null; }
  if (!room.engine) { socket.emit('snooker:error', { message: 'game-not-started' }); return null; } return { room, index };
}

// ---- the computer's turn ----
function scheduleBot(room) {
  const g = room.engine; if (!g || g.over || room.mode !== 'computer' || g.turn !== 1) return;
  const wait = Math.max(0, (room.animUntil || 0) - Date.now()) + BOT_THINK_MS;
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => {
    try {
      if (!rooms.rooms.has(room.code) || g.over || g.turn !== 1) return;
      if (g.cueInHand) { const p = g.defaultCuePosition(); g.place(1, p.x, p.y); emitState(room); }
      const c = chooseShot(g, room.level); playShot(room, 1, c.angle, c.power);
    } catch (err) { console.error('[snooker] bot', err && err.message); }
  }, wait);
}
function playShot(room, index, angle, power) {
  const g = room.engine, r = g.shoot(index, angle, Math.max(0, Math.min(1, power)));
  if (r.error) return r;
  room.lastActivityAt = Date.now(); room.animUntil = Date.now() + Math.round(r.sim.seconds * 1000) + 600; rooms.resetClock(room, room.animUntil - Date.now());
  // each player gets the recorded frames plus the table state to show once the animation has finished
  room.players.forEach((p, i) => { if (p.socketId) io.to(p.socketId).emit('snooker:shot', { by: index, angle, power, sim: r.sim, result: r.result, view: view(room, i), playMs: room.animUntil - Date.now() }); });
  scheduleBot(room); return { ok: true };
}

io.on('connection', socket => {
  socket.on('snooker:create-room', ({ name, mode, level, turnSeconds } = {}) => {
    const m = mode === 'computer' ? 'computer' : 'friends';
    const room = rooms.createRoom(socket.id, { name }, { mode: m, level, turnSeconds });
    socket.data.role = 'player'; socket.data.game = 'snooker'; socket.data.roomCode = room.code; socket.join(channel(room));
    socket.emit('snooker:created', { ...view(room, 0), playerToken: room.players[0].playerToken });
    if (room.engine) { emitState(room); scheduleBot(room); }
  });
  socket.on('snooker:join-room', ({ code, name } = {}) => {
    const res = rooms.joinRoom(code, socket.id, { name }); if (res.error) return socket.emit('snooker:error', { message: res.error });
    const { room } = res; socket.data.role = 'player'; socket.data.game = 'snooker'; socket.data.roomCode = room.code; socket.join(channel(room));
    socket.emit('snooker:joined', { ...view(room, res.index), playerToken: res.playerToken }); emitState(room);
  });
  socket.on('snooker:reconnect', ({ code, playerToken } = {}) => {
    const room = rooms.getRoom(code); if (!room) return socket.emit('snooker:error', { message: 'room-not-found' });
    const before = !!room.engine; const res = rooms.reconnect(room, socket.id, playerToken); if (res.error) return socket.emit('snooker:error', { message: res.error });
    retireSocket(res.replacedSocketId); socket.data.role = 'player'; socket.data.game = 'snooker'; socket.data.roomCode = room.code; socket.join(channel(room));
    socket.emit('snooker:joined', { ...view(room, res.index), playerToken }); emitState(room);
    if (!before && room.engine) scheduleBot(room);
  });
  socket.on('snooker:sync', ({ code } = {}) => { const g = guard(socket, code); if (g) socket.emit('snooker:state', view(g.room, g.index)); });
  socket.on('snooker:place', ({ code, x, y } = {}) => {
    const g = guard(socket, code); if (!g) return; if (Date.now() < g.room.animUntil) return socket.emit('snooker:error', { message: 'shot-in-progress' });
    const r = g.room.engine.place(g.index, Number(x), Number(y)); if (r.error) return socket.emit('snooker:error', { message: r.error });
    g.room.lastActivityAt = Date.now(); emitState(g.room);
  });
  socket.on('snooker:shoot', ({ code, angle, power } = {}) => {
    const g = guard(socket, code); if (!g) return; if (Date.now() < g.room.animUntil) return socket.emit('snooker:error', { message: 'shot-in-progress' });
    const r = playShot(g.room, g.index, Number(angle), Number(power)); if (r.error) socket.emit('snooker:error', { message: r.error });
  });
  socket.on('snooker:aim', ({ code, angle, power, x, y } = {}) => { // lets the opponent watch the cue line (cheap, rate limited)
    const g = guard(socket, code); if (!g || g.room.engine.turn !== g.index) return;
    const now = Date.now(); if (socket.data.lastAim && now - socket.data.lastAim < 70) return; socket.data.lastAim = now;
    g.room.players.forEach((p, i) => { if (i !== g.index && p.socketId) io.to(p.socketId).emit('snooker:aim', { angle: Number(angle), power: Number(power), x: Number(x), y: Number(y) }); });
  });
  socket.on('snooker:resign', ({ code } = {}) => { const g = guard(socket, code); if (!g) return; if (g.room.engine.resign(g.index).ok) { emitState(g.room); } });
  socket.on('snooker:rematch', ({ code } = {}) => {
    const room = rooms.getRoom(code); if (room && (room.versus || room.tournament)) return socket.emit('snooker:error', { message: 'rematch-not-available-in-versus' });
    const out = rooms.requestRematch(code, socket.id); if (out.error) return socket.emit('snooker:error', { message: out.error });
    emitState(out.room); if (out.started) scheduleBot(out.room);
  });
  socket.on('disconnect', () => {
    const d = rooms.disconnect(socket.id); if (!d) return;
    d.room.players.forEach((p, i) => { if (i !== d.index && p.socketId) io.to(p.socketId).emit('snooker:presence', { index: d.index, connected: false }); });
  });
});

// shot clock + abandoned games (versus and tournament rooms are judged by the referee in index.js)
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.rooms.values()) {
    const g = room.engine; if (!g || g.over) continue;
    if (room.deadline && now > room.deadline && now > room.animUntil) {
      const t = g.timeout(g.turn); if (t.ok) { room.animUntil = 0; rooms.resetClock(room, 0); emitTo(room, 'snooker:notice', { type: 'timeout', result: t.result }); emitState(room); scheduleBot(room); }
    }
    if (!room.versus && !room.tournament) {
      const gone = room.players.findIndex(p => !p.bot && !p.socketId && p.disconnectedAt && now - p.disconnectedAt > ABANDON_MS);
      if (gone >= 0 && room.players.length === 2) { g.resign(gone); emitState(room); }
    }
  }
}, 1000);
setInterval(() => rooms.sweepExpired(), 60 * 1000);

module.exports = { rooms };
