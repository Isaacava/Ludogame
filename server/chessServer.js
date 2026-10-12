'use strict';
const { io } = require('./index');
const { ChessRoomManager } = require('./rooms/chessRoomManager');
const { registerGameManager } = require('./bot/gameControl');

const rooms = new ChessRoomManager();
registerGameManager('chess', rooms);

const ABANDON_TIMED_MS = 90 * 1000;        // opponent offline this long in a timed game: you win
const ABANDON_CASUAL_MS = 4 * 60 * 1000;   // ... in a game without a clock
const FIRST_MOVE_MS = 70 * 1000;           // nobody has moved after this long: the game is aborted
const reactions = new Set(['😂', '🔥', '👏', '😭', 'Omo!', 'Sharp!']);
const channel = room => `CHESS_${room.code}`;
const nameOf = (room, color) => { const i = rooms.indexOfColor(room, color); return (room.players[i] && room.players[i].name) || (color === 'w' ? 'White' : 'Black'); };

function retireSocket(socketId) {
  if (!socketId) return;
  const old = io.sockets.sockets.get(socketId); if (!old) return;
  old.emit('chess:session-replaced'); old.data.role = null;
  setTimeout(() => { try { old.disconnect(true); } catch (e) { /* already gone */ } }, 80);
}
function playersInfo(room) {
  return room.players.map((p, i) => ({ index: i, name: p.name, color: room.colors ? room.colors[i] : null, connected: !!p.socketId }));
}
function audio(room, cue) {
  const send = sid => io.to(sid).emit('game-audio', { game: 'chess', cue });
  room.players.forEach(p => { if (p.socketId) send(p.socketId); });
  if (room.spectators) room.spectators.forEach((_, sid) => send(sid));
}
function cueFor(entry, state) {
  if (state.result) return 'chess-end';
  if (state.check) return 'chess-check';
  if (entry.promotion) return 'chess-promote';
  if (entry.flags && /[kq]/.test(entry.flags)) return 'chess-castle';
  if (entry.captured) return 'chess-capture';
  return 'chess-move';
}
const REASON = { checkmate: 'checkmate', resign: 'resignation', timeout: 'time', 'timeout-draw': 'time (no mating material)', stalemate: 'stalemate', insufficient: 'insufficient material', repetition: 'repetition', 'fifty-move': 'the fifty-move rule', agreement: 'agreement', abandoned: 'abandonment', aborted: 'abort' };
function resultText(room) {
  const r = room.engine && room.engine.result; if (!r) return '';
  if (r.reason === 'aborted') return 'Game aborted';
  if (!r.winner) return 'Draw by ' + (REASON[r.reason] || r.reason);
  return `${nameOf(room, r.winner)} wins by ${REASON[r.reason] || r.reason}`;
}

// One authoritative state for everybody; each player also learns which colour they hold.
function emitState(room, extra = {}) {
  if (!room.engine) return;
  room.lastActivityAt = Date.now();
  const now = Date.now(), state = room.engine.toJSON(now), players = playersInfo(room);
  const base = { code: room.code, state, players, serverNow: now, resultText: resultText(room), rematch: room.rematchVotes ? Array.from(room.rematchVotes) : [], ...extra };
  room.players.forEach((p, index) => { if (p.socketId) io.to(p.socketId).emit('chess:state', { ...base, index, color: room.colors[index] }); });
  if (room.spectators) room.spectators.forEach((_, sid) => io.to(sid).emit('chess:state', { ...base, index: -1, spectator: true }));
}
function feed(room, text, kind) { const item = rooms.addFeed(room, text, kind); io.to(channel(room)).emit('chess:feed', item); }
function evictSpectators(room) {
  rooms.spectatorsToEvict(room).forEach(sid => {
    io.to(sid).emit('chess:spectator-ended', { reason: room.visibility === 'private' ? 'spectating-disabled' : 'link-only' });
    const sock = io.sockets.sockets.get(sid); if (sock) { sock.leave(channel(room)); sock.data.role = null; }
    rooms.removeSpectator(room, sid);
  });
}
function hostOnly(socket, room) {
  if (!room) { socket.emit('chess:error', { message: 'room-not-found' }); return false; }
  if (rooms.playerIndexOf(room, socket.id) !== 0) { socket.emit('chess:error', { message: 'not-host' }); return false; }
  return true;
}
function afterGameEnds(room) {
  feed(room, resultText(room), 'result');
  audio(room, 'chess-end');
}

