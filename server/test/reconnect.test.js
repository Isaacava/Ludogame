'use strict';
// Reconnection must never lock a player out or leave a rolled die stranded.
// Runs against the real server: refresh after rolling, takeover of a half-open socket, and "roll again" while a roll is pending.
process.env.PORT = '3041';
process.env.ADMIN_PASSWORD = 'test';
const assert = require('assert');
const path = require('path');
const { rooms } = require('../index');
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const url = 'http://localhost:3041';
const wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 3000) => { const where = (new Error().stack.split('\n')[2] || '').trim(); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev + ' at ' + where)), ms); s.once(ev, x => { clearTimeout(t); res(x); }); }); };

(async () => {
  await wait(1200);
  // ---------------- Ludo ----------------
  const a = io(url), b = io(url);
  a.emit('create-room', { playerCount: 2, name: 'Host', turnSeconds: 60 });
  const created = await once(a, 'room-created');
  const code = created.code, token = created.playerToken;
  const startP = once(a, 'game-ready');
  b.emit('join-room', { code, name: 'Guest' });
  await startP;
  // put a token on the track so every roll has a legal move (otherwise the server auto-passes the turn)
  const eng = rooms.getRoom(code).engine;
  eng.turn = 0; eng.players[0].tokens[eng.players[0].colors[0]][0] = 3;
  const rolledP = once(a, 'dice-rolled');
  a.emit('roll-dice', { code });
  const rolled = await rolledP;
  assert.strictEqual(rolled.dice.length, 2);

  // 1) rolling again while the roll is pending hands the pending roll back instead of an error
  const errors = []; a.on('error-msg', m => errors.push(m));
  const resyncP = once(a, 'game-ready');
  a.emit('roll-dice', { code });
  const resync = await resyncP;
  assert(resync.state.dice && resync.state.dice.length === 2, 'pending dice are included in the resync');
  assert.deepStrictEqual(resync.state.dice, rolled.dice);
  assert.strictEqual(errors.length, 0, 'no error is sent for a pending roll');

  // 2) a refresh whose old socket is still "connected" takes the seat over immediately
  const a2 = io(url);
  const replaced = once(a, 'session-replaced');
  const youP = once(a2, 'you-are-player'), readyP = once(a2, 'game-ready');
  a2.emit('reconnect-player', { code, playerToken: token });
  const you = await youP;
  assert.strictEqual(you.reconnected, true);
  const ready = await readyP;
  assert.deepStrictEqual(ready.state.dice, rolled.dice, 'the roll survives the refresh');
  assert.deepStrictEqual(ready.state.remainingDice, [true, true]);
  await replaced;
  // the retired socket can no longer act
  a.emit('roll-dice', { code });
  await wait(300);
  const againP = once(a2, 'game-ready');
  a2.emit('request-sync', { code });
  const again = await againP;
  assert.strictEqual(again.state.turn, ready.state.turn);
  [a, a2, b].forEach(s => s.close());

  // ---------------- Whot ----------------
  const w1 = io(url), w2 = io(url);
  w1.emit('whot:create-room', { playerCount: 2, name: 'Host', mode: 'friends', turnSeconds: 60 });
  const wc = await once(w1, 'whot:created');
  const stP = once(w1, 'whot:state');
  w2.emit('whot:join-room', { code: wc.code, name: 'Guest' });
  await stP;
  const w1b = io(url);
  const wrep = once(w1, 'whot:session-replaced');
  const joinedP = once(w1b, 'whot:joined');
  w1b.emit('whot:reconnect', { code: wc.code, playerToken: wc.playerToken });
  const joined = await joinedP;
  assert(joined.state, 'the table state comes back after a refresh');
  assert.strictEqual(joined.index, 0);
  await wrep;
  [w1, w1b, w2].forEach(s => s.close());
  console.log('reconnect tests passed');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
