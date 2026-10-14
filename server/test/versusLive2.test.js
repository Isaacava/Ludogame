'use strict';
// Whot and Chess versus end to end: queue -> matched -> both connect with seat tokens -> result -> chips settle.
process.env.PORT = '3053'; process.env.ADMIN_PASSWORD = 'test'; process.env.CHIPS_TEST_TOPUP = '1';
process.env.VERSUS_FORFEIT_MS = '300'; process.env.NEW_ACCOUNT_MAX_STAKE = '100000';
const assert = require('assert'), path = require('path');
const { accounts, wallet } = require('../index');
const whot = require('../whotServer').rooms, chess = require('../chessServer').rooms;
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const base = 'http://localhost:3053', wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 5000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const api = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
async function player(name) {
  const a = await accounts.create({ email: name + '@x.com', emailLower: name + '@x.com', googleId: 'g' + name });
  await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), color: '#38a169' });
  const token = await accounts.createSession(a.id);
  await api('POST', '/api/versus/confirm-age', token, { confirm: true }); await api('POST', '/api/versus/test-topup', token, { amount: 1000 });
  return { id: a.id, token, name };
}
const bal = async p => (await api('GET', '/api/versus/me', p.token)).body.balance;
async function match(p1, p2, game, stake) {
  const l1 = io(base), l2 = io(base); await Promise.all([once(l1, 'connect'), once(l2, 'connect')]);
  const m1 = once(l1, 'versus-matched'), m2 = once(l2, 'versus-matched');
  l1.emit('versus-queue', { token: p1.token, game, stake }); await once(l1, 'versus-queued');
  l2.emit('versus-queue', { token: p2.token, game, stake });
  const [x, y] = await Promise.all([m1, m2]); l1.disconnect(); l2.disconnect();
  assert(x.url.startsWith('/' + (game === 'ludo' ? 'play' : game) + '.html')); return [x, y];
}

(async () => {
  await wait(1200);
  const ann = await player('Ann'), bob = await player('Bob');

  // ---------- WHOT ----------
  let [x, y] = await match(ann, bob, 'whot', 100);
  assert.strictEqual(await bal(ann), 900);
  const w1 = io(base), w2 = io(base); await Promise.all([once(w1, 'connect'), once(w2, 'connect')]);
  w1.emit('whot:reconnect', { code: x.code, playerToken: x.playerToken }); await once(w1, 'whot:joined');
  const st1 = once(w1, 'whot:state'); w2.emit('whot:reconnect', { code: y.code, playerToken: y.playerToken }); await once(w2, 'whot:joined');
  await st1; // first player is told the game started when the second connects
  const wroom = whot.getRoom(x.code); assert(wroom.engine && wroom.versus);
  const bobSeat = wroom.versus.accountIds.indexOf(bob.id);
  const wres = once(w1, 'versus-result', 6000); wroom.engine.gameOver = true; wroom.engine.winner = bobSeat;
  const wr = await wres; assert.strictEqual(wr.result, 'win'); assert.strictEqual(wr.payout, 180);
  assert.strictEqual(await bal(bob), 1080); assert.strictEqual(await bal(ann), 900);
  w1.emit('whot:rematch', { code: x.code }); assert.strictEqual((await once(w1, 'whot:error')).message, 'rematch-not-available-in-versus');
  w1.disconnect(); w2.disconnect();

  // ---------- CHESS: win by resignation, then a draw ----------
  [x, y] = await match(ann, bob, 'chess', 50);
  const c1 = io(base), c2 = io(base); await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
  c1.emit('chess:reconnect', { code: x.code, playerToken: x.playerToken }); await once(c1, 'chess:joined');
  const cst = once(c1, 'chess:state'); c2.emit('chess:reconnect', { code: y.code, playerToken: y.playerToken }); await once(c2, 'chess:joined'); await cst;
  const croom = chess.getRoom(x.code); assert(croom.engine && croom.colors && croom.versus);
  const annSeat = croom.versus.accountIds.indexOf(ann.id);
  const cres = once(c2, 'versus-result', 6000); croom.engine.resign(croom.colors[annSeat]); // Ann resigns -> Bob wins
  const cr = await cres; assert.strictEqual(cr.result, 'win'); assert.strictEqual(cr.winnerIndex, 1 - annSeat);
  assert.strictEqual(await bal(bob), 1080 - 50 + 90); assert.strictEqual(await bal(ann), 850);
  c1.disconnect(); c2.disconnect();

  [x, y] = await match(ann, bob, 'chess', 20);
  const d1 = io(base), d2 = io(base); await Promise.all([once(d1, 'connect'), once(d2, 'connect')]);
  d1.emit('chess:reconnect', { code: x.code, playerToken: x.playerToken }); await once(d1, 'chess:joined');
  d2.emit('chess:reconnect', { code: y.code, playerToken: y.playerToken }); await once(d2, 'chess:joined'); await wait(100);
  const droom = chess.getRoom(x.code); const dres = once(d1, 'versus-result', 6000);
  droom.engine.result = { winner: null, reason: 'agreed' }; // draw
  assert.strictEqual((await dres).result, 'draw'); assert.strictEqual(await bal(ann), 850); assert.strictEqual(await bal(bob), 1120);
  d1.disconnect(); d2.disconnect();

  // ---------- WHOT forfeit ----------
  [x, y] = await match(ann, bob, 'whot', 10);
  const f1 = io(base), f2 = io(base); await Promise.all([once(f1, 'connect'), once(f2, 'connect')]);
  f1.emit('whot:reconnect', { code: x.code, playerToken: x.playerToken }); await once(f1, 'whot:joined');
  f2.emit('whot:reconnect', { code: y.code, playerToken: y.playerToken }); await once(f2, 'whot:joined'); await wait(100);
  const fres = once(f2, 'versus-result', 8000); f1.disconnect(); // Ann leaves
  const fr = await fres; assert.strictEqual(fr.reason, 'forfeit'); assert.strictEqual(await bal(bob), 1120 - 10 + 18); assert.strictEqual(await bal(ann), 840);
  f2.disconnect();

  for (const id of [ann.id, bob.id, 'house']) assert((await wallet.audit(id)).ok, 'ledger audit ' + id);
  console.log('versus whot+chess ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
