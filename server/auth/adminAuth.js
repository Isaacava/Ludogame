'use strict';
const crypto = require('crypto');

class AdminAuth {
  constructor(password) {
    this.password = password || process.env.ADMIN_PASSWORD;
    if (!this.password) {
      if (process.env.NODE_ENV === 'production') throw new Error('ADMIN_PASSWORD must be set in production');
      this.password = 'change-me-now';
    }
    this.tokens = new Map();
  }
  login(candidatePassword) {
    if (candidatePassword !== this.password) return null;
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { createdAt: Date.now() });
    return token;
  }
  isValid(token) { return this.tokens.has(token); }
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
