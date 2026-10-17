'use strict';
// Settings the admin can change while the server runs (saved in MongoDB, so they survive restarts).
const GAMES = ['ludo', 'whot', 'chess', 'snooker'];
const DEFAULTS = () => ({ versusGames: (process.env.VERSUS_GAMES || 'ludo,whot,chess,snooker').split(',').map(x => x.trim()).filter(Boolean), versusFeeRate: process.env.VERSUS_FEE_RATE !== undefined && process.env.VERSUS_FEE_RATE !== '' ? Number(process.env.VERSUS_FEE_RATE) : 0.10,
  versusStakes: [10, 20, 50, 100, 500, 1000, 5000, 10000], newAccountMaxStake: Number(process.env.NEW_ACCOUNT_MAX_STAKE) || 1000, versusChessBase: Number(process.env.VERSUS_CHESS_BASE) || 300, versusChessInc: Number(process.env.VERSUS_CHESS_INC) || 0 });

function validate(p) {
  const out = {}, errs = [];
  if (p.versusGames !== undefined) { const g = [].concat(p.versusGames).filter(x => GAMES.includes(x)); out.versusGames = [...new Set(g)]; }
  if (p.versusFeeRate !== undefined) { const v = Number(p.versusFeeRate); if (!(v >= 0 && v <= 0.5)) errs.push('house fee must be between 0% and 50%'); else out.versusFeeRate = v; }
  if (p.versusStakes !== undefined) { const a = [...new Set([].concat(p.versusStakes).map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= 1000000).sort((x, y) => x - y); if (!a.length || a.length > 12) errs.push('give 1-12 whole-number stakes'); else out.versusStakes = a; }
  if (p.newAccountMaxStake !== undefined) { const v = Number(p.newAccountMaxStake); if (!Number.isInteger(v) || v < 0) errs.push('new account stake cap must be a whole number'); else out.newAccountMaxStake = v; }
  if (p.versusChessBase !== undefined) { const v = Number(p.versusChessBase); if (!(v >= 60 && v <= 3600)) errs.push('chess clock must be 60-3600 seconds'); else out.versusChessBase = v; }
  if (p.versusChessInc !== undefined) { const v = Number(p.versusChessInc); if (!(v >= 0 && v <= 60)) errs.push('chess increment must be 0-60 seconds'); else out.versusChessInc = v; }
  return errs.length ? { errors: errs } : { value: out };
}

class RuntimeSettings {
  constructor(persistence = null) { this.persistence = persistence; this.values = DEFAULTS(); this.apply = () => {}; }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }
  async load() {
    if (this._db) { const d = await this._db.collection('settings').findOne({ key: 'runtime' }); if (d && d.values) { const v = validate(d.values); if (v.value) this.values = { ...this.values, ...v.value }; } }
    this.apply(this.values); return this.values;
  }
  get() { return { ...this.values }; }
  async set(patch) {
    const v = validate(patch || {}); if (v.errors) return v;
    this.values = { ...this.values, ...v.value };
    if (this._db) await this._db.collection('settings').updateOne({ key: 'runtime' }, { $set: { key: 'runtime', values: this.values, updatedAt: new Date() } }, { upsert: true });
    this.apply(this.values); return { value: this.values };
  }
}

class AdminLog {
  constructor(persistence = null) { this.persistence = persistence; this.mem = []; }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }
  async add(action, target, details = {}) {
    const row = { at: new Date(), action, target: target || null, details };
    if (this._db) await this._db.collection('admin_log').insertOne({ ...row }); else { this.mem.push(row); if (this.mem.length > 1000) this.mem.shift(); }
  }
  async recent(limit = 100) {
    if (this._db) return (await this._db.collection('admin_log').find({}).sort({ at: -1 }).limit(limit).toArray()).map(({ _id, ...r }) => r);
    return this.mem.slice(-limit).reverse();
  }
}
module.exports = { RuntimeSettings, AdminLog, validate, DEFAULTS };
