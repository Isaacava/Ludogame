'use strict';
// Snooker over sockets: friends room (create / join / place / shoot / turn rules), computer game, reconnect, resign.
process.env.PORT = '3063'; process.env.ADMIN_PASSWORD = 'x';
const assert = require('assert'), path = require('path');
require('../index'); const snooker = require('../snookerServer').rooms;
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const base = 'http://localhost:3063', wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 6000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const connect = async () => { const s = io(base); await once(s, 'connect'); return s; };

(async () => {
  await wait(1000);
  // ---- friends room ----
  const a = await connect(), b = await connect();
  a.emit('snooker:create-room', { name: 'Ann', mode: 'friends' }); const c = await once(a, 'snooker:created');
  assert.strictEqual(c.code.length, 4); assert.strictEqual(c.started, false); assert(c.playerToken);
  const bj = once(b, 'snooker:joined'), aState = once(a, 'snooker:state'); b.emit('snooker:join-room', { code: c.code, name: 'Bob' });
  const j = await bj; assert.strictEqual(j.you, 1); const st = (await aState).state; assert(st && st.cueInHand && st.turn === 0 && st.names[1] === 'Bob' && st.balls.length === 22);
  b.emit('snooker:join-room', { code: c.code, name: 'Eve' }); assert.strictEqual((await once(b, 'snooker:error')).message, 'room-full');

  // not your turn / invalid place / must place before shooting
  b.emit('snooker:place', { code: c.code, x: 600, y: 889 }); assert.strictEqual((await once(b, 'snooker:error')).message, 'not-your-turn');
  a.emit('snooker:shoot', { code: c.code, angle: 0, power: 0.5 }); assert.strictEqual((await once(a, 'snooker:error')).message, 'place-the-cue-ball');
  a.emit('snooker:place', { code: c.code, x: 3000, y: 889 }); assert.strictEqual((await once(a, 'snooker:error')).message, 'invalid-position');
  const placed = once(b, 'snooker:state'); a.emit('snooker:place', { code: c.code, x: 640, y: 950 }); const ps = (await placed).state; assert.strictEqual(ps.cueInHand, false); assert(Math.abs(ps.balls[0][1] - 640) < 1);

  // the opponent sees the aim line while it is your turn
  const aimed = once(b, 'snooker:aim'); a.emit('snooker:aim', { code: c.code, angle: 0.1, power: 0.4, x: 640, y: 950 }); assert.strictEqual((await aimed).angle, 0.1);

  // shoot: both players receive identical frames; the second shot is refused until the animation is over
  const sa = once(a, 'snooker:shot'), sb = once(b, 'snooker:shot'); a.emit('snooker:shoot', { code: c.code, angle: -0.015, power: 0.75 });
  const [shotA, shotB] = await Promise.all([sa, sb]);
  assert(shotA.sim.frames.length > 10 && JSON.stringify(shotA.sim) === JSON.stringify(shotB.sim), 'same frames for both players');
  assert.strictEqual(shotA.view.you, 0); assert.strictEqual(shotB.view.you, 1); assert(shotA.playMs > 500);
  assert(shotA.result.firstHit === 'red' || shotA.result.foul, JSON.stringify(shotA.result));
  const turnAfter = shotA.view.state.turn; b.emit('snooker:shoot', { code: c.code, angle: 0, power: 0.3 }); const err = await once(b, 'snooker:error'); assert(['shot-in-progress', 'not-your-turn'].includes(err.message));
  assert.strictEqual(turnAfter, shotA.result.foul || shotA.result.points === 0 ? 1 : 0, 'turn follows the rules');

  // reconnect with the seat token (tab refresh)
  a.disconnect(); await wait(150); const a2 = await connect(); a2.emit('snooker:reconnect', { code: c.code, playerToken: c.playerToken }); const rj = await once(a2, 'snooker:joined'); assert.strictEqual(rj.you, 0); assert.strictEqual(rj.state.shots, 1);
  a2.emit('snooker:reconnect', { code: c.code, playerToken: 'bogus' }); assert.strictEqual((await once(a2, 'snooker:error')).message, 'invalid-reconnect-token');

  // resign ends the frame; rematch needs both players and swaps who breaks
  await wait(shotA.playMs + 100); const over = once(b, 'snooker:state'); b.emit('snooker:resign', { code: c.code }); const os = (await over).state; assert(os.over && os.winner === 0 && os.endReason === 'resigned');
  b.emit('snooker:rematch', { code: c.code }); await wait(150); const rm = once(b, 'snooker:state'); a2.emit('snooker:rematch', { code: c.code }); const ns = (await rm).state; assert(!ns.over && ns.turn === 1 && ns.cueInHand, 'rematch: the other player breaks'); a2.disconnect(); b.disconnect();

  // ---- computer game: starts at once, the computer answers after our shot ----
  const h = await connect(); h.emit('snooker:create-room', { name: 'Solo', mode: 'computer', level: 1 }); const cc = await once(h, 'snooker:created');
  assert(cc.started && cc.state.turn === 0 && cc.mode === 'computer' && cc.players[1].bot && cc.locked === false);
  const hs = once(h, 'snooker:shot'); h.emit('snooker:place', { code: cc.code, x: 640, y: 950 }); await once(h, 'snooker:state'); h.emit('snooker:shoot', { code: cc.code, angle: 0.0, power: 0.15 }); const mine = await hs;
  assert.strictEqual(mine.by, 0);
  if (mine.view.state.turn === 1) { const reply = await once(h, 'snooker:shot', 12000); assert.strictEqual(reply.by, 1, 'the computer plays its turn'); }
  const other = io(base); await once(other, 'connect'); other.emit('snooker:join-room', { code: cc.code, name: 'Intruder' }); assert.strictEqual((await once(other, 'snooker:error')).message, 'room-full'); other.disconnect(); h.disconnect();
  console.log('snooker live ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