io.on('connection', socket => {
  const seat = code => {
    const room = rooms.getRoom(code); if (!room) { socket.emit('chess:error', { message: 'room-not-found' }); return {}; }
    const index = rooms.playerIndexOf(room, socket.id);
    if (index < 0) { socket.emit('chess:error', { message: 'not-in-room' }); return {}; }
    return { room, index, color: room.colors ? room.colors[index] : null };
  };

  socket.on('chess:create-room', ({ name, color, base, inc, visibility, chatEnabled }) => {
    const room = rooms.createRoom(socket.id, { name: String(name || 'Player 1').slice(0, 24) }, { color, base, inc });
    rooms.applyOptions(room, { visibility, chatEnabled });
    socket.data.role = 'player'; socket.data.game = 'chess'; socket.data.roomCode = room.code;
    socket.join(channel(room));
    socket.emit('chess:created', { code: room.code, index: 0, playerToken: room.players[0].playerToken, timeControl: room.tc, colorPref: room.colorPref, players: playersInfo(room), audience: rooms.audienceInfo(room, true, true) });
  });

  socket.on('chess:join-room', ({ code, name, playerToken }) => {
    const existing = rooms.getRoom(code);
    if (!existing) return socket.emit('chess:error', { message: 'room-not-found' });
    if (playerToken) { // resuming a seat
      const resumed = rooms.reconnect(existing, socket.id, playerToken);
      if (!resumed.error) return finishJoin(existing, resumed.index, resumed.replacedSocketId);
    }
    const res = rooms.joinRoom(code, socket.id, { name: String(name || 'Player 2').slice(0, 24) });
    if (res.error) return socket.emit('chess:error', { message: res.error });
    finishJoin(res.room, res.room.players.length - 1, null, true);
  });
  socket.on('chess:reconnect', ({ code, playerToken }) => {
    const room = rooms.getRoom(code); if (!room) return socket.emit('chess:error', { message: 'room-not-found' });
    const res = rooms.reconnect(room, socket.id, playerToken);
    if (res.error) return socket.emit('chess:error', { message: res.error });
    finishJoin(room, res.index, res.replacedSocketId);
  });
  function finishJoin(room, index, replacedSocketId, fresh) {
    retireSocket(replacedSocketId);
    socket.data.role = 'player'; socket.data.game = 'chess'; socket.data.roomCode = room.code;
    socket.join(channel(room));
    socket.emit('chess:joined', { code: room.code, index, playerToken: room.players[index].playerToken, timeControl: room.tc, colorPref: room.colorPref, players: playersInfo(room), audience: rooms.audienceInfo(room, index === 0, true), started: !!room.engine });
    io.to(channel(room)).emit('chess:audience-info', rooms.audienceInfo(room, false));
    if (room.engine) {
      emitState(room, fresh ? { started: true } : { reconnected: index });
      if (fresh) { audio(room, 'chess-start'); feed(room, `${nameOf(room, 'w')} (White) vs ${nameOf(room, 'b')} (Black)`, 'start'); }
    }
  }

  socket.on('chess:move', ({ code, from, to, promotion }) => {
    const { room, color, index } = seat(code); if (!room) return;
    if (!room.engine) return socket.emit('chess:error', { message: 'game-not-started' });
    const res = room.engine.move(color, { from, to, promotion }, Date.now());
    if (!res.ok) { socket.emit('chess:error', { message: res.error }); return emitState(room, { rejected: true }); }
    room.lastMoveAt = Date.now();
    const state = room.engine.toJSON(Date.now());
    emitState(room, { move: res.move, actor: index });
    audio(room, cueFor(res.move, state));
    feed(room, `${room.players[index].name} played ${res.move.san}`, state.check ? 'check' : 'move');
    if (res.over) afterGameEnds(room);
  });

  socket.on('chess:resign', ({ code }) => {
    const { room, color } = seat(code); if (!room || !room.engine) return;
    if (room.engine.moves.length < 2) { room.engine.abort(); } else room.engine.resign(color);
    emitState(room, { ended: true }); afterGameEnds(room);
  });
  socket.on('chess:offer-draw', ({ code }) => {
    const { room, color } = seat(code); if (!room || !room.engine) return;
    if (!room.engine.offerDraw(color)) return socket.emit('chess:error', { message: 'cannot-offer-draw' });
    emitState(room, { event: 'draw-offered', by: color });
  });
  socket.on('chess:respond-draw', ({ code, accept }) => {
    const { room, color } = seat(code); if (!room || !room.engine) return;
    if (!room.engine.respondDraw(color, !!accept)) return;
    emitState(room, { event: accept ? 'draw-accepted' : 'draw-declined' });
    if (accept) afterGameEnds(room);
  });
  socket.on('chess:rematch', ({ code }) => {
    const out = rooms.requestRematch(code, socket.id);
    if (out.error) return socket.emit('chess:error', { message: out.error });
    emitState(out.room, out.started ? { event: 'rematch-started' } : { event: 'rematch-requested' });
    if (out.started) { audio(out.room, 'chess-start'); feed(out.room, `Rematch — ${nameOf(out.room, 'w')} is White`, 'start'); }
  });
  socket.on('chess:request-sync', ({ code }) => {
    const room = rooms.getRoom(code); if (!room || !room.engine) return;
    const index = rooms.playerIndexOf(room, socket.id);
    const now = Date.now(), base = { code: room.code, state: room.engine.toJSON(now), players: playersInfo(room), serverNow: now, resultText: resultText(room), resync: true, rematch: Array.from(room.rematchVotes || []) };
    socket.emit('chess:state', index >= 0 ? { ...base, index, color: room.colors[index] } : { ...base, index: -1, spectator: true });
  });

  // ---------------- audience ----------------
  socket.on('chess:spectate', ({ code, watchToken, name, viewerId }) => {
    const room = rooms.getRoom(code); if (!room) return socket.emit('chess:error', { message: 'room-not-found' });
    const deny = rooms.spectateDenyReason(room, watchToken); if (deny) return socket.emit('chess:error', { message: deny });
    if (room.spectators && room.spectators.size >= 200 && !room.spectators.has(socket.id)) return socket.emit('chess:error', { message: 'audience-full' });
    const viaToken = !!watchToken && String(watchToken) === room.spectatorToken;
    const spectator = rooms.addSpectator(room, socket.id, { name, viewerId, viaToken, reservedNames: room.players.map(p => p.name) });
    socket.data.role = 'spectator'; socket.data.game = 'chess'; socket.data.roomCode = room.code; socket.data.spectatorName = spectator.name; socket.data.spectatorKey = spectator.key;
    socket.join(channel(room));
    socket.emit('chess:spectator-joined', { code: room.code, started: !!room.engine, you: { key: spectator.key, name: spectator.name }, players: playersInfo(room), timeControl: room.tc, audience: rooms.audienceInfo(room, false, true) });
    if (room.engine) {
      const now = Date.now();
      socket.emit('chess:state', { code: room.code, index: -1, spectator: true, state: room.engine.toJSON(now), players: playersInfo(room), serverNow: now, resultText: resultText(room) });
    }
    io.to(channel(room)).emit('chess:audience-info', rooms.audienceInfo(room, false));
  });
  function applyAudienceOptions(payload) {
    const room = rooms.getRoom(payload && payload.code); if (!hostOnly(socket, room)) return;
    rooms.applyOptions(room, { visibility: payload.visibility, chatEnabled: payload.chatEnabled });
    evictSpectators(room);
    io.to(channel(room)).emit('chess:audience-info', rooms.audienceInfo(room, false));
    socket.emit('chess:audience-host', rooms.audienceInfo(room, true));
  }
  socket.on('chess:set-audience-options', applyAudienceOptions);
  socket.on('chess:mute-viewer', ({ code, key, muted }) => {
    const room = rooms.getRoom(code); if (!hostOnly(socket, room)) return;
    rooms.setMuted(room, key, muted !== false);
    socket.emit('chess:audience-host', rooms.audienceInfo(room, true));
  });
  socket.on('chess:chat-message', ({ code, text }) => {
    const room = rooms.getRoom(code); if (!room) return socket.emit('chess:error', { message: 'room-not-found' });
    let role = 'spectator', name = socket.data.spectatorName || 'Guest', key = socket.data.spectatorKey;
    const index = rooms.playerIndexOf(room, socket.id);
    if (index >= 0) { role = index === 0 ? 'host' : 'player'; name = room.players[index].name || ('Player ' + (index + 1)); key = null; }
    else if (!room.spectators || !room.spectators.has(socket.id)) return socket.emit('chess:error', { message: 'not-in-room' });
    const result = rooms.addChatMessage(room, socket.id, { name, role, text, key });
    if (result.error) return socket.emit('chess:error', { message: result.error });
    io.to(channel(room)).emit('chess:chat-message', result.message);
  });
  socket.on('chess:reaction', ({ code, reaction }) => {
    const room = rooms.getRoom(code); if (!room || !reactions.has(reaction)) return;
    const index = rooms.playerIndexOf(room, socket.id);
    const name = index >= 0 ? room.players[index].name : (socket.data.spectatorName || 'Guest');
    if (index < 0 && !(room.spectators && room.spectators.has(socket.id))) return;
    room.reactionTotal = (room.reactionTotal || 0) + 1;
    io.to(channel(room)).emit('chess:reaction', { name, reaction, role: index >= 0 ? 'player' : 'spectator' });
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    if (socket.data.role === 'spectator' && roomCode) {
      const room = rooms.getRoom(roomCode);
      if (room && rooms.removeSpectator(room, socket.id)) io.to(channel(room)).emit('chess:audience-info', rooms.audienceInfo(room, false));
      return;
    }
    const removed = rooms.removeSocket(socket.id); if (!removed) return;
    const room = removed.room;
    if (room.engine) emitState(room, { event: 'opponent-disconnected', who: removed.index });
    io.to(channel(room)).emit('chess:audience-info', rooms.audienceInfo(room, false));
  });
});

// Server-authoritative clocks, abandoned games and idle rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.rooms.values()) {
    const game = room.engine; if (!game || game.gameOver) continue;
    const flagged = game.tick(now);
    if (flagged || game.gameOver) { emitState(room, { event: 'timeout', loser: flagged }); afterGameEnds(room); continue; }
    if (game.moves.length < 2 && room.lastMoveAt && now - room.lastMoveAt > FIRST_MOVE_MS) { game.abort(); emitState(room, { event: 'aborted' }); afterGameEnds(room); continue; }
    const limit = game.tc.base ? ABANDON_TIMED_MS : ABANDON_CASUAL_MS;
    room.players.forEach((p, i) => {
      if (game.gameOver || p.socketId || !p.disconnectedAt || game.moves.length < 2) return;
      if (now - p.disconnectedAt > limit) { game.abandon(room.colors[i]); emitState(room, { event: 'abandoned', who: i }); afterGameEnds(room); }
    });
  }
}, 500);
setInterval(() => rooms.sweepExpired(), 60 * 1000);
module.exports = { rooms };
