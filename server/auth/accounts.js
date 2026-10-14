'use strict';
// CodePlay accounts: Google sign-in / sign-up only, unique usernames, bearer-token sessions.
// Kept fully separate from the WhatsApp phone users (collection `users`) so neither can break the other.
const crypto = require('crypto');
const express = require('express');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'help', 'moderator', 'mod', 'staff', 'system',
  'codeplay', 'codeplayhq', 'official', 'bot', 'guest', 'null', 'undefined', 'whatsapp', 'ludo', 'whot', 'chess', 'owner']);
const COLORS = ['#e53e3e', '#38a169', '#d69e2e', '#3182ce'];

const normEmail = (e) => String(e || '').trim().toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function validateUsername(raw) {
  const u = String(raw || '').trim();
  if (!USERNAME_RE.test(u)) return { ok: false, error: 'invalid-username' };
  if (RESERVED.has(u.toLowerCase())) return { ok: false, error: 'username-reserved' };
  return { ok: true, username: u, lower: u.toLowerCase() };
}

const isDup = (err) => err && (err.code === 11000 || err.code === 'DUP');
const dupField = (err) => {
  const s = (err.keyPattern && Object.keys(err.keyPattern)[0]) || err.field || (err.message || '');
  if (/usernameLower/.test(s)) return 'username';
  if (/emailLower/.test(s)) return 'email';
  if (/googleId/.test(s)) return 'google';
  return 'unknown';
};

