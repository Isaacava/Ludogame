'use strict';
// Public tournament API: browse, join/leave, and fetch my current match.
const express = require('express');
const { gameUrl } = require('../versus/versusRoutes');

function createTournamentRoutes({ accounts, tournaments }) {
  const router = express.Router();
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { console.error('[tournaments]', err && err.message); res.status(500).json({ error: 'server-error' }); });
  const optional = (fn) => wrap(async (req, res) => fn(req, res, await accounts.accountForToken(bearer(req))));
  const authed = (fn) => wrap(async (req, res) => { const a = await accounts.accountForToken(bearer(req)); if (!a) return res.status(401).json({ error: 'no-session' }); return fn(req, res, a); });
  router.use(express.json({ limit: '5kb' }));
  router.use((req, res, next) => { res.header('Cache-Control', 'no-store'); next(); });

  router.get('/', optional(async (req, res, me) => {
    const game = ['ludo', 'whot', 'chess', 'snooker'].includes(req.query.game) ? req.query.game : null;
    const all = await tournaments.list({ statuses: ['registration', 'running', 'completed'], game, limit: 200 });
    const dayAgo = Date.now() - 7 * 86400000;
    const rows = all.filter(t => t.status !== 'completed' || (t.finishedAt || 0) > dayAgo).map(t => tournaments.view(t, me && me.id));
    const order = { running: 0, registration: 1, completed: 2 };
    rows.sort((a, b) => order[a.status] - order[b.status] || (a.status === 'completed' ? b.startAt - a.startAt : a.startAt - b.startAt));
    res.json({ rows: rows.map(({ rounds, players, ...r }) => r) });
  }));
  router.get('/:id', optional(async (req, res, me) => {
    const t = await tournaments.get(req.params.id);
    if (!t || t.status === 'draft') return res.status(404).json({ error: 'not-found' });
    res.json({ tournament: tournaments.view(t, me && me.id) });
  }));
  router.post('/:id/join', authed(async (req, res, me) => {
    const r = await tournaments.join(me, req.params.id);
    if (r.error) return res.status(r.error === 'not-found' ? 404 : 409).json({ error: r.error });
    res.json(r);
  }));
  router.post('/:id/leave', authed(async (req, res, me) => {
    const r = await tournaments.leave(me, req.params.id);
    if (r.error) return res.status(r.error === 'not-found' ? 404 : 409).json({ error: r.error });
    res.json(r);
  }));
  router.get('/:id/my-match', authed(async (req, res, me) => {
    const m = await tournaments.myMatch(req.params.id, me.id);
    res.json({ match: m ? { ...m, url: gameUrl(m.game, m.code, m.playerToken, 2) } : null });
  }));
  return router;
}

module.exports = { createTournamentRoutes };
