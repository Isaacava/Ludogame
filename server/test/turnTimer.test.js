'use strict';
// The turn clock must auto-play for an idle player, reset when the game moves on, and never touch bots or rooms with the clock off.
const assert = require('assert');
const { startTurnTimers, normalizeTurnSeconds } = require('../realtime/turnTimer');

assert.strictEqual(normalizeTurnSeconds(30), 30);
assert.strictEqual(normalizeTurnSeconds('60'), 60);
assert.strictEqual(normalizeTurnSeconds(0), 0, 'Off is allowed');
assert.strictEqual(normalizeTurnSeconds(7, 45), 45, 'unknown values fall back');

const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const room = { code: 'TEST', turnSeconds: 1, seq: 0, seat: 0, over: false, players: [{ name: 'A', socketId: 's1' }, { name: 'B', socketId: 's2' }] };
  const off = { code: 'OFF', turnSeconds: 0, seq: 0, seat: 0, over: false, players: [{ name: 'A', socketId: 's1' }, { name: 'B', socketId: 's2' }] };
  const bots = { code: 'BOT', turnSeconds: 1, seq: 0, seat: 1, over: false, players: [{ name: 'A', socketId: 's1' }, { name: 'CPU', bot: true }] };
  const events = [], played = [];
  const stop = startTurnTimers({
    rooms: () => [room, off, bots],
    active: r => !r.over,
    signature: r => `${r.seat}:${r.seq}`,
    seat: r => r.seat,
    emit: (r, ev, payload) => events.push([r.code, payload.turn, payload.seconds]),
    autoPlay: (r, seat) => { played.push([r.code, seat]); r.seq++; r.seat = (r.seat + 1) % 2; },
    announce: () => {}
  });
  await sleep(4200);
  stop();
  assert(events.some(e => e[0] === 'TEST' && e[2] === 1), 'clock announced to the room');
  assert(played.some(p => p[0] === 'TEST' && p[1] === 0), 'idle seat 0 was auto-played');
  assert(played.filter(p => p[0] === 'TEST').length >= 1);
  assert(!played.some(p => p[0] === 'OFF'), 'rooms with the clock off are never auto-played');
  assert(!played.some(p => p[0] === 'BOT'), 'bots are never auto-played by the clock');
  assert((room.players[0].awayStreak || 0) >= 1, 'away streak recorded');
  console.log('turnTimer tests passed');
  process.exit(0);
})();
