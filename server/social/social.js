'use strict';
// Friends online + invites.
//  - Presence: a player is "online" while any page holds a social socket for them, "playing" while a game page does.
//  - Invites: a friend who is online can be invited to a normal match or a staked match (60s to answer).
//    A normal match is a private room with no chips. A staked match locks both stakes the moment it is accepted.
const crypto = require('crypto');
const express = require('express');
const { matchPayloadFor, gameUrl } = require('../versus/versusRoutes');

const INVITE_TTL_MS = 60 * 1000;
const GAMES = ['ludo', 'whot', 'chess'];
const limiter = ({ windowMs, max }) => { const h = new Map(); return (k) => { const n = Date.now(), a = (h.get(k) || []).filter(t => n - t < windowMs); a.push(n); h.set(k, a); return a.length <= max; }; };

class Presence {
  constructor() { this.bySocket = new Map(); this.byAccount = new Map(); }
  add(accountId, socketId, where) {
    this.bySocket.set(socketId, { accountId, where }); const s = this.byAccount.get(accountId) || new Set(); s.add(socketId); this.byAccount.set(accountId, s);
  }
  remove(socketId) {
    const e = this.bySocket.get(socketId); if (!e) return null;
    this.bySocket.delete(socketId); const s = this.byAccount.get(e.accountId); if (s) { s.delete(socketId); if (!s.size) this.byAccount.delete(e.accountId); }
    return e.accountId;
  }
  socketIds(accountId) { return [...(this.byAccount.get(accountId) || [])]; }
  status(accountId) {
    const s = this.byAccount.get(accountId); if (!s || !s.size) return 'offline';
    for (const id of s) { const e = this.bySocket.get(id); if (e && GAMES.includes(e.where)) return 'playing'; }
    return 'online';
  }
}