class AccountStore {
  constructor(persistence = null) {
    this.persistence = persistence;
    this.accounts = new Map(); // id -> account (memory backend: tests / no MongoDB)
    this.sessions = new Map(); // tokenHash -> { accountId, createdAt }
    this._indexed = false;
  }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }
  async _ensureIndexes() {
    if (this._indexed || !this._db) return;
    const a = this._db.collection('accounts'), s = this._db.collection('account_sessions');
    await Promise.all([
      a.createIndex({ id: 1 }, { unique: true, name: 'account_id_unique' }),
      a.createIndex({ emailLower: 1 }, { unique: true, sparse: true, name: 'account_email_unique' }),
      a.createIndex({ googleId: 1 }, { unique: true, sparse: true, name: 'account_google_unique' }),
      a.createIndex({ usernameLower: 1 }, { unique: true, sparse: true, name: 'account_username_unique' }),
      s.createIndex({ tokenHash: 1 }, { unique: true, name: 'account_session_token' }),
      s.createIndex({ createdAt: 1 }, { expireAfterSeconds: SESSION_TTL_MS / 1000, name: 'account_session_ttl' })
    ]);
    this._indexed = true;
  }
  _strip(doc) { if (!doc) return null; const d = { ...doc }; delete d._id; return d; }

  async _find(field, value) {
    if (!value) return null;
    if (this._db) { await this._ensureIndexes(); return this._strip(await this._db.collection('accounts').findOne({ [field]: value })); }
    for (const a of this.accounts.values()) if (a[field] === value) return { ...a };
    return null;
  }
  findById(id) { return this._find('id', id); }
  findByEmail(email) { return this._find('emailLower', normEmail(email)); }
  findByGoogleId(gid) { return this._find('googleId', gid); }
  findByUsername(u) { return this._find('usernameLower', String(u || '').toLowerCase()); }
  // ---- admin helpers ----
  async count(filter = {}) {
    if (this._db) { await this._ensureIndexes(); return this._db.collection('accounts').countDocuments(filter); }
    return [...this.accounts.values()].filter(a => Object.entries(filter).every(([k, v]) => (v && v.$gte ? a[k] >= v.$gte : a[k] === v))).length;
  }
  async list({ q = '', skip = 0, limit = 25, sort = 'createdAt' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    if (this._db) {
      await this._ensureIndexes();
      const esc = needle.replace(/[^a-z0-9_@.\-+]/g, '');
      const filter = esc ? { $or: [{ usernameLower: { $regex: esc } }, { emailLower: { $regex: esc } }, { id: needle }] } : {};
      const total = await this._db.collection('accounts').countDocuments(filter);
      const rows = await this._db.collection('accounts').find(filter).sort({ [sort]: -1 }).skip(skip).limit(limit).toArray();
      return { total, rows: rows.map(d => this._strip(d)) };
    }
    let all = [...this.accounts.values()].filter(a => !needle || (a.usernameLower || '').includes(needle) || (a.emailLower || '').includes(needle) || a.id === needle);
    all.sort((x, y) => (y[sort] > x[sort] ? 1 : -1));
    return { total: all.length, rows: all.slice(skip, skip + limit).map(a => ({ ...a })) };
  }
  async searchUsernames(prefix, limit = 8) {
    const p = String(prefix || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (p.length < 2) return [];
    if (this._db) {
      await this._ensureIndexes();
      return (await this._db.collection('accounts').find({ usernameLower: { $regex: '^' + p } }).sort({ usernameLower: 1 }).limit(limit).toArray()).map(d => this._strip(d));
    }
    return [...this.accounts.values()].filter(a => a.usernameLower && a.usernameLower.startsWith(p)).sort((x, y) => x.usernameLower.localeCompare(y.usernameLower)).slice(0, limit).map(a => ({ ...a }));
  }

  async create(fields) {
    const doc = { id: crypto.randomUUID(), createdAt: new Date(), ...fields };
    // sparse unique indexes ignore missing fields, so never store null/empty values for them
    for (const k of ['emailLower', 'googleId', 'usernameLower']) if (doc[k] == null || doc[k] === '') delete doc[k];
    if (this._db) {
      await this._ensureIndexes();
      await this._db.collection('accounts').insertOne({ ...doc });
      return doc;
    }
    for (const a of this.accounts.values()) {
      if (doc.emailLower && a.emailLower === doc.emailLower) { const e = new Error('dup'); e.code = 'DUP'; e.field = 'emailLower'; throw e; }
      if (doc.googleId && a.googleId === doc.googleId) { const e = new Error('dup'); e.code = 'DUP'; e.field = 'googleId'; throw e; }
    }
    this.accounts.set(doc.id, doc);
    return { ...doc };
  }
  async update(id, patch) {
    if (this._db) {
      await this._ensureIndexes();
      const r = await this._db.collection('accounts').findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
      return this._strip(r && r.value !== undefined ? r.value : r);
    }
    const cur = this.accounts.get(id); if (!cur) return null;
    if (patch.usernameLower) for (const a of this.accounts.values()) if (a.id !== id && a.usernameLower === patch.usernameLower) { const e = new Error('dup'); e.code = 'DUP'; e.field = 'usernameLower'; throw e; }
    const next = { ...cur, ...patch, updatedAt: new Date() }; this.accounts.set(id, next); return { ...next };
  }
  // Sets the username exactly once; the unique index decides races between two people picking the same name.
  async setUsername(id, validated, color) {
    if (this._db) {
      await this._ensureIndexes();
      const patch = { username: validated.username, usernameLower: validated.lower, updatedAt: new Date() };
      if (color) patch.color = color;
      const r = await this._db.collection('accounts').findOneAndUpdate(
        { id, usernameLower: { $exists: false } }, { $set: patch }, { returnDocument: 'after' });
      return this._strip(r && r.value !== undefined ? r.value : r);
    }
    const cur = this.accounts.get(id); if (!cur || cur.usernameLower) return null;
    return this.update(id, { username: validated.username, usernameLower: validated.lower, ...(color ? { color } : {}) });
  }

  async createSession(accountId) {
    const token = crypto.randomBytes(32).toString('hex'), tokenHash = sha(token), createdAt = new Date();
    if (this._db) { await this._ensureIndexes(); await this._db.collection('account_sessions').insertOne({ tokenHash, accountId, createdAt }); }
    else this.sessions.set(tokenHash, { accountId, createdAt });
    return token;
  }
  async accountForToken(token) {
    if (!token) return null;
    const tokenHash = sha(token);
    let s;
    if (this._db) { await this._ensureIndexes(); s = await this._db.collection('account_sessions').findOne({ tokenHash }); }
    else s = this.sessions.get(tokenHash);
    if (!s || Date.now() - new Date(s.createdAt).getTime() > SESSION_TTL_MS) return null;
    const acc = await this.findById(s.accountId);
    return acc && !acc.banned ? acc : null; // banned players are signed out everywhere
  }
  async deleteSession(token) {
    if (!token) return;
    const tokenHash = sha(token);
    if (this._db) await this._db.collection('account_sessions').deleteOne({ tokenHash }); else this.sessions.delete(tokenHash);
  }
}

function publicAccount(a) {
  return {
    id: a.id, email: a.email || null, username: a.username || null, color: a.color || null,
    hasUsername: !!a.usernameLower, hasGoogle: !!a.googleId, avatar: a.avatar || null
  };
}

// Verifies a Google Identity Services ID token (credential). Injectable so tests never hit Google.
function defaultGoogleVerifier(clientId) {
  let client = null;
  return async (credential) => {
    if (!clientId) throw new Error('google-not-configured');
    if (!client) { const { OAuth2Client } = require('google-auth-library'); client = new OAuth2Client(clientId); }
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const p = ticket.getPayload();
    return { sub: p.sub, email: p.email, emailVerified: !!p.email_verified, name: p.name, picture: p.picture };
  };
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now); hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k);
    return arr.length <= max;
  };
}

