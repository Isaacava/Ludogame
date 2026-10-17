'use strict';
// Snooker as a first-class game: staked versus (settles + forfeit), a tournament, and a friend invite.
process.env.PORT = '3065'; process.env.ADMIN_PASSWORD = 'x'; process.env.CHIPS_TEST_TOPUP = '1'; process.env.VERSUS_FORFEIT_MS = '400'; process.env.TOURNAMENT_FORFEIT_MS = '400'; process.env.NEW_ACCOUNT_MAX_STAKE = '100000';
const assert = require('assert'), path = require('path');
const { accounts, wallet, tournaments, versus } = require('../index'); const snooker = require('../snookerServer').rooms;
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const base = 'http://localhost:3065', wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 7000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const api = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
async function player(name) {
  const a = await accounts.create({ email: name + '@x.com', emailLower: name + '@x.com', googleId: 'g' + name });
  await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), color: '#38a169' });
  const token = await accounts.createSession(a.id); await api('POST', '/api/versus/confirm-age', token, { confirm: true }); await api('POST', '/api/versus/test-topup', token, { amount: 1000 });
  const sock = io(base); await once(sock, 'connect'); sock.emit('social-hello', { token, where: 'site' }); await once(sock, 'social-ready');
  return { id: a.id, token, name, sock, acc: await accounts.findById(a.id), bal: async () => (await api('GET', '/api/versus/me', token)).body.balance };
}
async function seat(url, code, tok) { const s = io(base); await once(s, 'connect'); s.emit('snooker:reconnect', { code, playerToken: tok }); await once(s, 'snooker:joined'); return s; }

(async () => {
  await wait(1200);
  const ann = await player('Ann'), bob = await player('Bob'), cy = await player('Cy'), dee = await player('Dee');

  // ---- staked versus: both seat in, the game starts, resigning settles the pot ----
  assert((await api('GET', '/api/versus/config')).body.games.includes('snooker'));
  const m1 = once(ann.sock, 'versus-matched'), m2 = once(bob.sock, 'versus-matched');
  ann.sock.emit('versus-queue', { token: ann.token, game: 'snooker', stake: 100 }); await once(ann.sock, 'versus-queued'); bob.sock.emit('versus-queue', { token: bob.token, game: 'snooker', stake: 100 });
  const [x, y] = await Promise.all([m1, m2]); assert(x.url.startsWith('/snooker.html') && x.url.includes('playerToken=' + x.playerToken));
  assert.strictEqual(await ann.bal(), 900);
  const sa = await seat(x.url, x.code, x.playerToken); const stB = once(sa, 'snooker:state'); const sb = await seat(y.url, y.code, y.playerToken); const bst = (await stB).state;
  assert(bst.cueInHand && bst.names.length === 2); const room = snooker.getRoom(x.code); assert(room.versus && room.engine);
  const seatAnn = room.versus.accountIds.indexOf(ann.id); const res = once(sa, 'versus-result', 8000); room.engine.resign(1 - seatAnn); // Bob resigns -> Ann wins
  const r = await res; assert.strictEqual(r.result, 'win'); assert.strictEqual(r.winnerIndex, seatAnn); assert.strictEqual(r.payout, 180);
  assert.strictEqual(await ann.bal(), 1080); assert.strictEqual(await bob.bal(), 900);
  sb.emit('snooker:rematch', { code: x.code }); assert.strictEqual((await once(sb, 'snooker:error')).message, 'rematch-not-available-in-versus');
  sa.disconnect(); sb.disconnect();

  // ---- versus forfeit: a player who leaves loses the pot ----
  const n1 = once(ann.sock, 'versus-matched'), n2 = once(bob.sock, 'versus-matched');
  ann.sock.emit('versus-queue', { token: ann.token, game: 'snooker', stake: 50 }); await once(ann.sock, 'versus-queued'); bob.sock.emit('versus-queue', { token: bob.token, game: 'snooker', stake: 50 });
  const [p, q] = await Promise.all([n1, n2]); const fa = await seat(p.url, p.code, p.playerToken), fb = await seat(q.url, q.code, q.playerToken); await wait(150);
  const fres = once(fb, 'versus-result', 8000); fa.disconnect(); const fr = await fres; assert.strictEqual(fr.reason, 'forfeit'); assert.strictEqual(await bob.bal(), 900 - 50 + 90); fb.disconnect();

  // ---- tournament: a snooker bracket of two, the final ends when one player resigns ----
  const { tournament: t } = await tournaments.create({ game: 'snooker', name: 'Snooker Cup', entryFee: 0, fixedPrize: 400, minPlayers: 2, maxPlayers: 2, startAt: Date.now() + 1200, prizeSplit: [100] });
  assert.strictEqual((await api('POST', `/api/tournaments/${t.id}/join`, cy.token)).status, 200); assert.strictEqual((await api('POST', `/api/tournaments/${t.id}/join`, dee.token)).status, 200);
  const got = [once(cy.sock, 'tournament-match'), once(dee.sock, 'tournament-match')]; await wait(1400); await tournaments.tick(); const [tc, td] = await Promise.all(got);
  assert(tc.url.startsWith('/snooker.html') && tc.game === 'snooker');
  const ca = await seat(tc.url, tc.code, tc.playerToken), cb = await seat(td.url, td.code, td.playerToken); await wait(150);
  const troom = snooker.getRoom(tc.code); assert(troom.tournament && troom.engine); const cySeat = troom.tournament.accountIds.indexOf(cy.id);
  const tres = once(ca, 'versus-result', 8000); troom.engine.resign(1 - cySeat); const tr = await tres; assert(tr.tournament && tr.final && tr.winnerIndex === cySeat);
  const done = await tournaments.get(t.id); assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.results.find(z => z.place === 1).accountId, cy.id); assert.strictEqual(await cy.bal(), 1400);
  ca.disconnect(); cb.disconnect();

  // ---- friend invite (friendly): becomes a private snooker room that can be rematched ----
  await api('POST', '/api/social/friends/request', cy.token, { username: 'Dee' }); const fid = (await api('GET', '/api/social/friends', dee.token)).body.incoming[0].friendshipId; await api('POST', `/api/social/friends/${fid}/accept`, dee.token);
  const inv = once(dee.sock, 'friend-invite'); assert.strictEqual((await api('POST', '/api/social/invite', cy.token, { username: 'Dee', game: 'snooker', stake: 0 })).status, 200); const gi = await inv; assert.strictEqual(gi.game, 'snooker');
  const r1 = once(cy.sock, 'match-ready'), r2 = once(dee.sock, 'match-ready'); assert.strictEqual((await api('POST', `/api/social/invite/${gi.inviteId}/accept`, dee.token)).status, 200); const [ma, mb] = await Promise.all([r1, r2]);
  assert(ma.url.startsWith('/snooker.html')); const ga = await seat(ma.url, ma.code, ma.playerToken), gb = await seat(mb.url, mb.code, mb.playerToken); await wait(100);
  const froom = snooker.getRoom(ma.code); assert(froom.engine && !froom.versus && !froom.tournament);
  ga.disconnect(); gb.disconnect();
  for (const p of [ann, bob, cy, dee]) assert((await wallet.audit(p.id)).ok);
  console.log('snooker integration ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
