'use strict';
// Tournament engine: registration + fee escrow, bracket with byes, results, draws, prizes, refunds, weekly repeat.
const assert = require('assert');
const { AccountStore } = require('../auth/accounts');
const { ChipWallet, HOUSE } = require('../wallet/chipWallet');
const { TournamentService, validateInput } = require('../tournaments/tournamentService');

(async () => {
  const accounts = new AccountStore(null), wallet = new ChipWallet(null);
  let clock = Date.UTC(2026, 9, 17, 12, 0, 0); const events = [], rooms = [];
  const svc = new TournamentService({ wallet, accounts, now: () => clock,
    createRoom: async (game, profiles, extra) => { const r = { code: 'R' + rooms.length, tokens: ['a' + rooms.length, 'b' + rooms.length], game, profiles, extra }; rooms.push(r); return r; },
    notify: (id, ev, p) => events.push([id, ev, p]) });
  const mk = async (name, chips = 1000, age = true) => { const a = await accounts.create({ email: name + '@x', emailLower: name + '@x', googleId: 'g' + name }); await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), ageConfirmed: age }); if (chips) await wallet.apply(a.id, { amount: chips, type: 'test_topup' }); return accounts.findById(a.id); };
  const P = []; for (const n of ['P1', 'P2', 'P3', 'P4', 'P5']) P.push(await mk(n));
  const bal = async p => wallet.balance(p.id);

  // validation
  assert(validateInput({ game: 'go', name: 'x', startAt: 'nope', prizeSplit: [60, 30] }).errors.length >= 3);
  assert(validateInput({ game: 'ludo', name: 'Weekend Ludo', startAt: clock + 1000, prizeSplit: '50,30,20' }).value);

  const startAt = clock + 3600e3;
  const { tournament: t } = await svc.create({ game: 'chess', name: 'Sunday Chess Cup', entryFee: 100, fixedPrize: 400, rakePercent: 10, minPlayers: 4, maxPlayers: 4, startAt, chessBase: 180 });
  assert.strictEqual(t.status, 'registration');

  // registration
  const poor = await mk('Poor', 50); assert.strictEqual((await svc.join(poor, t.id)).error, 'insufficient-chips');
  const young = await mk('Young', 500, false); assert.strictEqual((await svc.join(young, t.id)).error, 'age-confirmation-required');
  for (const p of P.slice(0, 4)) assert((await svc.join(p, t.id)).ok);
  assert.strictEqual((await svc.join(P[0], t.id)).error, 'already-joined'); assert.strictEqual((await svc.join(P[4], t.id)).error, 'tournament-full');
  assert.strictEqual(await bal(P[0]), 900);
  assert.strictEqual((await svc.leave(P[3], t.id)).ok, true); assert.strictEqual(await bal(P[3]), 1000);
  assert((await svc.join(P[3], t.id)).ok);
  assert.strictEqual(svc.inPool(await svc.get(t.id)), 400 + 360);
  assert.strictEqual(await svc.tick(), 0); // not due yet

  // start -> 2 semi-finals as private rooms with the chess clock
  clock = startAt + 1000; assert.strictEqual(await svc.tick(), 1);
  let cur = await svc.get(t.id); assert.strictEqual(cur.status, 'running'); assert.strictEqual(cur.rounds[0].matches.length, 2); assert.strictEqual(rooms.length, 2);
  assert(rooms.every(r => r.game === 'chess' && r.extra.tournamentId === t.id && r.extra.chess.base === 180));
  assert.strictEqual((await svc.join(poor, t.id)).error, 'registration-closed');
  assert.strictEqual(events.filter(e => e[1] === 'tournament-match').length, 4);
  const m0 = cur.rounds[0].matches[0], m1 = cur.rounds[0].matches[1];
  assert((await svc.activeMatchFor(m0.a)).tournamentId === t.id);
  const mine = await svc.myMatch(t.id, m0.a); assert.strictEqual(mine.matchId, m0.id); assert(mine.playerToken);

  // results advance winners; wrong winner / double report rejected
  assert.strictEqual((await svc.reportResult(t.id, m0.id, 'stranger')).error, 'invalid-winner');
  assert((await svc.reportResult(t.id, m0.id, m0.a)).ok); assert.strictEqual((await svc.reportResult(t.id, m0.id, m0.b)).error, 'match-not-active');
  cur = await svc.get(t.id); assert.strictEqual(cur.rounds.length, 1); // final not created until both semis are done
  assert((await svc.reportResult(t.id, m1.id, m1.a)).ok);
  cur = await svc.get(t.id); assert.strictEqual(cur.rounds.length, 2); const fin = cur.rounds[1].matches[0]; assert.strictEqual(fin.status, 'active'); assert.strictEqual(rooms.length, 3);
  const fw = m0.a, fl = m1.a; // winner is whoever; decide final
  const done = await svc.reportResult(t.id, fin.id, fin.a); assert.strictEqual(done.status, 'completed');
  cur = await svc.get(t.id); assert.strictEqual(cur.status, 'completed');
  const byPlace = p => cur.results.filter(r => r.place === p);
  assert.strictEqual(byPlace(1)[0].prize, 380); assert.strictEqual(byPlace(2)[0].prize, 228); assert.strictEqual(byPlace(3).length, 2); assert(byPlace(3).every(r => r.prize === 76));
  assert.strictEqual(cur.pool.paid, 380 + 228 + 152); assert.strictEqual(cur.pool.houseFees, 40);
  assert.strictEqual(await wallet.balance(HOUSE), 40);
  for (const p of P) assert((await wallet.audit(p.id)).ok); assert((await wallet.audit(HOUSE)).ok);
  assert.strictEqual(await svc.reportResult(t.id, fin.id, fin.a).then(r => r.error), 'not-running');

  // 3 players -> one bye; draws replay once then seed decides
  clock += 1000; const s2 = clock + 1000;
  const { tournament: t2 } = await svc.create({ game: 'whot', name: 'Whot Night', entryFee: 0, fixedPrize: 300, minPlayers: 3, maxPlayers: 8, startAt: s2, prizeSplit: [100] });
  for (const p of P.slice(0, 3)) assert((await svc.join(p, t2.id)).ok); clock = s2 + 5; await svc.tick();
  let c2 = await svc.get(t2.id); const real = c2.rounds[0].matches.find(m => m.b); const bye = c2.rounds[0].matches.find(m => !m.b);
  assert.strictEqual(bye.status, 'done'); assert.strictEqual(bye.reason, 'bye'); assert.strictEqual(c2.roundsTotal, 2);
  const before = rooms.length; const rp = await svc.reportResult(t2.id, real.id, null); assert(rp.replay); assert.strictEqual(rooms.length, before + 1); // draw -> replay
  const real2 = (await svc.get(t2.id)).rounds[0].matches.find(m => m.b); assert.notStrictEqual(real2.room.code, real.room.code);
  const tb = await svc.reportResult(t2.id, real2.id, null); assert.strictEqual(tb.reason, 'draw-tiebreak');
  c2 = await svc.get(t2.id); const f2 = c2.rounds[1].matches[0]; assert.strictEqual(f2.status, 'active');
  await svc.reportResult(t2.id, f2.id, f2.b); c2 = await svc.get(t2.id); assert.strictEqual(c2.status, 'completed');
  assert.strictEqual(c2.results.find(r => r.place === 1).prize, 300); assert.strictEqual(c2.results.filter(r => r.place === 3).length, 1); // single semi loser gets 3rd, split has no 3rd share

  // not enough players -> cancelled, fees refunded
  clock += 1000; const s3 = clock + 1000;
  const { tournament: t3 } = await svc.create({ game: 'ludo', name: 'Ludo Open', entryFee: 200, minPlayers: 4, maxPlayers: 16, startAt: s3, repeatWeekly: true });
  const b0 = await bal(P[0]); await svc.join(P[0], t3.id); await svc.join(P[1], t3.id); assert.strictEqual(await bal(P[0]), b0 - 200);
  clock = s3 + 10; await svc.tick(); const c3 = await svc.get(t3.id); assert.strictEqual(c3.status, 'cancelled'); assert.strictEqual(c3.cancelReason, 'not-enough-players'); assert.strictEqual(await bal(P[0]), b0);
  const all = await svc.list({ statuses: ['registration'] }); const rep = all.find(x => x.name === 'Ludo Open'); assert(rep && rep.startAt === s3 + 7 * 86400000 && rep.players.length === 0); // weekly repeat re-opens it

  // admin cancel of a running tournament refunds everyone; drafts are hidden until published
  clock += 1000; const s4 = clock + 1000;
  const { tournament: t4 } = await svc.create({ game: 'ludo', name: 'Cancelled Cup', entryFee: 100, minPlayers: 2, maxPlayers: 8, startAt: s4 }, { publish: false });
  assert.strictEqual(t4.status, 'draft'); assert.strictEqual((await svc.join(P[0], t4.id)).error, 'registration-closed'); await svc.publish(t4.id);
  await svc.join(P[0], t4.id); await svc.join(P[1], t4.id); clock = s4 + 5; await svc.tick(); assert.strictEqual((await svc.get(t4.id)).status, 'running');
  const bb = await bal(P[0]); const cc = await svc.cancel(t4.id); assert.strictEqual(cc.refunded, 2); assert.strictEqual(await bal(P[0]), bb + 100); assert.strictEqual((await svc.cancel(t4.id)).error, 'already-closed');
  for (const p of P) assert((await wallet.audit(p.id)).ok);

  // view hides room tokens
  const v = svc.view(await svc.get(t.id), P[0].id); assert(!JSON.stringify(v).includes('tokens') && v.joined === true);
  console.log('tournament ok');
})().catch(e => { console.error(e); process.exit(1); });
