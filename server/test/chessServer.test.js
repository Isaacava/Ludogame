'use strict';
// End-to-end multiplayer chess on the real server: seating, moves, rules enforcement, draw/resign, clocks, rematch, spectators, reconnection.
process.env.PORT = '3051';
process.env.ADMIN_PASSWORD = 'test';
const assert = require('assert');
const path = require('path');
require('../index');
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const url = 'http://localhost:3051';
const wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 3000) => { const where = (new Error().stack.split('\n')[2] || '').trim(); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev + ' at ' + where)), ms); s.once(ev, x => { clearTimeout(t); res(x); }); }); };
// Resolves on the next `chess:state` that satisfies the predicate.
const state = (s, pred = () => true, ms = 3000) => new Promise((res, rej) => { const t = setTimeout(() => { s.off('chess:state', h); rej(new Error('timeout waiting for state')); }, ms); const h = x => { if (pred(x)) { clearTimeout(t); s.off('chess:state', h); res(x); } }; s.on('chess:state', h); });

(async () => {
  await wait(1200);
  // ---------- a full game: host picks White
  const a = io(url), b = io(url);
  const created = once(a, 'chess:created');
  a.emit('chess:create-room', { name: 'Ann', color: 'w', base: 300, inc: 2 });
  const c = await created, code = c.code;
  assert.strictEqual(c.timeControl.base, 300);
  const aStart = state(a), bStart = state(b);
  b.emit('chess:join-room', { code, name: 'Ben' });
  const sa = await aStart, sb = await bStart;
  assert.strictEqual(sa.color, 'w'); assert.strictEqual(sb.color, 'b');
  assert.strictEqual(sa.state.turn, 'w'); assert(sa.state.dests.e2.includes('e4'), 'legal moves are included');

  // illegal / out-of-turn moves are refused and the table is re-sent
  const err1 = once(b, 'chess:error'); b.emit('chess:move', { code, from: 'e7', to: 'e5' }); assert.strictEqual((await err1).message, 'not-your-turn');
  const err2 = once(a, 'chess:error'); a.emit('chess:move', { code, from: 'e2', to: 'e5' }); assert.strictEqual((await err2).message, 'illegal-move');

  // fool's mate
  const play = async (sock, from, to) => { const p = state(sock, x => x.move); sock.emit('chess:move', { code, from, to }); return p; };
  await play(a, 'f2', 'f3'); await play(b, 'e7', 'e5'); await play(a, 'g2', 'g4');
  const mate = state(a, x => x.state.gameOver);
  b.emit('chess:move', { code, from: 'd8', to: 'h4' });
  const end = await mate;
  assert.deepStrictEqual(end.state.result, { winner: 'b', reason: 'checkmate' });
  assert(/Ben wins by checkmate/.test(end.resultText), end.resultText);
  const late = once(a, 'chess:error'); a.emit('chess:move', { code, from: 'e2', to: 'e4' }); assert.strictEqual((await late).message, 'game-over');

  // rematch swaps colours
  const r1 = state(a, x => x.event === 'rematch-requested' || x.event === 'rematch-started');
  a.emit('chess:rematch', { code }); await r1;
  const rs = state(b, x => x.event === 'rematch-started'); b.emit('chess:rematch', { code });
  const restarted = await rs; assert.strictEqual(restarted.color, 'w', 'Ben is White in the rematch'); assert.strictEqual(restarted.state.plies, 0);

  // draw offer / decline / accept
  await play(b, 'e2', 'e4'); await play(a, 'e7', 'e5');
  const off = state(a, x => x.event === 'draw-offered'); b.emit('chess:offer-draw', { code }); assert.strictEqual((await off).state.drawOffer, 'w');
  const dec = state(b, x => x.event === 'draw-declined'); a.emit('chess:respond-draw', { code, accept: false }); assert.strictEqual((await dec).state.drawOffer, null);
  b.emit('chess:offer-draw', { code }); await state(a, x => x.event === 'draw-offered');
  const acc = state(b, x => x.state.gameOver); a.emit('chess:respond-draw', { code, accept: true });
  assert.strictEqual((await acc).state.result.reason, 'agreement');

  // ---------- reconnection: refresh takes the seat over and the position survives
  const a2 = io(url), moved = state(a2);
  const replaced = once(a, 'chess:session-replaced');
  a2.emit('chess:reconnect', { code, playerToken: c.playerToken });
  const back = await moved; assert.strictEqual(back.index, 0); assert.strictEqual(back.state.plies, 2);
  await replaced;

  // ---------- spectators: private by default, watch with the token, can chat, cannot move
  const sp = io(url), denied = once(sp, 'chess:error');
  sp.emit('chess:spectate', { code, name: 'Fan' });
  assert.strictEqual((await denied).message, 'spectator-access-denied');
  const sp2 = io(url), joined = once(sp2, 'chess:spectator-joined'), st = state(sp2);
  sp2.emit('chess:spectate', { code, name: 'Fan', watchToken: c.audience.spectatorToken });
  await joined; assert.strictEqual((await st).spectator, true);
  const chat = once(a2, 'chess:chat-message'); sp2.emit('chess:chat-message', { code, text: 'good game' });
  assert.strictEqual((await chat).role, 'spectator');
  const nope = once(sp2, 'chess:error'); sp2.emit('chess:move', { code, from: 'e2', to: 'e4' }); assert.strictEqual((await nope).message, 'not-in-room');

  // ---------- clocks: a flag fall ends the game on the server
  const t1 = io(url), t2 = io(url), tc = once(t1, 'chess:created');
  t1.emit('chess:create-room', { name: 'T1', color: 'w', base: 1, inc: 0 });
  const tcode = (await tc).code, ts = state(t1); t2.emit('chess:join-room', { code: tcode, name: 'T2' }); await ts;
  const pm = (s, f, to) => { const p = state(s, x => x.move); s.emit('chess:move', { code: tcode, from: f, to }); return p; };
  await pm(t1, 'e2', 'e4'); await pm(t2, 'e7', 'e5');           // clocks start after both sides have moved: White has 1 s
  const flagged = await state(t1, x => x.state.gameOver, 4000);
  assert.deepStrictEqual(flagged.state.result, { winner: 'b', reason: 'timeout' });
  [a, b, a2, sp, sp2, t1, t2].forEach(s => s.close());
  console.log('chessServer tests passed');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
