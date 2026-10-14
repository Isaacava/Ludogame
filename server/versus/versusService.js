'use strict';
// Versus mode: players lock a chip stake, get paired at random with someone at the same game+stake,
// play one match, and the winner takes both stakes minus the house fee.
//   - Stakes are locked in escrow (taken from the wallet) the moment a player joins the queue.
//   - A match is settled exactly once (atomic status change); settle/cancel/refund are idempotent ledger keys.
//   - The game server decides the result. This service only moves chips and points.
const crypto = require('crypto');
const { HOUSE } = require('../wallet/chipWallet');

const STAKES = [10, 20, 50, 100, 500, 1000, 5000, 10000];
const FEE_RATE = Number(process.env.VERSUS_FEE_RATE) >= 0 && process.env.VERSUS_FEE_RATE !== undefined && process.env.VERSUS_FEE_RATE !== '' ? Number(process.env.VERSUS_FEE_RATE) : 0.10;
const START_POINTS = 1000, K_FACTOR = 32;
const weekKey = (d = new Date()) => { // ISO-style week, e.g. 2026-W42 (Monday start, UTC)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
};

// Points are Elo-style: beating a stronger player is worth more, losing to a weaker one costs more. Never below 0.
function eloDelta(winnerPts, loserPts) {
  const expected = 1 / (1 + Math.pow(10, (loserPts - winnerPts) / 400));
  const gain = Math.max(1, Math.round(K_FACTOR * (1 - expected)));
  return { gain, loss: gain };
}

