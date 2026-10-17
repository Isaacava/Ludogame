'use strict';
// Tournaments. One tournament is for ONE game (Ludo, Whot or Chess) and is played as a knockout bracket.
//  - Players register (paying the entry fee into escrow), and can leave for a full refund until it starts.
//  - At the start time a bracket is built (byes if the count is not a power of two) and every match is a private
//    reserved room, so tournament players only ever meet other tournament players, never the general queue.
//  - A match result advances the winner. No-shows are walkovers, draws are replayed once and then decided by seed.
//  - Prizes are paid exactly once from the pool (guaranteed prize + share of entry fees), refunds are idempotent.
const crypto = require('crypto');
const { HOUSE } = require('../wallet/chipWallet');

const GAMES = ['ludo', 'whot', 'chess', 'snooker'];
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
const shuffle = (a) => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };

function validateInput(i, existing = null) {
  const out = {}; const errs = [];
  const num = (k, def, min, max, label) => { const v = i[k] === undefined || i[k] === '' ? (existing ? existing[k] : def) : Number(i[k]); if (!Number.isFinite(v) || v < min || v > max) errs.push(`${label || k} must be between ${min} and ${max}`); else out[k] = Math.floor(v); };
  const g = i.game !== undefined ? i.game : existing && existing.game;
  if (!GAMES.includes(g)) errs.push('game must be ludo, whot, chess or snooker'); else out.game = g;
  const name = String(i.name !== undefined ? i.name : (existing && existing.name) || '').trim();
  if (name.length < 3 || name.length > 60) errs.push('name must be 3-60 characters'); else out.name = name;
  out.description = String(i.description !== undefined ? i.description : (existing && existing.description) || '').slice(0, 400);
  num('entryFee', 0, 0, 1000000, 'entry fee'); num('fixedPrize', 0, 0, 100000000, 'guaranteed prize'); num('rakePercent', 10, 0, 100, 'house cut %');
  num('minPlayers', 4, 2, 128, 'minimum players'); num('maxPlayers', 32, 2, 128, 'maximum players'); num('matchTimeoutSec', 180, 30, 1800, 'match join timeout');
  num('chessBase', 300, 60, 3600, 'chess base seconds'); num('chessInc', 0, 0, 60, 'chess increment');
  out.feeToPool = i.feeToPool !== undefined ? !!i.feeToPool : existing ? existing.feeToPool : true;
  out.repeatWeekly = i.repeatWeekly !== undefined ? !!i.repeatWeekly : existing ? !!existing.repeatWeekly : false;
  const split = i.prizeSplit !== undefined ? i.prizeSplit : existing ? existing.prizeSplit : [50, 30, 20];
  const arr = Array.isArray(split) ? split.map(Number) : String(split).split(/[ ,/]+/).filter(Boolean).map(Number);
  if (!arr.length || arr.length > 3 || arr.some(x => !Number.isFinite(x) || x < 0) || Math.round(arr.reduce((a, b) => a + b, 0)) !== 100) errs.push('prize split must be 1-3 numbers adding up to 100 (e.g. 50,30,20)'); else out.prizeSplit = arr;
  const start = i.startAt !== undefined ? new Date(i.startAt).getTime() : existing ? existing.startAt : NaN;
  if (!Number.isFinite(start)) errs.push('start time is required'); else out.startAt = start;
  if (out.minPlayers && out.maxPlayers && out.minPlayers > out.maxPlayers) errs.push('minimum players cannot exceed maximum');
  return errs.length ? { errors: errs } : { value: out };
}

