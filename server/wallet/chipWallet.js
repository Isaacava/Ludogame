'use strict';
// Chip wallet. Chips are whole numbers (CHIPS_PER_USD chips = $1).
// Every balance change is an append-only ledger row with a unique idempotency `key`, so a retried webhook,
// double click or crash-restart can never apply the same change twice. The balance can never go below zero.
const crypto = require('crypto');

const CHIPS_PER_USD = Number(process.env.CHIPS_PER_USD) || 100;
const HOUSE = 'house'; // accountId that collects the house fee, so the books always balance

class ChipWallet {
  constructor(persistence = null) {
    this.persistence = persistence;
    this.mem = { wallets: new Map(), ledger: [], keys: new Set() };
    this._indexed = false;
  }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }

  async _ensureIndexes() {
    if (this._indexed || !this._db) return;
    await Promise.all([
      this._db.collection('chip_wallets').createIndex({ accountId: 1 }, { unique: true, name: 'wallet_account_unique' }),
      this._db.collection('chip_ledger').createIndex({ key: 1 }, { unique: true, name: 'ledger_key_unique' }),
      this._db.collection('chip_ledger').createIndex({ accountId: 1, createdAt: -1 }, { name: 'ledger_account_time' })
    ]);
    this._indexed = true;
  }

  async balance(accountId) {
    if (this._db) {
      await this._ensureIndexes();
      const w = await this._db.collection('chip_wallets').findOne({ accountId });
      return w ? w.balance : 0;
    }
    const w = this.mem.wallets.get(accountId);
    return w ? w.balance : 0;
  }

  // amount is a signed integer. Returns { ok, balance, duplicate? } or { error: 'insufficient' | 'invalid-amount' }.
  async apply(accountId, { amount, type, ref = null, key = null, meta = null }) {
    if (!Number.isSafeInteger(amount) || amount === 0) return { error: 'invalid-amount' };
    key = key || `${type}:${crypto.randomUUID()}`;
    const row = { id: crypto.randomUUID(), key, accountId, amount, type, ref, meta, createdAt: new Date() };

    if (this._db) {
      await this._ensureIndexes();
      const ledger = this._db.collection('chip_ledger'), wallets = this._db.collection('chip_wallets');
      try { await ledger.insertOne({ ...row }); }
      catch (err) { if (err && err.code === 11000) return { ok: true, duplicate: true, balance: await this.balance(accountId) }; throw err; }
      try {
        if (amount > 0) {
          await wallets.updateOne({ accountId }, { $inc: { balance: amount }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
        } else {
          await wallets.updateOne({ accountId }, { $setOnInsert: { balance: 0, createdAt: new Date() } }, { upsert: true });
          const r = await wallets.updateOne({ accountId, balance: { $gte: -amount } }, { $inc: { balance: amount } });
          if (!r.matchedCount) { await ledger.deleteOne({ key }); return { error: 'insufficient' }; }
        }
      } catch (err) { await ledger.deleteOne({ key }).catch(() => {}); throw err; }
      return { ok: true, balance: await this.balance(accountId) };
    }

    if (this.mem.keys.has(key)) return { ok: true, duplicate: true, balance: await this.balance(accountId) };
    const w = this.mem.wallets.get(accountId) || { accountId, balance: 0 };
    if (amount < 0 && w.balance + amount < 0) return { error: 'insufficient' };
    w.balance += amount; this.mem.wallets.set(accountId, w);
    this.mem.keys.add(key); this.mem.ledger.push(row);
    return { ok: true, balance: w.balance };
  }

  async history(accountId, limit = 50) {
    if (this._db) {
      await this._ensureIndexes();
      const rows = await this._db.collection('chip_ledger').find({ accountId }).sort({ createdAt: -1 }).limit(limit).toArray();
      return rows.map(({ _id, ...r }) => r);
    }
    return this.mem.ledger.filter(r => r.accountId === accountId).slice(-limit).reverse();
  }

  // ---- admin helpers ----
  async summary() {
    if (this._db) {
      await this._ensureIndexes();
      const agg = await this._db.collection('chip_wallets').aggregate([{ $group: { _id: null, total: { $sum: '$balance' }, wallets: { $sum: 1 } } }]).toArray();
      return { totalChips: agg[0] ? agg[0].total : 0, wallets: agg[0] ? agg[0].wallets : 0, house: await this.balance(HOUSE) };
    }
    const all = [...this.mem.wallets.values()];
    return { totalChips: all.reduce((a, w) => a + w.balance, 0), wallets: all.length, house: await this.balance(HOUSE) };
  }
  // Net chip movement per day and ledger type for the last N days (UTC), for the finance charts.
  async byDay(days = 14) {
    const since = new Date(Date.now() - days * 86400000); since.setUTCHours(0, 0, 0, 0);
    const rows = this._db
      ? await this._db.collection('chip_ledger').aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, t: '$type' }, sum: { $sum: '$amount' }, n: { $sum: 1 } } }]).toArray().then(r => r.map(x => ({ day: x._id.d, type: x._id.t, sum: x.sum, n: x.n })))
      : (() => { const m = new Map(); for (const r of this.mem.ledger) if (r.createdAt >= since) { const k = r.createdAt.toISOString().slice(0, 10) + '|' + r.type; const c = m.get(k) || { day: r.createdAt.toISOString().slice(0, 10), type: r.type, sum: 0, n: 0 }; c.sum += r.amount; c.n++; m.set(k, c); } return [...m.values()]; })();
    return rows;
  }
  // Checks every wallet against its ledger. Returns up to 50 mismatches.
  async auditAll() {
    const bad = []; let checked = 0;
    if (this._db) {
      const sums = new Map((await this._db.collection('chip_ledger').aggregate([{ $group: { _id: '$accountId', sum: { $sum: '$amount' } } }]).toArray()).map(x => [x._id, x.sum]));
      const wallets = await this._db.collection('chip_wallets').find({}).toArray();
      for (const w of wallets) { checked++; const s = sums.get(w.accountId) || 0; if (s !== w.balance) bad.push({ accountId: w.accountId, balance: w.balance, ledgerSum: s }); sums.delete(w.accountId); }
      for (const [accountId, s] of sums) if (s !== 0) bad.push({ accountId, balance: 0, ledgerSum: s });
    } else {
      for (const w of this.mem.wallets.values()) { checked++; const s = this.mem.ledger.filter(r => r.accountId === w.accountId).reduce((a, r) => a + r.amount, 0); if (s !== w.balance) bad.push({ accountId: w.accountId, balance: w.balance, ledgerSum: s }); }
    }
    return { ok: bad.length === 0, checked, mismatches: bad.slice(0, 50) };
  }
  async recentLedger(limit = 100, filter = {}) {
    if (this._db) { await this._ensureIndexes(); return (await this._db.collection('chip_ledger').find(filter).sort({ createdAt: -1 }).limit(limit).toArray()).map(({ _id, ...r }) => r); }
    return this.mem.ledger.filter(r => Object.entries(filter).every(([k, v]) => r[k] === v)).slice(-limit).reverse();
  }

  // Sanity check: the ledger must add up to the stored balance.
  async audit(accountId) {
    let sum = 0;
    if (this._db) {
      const rows = await this._db.collection('chip_ledger').find({ accountId }).toArray();
      sum = rows.reduce((a, r) => a + r.amount, 0);
    } else sum = this.mem.ledger.filter(r => r.accountId === accountId).reduce((a, r) => a + r.amount, 0);
    const balance = await this.balance(accountId);
    return { ok: sum === balance, ledgerSum: sum, balance };
  }
}

const chipsToUsd = (chips) => chips / CHIPS_PER_USD;
module.exports = { ChipWallet, CHIPS_PER_USD, HOUSE, chipsToUsd };