class VersusService {
  constructor({ wallet, accounts, persistence = null, games = ['ludo', 'whot', 'chess'], createRoom, feeRate = FEE_RATE, stakes = STAKES, now = () => Date.now() }) {
    this.wallet = wallet; this.accounts = accounts; this.persistence = persistence;
    this.games = games; this.createRoom = createRoom; this.feeRate = feeRate; this.stakes = stakes; this.now = now;
    this.queues = new Map();       // `${game}:${stake}` -> [entry]
    this.memMatches = new Map();   // id -> match (memory backend)
    this.listeners = new Set();
  }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }
  onEvent(fn) { this.listeners.add(fn); }
  _emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.error('[versus] listener', e && e.message); } } }

  config() { return { games: this.games, stakes: this.stakes, feeRate: this.feeRate }; }

  // ---------- match storage (Mongo or memory) ----------
  async _saveMatch(m) {
    if (this._db) { await this._db.collection('versus_matches').insertOne({ ...m }); return; }
    this.memMatches.set(m.id, { ...m });
  }
  async getMatch(id) {
    if (this._db) { const m = await this._db.collection('versus_matches').findOne({ id }); if (!m) return null; const { _id, ...r } = m; return r; }
    const m = this.memMatches.get(id); return m ? { ...m } : null;
  }
  async _patchMatch(id, patch) {
    if (this._db) await this._db.collection('versus_matches').updateOne({ id }, { $set: patch });
    else { const m = this.memMatches.get(id); if (m) Object.assign(m, patch); }
  }
  // Atomically move a match out of an open status. Returns true only for the single caller that wins the race.
  async _claim(id, fromStatuses, toStatus) {
    if (this._db) {
      const r = await this._db.collection('versus_matches').updateOne({ id, status: { $in: fromStatuses } }, { $set: { status: toStatus, closedAt: new Date() } });
      return r.modifiedCount === 1;
    }
    const m = this.memMatches.get(id);
    if (!m || !fromStatuses.includes(m.status)) return false;
    m.status = toStatus; m.closedAt = new Date(); return true;
  }
  async activeMatchFor(accountId) {
    const open = ['pending', 'active'];
    if (this._db) { const m = await this._db.collection('versus_matches').findOne({ 'players.accountId': accountId, status: { $in: open } }, { sort: { createdAt: -1 } }); if (!m) return null; const { _id, ...r } = m; return r; }
    return [...this.memMatches.values()].filter(m => open.includes(m.status) && m.players.some(p => p.accountId === accountId)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  // ---------- queue ----------
  async isBusy(accountId) { return !!(this.queuedEntry(accountId) || (await this.activeMatchFor(accountId)) || (this.extraBusy && (await this.extraBusy(accountId)))); }
  _qkey(game, stake) { return `${game}:${stake}`; }
  queuedEntry(accountId) { for (const q of this.queues.values()) { const e = q.find(x => x.accountId === accountId); if (e) return e; } return null; }
  queueSize() { let n = 0; for (const q of this.queues.values()) n += q.length; return n; }

  async join(account, game, stake, ctx = {}) {
    if (!this.games.includes(game)) return { error: 'game-unavailable' };
    if (!this.stakes.includes(stake)) return { error: 'invalid-stake' };
    if (!account || !account.usernameLower) return { error: 'username-required' };
    if (!account.ageConfirmed) return { error: 'age-confirmation-required' };
    const cap = this.stakeCapFor(account);
    if (stake > cap) return { error: 'stake-too-high-for-new-account', max: cap };
    if (this.queuedEntry(account.id)) return { error: 'already-queued' };
    if (await this.activeMatchFor(account.id) || (this.extraBusy && await this.extraBusy(account.id))) return { error: 'match-in-progress' };

    const entry = { entryId: crypto.randomUUID(), accountId: account.id, game, stake, joinedAt: this.now(), ctx };
    const lock = await this.wallet.apply(account.id, { amount: -stake, type: 'stake_lock', ref: entry.entryId, key: `lock:${entry.entryId}` });
    if (lock.error) return { error: lock.error === 'insufficient' ? 'insufficient-chips' : lock.error };

    const key = this._qkey(game, stake);
    const q = this.queues.get(key) || []; this.queues.set(key, q);
    const idx = q.findIndex(x => x.accountId !== account.id);
    if (idx === -1) { q.push(entry); return { queued: true, entryId: entry.entryId, balance: lock.balance }; }
    const opp = q.splice(idx, 1)[0];
    // Randomise who gets seat 0 so there is no first-mover advantage for whoever queued first.
    const pair = Math.random() < 0.5 ? [opp, entry] : [entry, opp];
    try {
      const match = await this._createMatch(game, stake, pair);
      return { queued: false, matched: true, match, balance: lock.balance };
    } catch (err) {
      console.error('[versus] match creation failed', err && err.message);
      await this._refundEntry(opp, 'match-error'); await this._refundEntry(entry, 'match-error');
      return { error: 'match-failed' };
    }
  }

  // A staked match agreed between two friends. Both stakes lock now; returns the match or { error }.
  async challenge(accountA, accountB, game, stake) {
    if (!this.games.includes(game)) return { error: 'game-unavailable' };
    if (!this.stakes.includes(stake)) return { error: 'invalid-stake' };
    for (const a of [accountA, accountB]) {
      if (!a || !a.usernameLower) return { error: 'username-required', who: a && a.id };
      if (!a.ageConfirmed) return { error: 'age-confirmation-required', who: a.id };
      if (stake > this.stakeCapFor(a)) return { error: 'stake-too-high-for-new-account', who: a.id, max: this.stakeCapFor(a) };
      if (this.queuedEntry(a.id)) return { error: 'already-queued', who: a.id };
      if (await this.activeMatchFor(a.id) || (this.extraBusy && await this.extraBusy(a.id))) return { error: 'match-in-progress', who: a.id };
    }
    const entries = [accountA, accountB].map(a => ({ entryId: crypto.randomUUID(), accountId: a.id, game, stake, joinedAt: this.now() }));
    const locked = [];
    for (const e of entries) {
      const r = await this.wallet.apply(e.accountId, { amount: -stake, type: 'stake_lock', ref: e.entryId, key: `lock:${e.entryId}` });
      if (r.error) { for (const l of locked) await this._refundEntry(l, 'challenge-failed'); return { error: r.error === 'insufficient' ? 'insufficient-chips' : r.error, who: e.accountId }; }
      locked.push(e);
    }
    try { return { match: await this._createMatch(game, stake, entries, 'friend') }; }
    catch (err) { console.error('[versus] challenge failed', err && err.message); for (const l of locked) await this._refundEntry(l, 'match-error'); return { error: 'match-failed' }; }
  }

  stakeCapFor(account) {
    const ageMs = this.now() - new Date(account.createdAt || 0).getTime();
    const cap = this.newAccountMaxStake !== undefined ? this.newAccountMaxStake : (Number(process.env.NEW_ACCOUNT_MAX_STAKE) || 1000);
    return ageMs < 24 * 60 * 60 * 1000 ? cap : Infinity;
  }

  async cancel(accountId) {
    const e = this.queuedEntry(accountId); if (!e) return { error: 'not-queued' };
    const q = this.queues.get(this._qkey(e.game, e.stake)); q.splice(q.indexOf(e), 1);
    const r = await this._refundEntry(e, 'cancelled');
    return { ok: true, balance: r.balance };
  }
  async sweepQueue(maxWaitMs = 5 * 60 * 1000) {
    const expired = [];
    for (const q of this.queues.values()) for (const e of [...q]) if (this.now() - e.joinedAt > maxWaitMs) { q.splice(q.indexOf(e), 1); expired.push(e); }
    for (const e of expired) { const r = await this._refundEntry(e, 'queue-timeout'); this._emit({ type: 'queue-timeout', accountId: e.accountId, balance: r.balance }); }
    return expired.length;
  }
  async _refundEntry(e, reason) {
    return this.wallet.apply(e.accountId, { amount: e.stake, type: 'stake_refund', ref: e.entryId, key: `refund:${e.entryId}`, meta: { reason } });
  }

  async _createMatch(game, stake, pair, kind = 'queue') {
    const id = crypto.randomUUID();
    const players = [];
    for (const e of pair) {
      const acc = await this.accounts.findById(e.accountId);
      players.push({ accountId: e.accountId, entryId: e.entryId, username: acc.username, color: acc.color || null });
    }
    const room = await this.createRoom(game, players, { matchId: id, stake });
    const match = { id, game, stake, kind, status: 'pending', players, room: { code: room.code, tokens: room.tokens }, feeRate: this.feeRate, createdAt: new Date() };
    await this._saveMatch(match);
    this._emit({ type: 'matched', match });
    return match;
  }
  async markActive(matchId) {
    if (this._db) { await this._db.collection('versus_matches').updateOne({ id: matchId, status: 'pending' }, { $set: { status: 'active', startedAt: new Date() } }); return; }
    const m = this.memMatches.get(matchId); if (m && m.status === 'pending') { m.status = 'active'; m.startedAt = new Date(); }
  }

  // ---------- settlement ----------
  // winnerAccountId = null means a draw. Exactly one caller wins the claim, so chips are never paid twice.
  async settle(matchId, winnerAccountId, reason = 'completed') {
    if (!(await this._claim(matchId, ['pending', 'active'], 'settling'))) return { error: 'already-closed' };
    const m = await this.getMatch(matchId);
    const [a, b] = m.players;
    if (!winnerAccountId) {
      for (const p of m.players) await this.wallet.apply(p.accountId, { amount: m.stake, type: 'stake_refund', ref: m.id, key: `draw:${m.id}:${p.accountId}`, meta: { reason: 'draw' } });
      await this._patchMatch(m.id, { status: 'settled', result: 'draw', reason, settledAt: new Date() });
      this._emit({ type: 'settled', matchId: m.id, result: 'draw', players: m.players.map(p => p.accountId) });
      return { ok: true, result: 'draw' };
    }
    const winner = m.players.find(p => p.accountId === winnerAccountId), loser = m.players.find(p => p.accountId !== winnerAccountId);
    if (!winner || !loser) { await this._patchMatch(m.id, { status: 'error' }); return { error: 'invalid-winner' }; }
    const pot = m.stake * 2, fee = Math.floor(pot * m.feeRate), payout = pot - fee;
    await this.wallet.apply(winner.accountId, { amount: payout, type: 'win_payout', ref: m.id, key: `win:${m.id}` });
    if (fee > 0) await this.wallet.apply(HOUSE, { amount: fee, type: 'house_fee', ref: m.id, key: `fee:${m.id}` });
    // Matches between friends never move ranking points (stops friends farming points off each other).
    const pts = m.kind === 'friend' ? null : await this._applyPoints(winner.accountId, loser.accountId);
    await this._patchMatch(m.id, { status: 'settled', result: 'win', winnerAccountId, payout, fee, reason, points: pts, settledAt: new Date() });
    this._emit({ type: 'settled', matchId: m.id, result: 'win', winnerAccountId, loserAccountId: loser.accountId, payout, fee, points: pts, players: m.players.map(p => p.accountId) });
    return { ok: true, result: 'win', payout, fee, points: pts };
  }
  // Both stakes returned (no-show, server error, cancelled before play).
  async cancelMatch(matchId, reason = 'cancelled') {
    if (!(await this._claim(matchId, ['pending', 'active'], 'cancelling'))) return { error: 'already-closed' };
    const m = await this.getMatch(matchId);
    for (const p of m.players) await this.wallet.apply(p.accountId, { amount: m.stake, type: 'stake_refund', ref: m.id, key: `cancel:${m.id}:${p.accountId}`, meta: { reason } });
    await this._patchMatch(m.id, { status: 'cancelled', reason, settledAt: new Date() });
    this._emit({ type: 'cancelled', matchId: m.id, reason, players: m.players.map(p => p.accountId) });
    return { ok: true };
  }

  async _applyPoints(winnerId, loserId) {
    const wk = weekKey();
    const [w, l] = await Promise.all([this.accounts.findById(winnerId), this.accounts.findById(loserId)]);
    const wp = typeof w.points === 'number' ? w.points : START_POINTS, lp = typeof l.points === 'number' ? l.points : START_POINTS;
    const { gain, loss } = eloDelta(wp, lp);
    const roll = (acc, delta, won) => {
      const wkly = acc.weekly && acc.weekly.key === wk ? acc.weekly : { key: wk, points: 0, wins: 0, losses: 0 };
      const cur = typeof acc.points === 'number' ? acc.points : START_POINTS;
      const next = Math.max(0, cur + delta);
      const applied = next - cur;
      return { points: next, wins: (acc.wins || 0) + (won ? 1 : 0), losses: (acc.losses || 0) + (won ? 0 : 1),
        weekly: { key: wk, points: Math.max(0, wkly.points + applied), wins: wkly.wins + (won ? 1 : 0), losses: wkly.losses + (won ? 0 : 1) } };
    };
    await this.accounts.update(winnerId, roll(w, gain, true));
    await this.accounts.update(loserId, roll(l, -loss, false));
    return { winner: gain, loser: -loss };
  }

  // ---- admin helpers ----
  async recentMatches({ limit = 50, status = null } = {}) {
    const filter = status ? { status } : {};
    if (this._db) return (await this._db.collection('versus_matches').find(filter).sort({ createdAt: -1 }).limit(limit).toArray()).map(({ _id, room, ...r }) => r);
    return [...this.memMatches.values()].filter(m => !status || m.status === status).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(({ room, ...r }) => r);
  }
  async stats(sinceMs) {
    const since = new Date(this.now() - sinceMs); const rows = await this.recentMatches({ limit: 2000 });
    const mine = rows.filter(m => new Date(m.createdAt) >= since);
    const settled = mine.filter(m => m.status === 'settled');
    return { matches: mine.length, settled: settled.length, open: rows.filter(m => ['pending', 'active'].includes(m.status)).length, cancelled: mine.filter(m => m.status === 'cancelled').length,
      volume: settled.reduce((a, m) => a + m.stake * 2, 0), fees: settled.reduce((a, m) => a + (m.fee || 0), 0) };
  }
  queueSnapshot() { const out = []; for (const [k, q] of this.queues) if (q.length) out.push({ key: k, waiting: q.length }); return out; }

  // After a server restart the in-memory game rooms are gone: refund every match that was still open.
  async recoverOrphans() {
    let open = [];
    if (this._db) open = await this._db.collection('versus_matches').find({ status: { $in: ['pending', 'active'] } }).toArray();
    else open = [...this.memMatches.values()].filter(m => ['pending', 'active'].includes(m.status));
    for (const m of open) await this.cancelMatch(m.id, 'server-restart');
    return open.length;
  }

  async leaderboard(scope = 'weekly', limit = 20) {
    const wk = weekKey();
    if (this._db) {
      const col = this._db.collection('accounts');
      const rows = scope === 'weekly'
        ? await col.find({ 'weekly.key': wk, usernameLower: { $exists: true } }).sort({ 'weekly.points': -1 }).limit(limit).toArray()
        : await col.find({ usernameLower: { $exists: true }, points: { $exists: true } }).sort({ points: -1 }).limit(limit).toArray();
      return rows.map(a => scope === 'weekly' ? { username: a.username, points: a.weekly.points, wins: a.weekly.wins, losses: a.weekly.losses } : { username: a.username, points: a.points, wins: a.wins || 0, losses: a.losses || 0 });
    }
    const all = [...this.accounts.accounts.values()].filter(a => a.usernameLower);
    return (scope === 'weekly'
      ? all.filter(a => a.weekly && a.weekly.key === wk).map(a => ({ username: a.username, points: a.weekly.points, wins: a.weekly.wins, losses: a.weekly.losses }))
      : all.filter(a => typeof a.points === 'number').map(a => ({ username: a.username, points: a.points, wins: a.wins || 0, losses: a.losses || 0 })))
      .sort((x, y) => y.points - x.points).slice(0, limit);
  }
}

module.exports = { VersusService, STAKES, FEE_RATE, START_POINTS, eloDelta, weekKey };