class TournamentService {
  constructor({ persistence = null, wallet, accounts, createRoom, roomExists = () => true, notify = () => {}, now = () => Date.now() }) {
    this.persistence = persistence; this.wallet = wallet; this.accounts = accounts; this.createRoom = createRoom; this.roomExists = roomExists; this.notify = notify; this.now = now;
    this.mem = new Map(); this.locks = new Map(); this._indexed = false;
  }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }

  // ---------- storage ----------
  async _idx() { if (this._indexed || !this._db) return; await this._db.collection('tournaments').createIndex({ id: 1 }, { unique: true, name: 'tournament_id' }); await this._db.collection('tournaments').createIndex({ status: 1, startAt: 1 }, { name: 'tournament_status' }); this._indexed = true; }
  async get(id) { if (this._db) { await this._idx(); const d = await this._db.collection('tournaments').findOne({ id }); if (!d) return null; const { _id, ...r } = d; return r; } const t = this.mem.get(id); return t ? JSON.parse(JSON.stringify(t)) : null; }
  async _save(t) { t.updatedAt = this.now(); if (this._db) { await this._idx(); await this._db.collection('tournaments').replaceOne({ id: t.id }, { ...t }, { upsert: true }); } else this.mem.set(t.id, JSON.parse(JSON.stringify(t))); return t; }
  async list({ statuses = null, game = null, limit = 100 } = {}) {
    let rows;
    if (this._db) { await this._idx(); const f = {}; if (statuses) f.status = { $in: statuses }; if (game) f.game = game; rows = (await this._db.collection('tournaments').find(f).sort({ startAt: -1 }).limit(limit).toArray()).map(({ _id, ...r }) => r); }
    else rows = [...this.mem.values()].filter(t => (!statuses || statuses.includes(t.status)) && (!game || t.game === game)).sort((a, b) => b.startAt - a.startAt).slice(0, limit).map(t => JSON.parse(JSON.stringify(t)));
    return rows;
  }
  async _lock(id, fn) { const prev = this.locks.get(id) || Promise.resolve(); const run = prev.catch(() => {}).then(fn); this.locks.set(id, run); try { return await run; } finally { if (this.locks.get(id) === run) this.locks.delete(id); } }

  // ---------- admin: create / edit / publish / cancel ----------
  async create(input, { publish = true } = {}) {
    const v = validateInput(input); if (v.errors) return { errors: v.errors };
    const t = { id: crypto.randomUUID(), ...v.value, status: publish ? 'registration' : 'draft', players: [], rounds: [], results: [], fees: { collected: 0, refunded: 0 }, createdAt: this.now() };
    await this._save(t); return { tournament: t };
  }
  async update(id, input) {
    return this._lock(id, async () => {
      const t = await this.get(id); if (!t) return { error: 'not-found' };
      if (!['draft', 'registration'].includes(t.status)) return { error: 'already-started' };
      const locked = t.players.length > 0 && ((input.game && input.game !== t.game) || (input.entryFee !== undefined && Number(input.entryFee) !== t.entryFee));
      if (locked) return { error: 'players-already-joined-cannot-change-game-or-fee' };
      const v = validateInput({ ...input }, t); if (v.errors) return { errors: v.errors };
      if (v.value.maxPlayers < t.players.length) return { errors: ['maximum players cannot be below the number already registered'] };
      Object.assign(t, v.value); await this._save(t); return { tournament: t };
    });
  }
  async publish(id) { return this._lock(id, async () => { const t = await this.get(id); if (!t || t.status !== 'draft') return { error: 'not-a-draft' }; t.status = 'registration'; await this._save(t); return { tournament: t }; }); }
  async remove(id) { return this._lock(id, async () => { const t = await this.get(id); if (!t) return { error: 'not-found' }; if (t.status !== 'draft' && !(t.status === 'cancelled' || t.status === 'completed')) return { error: 'cancel-it-first' }; if (this._db) await this._db.collection('tournaments').deleteOne({ id }); else this.mem.delete(id); return { ok: true }; }); }

  async _refundAll(t, reason) {
    if (t.entryFee > 0) for (const p of t.players) { const r = await this.wallet.apply(p.accountId, { amount: t.entryFee, type: 'tournament_refund', ref: t.id, key: `trefund:${t.id}:${p.accountId}`, meta: { reason } }); if (!r.duplicate) t.fees.refunded += t.entryFee; }
  }
  async cancel(id, reason = 'cancelled-by-admin') {
    return this._lock(id, async () => {
      const t = await this.get(id); if (!t) return { error: 'not-found' };
      if (['completed', 'cancelled'].includes(t.status)) return { error: 'already-closed' };
      await this._refundAll(t, reason); t.status = 'cancelled'; t.cancelReason = reason; t.finishedAt = this.now(); await this._save(t);
      for (const p of t.players) this.notify(p.accountId, 'tournament-update', { tournamentId: t.id, status: 'cancelled', name: t.name, refunded: t.entryFee });
      return { ok: true, refunded: t.players.length };
    });
  }

  // ---------- players ----------
  inPool(t) { return t.fixedPrize + (t.feeToPool ? Math.floor(t.fees.collected * (100 - t.rakePercent) / 100) : 0); }
  async join(account, id) {
    return this._lock(id, async () => {
      const t = await this.get(id); if (!t) return { error: 'not-found' };
      if (t.status !== 'registration' || this.now() >= t.startAt) return { error: 'registration-closed' };
      if (!account.usernameLower) return { error: 'username-required' };
      if (t.players.some(p => p.accountId === account.id)) return { error: 'already-joined' };
      if (t.players.length >= t.maxPlayers) return { error: 'tournament-full' };
      if (t.entryFee > 0) {
        if (!account.ageConfirmed) return { error: 'age-confirmation-required' };
        const r = await this.wallet.apply(account.id, { amount: -t.entryFee, type: 'tournament_entry', ref: t.id, key: `tentry:${t.id}:${account.id}` });
        if (r.error) return { error: r.error === 'insufficient' ? 'insufficient-chips' : r.error };
        t.fees.collected += t.entryFee;
      }
      t.players.push({ accountId: account.id, username: account.username, color: account.color || null, joinedAt: this.now() });
      await this._save(t); return { ok: true, players: t.players.length };
    });
  }
  async leave(account, id) {
    return this._lock(id, async () => {
      const t = await this.get(id); if (!t) return { error: 'not-found' };
      if (t.status !== 'registration' || this.now() >= t.startAt) return { error: 'registration-closed' };
      const i = t.players.findIndex(p => p.accountId === account.id); if (i < 0) return { error: 'not-joined' };
      if (t.entryFee > 0) { await this.wallet.apply(account.id, { amount: t.entryFee, type: 'tournament_refund', ref: t.id, key: `trefund:${t.id}:${account.id}`, meta: { reason: 'left' } }); t.fees.collected -= t.entryFee; }
      t.players.splice(i, 1); await this._save(t); return { ok: true };
    });
  }

  // ---------- start + bracket ----------
  async tick() {
    const due = (await this.list({ statuses: ['registration'] })).filter(t => this.now() >= t.startAt);
    for (const t of due) await this.start(t.id);
    return due.length;
  }
  async start(id) {
    return this._lock(id, async () => {
      const t = await this.get(id); if (!t || t.status !== 'registration') return { error: 'not-in-registration' };
      if (t.players.length < t.minPlayers) {
        await this._refundAll(t, 'not-enough-players'); t.status = 'cancelled'; t.cancelReason = 'not-enough-players'; t.finishedAt = this.now(); await this._save(t);
        for (const p of t.players) this.notify(p.accountId, 'tournament-update', { tournamentId: t.id, status: 'cancelled', name: t.name, refunded: t.entryFee, reason: 'not-enough-players' });
        await this._maybeRepeat(t); return { cancelled: true };
      }
      const order = shuffle(t.players); order.forEach((p, i) => { p.seed = i + 1; });
      t.players = order; const size = nextPow2(order.length), byes = size - order.length; let idx = 0; const matches = [];
      for (let m = 0; m < size / 2; m++) {
        const a = order[idx++].accountId, b = m < byes ? null : order[idx++].accountId;
        matches.push({ id: crypto.randomUUID(), a, b, winner: b === null ? a : null, status: b === null ? 'done' : 'pending', reason: b === null ? 'bye' : null, replays: 0 });
      }
      t.rounds = [{ matches }]; t.status = 'running'; t.startedAt = this.now(); t.roundsTotal = Math.log2(size);
      await this._advance(t); await this._save(t);
      for (const p of t.players) this.notify(p.accountId, 'tournament-update', { tournamentId: t.id, status: 'running', name: t.name });
      return { ok: true };
    });
  }
  seedOf(t, accountId) { const p = t.players.find(x => x.accountId === accountId); return p ? p.seed : 9999; }
  _profile(t, accountId) { const p = t.players.find(x => x.accountId === accountId); return { username: p ? p.username : 'Player', color: p ? p.color : null }; }

  // Create rooms for playable matches, move to the next round when a round is done, finish after the final.
  async _advance(t) {
    for (;;) {
      const round = t.rounds[t.rounds.length - 1];
      for (const m of round.matches) if (m.status === 'pending' && m.a && m.b) await this._openMatch(t, m, t.rounds.length);
      if (!round.matches.every(m => m.status === 'done')) return;
      if (round.matches.length === 1) return this._finish(t);
      const next = []; for (let i = 0; i < round.matches.length; i += 2) {
        const a = round.matches[i].winner, b = round.matches[i + 1].winner;
        next.push({ id: crypto.randomUUID(), a, b, winner: null, status: 'pending', reason: null, replays: 0 });
      }
      t.rounds.push({ matches: next });
    }
  }
  async _openMatch(t, m, roundNo) {
    const seats = Math.random() < 0.5 ? [m.a, m.b] : [m.b, m.a];
    const room = await this.createRoom(t.game, seats.map(id => this._profile(t, id)), { tournamentId: t.id, matchId: m.id, accountIds: seats, timeoutMs: t.matchTimeoutSec * 1000, chess: { base: t.chessBase, inc: t.chessInc } });
    m.status = 'active'; m.seats = seats; m.room = { code: room.code, tokens: room.tokens }; m.openedAt = this.now();
    for (const id of seats) this.notify(id, 'tournament-match', this.matchPayload(t, m, roundNo, id));
  }
  matchPayload(t, m, roundNo, accountId) {
    const i = m.seats.indexOf(accountId); const opp = m.seats[1 - i];
    return { tournamentId: t.id, name: t.name, game: t.game, round: roundNo, rounds: t.roundsTotal, matchId: m.id, opponent: this._profile(t, opp).username, code: m.room.code, playerToken: m.room.tokens[i], timeoutAt: m.openedAt + t.matchTimeoutSec * 1000 };
  }
  // The caller turns this into a page URL. Recreates the room if the server restarted since it was made.
  async myMatch(id, accountId) {
    return this._lock(id, async () => {
      const t = await this.get(id); if (!t || t.status !== 'running') return null;
      for (let r = 0; r < t.rounds.length; r++) for (const m of t.rounds[r].matches) {
        if (m.status === 'active' && m.seats.includes(accountId)) {
          if (!this.roomExists(t.game, m.room.code)) { const room = await this.createRoom(t.game, m.seats.map(x => this._profile(t, x)), { tournamentId: t.id, matchId: m.id, accountIds: m.seats, timeoutMs: t.matchTimeoutSec * 1000, chess: { base: t.chessBase, inc: t.chessInc } }); m.room = { code: room.code, tokens: room.tokens }; m.openedAt = this.now(); await this._save(t); }
          return this.matchPayload(t, m, r + 1, accountId);
        }
      }
      return null;
    });
  }
  async activeMatchFor(accountId) {
    for (const t of await this.list({ statuses: ['running'] })) for (const r of t.rounds) for (const m of r.matches) if (m.status === 'active' && m.seats && m.seats.includes(accountId)) return { tournamentId: t.id, matchId: m.id };
    return null;
  }

  // A game server reports a finished match. winnerAccountId null = draw.
  async reportResult(tid, matchId, winnerAccountId, reason = 'completed') {
    return this._lock(tid, async () => {
      const t = await this.get(tid); if (!t || t.status !== 'running') return { error: 'not-running' };
      let found = null, roundNo = 0; t.rounds.forEach((r, ri) => r.matches.forEach(m => { if (m.id === matchId) { found = m; roundNo = ri + 1; } }));
      if (!found || found.status !== 'active') return { error: 'match-not-active' };
      const m = found;
      if (winnerAccountId && !m.seats.includes(winnerAccountId)) return { error: 'invalid-winner' };
      if (!winnerAccountId) {
        if (m.replays < 1) { // first draw: play again with fresh seats
          m.replays++; m.status = 'pending'; m.room = null; await this._openMatch(t, m, roundNo); await this._save(t);
          for (const id of m.seats) this.notify(id, 'tournament-update', { tournamentId: t.id, status: 'replay', name: t.name });
          return { ok: true, replay: true };
        }
        winnerAccountId = this.seedOf(t, m.a) <= this.seedOf(t, m.b) ? m.a : m.b; reason = 'draw-tiebreak';
      }
      m.winner = winnerAccountId; m.loser = m.a === winnerAccountId ? m.b : m.a; m.status = 'done'; m.reason = reason; m.finishedAt = this.now();
      await this._advance(t); await this._save(t);
      const status = t.status; // may now be completed
      if (status === 'running') this.notify(m.loser, 'tournament-update', { tournamentId: t.id, status: 'eliminated', name: t.name, round: roundNo });
      return { ok: true, status, winner: winnerAccountId, loser: m.loser, round: roundNo, reason };
    });
  }

  async _finish(t) {
    const final = t.rounds[t.rounds.length - 1].matches[0];
    const places = [{ place: 1, ids: [final.winner] }, { place: 2, ids: [final.loser || (final.a === final.winner ? final.b : final.a)] }];
    if (t.rounds.length >= 2) { // semi-final losers share 3rd place
      const semi = t.rounds[t.rounds.length - 2].matches.map(m => m.loser).filter(Boolean);
      if (semi.length) places.push({ place: 3, ids: semi });
    }
    const pool = this.inPool(t); let paid = 0; const results = [];
    for (const pl of places) {
      const pct = t.prizeSplit[pl.place - 1] || 0; const each = Math.floor((pool * pct / 100) / pl.ids.length);
      for (const accountId of pl.ids) {
        if (!accountId) continue;
        const prize = each; if (prize > 0) { await this.wallet.apply(accountId, { amount: prize, type: 'tournament_prize', ref: t.id, key: `tprize:${t.id}:${accountId}`, meta: { place: pl.place } }); paid += prize; }
        results.push({ place: pl.place, accountId, username: this._profile(t, accountId).username, prize });
      }
    }
    const feesKept = t.fees.collected - (t.feeToPool ? Math.floor(t.fees.collected * (100 - t.rakePercent) / 100) : 0);
    if (feesKept > 0) await this.wallet.apply(HOUSE, { amount: feesKept, type: 'tournament_fee', ref: t.id, key: `tfee:${t.id}` });
    t.results = results; t.pool = { total: pool, paid, houseFees: feesKept, guaranteed: t.fixedPrize }; t.status = 'completed'; t.finishedAt = this.now();
    for (const p of t.players) { const r = results.find(x => x.accountId === p.accountId); this.notify(p.accountId, 'tournament-update', { tournamentId: t.id, status: 'completed', name: t.name, place: r ? r.place : null, prize: r ? r.prize : 0 }); }
    await this._maybeRepeat(t);
  }
  async _maybeRepeat(t) {
    if (!t.repeatWeekly) return;
    const next = { ...t, id: crypto.randomUUID(), status: 'registration', startAt: t.startAt + 7 * 86400000, players: [], rounds: [], results: [], fees: { collected: 0, refunded: 0 }, createdAt: this.now() };
    delete next.pool; delete next.cancelReason; delete next.startedAt; delete next.finishedAt; delete next.roundsTotal; delete next.updatedAt;
    while (next.startAt <= this.now()) next.startAt += 7 * 86400000;
    await this._save(next);
  }

  // Public view (never leaks room tokens).
  view(t, accountId = null) {
    const me = accountId ? t.players.find(p => p.accountId === accountId) : null;
    return {
      id: t.id, name: t.name, description: t.description, game: t.game, status: t.status, startAt: t.startAt, entryFee: t.entryFee, fixedPrize: t.fixedPrize, prizeSplit: t.prizeSplit,
      minPlayers: t.minPlayers, maxPlayers: t.maxPlayers, playerCount: t.players.length, pool: t.status === 'completed' && t.pool ? t.pool.total : this.inPool(t), repeatWeekly: !!t.repeatWeekly,
      chess: t.game === 'chess' ? { base: t.chessBase, inc: t.chessInc } : null, matchTimeoutSec: t.matchTimeoutSec, cancelReason: t.cancelReason || null,
      joined: !!me, meId: accountId || null, players: t.players.map(p => ({ accountId: p.accountId, username: p.username, color: p.color, seed: p.seed || null })),
      rounds: t.rounds.map(r => r.matches.map(m => ({ id: m.id, a: m.a, b: m.b, winner: m.winner || null, status: m.status, reason: m.reason || null }))), results: t.results || []
    };
  }
}

module.exports = { TournamentService, validateInput, GAMES };
