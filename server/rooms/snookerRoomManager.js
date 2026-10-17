'use strict';
// Snooker rooms: always two players. Friends rooms (4-letter code), computer games, and reserved rooms for
// versus / tournament / friend-invite matches (seats are created up front and filled with seat tokens).
const crypto = require('crypto');
const { SnookerGame } = require('../engine/snookerEngine');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normCode = c => String(c || '').trim().toUpperCase();
function generateCode() { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; return c; }
const token = () => crypto.randomBytes(16).toString('hex');
const IDLE_MS = 2 * 60 * 60 * 1000, EMPTY_MS = 10 * 60 * 1000;

class SnookerRoomManager {
  constructor() { this.rooms = new Map(); }
  _newCode() { let c; do { c = generateCode(); } while (this.rooms.has(c)); return c; }
  _player(socketId, name, bot = false) { return { socketId, playerToken: token(), connected: !!socketId || bot, disconnectedAt: null, name: String(name || (bot ? 'Computer' : 'Player')).slice(0, 24), bot }; }
  getRoom(code) { return this.rooms.get(normCode(code)); }

  createRoom(hostSocketId, profile = {}, { mode = 'friends', level = 2, turnSeconds = 90 } = {}) {
    const room = { code: this._newCode(), game: 'snooker', mode, level: Math.max(1, Math.min(3, Number(level) || 2)), playerCount: 2, players: [this._player(hostSocketId, profile.name)], engine: null,
      rematchVotes: new Set(), createdAt: Date.now(), lastActivityAt: Date.now(), turnSeconds: mode === 'computer' ? 0 : Math.max(0, Math.min(300, Number(turnSeconds) || 0)), deadline: null, animUntil: 0, gamesPlayed: 0, starter: 0 };
    if (mode === 'computer') { room.players.push(this._player(null, `Computer · Lv ${room.level}`, true)); this.startGame(room); }
    this.rooms.set(room.code, room); return room;
  }
  // Seats are reserved up front; players connect with their seat token and the game starts once both are in.
  createReservedRoom(profiles) {
    const room = { code: this._newCode(), game: 'snooker', mode: 'friends', level: 2, playerCount: 2, players: profiles.map((p, i) => this._player(null, p.name || `Player ${i + 1}`)), engine: null,
      rematchVotes: new Set(), createdAt: Date.now(), lastActivityAt: Date.now(), turnSeconds: 90, deadline: null, animUntil: 0, gamesPlayed: 0, starter: 0 };
    this.rooms.set(room.code, room); return room;
  }
  joinRoom(code, socketId, profile = {}) {
    const room = this.getRoom(code); if (!room) return { error: 'room-not-found' };
    if (room.mode === 'computer') return { error: 'room-full' };
    if (room.players.length >= 2) return { error: 'room-full' };
    room.players.push(this._player(socketId, profile.name || 'Player 2'));
    room.lastActivityAt = Date.now(); if (room.players.length === 2) this.startGame(room);
    return { room, index: 1, playerToken: room.players[1].playerToken };
  }
  startGame(room) {
    room.engine = new SnookerGame({ names: room.players.map(p => p.name), mode: room.mode, level: room.level });
    room.engine.turn = room.starter; room.rematchVotes = new Set(); room.animUntil = 0; this.resetClock(room, 0);
  }
  resetClock(room, extraMs) { room.deadline = room.turnSeconds && room.engine && !room.engine.over ? Date.now() + (extraMs || 0) + room.turnSeconds * 1000 : null; }
  secondsLeft(room) { return room.deadline ? Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000)) : null; }

  reconnect(room, socketId, playerToken) {
    const index = room.players.findIndex(p => !p.bot && p.playerToken === playerToken); if (index < 0) return { error: 'invalid-reconnect-token' };
    const p = room.players[index], replacedSocketId = p.socketId && p.socketId !== socketId ? p.socketId : null;
    p.socketId = socketId; p.connected = true; p.disconnectedAt = null; room.lastActivityAt = Date.now();
    if (!room.engine && room.players.length === 2 && room.players.every(x => x.bot || x.socketId)) this.startGame(room);
    return { index, room, replacedSocketId };
  }
  indexOf(room, socketId) { return room.players.findIndex(p => !p.bot && p.socketId === socketId); }
  disconnect(socketId) {
    for (const room of this.rooms.values()) { const i = this.indexOf(room, socketId); if (i >= 0) { const p = room.players[i]; p.socketId = null; p.connected = false; p.disconnectedAt = Date.now(); return { room, index: i }; } }
    return null;
  }
  requestRematch(code, socketId) {
    const room = this.getRoom(code); if (!room || !room.engine || !room.engine.over) return { error: 'game-not-finished' };
    const i = this.indexOf(room, socketId); if (i < 0) return { error: 'not-in-room' };
    room.rematchVotes.add(i);
    const everyone = room.players.every((p, k) => p.bot || room.rematchVotes.has(k));
    if (everyone) { room.gamesPlayed++; room.starter = 1 - room.starter; this.startGame(room); return { room, started: true }; }
    return { room, started: false };
  }
  sweepExpired() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const online = room.players.some(p => !p.bot && p.socketId);
      if (now - room.lastActivityAt > IDLE_MS || (!online && now - room.lastActivityAt > EMPTY_MS)) this.rooms.delete(code);
    }
  }
}
module.exports = { SnookerRoomManager, normCode };