function createAccountRoutes({ accounts, googleClientId = process.env.GOOGLE_CLIENT_ID, verifyGoogle } = {}) {
  const router = express.Router();
  const gVerify = verifyGoogle || defaultGoogleVerifier(googleClientId);
  const authLimit = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
  const nameLimit = createRateLimiter({ windowMs: 60 * 1000, max: 40 });
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { console.error('[accounts]', err && err.message); res.status(500).json({ error: 'server-error' }); });

  router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.SITE_ORIGIN || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(express.json({ limit: '10kb' }));

  router.get('/config', (req, res) => res.json({ googleClientId: googleClientId || null }));

  router.post('/google', wrap(async (req, res) => {
    if (!googleClientId && !verifyGoogle) return res.status(503).json({ error: 'google-not-configured' });
    if (!authLimit('google|' + ipOf(req))) return res.status(429).json({ error: 'too-many-attempts' });
    const credential = String((req.body && req.body.credential) || '');
    if (!credential) return res.status(400).json({ error: 'missing-credential' });
    let g;
    try { g = await gVerify(credential); } catch (e) { return res.status(401).json({ error: 'invalid-google-token' }); }
    if (!g || !g.sub || !g.email || !g.emailVerified) return res.status(401).json({ error: 'invalid-google-token' });
    const email = normEmail(g.email);
    let account = await accounts.findByGoogleId(g.sub);
    if (!account) {
      const byEmail = await accounts.findByEmail(email);
      if (byEmail) account = await accounts.update(byEmail.id, { googleId: g.sub, avatar: byEmail.avatar || g.picture || null }); // Google verified this email, so it is safe to link
      else {
        try { account = await accounts.create({ email, emailLower: email, googleId: g.sub, avatar: g.picture || null }); }
        catch (err) { if (isDup(err)) account = (await accounts.findByGoogleId(g.sub)) || (await accounts.findByEmail(email)); else throw err; }
      }
    }
    if (!account) return res.status(500).json({ error: 'server-error' });
    res.json({ token: await accounts.createSession(account.id), account: publicAccount(account) });
  }));

  router.get('/me', wrap(async (req, res) => {
    const account = await accounts.accountForToken(bearer(req));
    if (!account) return res.status(401).json({ error: 'no-session' });
    res.json({ account: publicAccount(account) });
  }));

  router.get('/username-available', wrap(async (req, res) => {
    if (!nameLimit('name|' + ipOf(req))) return res.status(429).json({ error: 'too-many-attempts' });
    const v = validateUsername(req.query.u);
    if (!v.ok) return res.json({ available: false, reason: v.error });
    res.json({ available: !(await accounts.findByUsername(v.username)), reason: null });
  }));

  router.post('/username', wrap(async (req, res) => {
    const account = await accounts.accountForToken(bearer(req));
    if (!account) return res.status(401).json({ error: 'no-session' });
    if (account.usernameLower) return res.status(409).json({ error: 'username-already-set' });
    const v = validateUsername(req.body && req.body.username);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const color = COLORS.includes(req.body && req.body.color) ? req.body.color : null;
    if (await accounts.findByUsername(v.username)) return res.status(409).json({ error: 'username-taken' });
    let updated;
    try { updated = await accounts.setUsername(account.id, v, color); }
    catch (err) { if (isDup(err)) return res.status(409).json({ error: 'username-taken' }); throw err; }
    if (!updated) return res.status(409).json({ error: 'username-already-set' });
    res.json({ account: publicAccount(updated) });
  }));

  router.post('/logout', wrap(async (req, res) => { await accounts.deleteSession(bearer(req)); res.json({ ok: true }); }));

  return router;
}

module.exports = { AccountStore, createAccountRoutes, validateUsername, publicAccount };
