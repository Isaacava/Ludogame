'use strict';
// End to end against the real server: two players queue, get matched, join the reserved Ludo room with their seat
// tokens, the game ends, and chips settle. Also covers forfeit-on-disconnect.
process.env.PORT = '3052'; process.env.ADMIN_PASSWORD = 'test'; process.env.CHIPS_TEST_TOPUP = '1';
process.env.VERSUS_FORFEIT_MS = '300'; process.env.NEW_ACCOUNT_MAX_STAKE = '100000';
const assert = require('assert'), path = require('path');
const { rooms, accounts, wallet, versus } = require('../index');
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const base = 'http://localhost:3052', wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 4000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const api = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

async function player(name) {
  const a = await accounts.create({ email: name + '@x.com', emailLower: name + '@x.com', googleId: 'g' + name });
  await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), color: '#38a169' });
  const token = await accounts.createSession(a.id);
  await api('POST', '/api/versus/confirm-age', token, { confirm: true });
  await api('POST', '/api/versus/test-topup', token, { amount: 1000 });
  return { id: a.id, token, name };
}
async function runMatch(p1, p2, stake) {
  const l1 = io(base), l2 = io(base);
  await Promise.all([once(l1, 'connect'), once(l2, 'connect')]);
  const m1 = once(l1, 'versus-matched'), m2 = once(l2, 'versus-matched');
  l1.emit('versus-queue', { token: p1.token, game: 'ludo', stake });
  await once(l1, 'versus-queued');
  l2.emit('versus-queue', { token: p2.token, game: 'ludo', stake });
  const [x, y] = await Promise.all([m1, m2]);
  assert.strictEqual(x.code, y.code); assert(x.url.includes('action=reconnect') && x.url.includes(x.playerToken));
  l1.disconnect(); l2.disconnect();
  // game pages connect with their seat tokens
  const g1 = io(base), g2 = io(base);
  await Promise.all([once(g1, 'connect'), once(g2, 'connect')]);
  const ready1 = once(g1, 'game-ready'), ready2 = once(g2, 'game-ready');
  g1.emit('reconnect-player', { code: x.code, playerToken: x.playerToken });
  await once(g1, 'you-are-player');
  g2.emit('reconnect-player', { code: y.code, playerToken: y.playerToken });
  await Promise.all([ready1, ready2]); // BOTH players get game-ready once the second one arrives
  return { code: x.code, g1, g2, seatOf: { [p1.id]: x.opponent === p2.name ? null : null } };
}

(async () => {
  await wait(1200);
  const ann = await player('Ann'), bob = await player('Bob');
  assert.strictEqual((await api('GET', '/api/versus/me', ann.token)).body.balance, 1000);

  // ---- normal finish ----
  const { code, g1, g2 } = await runMatch(ann, bob, 100);
  assert.strictEqual((await api('GET', '/api/versus/me', ann.token)).body.balance, 900); // stake in escrow
  const room = rooms.getRoom(code); assert(room.engine && room.versus);
  const seatOfBob = room.versus.accountIds.indexOf(bob.id);
  const resultP = once(g1, 'versus-result', 6000);
  room.engine.gameOver = true; room.engine.finishOrder = [seatOfBob];
  const res = await resultP; assert.strictEqual(res.result, 'win'); assert.strictEqual(res.payout, 180);
  assert.strictEqual((await api('GET', '/api/versus/me', bob.token)).body.balance, 1080);
  assert.strictEqual((await api('GET', '/api/versus/me', ann.token)).body.balance, 900);
  g2.emit('rematch', { code }); const rm = await once(g2, 'error-msg'); assert.strictEqual(rm, 'rematch-not-available-in-versus');
  g1.disconnect(); g2.disconnect();

  // ---- forfeit: one player drops after the game starts ----
  const r2 = await runMatch(ann, bob, 50);
  const room2 = rooms.getRoom(r2.code); const annSeat = room2.versus.accountIds.indexOf(ann.id);
  const forfeitP = once(r2.g2, 'versus-result', 8000); // g1 is always Ann's socket, g2 Bob's
  r2.g1.disconnect();
  const f = await forfeitP; assert.strictEqual(f.reason, 'forfeit'); assert.strictEqual(f.winnerIndex, 1 - annSeat);
  assert.strictEqual((await api('GET', '/api/versus/me', bob.token)).body.balance, 1080 - 50 + 90);
  assert.strictEqual((await api('GET', '/api/versus/me', ann.token)).body.balance, 850);

  // ---- no-show: matched but nobody connects -> refund ----
  const cy = await player('Cy'), dee = await player('Dee');
  const a = io(base), b = io(base); await Promise.all([once(a, 'connect'), once(b, 'connect')]);
  const mm = once(a, 'versus-matched'); a.emit('versus-queue', { token: cy.token, game: 'ludo', stake: 20 }); await once(a, 'versus-queued');
  b.emit('versus-queue', { token: dee.token, game: 'ludo', stake: 20 }); const matched = await mm;
  assert.strictEqual((await api('GET', '/api/versus/me', cy.token)).body.balance, 980);
  const noshow = await versus.getMatch(matched.matchId); assert.strictEqual(noshow.status, 'pending');
  await versus.cancelMatch(matched.matchId, 'no-show'); // referee does this after VERSUS_NOSHOW_MS; verify the refund path directly
  assert.strictEqual((await api('GET', '/api/versus/me', cy.token)).body.balance, 1000);

  // ---- leaving the lobby while queued refunds the stake ----
  const eve = await player('Eve'); const c = io(base); await once(c, 'connect');
  c.emit('versus-queue', { token: eve.token, game: 'ludo', stake: 500 }); await once(c, 'versus-queued');
  assert.strictEqual((await api('GET', '/api/versus/me', eve.token)).body.balance, 500);
  c.disconnect(); await wait(400);
  assert.strictEqual((await api('GET', '/api/versus/me', eve.token)).body.balance, 1000);

  // ---- guests / signed-out cannot touch chips ----
  assert.strictEqual((await api('GET', '/api/versus/me')).status, 401);
  for (const id of [ann.id, bob.id, cy.id, dee.id, eve.id, 'house']) assert((await wallet.audit(id)).ok, 'ledger audit ' + id);
  console.log('versus live ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
