'use strict';
// REST endpoints for chips + versus, and the Socket.IO lobby (queue / cancel / matched).
const express = require('express');
const { CHIPS_PER_USD } = require('../wallet/chipWallet');

function createVersusRoutes({ accounts, wallet, versus, testTopup = process.env.CHIPS_TEST_TOPUP === '1' }) {
  const router = express.Router();
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { console.error('[versus]', err && err.message); res.status(500).json({ error: 'server-error' }); });
  const authed = (fn) => wrap(async (req, res) => {
    const account = await accounts.accountForToken(bearer(req));
    if (!account) return res.status(401).json({ error: 'no-session' });
    return fn(req, res, account);
  });
  router.use(express.json({ limit: '5kb' }));
  router.use((req, res, next) => { res.header('Cache-Control', 'no-store'); next(); });

  router.get('/config', (req, res) => res.json({ ...versus.config(), chipsPerUsd: CHIPS_PER_USD, testTopup }));

  router.get('/me', authed(async (req, res, account) => {
    res.json({
      balance: await wallet.balance(account.id), points: typeof account.points === 'number' ? account.points : 1000,
      wins: account.wins || 0, losses: account.losses || 0, weekly: account.weekly || null, ageConfirmed: !!account.ageConfirmed,
      queued: !!versus.queuedEntry(account.id)
    });
  }));
  router.get('/ledger', authed(async (req, res, account) => res.json({ rows: await wallet.history(account.id, 50) })));
  router.post('/confirm-age', authed(async (req, res, account) => {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'confirmation-required' });
    await accounts.update(account.id, { ageConfirmed: true, ageConfirmedAt: new Date() });
    res.json({ ok: true });
  }));
  // Test-only chips so versus can be tried before real deposits exist. Disabled unless CHIPS_TEST_TOPUP=1.
  router.post('/test-topup', authed(async (req, res, account) => {
    if (!testTopup) return res.status(403).json({ error: 'disabled' });
    const amount = Math.min(Math.max(parseInt(req.body && req.body.amount, 10) || 0, 0), 10000);
    if (!amount) return res.status(400).json({ error: 'invalid-amount' });
    const r = await wallet.apply(account.id, { amount, type: 'test_topup' });
    res.json({ balance: r.balance });
  }));
  router.get('/active', authed(async (req, res, account) => {
    const m = await versus.activeMatchFor(account.id);
    if (!m) return res.json({ match: null });
    res.json({ match: matchPayloadFor(m, account.id) });
  }));
  router.get('/leaderboard', wrap(async (req, res) => res.json({ rows: await versus.leaderboard(req.query.scope === 'all' ? 'all' : 'weekly', 20) })));
  return router;
}

function matchPayloadFor(match, accountId) {
  const idx = match.players.findIndex(p => p.accountId === accountId);
  return {
    matchId: match.id, game: match.game, stake: match.stake, code: match.room.code, playerToken: match.room.tokens[idx],
    opponent: match.players[idx === 0 ? 1 : 0].username, url: gameUrl(match.game, match.room.code, match.room.tokens[idx], match.players.length)
  };
}
function gameUrl(game, code, token, players) {
  if (game === 'ludo') return `/play.html?mode=friends&action=reconnect&code=${code}&playerToken=${token}&players=${players}`;
  if (game === 'whot') return `/whot.html?mode=friends&action=reconnect&code=${code}&playerToken=${token}&players=${players}`;
  if (game === 'chess') return `/chess.html?mode=friends&action=reconnect&code=${code}&playerToken=${token}`;
  return null;
}

// Socket.IO lobby: the client authenticates with its account token and joins the stake queue.
function attachVersusSockets({ io, accounts, wallet, versus }) {
  const sockets = new Map(); // accountId -> socket.id
  const toAccount = (accountId, event, payload) => { const sid = sockets.get(accountId); if (sid) io.to(sid).emit(event, payload); };
  versus.onEvent((ev) => {
    if (ev.type === 'matched') for (const p of ev.match.players) toAccount(p.accountId, 'versus-matched', matchPayloadFor(ev.match, p.accountId));
    if (ev.type === 'queue-timeout') toAccount(ev.accountId, 'versus-queue-timeout', { balance: ev.balance });
    if (ev.type === 'settled' || ev.type === 'cancelled') ev.players.forEach(async (id) => toAccount(id, 'wallet-update', { balance: await wallet.balance(id) }));
  });
  io.on('connection', (socket) => {
    socket.on('versus-queue', async ({ token, game, stake } = {}) => {
      try {
        const account = await accounts.accountForToken(token);
        if (!account) return socket.emit('versus-error', { error: 'no-session' });
        sockets.set(account.id, socket.id); socket.data.versusAccountId = account.id;
        const r = await versus.join(account, game, parseInt(stake, 10), {});
        if (r.error) return socket.emit('versus-error', r);
        if (r.queued) socket.emit('versus-queued', { game, stake: parseInt(stake, 10), balance: r.balance });
        else socket.emit('wallet-update', { balance: await wallet.balance(account.id) });
      } catch (err) { console.error('[versus] queue', err && err.message); socket.emit('versus-error', { error: 'server-error' }); }
    });
    socket.on('versus-cancel', async () => {
      const id = socket.data.versusAccountId; if (!id) return;
      const r = await versus.cancel(id); socket.emit('versus-cancelled', r.error ? r : { ok: true, balance: r.balance });
    });
    socket.on('versus-hello', async ({ token } = {}) => { // lobby page re-attaches after a reload
      const account = await accounts.accountForToken(token); if (!account) return;
      sockets.set(account.id, socket.id); socket.data.versusAccountId = account.id;
      const m = await versus.activeMatchFor(account.id); if (m) socket.emit('versus-matched', matchPayloadFor(m, account.id));
    });
    socket.on('disconnect', async () => {
      const id = socket.data.versusAccountId; if (!id) return;
      if (sockets.get(id) === socket.id) sockets.delete(id);
      // Leaving the lobby while still waiting returns the stake. A matched player is not queued, so this is a no-op for them.
      if (versus.queuedEntry(id)) await versus.cancel(id).catch(() => {});
    });
  });
}

module.exports = { createVersusRoutes, attachVersusSockets, matchPayloadFor, gameUrl };