function createSocial({ io, accounts, friends, versus, wallet, createFriendlyRoom, ttlMs = INVITE_TTL_MS }) {
  const presence = new Presence();
  const invites = new Map(); // id -> invite (short-lived, memory only)
  const router = express.Router();
  const reqLimit = limiter({ windowMs: 10 * 60 * 1000, max: 40 }), searchLimit = limiter({ windowMs: 60 * 1000, max: 40 });

  const push = (accountId, event, payload) => { for (const sid of presence.socketIds(accountId)) io.to(sid).emit(event, payload); };
  const statusOf = (accountId) => { const s = presence.status(accountId); return s !== 'offline' && versus.queuedEntry(accountId) ? 'playing' : s; };
  const pub = (a) => ({ accountId: a.id, username: a.username, color: a.color || null });
  const inviteView = (inv) => ({ inviteId: inv.id, game: inv.game, stake: inv.stake, expiresAt: inv.expiresAt, status: inv.status, from: inv.from, to: inv.to });

  async function broadcastPresence(accountId) {
    const status = statusOf(accountId);
    for (const fid of await friends.friendIds(accountId)) push(fid, 'presence', { accountId, status });
  }
  function closeInvite(inv, status, extra = {}) {
    if (inv.status !== 'pending') return false;
    inv.status = status;
    const payload = { inviteId: inv.id, status, ...extra };
    push(inv.from.accountId, 'invite-update', payload); push(inv.to.accountId, 'invite-update', payload);
    setTimeout(() => invites.delete(inv.id), 60 * 1000).unref();
    return true;
  }
  const sweep = setInterval(() => { const n = Date.now(); for (const inv of invites.values()) if (inv.status === 'pending' && n > inv.expiresAt) closeInvite(inv, 'expired'); }, 1000);
  sweep.unref();
  const pendingFor = (id, dir) => [...invites.values()].filter(i => i.status === 'pending' && i[dir].accountId === id && Date.now() <= i.expiresAt);

  // ---------- auth helpers ----------
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { console.error('[social]', err && err.message); res.status(500).json({ error: 'server-error' }); });
  const authed = (fn) => wrap(async (req, res) => { const a = await accounts.accountForToken(bearer(req)); if (!a) return res.status(401).json({ error: 'no-session' }); if (!a.usernameLower) return res.status(400).json({ error: 'username-required' }); return fn(req, res, a); });
  router.use(express.json({ limit: '5kb' }));
  router.use((req, res, next) => { res.header('Cache-Control', 'no-store'); next(); });

  // ---------- friends ----------
  router.get('/friends', authed(async (req, res, me) => {
    const l = await friends.list(me.id);
    l.friends.forEach(f => { f.status = statusOf(f.accountId); });
    res.json({ ...l, config: { games: versus.games, stakes: versus.stakes, chipsPerUsd: Number(process.env.CHIPS_PER_USD) || 100 } });
  }));
  router.get('/search', authed(async (req, res, me) => {
    if (!searchLimit('s|' + me.id)) return res.status(429).json({ error: 'too-many-attempts' });
    res.json({ rows: await friends.search(req.query.q, me.id) });
  }));
  router.post('/friends/request', authed(async (req, res, me) => {
    if (!reqLimit('r|' + me.id)) return res.status(429).json({ error: 'too-many-attempts' });
    const r = await friends.request(me.id, req.body && req.body.username);
    if (r.error) return res.status(r.error === 'user-not-found' ? 404 : 409).json({ error: r.error });
    if (r.autoAccepted) { push(r.target.id, 'social-update', { kind: 'request-accepted', username: me.username }); push(me.id, 'social-update', { kind: 'friends-changed' }); }
    else push(r.target.id, 'social-update', { kind: 'request-received', username: me.username });
    res.json({ ok: true, autoAccepted: !!r.autoAccepted, username: r.target.username });
  }));
  router.post('/friends/:id/accept', authed(async (req, res, me) => {
    const r = await friends.accept(req.params.id, me.id);
    if (r.error) return res.status(404).json({ error: r.error });
    push(r.otherId, 'social-update', { kind: 'request-accepted', username: me.username }); push(me.id, 'social-update', { kind: 'friends-changed' });
    await broadcastPresence(me.id); const o = statusOf(r.otherId); push(me.id, 'presence', { accountId: r.otherId, status: o });
    res.json({ ok: true });
  }));
  router.delete('/friends/:id', authed(async (req, res, me) => {
    const r = await friends.end(req.params.id, me.id);
    if (r.error) return res.status(404).json({ error: r.error });
    push(r.otherId, 'social-update', { kind: 'friends-changed' }); push(me.id, 'social-update', { kind: 'friends-changed' });
    res.json({ ok: true });
  }));

  // ---------- invites ----------
  router.get('/invites', authed(async (req, res, me) => res.json({ incoming: pendingFor(me.id, 'to').map(inviteView), outgoing: pendingFor(me.id, 'from').map(inviteView) })));

  router.post('/invite', authed(async (req, res, me) => {
    if (!reqLimit('i|' + me.id)) return res.status(429).json({ error: 'too-many-attempts' });
    const { username, game } = req.body || {}; const stake = parseInt(req.body && req.body.stake, 10) || 0;
    if (!versus.games.includes(game)) return res.status(400).json({ error: 'game-unavailable' });
    if (stake && !versus.stakes.includes(stake)) return res.status(400).json({ error: 'invalid-stake' });
    const target = await accounts.findByUsername(username);
    if (!target || !target.usernameLower) return res.status(404).json({ error: 'user-not-found' });
    if (!(await friends.areFriends(me.id, target.id))) return res.status(403).json({ error: 'not-friends' });
    const st = statusOf(target.id);
    if (st === 'offline') return res.status(409).json({ error: 'friend-offline' });
    if (st === 'playing') return res.status(409).json({ error: 'friend-busy' });
    if (statusOf(me.id) === 'playing' || await versus.isBusy(me.id)) return res.status(409).json({ error: 'you-are-busy' });
    if (pendingFor(me.id, 'from').length) return res.status(409).json({ error: 'invite-pending' });
    if (pendingFor(target.id, 'to').length >= 3) return res.status(409).json({ error: 'friend-busy' });
    if (stake) {
      if (!me.ageConfirmed) return res.status(400).json({ error: 'age-confirmation-required' });
      if (stake > versus.stakeCapFor(me)) return res.status(400).json({ error: 'stake-too-high-for-new-account', max: versus.stakeCapFor(me) });
      if ((await wallet.balance(me.id)) < stake) return res.status(400).json({ error: 'insufficient-chips' });
    }
    const inv = { id: crypto.randomUUID(), game, stake, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + ttlMs, from: pub(me), to: pub(target) };
    invites.set(inv.id, inv);
    push(target.id, 'friend-invite', inviteView(inv));
    res.json({ ok: true, invite: inviteView(inv) });
  }));

  router.post('/invite/:id/cancel', authed(async (req, res, me) => {
    const inv = invites.get(req.params.id);
    if (!inv || inv.from.accountId !== me.id) return res.status(404).json({ error: 'invite-not-found' });
    res.json({ ok: closeInvite(inv, 'cancelled') });
  }));
  router.post('/invite/:id/decline', authed(async (req, res, me) => {
    const inv = invites.get(req.params.id);
    if (!inv || inv.to.accountId !== me.id) return res.status(404).json({ error: 'invite-not-found' });
    res.json({ ok: closeInvite(inv, 'declined') });
  }));
  router.post('/invite/:id/accept', authed(async (req, res, me) => {
    const inv = invites.get(req.params.id);
    if (!inv || inv.to.accountId !== me.id) return res.status(404).json({ error: 'invite-not-found' });
    if (inv.status !== 'pending') return res.status(409).json({ error: 'invite-' + inv.status });
    if (Date.now() > inv.expiresAt) { closeInvite(inv, 'expired'); return res.status(409).json({ error: 'invite-expired' }); }
    const sender = await accounts.findById(inv.from.accountId);
    if (presence.status(sender.id) === 'offline') { closeInvite(inv, 'expired', { reason: 'sender-left' }); return res.status(409).json({ error: 'invite-expired' }); }
    for (const a of [sender, me]) if (await versus.isBusy(a.id)) { closeInvite(inv, 'failed', { error: 'match-in-progress', who: a.id }); return res.status(409).json({ error: a.id === me.id ? 'you-are-busy' : 'friend-busy' }); }
    inv.status = 'accepting'; // claim it so a double tap cannot start two matches

    if (inv.stake) {
      const r = await versus.challenge(sender, me, inv.game, inv.stake);
      if (r.error) {
        inv.status = 'pending'; closeInvite(inv, 'failed', { error: r.error, who: r.who });
        return res.status(409).json({ error: r.error, mine: r.who === me.id, max: r.max });
      }
      const m = r.match;
      for (const p of m.players) { const payload = { ...matchPayloadFor(m, p.accountId), inviteId: inv.id }; push(p.accountId, 'match-ready', payload); }
      inv.status = 'accepted'; push(sender.id, 'invite-update', { inviteId: inv.id, status: 'accepted' });
      return res.json({ ok: true, match: matchPayloadFor(m, me.id) });
    }
    const pair = Math.random() < 0.5 ? [sender, me] : [me, sender]; // random seats, so nobody always moves first
    const room = await createFriendlyRoom(inv.game, pair.map(a => ({ username: a.username, color: a.color })));
    const view = (a) => { const i = pair.findIndex(x => x.id === a.id); const opp = pair[1 - i]; return { inviteId: inv.id, game: inv.game, stake: 0, code: room.code, playerToken: room.tokens[i], opponent: opp.username, url: gameUrl(inv.game, room.code, room.tokens[i], 2) }; };
    push(sender.id, 'match-ready', view(sender)); push(me.id, 'match-ready', view(me));
    inv.status = 'accepted'; push(sender.id, 'invite-update', { inviteId: inv.id, status: 'accepted' });
    res.json({ ok: true, match: view(me) });
  }));

  // ---------- sockets ----------
  function attach() {
    io.on('connection', (socket) => {
      socket.on('social-hello', async ({ token, where } = {}) => {
        try {
          const a = await accounts.accountForToken(token); if (!a || !a.usernameLower) return;
          const w = GAMES.includes(where) ? where : 'site';
          const before = statusOf(a.id);
          socket.data.socialAccountId = a.id; presence.add(a.id, socket.id, w);
          if (statusOf(a.id) !== before) await broadcastPresence(a.id);
          const l = await friends.list(a.id);
          socket.emit('social-ready', { requests: l.incoming.length, invites: pendingFor(a.id, 'to').map(inviteView) });
        } catch (err) { console.error('[social] hello', err && err.message); }
      });
      socket.on('disconnect', async () => {
        const id = presence.remove(socket.id); if (!id) return;
        try { await broadcastPresence(id); } catch (e) { /* ignore */ }
        // A pending invite from someone who left the site cannot be answered any more.
        for (const inv of pendingFor(id, 'from')) if (presence.status(id) === 'offline') closeInvite(inv, 'cancelled', { reason: 'sender-left' });
      });
    });
  }

  return { router, attach, presence, invites, push, statusOf };
}

module.exports = { createSocial, Presence, INVITE_TTL_MS };
