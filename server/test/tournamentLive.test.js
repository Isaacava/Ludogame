'use strict';
// Tournament end to end on the real server: join over HTTP, bracket starts, matches arrive over sockets, players
// play (Whot), results advance the bracket, prizes pay out, no-show walkovers work, and tournament players are
// kept out of the general versus queue while they have a match.
process.env.PORT = '3055'; process.env.ADMIN_PASSWORD = 'test'; process.env.CHIPS_TEST_TOPUP = '1';
process.env.TOURNAMENT_FORFEIT_MS = '400'; process.env.NEW_ACCOUNT_MAX_STAKE = '100000';
const assert = require('assert'), path = require('path');
const { accounts, wallet, tournaments } = require('../index');
const whot = require('../whotServer').rooms;
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const base = 'http://localhost:3055', wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 6000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const api = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
async function player(name) {
  const a = await accounts.create({ email: name + '@x.com', emailLower: name + '@x.com', googleId: 'g' + name });
  await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), color: '#38a169' });
  const token = await accounts.createSession(a.id);
  await api('POST', '/api/versus/confirm-age', token, { confirm: true }); await api('POST', '/api/versus/test-topup', token, { amount: 1000 });
  const sock = io(base); await once(sock, 'connect'); sock.emit('social-hello', { token, where: 'site' }); await once(sock, 'social-ready');
  return { id: a.id, token, name, sock, bal: async () => (await api('GET', '/api/versus/me', token)).body.balance };
}

(async () => {
  await wait(1200);
  const ps = []; for (const n of ['T1', 'T2', 'T3', 'T4']) ps.push(await player(n));
  const byId = Object.fromEntries(ps.map(p => [p.id, p]));
  const { tournament: t } = await tournaments.create({ game: 'whot', name: 'Live Whot Cup', entryFee: 100, fixedPrize: 200, rakePercent: 10, minPlayers: 4, maxPlayers: 4, startAt: Date.now() + 1500, prizeSplit: '60,30,10' });

  // public API
  const list = (await api('GET', '/api/tournaments')).body.rows; assert(list.find(r => r.id === t.id));
  assert.strictEqual((await api('POST', `/api/tournaments/${t.id}/join`)).status, 401);
  for (const p of ps) assert.strictEqual((await api('POST', `/api/tournaments/${t.id}/join`, p.token)).status, 200);
  assert.strictEqual((await ps[0].bal()), 900);
  assert.strictEqual((await api('GET', `/api/tournaments/${t.id}`, ps[0].token)).body.tournament.joined, true);

  // start; every player is told about their match over their socket
  const inbox = {}; ps.forEach(p => { inbox[p.id] = []; p.sock.on('tournament-match', m => inbox[p.id].push(m)); });
  const got = ps.map(p => once(p.sock, 'tournament-match')); await wait(1700); await tournaments.tick();
  const matches = await Promise.all(got); assert(matches.every(m => m.url.startsWith('/whot.html') && m.round === 1 && m.rounds === 2));
  const pm = Object.fromEntries(ps.map((p, i) => [p.id, matches[i]]));
  assert.strictEqual((await api('POST', '/api/versus/confirm-age', ps[0].token, { confirm: true })).status, 200);
  const q = io(base); await once(q, 'connect'); q.emit('versus-queue', { token: ps[0].token, game: 'ludo', stake: 10 }); assert.strictEqual((await once(q, 'versus-error')).error, 'match-in-progress'); q.disconnect(); // busy in a tournament

  async function playMatch(m1, m2, winnerId, rounds = 1) { // both players connect, then the game ends with winnerId
    const a = io(base), b = io(base); await Promise.all([once(a, 'connect'), once(b, 'connect')]);
    a.emit('whot:reconnect', { code: m1.code, playerToken: m1.playerToken }); await once(a, 'whot:joined');
    b.emit('whot:reconnect', { code: m2.code, playerToken: m2.playerToken }); await once(b, 'whot:joined'); await wait(100);
    const room = whot.getRoom(m1.code); assert(room.tournament && !room.versus);
    const seat = room.tournament.accountIds.indexOf(winnerId); const res = once(a, 'versus-result', 8000);
    room.engine.gameOver = true; room.engine.winner = seat; const r = await res; a.disconnect(); b.disconnect(); return r;
  }
  const pairs = {}; for (const p of ps) { const m = pm[p.id]; (pairs[m.matchId] = pairs[m.matchId] || []).push(p); }
  const semis = Object.values(pairs); assert.strictEqual(semis.length, 2);
  const winners = []; for (const [x, y] of semis) { const r = await playMatch(pm[x.id], pm[y.id], x.id); assert.strictEqual(r.tournament, true); assert.strictEqual(r.winnerIndex >= 0, true); winners.push(x); }

  // final: winners get new matches over the socket; one of them never shows up -> walkover for the other
  await wait(300); const nm = winners.map(w => inbox[w.id].find(m => m.round === 2)); assert(nm.every(m => m && m.round === 2));
  const fa = io(base); await once(fa, 'connect'); fa.emit('whot:reconnect', { code: nm[0].code, playerToken: nm[0].playerToken }); await once(fa, 'whot:joined');
  whot.getRoom(nm[0].code).tournament.timeoutMs = 300; // shorten the no-show timer for the test
  const wr = await once(fa, 'versus-result', 8000); assert.strictEqual(wr.reason, 'walkover'); assert.strictEqual(wr.final, true); fa.disconnect();

  // results and money
  const done = await tournaments.get(t.id); assert.strictEqual(done.status, 'completed');
  const champ = byId[winners[0].id]; const first = done.results.find(r => r.place === 1); assert.strictEqual(first.accountId, winners[0].id);
  // pool = 200 guaranteed + 90% of 400 fees = 560 -> 60% / 30% / 10% shared by the two semi-final losers
  assert.strictEqual(first.prize, 336); assert.strictEqual(done.results.find(r => r.place === 2).prize, 168);
  assert.deepStrictEqual(done.results.filter(r => r.place === 3).map(r => r.prize), [28, 28]);
  assert.strictEqual(await champ.bal(), 900 + 336);
  // after the tournament players are free again
  assert.strictEqual(await tournaments.activeMatchFor(ps[0].id), null);
  for (const p of ps) assert((await wallet.audit(p.id)).ok);
  console.log('tournament live ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
