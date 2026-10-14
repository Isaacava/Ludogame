'use strict';
// Admin API: login protection, overview, players (ban / adjust), deposit review, tournaments CRUD, runtime settings.
process.env.PORT = '3056'; process.env.ADMIN_PASSWORD = 'secret-pass'; process.env.CHIPS_TEST_TOPUP = '1'; process.env.NEW_ACCOUNT_MAX_STAKE = '100000';
const assert = require('assert');
const { accounts, wallet, deposits, versus } = require('../index');
const base = 'http://localhost:3056', wait = ms => new Promise(r => setTimeout(r, ms));
const call = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

(async () => {
  await wait(1000);
  // login protection
  assert.strictEqual((await call('GET', '/api/admin/overview')).status, 401);
  assert.strictEqual((await call('POST', '/api/admin/login', null, { password: 'nope' })).status, 401);
  const login = await call('POST', '/api/admin/login', null, { password: 'secret-pass' }); assert.strictEqual(login.status, 200);
  const A = (m, p, b) => call(m, '/api/admin' + p, login.body.token, b);

  // players + money to look at
  const a = await accounts.create({ email: 'ann@x.com', emailLower: 'ann@x.com', googleId: 'ga' }); await accounts.update(a.id, { username: 'Ann', usernameLower: 'ann', ageConfirmed: true });
  const b = await accounts.create({ email: 'bob@x.com', emailLower: 'bob@x.com', googleId: 'gb' }); await accounts.update(b.id, { username: 'Bob', usernameLower: 'bob' });
  await wallet.apply(a.id, { amount: 5000, type: 'test_topup' });
  await deposits.create({ id: 'dep1', accountId: a.id, usd: 10, chips: 1000, status: 'partially_paid', createdAt: new Date() });
  await deposits.create({ id: 'dep2', accountId: a.id, usd: 5, chips: 500, status: 'completed', createdAt: new Date(), paidAt: new Date() });

  const ov = (await A('GET', '/overview')).body;
  assert.strictEqual(ov.players.total, 2); assert.strictEqual(ov.money.chipsInCirculation, 5000); assert.strictEqual(ov.money.flagged, 1); assert.strictEqual(ov.money.depositsToday, 5);
  assert(ov.alerts.some(x => /manual review/.test(x.text)) && ov.alerts.some(x => /Test chips/.test(x.text)));
  assert.strictEqual(ov.rooms.ludo.rooms, 0);

  // search + detail
  const pl = (await A('GET', '/players?q=an')).body; assert.strictEqual(pl.rows.length, 1); assert.strictEqual(pl.rows[0].balance, 5000);
  const det = (await A('GET', '/players/' + a.id)).body; assert.strictEqual(det.account.username, 'Ann'); assert(det.ledger.length >= 1);

  // adjust chips with a reason; ledger stays consistent
  assert.strictEqual((await A('POST', `/players/${a.id}/adjust`, { amount: 100 })).body.error, 'reason-required');
  assert.strictEqual((await A('POST', `/players/${a.id}/adjust`, { amount: -999999, reason: 'too much' })).body.error, 'insufficient-chips');
  assert.strictEqual((await A('POST', `/players/${a.id}/adjust`, { amount: 250, reason: 'goodwill credit' })).body.balance, 5250);
  assert((await wallet.audit(a.id)).ok);

  // ban signs the player out everywhere; unban restores
  const tok = await accounts.createSession(b.id); assert((await accounts.accountForToken(tok)));
  assert.strictEqual((await A('POST', `/players/${b.id}/ban`, { reason: 'cheating' })).status, 200);
  assert.strictEqual(await accounts.accountForToken(tok), null);
  assert.strictEqual((await call('GET', '/api/versus/me', tok)).status, 401);
  await A('POST', `/players/${b.id}/unban`); assert((await accounts.accountForToken(tok)));

  // deposit review: credit what actually arrived, reject another, cannot resolve twice
  assert.strictEqual((await A('POST', '/deposits/dep1/resolve', { chips: 600 })).body.error, 'note-required');
  assert.strictEqual((await A('POST', '/deposits/dep1/resolve', { chips: 600, note: 'user paid $6 only' })).status, 200);
  assert.strictEqual(await wallet.balance(a.id), 5850); assert.strictEqual((await A('POST', '/deposits/dep1/resolve', { chips: 600, note: 'again' })).status, 409);
  assert.strictEqual((await A('GET', '/deposits')).body.rows.find(d => d.id === 'dep1').status, 'completed-manual');

  // finance + audit
  const fin = (await A('GET', '/finance')).body; assert(fin.byDay.some(r => r.type === 'admin_adjust')); assert.strictEqual(fin.summary.totalChips, 5850);
  const au = (await A('POST', '/audit')).body; assert.strictEqual(au.ok, true);

  // tournaments: create (validation), list, publish, edit, cancel
  assert((await A('POST', '/tournaments', { game: 'chess', name: 'x' })).body.errors.length > 1);
  const start = Date.now() + 86400000;
  const t = (await A('POST', '/tournaments', { game: 'ludo', name: 'Weekend Ludo Open', entryFee: 50, fixedPrize: 1000, minPlayers: 4, maxPlayers: 16, startAt: start, prizeSplit: '50,30,20', draft: true })).body.tournament;
  assert.strictEqual(t.status, 'draft');
  assert.strictEqual((await call('GET', '/api/tournaments')).body.rows.find(r => r.id === t.id), undefined); // drafts are hidden from players
  assert.strictEqual((await A('PATCH', '/tournaments/' + t.id, { entryFee: 75 })).body.tournament.entryFee, 75);
  assert.strictEqual((await A('POST', `/tournaments/${t.id}/publish`)).status, 200);
  assert((await call('GET', '/api/tournaments')).body.rows.find(r => r.id === t.id));
  assert.strictEqual((await A('GET', '/tournaments')).body.rows.find(r => r.id === t.id).entryFee, 75);
  assert.strictEqual((await A('POST', `/tournaments/${t.id}/cancel`)).status, 200); assert.strictEqual((await A('DELETE', '/tournaments/' + t.id)).status, 200);

  // runtime settings change live behaviour
  assert((await A('PATCH', '/settings/runtime', { versusFeeRate: 0.9 })).body.errors);
  const rs = (await A('PATCH', '/settings/runtime', { versusFeeRate: 0.05, versusGames: ['ludo'], versusStakes: [20, 100] })).body.values;
  assert.strictEqual(rs.versusFeeRate, 0.05); assert.strictEqual(versus.feeRate, 0.05); assert.deepStrictEqual(versus.games, ['ludo']); assert.deepStrictEqual(versus.stakes, [20, 100]);
  assert.strictEqual((await call('GET', '/api/versus/config')).body.stakes.length, 2);

  // logs + system
  const logs = (await A('GET', '/logs')).body.rows; assert(logs.some(r => r.action === 'ban') && logs.some(r => r.action === 'adjust') && logs.some(r => r.action === 'deposit-resolve'));
  const sys = (await A('GET', '/system')).body; assert(sys.uptimeSec >= 0 && sys.flags.testChips === true && sys.flags.adminPasswordSet === true);
  assert.strictEqual((await A('GET', '/rooms')).status, 200); assert.strictEqual((await A('GET', '/matches')).status, 200);

  // sign out ends the admin session
  await A('POST', '/logout'); assert.strictEqual((await A('GET', '/overview')).status, 401);
  console.log('admin api ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
