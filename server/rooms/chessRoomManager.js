'use strict';
const crypto = require('crypto');
const path = require('path');
const { ChessGame, normalizeTimeControl } = require(path.join(__dirname, '..', '..', 'web', 'chess-game.js'));
const { ensureAudience, setVisibility, applyOptions, canSpectate, spectateDenyReason, addSpectator, removeSpectator, spectatorsToEvict, setMuted, audienceInfo, addChatMessage, addFeed } = require('../realtime/audience');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = c => String(c || '').trim().toUpperCase();
function generateCode() { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return c; }
const COLOR_PREFS = ['w', 'b', 'random'];

class ChessRoomManager {
  constructor() { this.rooms = new Map(); }

  createRoom(hostSocketId, profile = {}, opts = {}) {
    let code; do { code = generateCode(); } while (this.rooms.has(code));
    const tc = normalizeTimeControl(opts);
    const room = {
      code, game: 'chess', playerCount: 2, mode: 'friends', tc,
      colorPref: COLOR_PREFS.includes(opts.color) ? opts.color : 'random',
      players: [{ socketId: hostSocketId, playerToken: crypto.randomBytes(16).toString('hex'), connected: true, disconnectedAt: null, name: profile.name || 'Player 1', bot: false }],
      colors: null,            // colors[playerIndex] = 'w' | 'b' once the game starts
      engine: null, rematchVotes: new Set(), createdAt: Date.now(), lastActivityAt: Date.now(), lastMoveAt: null, gamesPlayed: 0
    };
    ensureAudience(room);
    this.rooms.set(code, room);
    return room;
  }

  // Versus matches: both seats reserved up front; the game starts once both players have connected with their seat tokens.
  createReservedRoom(profiles, opts = {}) {
    let code; do { code = generateCode(); } while (this.rooms.has(code));
    const tc = normalizeTimeControl(opts);
    const room = {
      code, game: 'chess', playerCount: 2, mode: 'friends', tc, colorPref: 'random',
      players: profiles.map((p, i) => ({ socketId: null, playerToken: crypto.randomBytes(16).toString('hex'), connected: false, disconnectedAt: null, name: p.name || `Player ${i + 1}`, bot: false })),
      colors: null, engine: null, rematchVotes: new Set(), createdAt: Date.now(), lastActivityAt: Date.now(), lastMoveAt: null, gamesPlayed: 0
    };
    ensureAudience(room); this.rooms.set(code, room); return room;
  }

  joinRoom(code, socketId, profile = {}) {
    const room = this.rooms.get(normCode(code)); if (!room) return { error: 'room-not-found' };
    if (room.engine || room.players.length >= 2) return { error: 'room-full' };
    room.players.push({ socketId, playerToken: crypto.randomBytes(16).toString('hex'), connected: true, disconnectedAt: null, name: profile.name || 'Player 2', bot: false });
    this.startGame(room);
    return { room };
  }

  startGame(room, swap) {
    if (swap && room.colors) room.colors = [room.colors[1], room.colors[0]];
    else {
      const hostWhite = room.colorPref === 'w' ? true : room.colorPref === 'b' ? false : Math.random() < 0.5;
      room.colors = hostWhite ? ['w', 'b'] : ['b', 'w'];
    }
    room.engine = new ChessGame({ base: room.tc.base, inc: room.tc.inc });
    room.rematchVotes = new Set();
    room.lastMoveAt = Date.now(); room.lastActivityAt = Date.now(); room.gamesPlayed++;
    return room.engine;
  }

  getRoom(code) { return this.rooms.get(normCode(code)); }
  playerIndexOf(room, socketId) { return room.players.findIndex(p => p.socketId === socketId); }
  colorOf(room, index) { return room.colors ? room.colors[index] : null; }
  indexOfColor(room, color) { return room.colors ? room.colors.indexOf(color) : -1; }

  reconnect(room, socketId, playerToken) {
    const index = room.players.findIndex(p => p.playerToken === playerToken);
    if (index < 0) return { error: 'invalid-reconnect-token' };
    const player = room.players[index];
    const replacedSocketId = (player.socketId && player.socketId !== socketId) ? player.socketId : null; // the token proves identity: take the seat over
    player.socketId = socketId; player.connected = true; player.disconnectedAt = null;
    return { index, playerToken: player.playerToken, room, replacedSocketId };
  }
  removeSocket(socketId) {
    for (const room of this.rooms.values()) {
      const index = room.players.findIndex(p => p.socketId === socketId);
      if (index >= 0) { const player = room.players[index]; player.socketId = null; player.connected = false; player.disconnectedAt = Date.now(); return { room, index, player }; }
    }
    return null;
  }

  requestRematch(code, socketId) {
    const room = this.getRoom(code); if (!room || !room.engine) return { error: 'room-not-found' };
    if (!room.engine.gameOver) return { error: 'game-not-over' };
    const index = this.playerIndexOf(room, socketId); if (index < 0) return { error: 'not-in-room' };
    if (!room.players.every(p => p.connected)) return { error: 'players-disconnected' };
    room.rematchVotes.add(index);
    if (room.rematchVotes.size === 2) { this.startGame(room, true); return { room, started: true, requested: 2 }; }
    return { room, started: false, requested: room.rematchVotes.size };
  }

  // audience helpers (same behaviour as the other games)
  setVisibility(room, v) { return setVisibility(room, v); }
  canSpectate(room, t) { return canSpectate(room, t); }
  addSpectator(room, socketId, payload) { return addSpectator(room, socketId, payload); }
  applyOptions(room, opts) { return applyOptions(room, opts); }
  spectateDenyReason(room, t) { return spectateDenyReason(room, t); }
  spectatorsToEvict(room) { return spectatorsToEvict(room); }
  setMuted(room, key, muted) { return setMuted(room, key, muted); }
  addFeed(room, text, kind) { return addFeed(room, text, kind); }
  removeSpectator(room, socketId) { return removeSpectator(room, socketId); }
  audienceInfo(room, includeSecret = false, includeHistory = false) { return audienceInfo(room, includeSecret, includeHistory); }
  addChatMessage(room, socketId, data) { return addChatMessage(room, socketId, data); }

  sweepExpired(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const idle = now - (room.lastActivityAt || room.createdAt), online = room.players.some(p => p.socketId);
      const stale = !room.engine ? now - room.createdAt > maxAgeMs : (room.engine.gameOver ? idle > 20 * 60 * 1000 : ((!online && idle > 15 * 60 * 1000) || idle > 8 * 60 * 60 * 1000));
      if (stale) this.rooms.delete(code);
    }
  }
}
module.exports = { ChessRoomManager };
