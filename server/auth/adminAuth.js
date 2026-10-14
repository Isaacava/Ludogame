'use strict';
const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // an admin session lasts 12 hours

class AdminAuth {
  constructor(password) {
    this.password = password || process.env.ADMIN_PASSWORD;
    if (!this.password) {
      if (process.env.NODE_ENV === 'production') throw new Error('ADMIN_PASSWORD must be set in production');
      this.password = 'change-me-now';
    }
    this.tokens = new Map();
    this.attempts = new Map(); // ip -> [timestamps]
  }
  tooManyAttempts(ip) {
    const now = Date.now(), a = (this.attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    this.attempts.set(ip, a); return a.length >= 8;
  }
  login(candidatePassword, ip = 'unknown') {
    if (this.tooManyAttempts(ip)) return { error: 'too-many-attempts' };
    const a = crypto.createHash('sha256').update(String(candidatePassword || '')).digest(), b = crypto.createHash('sha256').update(this.password).digest();
    if (!crypto.timingSafeEqual(a, b)) { this.attempts.get(ip).push(Date.now()); return null; }
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { createdAt: Date.now() });
    return token;
  }
  isValid(token) {
    const t = this.tokens.get(token); if (!t) return false;
    if (Date.now() - t.createdAt > TOKEN_TTL_MS) { this.tokens.delete(token); return false; }
    return true;
  }
  logout(token) { this.tokens.delete(token); }
}
function requireAdmin(adminAuth) {
  return (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !adminAuth.isValid(token)) return res.status(401).json({ error: 'admin-auth-required' });
    next();
  };
}
module.exports = { AdminAuth, requireAdmin };
