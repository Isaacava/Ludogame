'use strict';
// Admin monitoring + management API (all routes need an admin login).
const crypto = require('crypto');
const express = require('express');
const { requireAdmin } = require('../auth/adminAuth');
const { CHIPS_PER_USD } = require('../wallet/chipWallet');

function createAdminApi({ auth, accounts, wallet, deposits, versus, tournaments, social, clients, persistence, runtime, log, liveRooms, configStore }) {
  const router = express.Router();
  const guard = requireAdmin(auth);
  const wrap = (fn) => [guard, (req, res) => Promise.resolve(fn(req, res)).catch((err) => { console.error('[admin]', err && err.stack || err); res.status(500).json({ error: 'server-error' }); })];
  router.use(express.json({ limit: '50kb' }));
  const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };
  const daysAgo = (n) => new Date(Date.now() - n * 86400000);
  const usd = (chips) => Math.round(chips / CHIPS_PER_USD * 100) / 100;

  // ---------- overview ----------
  router.get('/overview', ...wrap(async (req, res) => {
    const [total, today, week, depRows, wsum, v24, v7] = await Promise.all([
      accounts.count(), accounts.count({ createdAt: { $gte: startOfDay() } }), accounts.count({ createdAt: { $gte: daysAgo(7) } }),
      deposits.recent(1000), wallet.summary(), versus.stats(86400000), versus.stats(7 * 86400000)]);
    const rooms = liveRooms(); const byGame = {};
    for (const g of ['ludo', 'whot', 'chess', 'snooker']) { const r = rooms.filter(x => x.game === g); byGame[g] = { rooms: r.length, playing: r.filter(x => x.started && !x.over).length, waiting: r.filter(x => !x.started).length }; }
    const tAll = await tournaments.list({ limit: 300 }); const tCount = {}; tAll.forEach(t => { tCount[t.status] = (tCount[t.status] || 0) + 1; });
    const done = depRows.filter(d => d.status === 'completed' || d.status === 'completed-manual');
    const sum = (rows, since) => rows.filter(d => new Date(d.paidAt || d.createdAt) >= since).reduce((a, d) => a + (d.usd || 0), 0);
    const flagged = depRows.filter(d => ['partially_paid', 'amount-mismatch'].includes(d.status));
    const players = social.presence.byAccount.size; let playing = 0; for (const id of social.presence.byAccount.keys()) if (social.presence.status(id) === 'playing') playing++;
    const alerts = [];
    if (flagged.length) alerts.push({ level: 'bad', text: `${flagged.length} deposit(s) need manual review`, go: 'money' });
    if (process.env.CHIPS_TEST_TOPUP === '1') alerts.push({ level: 'warn', text: 'Test chips are switched on (CHIPS_TEST_TOPUP=1). Turn this off before real deposits.', go: 'system' });
    if (!persistence || !persistence.db) alerts.push({ level: 'bad', text: 'MongoDB is not connected: accounts, chips and tournaments are lost on restart.', go: 'system' });
    if (!process.env.NOWPAYMENTS_API_KEY || !process.env.NOWPAYMENTS_IPN_SECRET) alerts.push({ level: 'warn', text: 'Crypto deposits are not configured (NOWPayments keys missing).', go: 'system' });
    if (!process.env.GOOGLE_CLIENT_ID) alerts.push({ level: 'warn', text: 'Google sign-in is not configured (GOOGLE_CLIENT_ID missing).', go: 'system' });
    if (!process.env.ADMIN_PASSWORD) alerts.push({ level: 'bad', text: 'ADMIN_PASSWORD is not set; the default password is in use.', go: 'system' });
    res.json({
      players: { total, today, week, online: players, playing, sockets: clients() },
      rooms: byGame, versus: { queues: versus.queueSnapshot(), open: v24.open, day: v24, week: v7 },
      tournaments: { counts: tCount, upcoming: tAll.filter(t => t.status === 'registration').sort((a, b) => a.startAt - b.startAt).slice(0, 5).map(t => ({ id: t.id, name: t.name, game: t.game, startAt: t.startAt, players: t.players.length, max: t.maxPlayers })) },
      money: { chipsInCirculation: wsum.totalChips, chipsUsd: usd(wsum.totalChips), wallets: wsum.wallets, houseChips: wsum.house, houseUsd: usd(wsum.house),
        depositsToday: sum(done, startOfDay()), deposits7d: sum(done, daysAgo(7)), depositsTotal: sum(done, new Date(0)), depositCount: done.length, pendingDeposits: depRows.filter(d => ['created', 'pending'].includes(d.status) && Date.now() - new Date(d.createdAt) < 3600e3).length, flagged: flagged.length },
      alerts
    });
  }));

  // ---------- live ----------
  router.get('/rooms', ...wrap(async (req, res) => res.json({ rooms: liveRooms().sort((a, b) => b.ageSec - a.ageSec).slice(0, 300), queues: versus.queueSnapshot() })));

  // ---------- players ----------
  router.get('/players', ...wrap(async (req, res) => {
    const page = Math.max(0, parseInt(req.query.page, 10) || 0), limit = 25;
    const r = await accounts.list({ q: req.query.q, skip: page * limit, limit });
    const rows = await Promise.all(r.rows.map(async a => ({ id: a.id, username: a.username || null, email: a.email || null, createdAt: a.createdAt, points: a.points ?? null, wins: a.wins || 0, losses: a.losses || 0, balance: await wallet.balance(a.id), ageConfirmed: !!a.ageConfirmed, banned: !!a.banned, online: social.presence.status(a.id) })));
    res.json({ total: r.total, page, rows });
  }));
  router.get('/players/:id', ...wrap(async (req, res) => {
    const a = await accounts.findById(req.params.id); if (!a) return res.status(404).json({ error: 'not-found' });
    const [balance, ledger, deps, friends, tAll] = await Promise.all([wallet.balance(a.id), wallet.history(a.id, 40), deposits.forAccount(a.id, 20), social.friendCount ? social.friendCount(a.id) : 0, tournaments.list({ limit: 300 })]);
    const matches = (await versus.recentMatches({ limit: 500 })).filter(m => m.players.some(p => p.accountId === a.id)).slice(0, 15).map(m => ({ id: m.id, game: m.game, stake: m.stake, status: m.status, result: m.result || null, win: m.winnerAccountId === a.id, createdAt: m.createdAt, kind: m.kind || 'queue' }));
    res.json({ account: { id: a.id, username: a.username, email: a.email, createdAt: a.createdAt, points: a.points ?? null, wins: a.wins || 0, losses: a.losses || 0, ageConfirmed: !!a.ageConfirmed, banned: !!a.banned, banReason: a.banReason || null, hasGoogle: !!a.googleId }, balance, ledger, deposits: deps, matches, friends,
      tournaments: tAll.filter(t => t.players.some(p => p.accountId === a.id)).map(t => ({ id: t.id, name: t.name, status: t.status, game: t.game })) });
  }));
  router.post('/players/:id/ban', ...wrap(async (req, res) => {
    const a = await accounts.findById(req.params.id); if (!a) return res.status(404).json({ error: 'not-found' });
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200); if (reason.length < 3) return res.status(400).json({ error: 'reason-required' });
    await accounts.update(a.id, { banned: true, banReason: reason, bannedAt: new Date() }); if (versus.queuedEntry(a.id)) await versus.cancel(a.id);
    social.push(a.id, 'banned', {}); await log.add('ban', a.id, { username: a.username, reason }); res.json({ ok: true });
  }));
  router.post('/players/:id/unban', ...wrap(async (req, res) => {
    const a = await accounts.findById(req.params.id); if (!a) return res.status(404).json({ error: 'not-found' });
    await accounts.update(a.id, { banned: false, banReason: null }); await log.add('unban', a.id, { username: a.username }); res.json({ ok: true });
  }));
  router.post('/players/:id/adjust', ...wrap(async (req, res) => {
    const a = await accounts.findById(req.params.id); if (!a) return res.status(404).json({ error: 'not-found' });
    const amount = parseInt(req.body && req.body.amount, 10), reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 10000000) return res.status(400).json({ error: 'invalid-amount' });
    if (reason.length < 3) return res.status(400).json({ error: 'reason-required' });
    const r = await wallet.apply(a.id, { amount, type: 'admin_adjust', meta: { reason }, key: 'adjust:' + crypto.randomUUID() });
    if (r.error) return res.status(409).json({ error: r.error === 'insufficient' ? 'insufficient-chips' : r.error });
    await log.add('adjust', a.id, { username: a.username, amount, reason }); res.json({ ok: true, balance: r.balance });
  }));

  // ---------- matches ----------
  router.get('/matches', ...wrap(async (req, res) => {
    const status = ['pending', 'active', 'settled', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const rows = await versus.recentMatches({ limit: 100, status });
    res.json({ rows: rows.map(m => ({ id: m.id, game: m.game, stake: m.stake, status: m.status, kind: m.kind || 'queue', players: m.players.map(p => p.username), winner: m.winnerAccountId ? (m.players.find(p => p.accountId === m.winnerAccountId) || {}).username : null, result: m.result || null, payout: m.payout || 0, fee: m.fee || 0, reason: m.reason || null, createdAt: m.createdAt, settledAt: m.settledAt || null })) });
  }));

  // ---------- money ----------
  router.get('/deposits', ...wrap(async (req, res) => {
    const rows = await deposits.recent(150); const names = new Map();
    for (const d of rows) if (!names.has(d.accountId)) { const a = await accounts.findById(d.accountId); names.set(d.accountId, a ? a.username : null); }
    res.json({ rows: rows.map(d => ({ id: d.id, accountId: d.accountId, username: names.get(d.accountId), usd: d.usd, chips: d.chips, status: d.status, createdAt: d.createdAt, paidAt: d.paidAt || null, nowPaymentId: d.nowPaymentId || null, note: d.note || null, last: (d.history || []).slice(-1)[0] || null, error: d.error || null })) });
  }));
  router.post('/deposits/:id/resolve', ...wrap(async (req, res) => {
    const d = await deposits.get(req.params.id); if (!d) return res.status(404).json({ error: 'not-found' });
    if (['completed', 'completed-manual', 'rejected'].includes(d.status)) return res.status(409).json({ error: 'already-resolved' });
    const chips = parseInt(req.body && req.body.chips, 10), note = String((req.body && req.body.note) || '').trim().slice(0, 200);
    if (!Number.isInteger(chips) || chips < 0 || chips > d.chips * 2) return res.status(400).json({ error: 'invalid-amount' }); if (note.length < 3) return res.status(400).json({ error: 'note-required' });
    if (chips > 0) await wallet.apply(d.accountId, { amount: chips, type: 'deposit', ref: d.id, key: `depositadmin:${d.id}`, meta: { manual: true, note } });
    await deposits.patch(d.id, { status: chips > 0 ? 'completed-manual' : 'rejected', note, resolvedChips: chips, paidAt: chips > 0 ? new Date() : null });
    await log.add('deposit-resolve', d.accountId, { depositId: d.id, chips, note }); res.json({ ok: true });
  }));
  router.get('/finance', ...wrap(async (req, res) => {
    const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 14));
    res.json({ summary: await wallet.summary(), byDay: await wallet.byDay(days), chipsPerUsd: CHIPS_PER_USD });
  }));
  router.post('/audit', ...wrap(async (req, res) => { const r = await wallet.auditAll(); await log.add('audit', null, { ok: r.ok, checked: r.checked, mismatches: r.mismatches.length }); res.json(r); }));
  router.get('/ledger', ...wrap(async (req, res) => {
    const filter = {}; if (req.query.accountId) filter.accountId = String(req.query.accountId); if (req.query.type) filter.type = String(req.query.type);
    res.json({ rows: await wallet.recentLedger(Math.min(300, parseInt(req.query.limit, 10) || 100), filter) });
  }));

  // ---------- tournaments ----------
  const adminView = (t) => ({ ...tournaments.view(t), fees: t.fees, poolInfo: t.pool || null, roundsTotal: t.roundsTotal || null, rake: t.rakePercent, feeToPool: t.feeToPool, matchTimeoutSec: t.matchTimeoutSec, chessBase: t.chessBase, chessInc: t.chessInc, createdAt: t.createdAt, finishedAt: t.finishedAt || null, status: t.status, repeatWeekly: !!t.repeatWeekly });
  router.get('/tournaments', ...wrap(async (req, res) => res.json({ rows: (await tournaments.list({ limit: 200 })).map(adminView).map(({ rounds, players, results, ...r }) => ({ ...r, playerCount: players.length })) })));
  router.get('/tournaments/:id', ...wrap(async (req, res) => { const t = await tournaments.get(req.params.id); if (!t) return res.status(404).json({ error: 'not-found' }); res.json({ tournament: adminView(t) }); }));
  router.post('/tournaments', ...wrap(async (req, res) => {
    const r = await tournaments.create(req.body || {}, { publish: !(req.body && req.body.draft) }); if (r.errors) return res.status(400).json({ errors: r.errors });
    await log.add('tournament-create', r.tournament.id, { name: r.tournament.name, game: r.tournament.game }); res.json({ tournament: adminView(r.tournament) });
  }));
  router.patch('/tournaments/:id', ...wrap(async (req, res) => {
    const r = await tournaments.update(req.params.id, req.body || {}); if (r.errors) return res.status(400).json({ errors: r.errors }); if (r.error) return res.status(r.error === 'not-found' ? 404 : 409).json({ error: r.error });
    await log.add('tournament-update', req.params.id, {}); res.json({ tournament: adminView(r.tournament) });
  }));
  for (const [name, fn] of [['publish', id => tournaments.publish(id)], ['cancel', id => tournaments.cancel(id, 'cancelled-by-admin')], ['start-now', id => tournaments.start(id)]]) {
    router.post(`/tournaments/:id/${name}`, ...wrap(async (req, res) => { const r = await fn(req.params.id); if (r.error) return res.status(r.error === 'not-found' ? 404 : 409).json({ error: r.error }); await log.add('tournament-' + name, req.params.id, {}); res.json({ ok: true, ...r }); }));
  }
  router.delete('/tournaments/:id', ...wrap(async (req, res) => { const r = await tournaments.remove(req.params.id); if (r.error) return res.status(409).json({ error: r.error }); await log.add('tournament-delete', req.params.id, {}); res.json({ ok: true }); }));

  // ---------- settings, logs, system ----------
  router.get('/settings/runtime', ...wrap(async (req, res) => res.json({ values: runtime.get() })));
  router.patch('/settings/runtime', ...wrap(async (req, res) => { const r = await runtime.set(req.body || {}); if (r.errors) return res.status(400).json({ errors: r.errors }); await log.add('settings', null, req.body); res.json({ values: r.value }); }));
  router.get('/logs', ...wrap(async (req, res) => res.json({ rows: await log.recent(150) })));
  router.get('/system', ...wrap(async (req, res) => {
    const mem = process.memoryUsage();
    res.json({ uptimeSec: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), mongo: !!(persistence && persistence.db), env: process.env.NODE_ENV || 'development',
      flags: { nowpayments: !!(process.env.NOWPAYMENTS_API_KEY && process.env.NOWPAYMENTS_IPN_SECRET), nowpaymentsSandbox: process.env.NOWPAYMENTS_SANDBOX === '1', google: !!process.env.GOOGLE_CLIENT_ID, testChips: process.env.CHIPS_TEST_TOPUP === '1', adminPasswordSet: !!process.env.ADMIN_PASSWORD, whatsappMeta: !!process.env.META_WHATSAPP_VERIFY_TOKEN, publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.SITE_URL || null },
      config: configStore ? configStore.getAll().maintenance : null });
  }));
  return router;
}
module.exports = { createAdminApi };
