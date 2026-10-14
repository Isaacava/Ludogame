'use strict';
// Wallet: crypto deposits through NOWPayments hosted invoices.
//   1. POST /api/wallet/deposit {usd}  -> creates a deposit record + a NOWPayments invoice, returns the invoice URL.
//   2. NOWPayments calls POST /api/wallet/ipn when the payment status changes. The signature (HMAC-SHA512 of the
//      key-sorted JSON body with the IPN secret) is verified, and chips are credited only on status "finished",
//      exactly once (idempotent ledger key), and only if the paid invoice matches the deposit we created.
const crypto = require('crypto');
const express = require('express');
const { CHIPS_PER_USD } = require('./chipWallet');

const MIN_USD = Number(process.env.DEPOSIT_MIN_USD) || 1;
const MAX_USD = Number(process.env.DEPOSIT_MAX_USD) || 500;

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {});
  return v;
}
function ipnSignature(body, secret) {
  return crypto.createHmac('sha512', secret).update(JSON.stringify(sortKeys(body))).digest('hex');
}
function verifyIpn(body, header, secret) {
  if (!secret || !header || !body || typeof body !== 'object') return false;
  const a = Buffer.from(ipnSignature(body, secret), 'hex'), b = Buffer.from(String(header).toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createNowPaymentsClient({ apiKey = process.env.NOWPAYMENTS_API_KEY, sandbox = process.env.NOWPAYMENTS_SANDBOX === '1' } = {}) {
  const base = sandbox ? 'https://api-sandbox.nowpayments.io' : 'https://api.nowpayments.io';
  return {
    configured: !!apiKey,
    async createInvoice({ usd, orderId, description, ipnUrl, successUrl, cancelUrl }) {
      const r = await fetch(base + '/v1/invoice', {
        method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_amount: usd, price_currency: 'usd', order_id: orderId, order_description: description, ipn_callback_url: ipnUrl, success_url: successUrl, cancel_url: cancelUrl })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.invoice_url) throw new Error('nowpayments-invoice-failed:' + r.status + ':' + (data.message || ''));
      return { invoiceId: String(data.id), invoiceUrl: data.invoice_url };
    }
  };
}

class DepositStore {
  constructor(persistence = null) { this.persistence = persistence; this.mem = new Map(); this._indexed = false; }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }
  async _idx() {
    if (this._indexed || !this._db) return;
    const c = this._db.collection('deposits');
    await Promise.all([c.createIndex({ id: 1 }, { unique: true, name: 'deposit_id' }), c.createIndex({ accountId: 1, createdAt: -1 }, { name: 'deposit_account' })]);
    this._indexed = true;
  }
  async create(d) { if (this._db) { await this._idx(); await this._db.collection('deposits').insertOne({ ...d }); } else this.mem.set(d.id, { ...d }); return d; }
  async get(id) { if (this._db) { await this._idx(); const d = await this._db.collection('deposits').findOne({ id }); if (!d) return null; const { _id, ...r } = d; return r; } const d = this.mem.get(id); return d ? { ...d } : null; }
  async patch(id, patch) { if (this._db) await this._db.collection('deposits').updateOne({ id }, { $set: patch }); else { const d = this.mem.get(id); if (d) Object.assign(d, patch); } }
  async forAccount(accountId, limit = 20) {
    if (this._db) { await this._idx(); return (await this._db.collection('deposits').find({ accountId }).sort({ createdAt: -1 }).limit(limit).toArray()).map(({ _id, ...r }) => r); }
    return [...this.mem.values()].filter(d => d.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async recent(limit = 100) {
    if (this._db) { await this._idx(); return (await this._db.collection('deposits').find({}).sort({ createdAt: -1 }).limit(limit).toArray()).map(({ _id, ...r }) => r); }
    return [...this.mem.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
}

function createWalletRoutes({ accounts, wallet, deposits, nowpayments = createNowPaymentsClient(), ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET, baseUrl = process.env.PUBLIC_BASE_URL || process.env.SITE_URL || '', siteUrl = process.env.SITE_URL || process.env.PUBLIC_BASE_URL || '' }) {
  const router = express.Router();
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => { console.error('[wallet]', err && err.message); res.status(500).json({ error: 'server-error' }); });
  const authed = (fn) => wrap(async (req, res) => { const a = await accounts.accountForToken(bearer(req)); if (!a) return res.status(401).json({ error: 'no-session' }); return fn(req, res, a); });
  router.use(express.json({ limit: '20kb' }));
  router.use((req, res, next) => { res.header('Cache-Control', 'no-store'); next(); });

  router.get('/config', (req, res) => res.json({ depositsEnabled: !!(nowpayments.configured && ipnSecret), minUsd: MIN_USD, maxUsd: MAX_USD, chipsPerUsd: CHIPS_PER_USD, presets: [5, 10, 25, 50, 100], withdrawalsEnabled: false }));

  router.post('/deposit', authed(async (req, res, account) => {
    if (!nowpayments.configured || !ipnSecret) return res.status(503).json({ error: 'deposits-not-configured' });
    if (!account.usernameLower) return res.status(400).json({ error: 'username-required' });
    if (!account.ageConfirmed) return res.status(400).json({ error: 'age-confirmation-required' });
    const usd = Math.round(Number(req.body && req.body.usd) * 100) / 100;
    if (!(usd >= MIN_USD && usd <= MAX_USD)) return res.status(400).json({ error: 'invalid-amount', min: MIN_USD, max: MAX_USD });
    const pending = (await deposits.forAccount(account.id, 10)).filter(d => d.status === 'created' && Date.now() - new Date(d.createdAt).getTime() < 15 * 60 * 1000);
    if (pending.length >= 3) return res.status(429).json({ error: 'too-many-pending-deposits' });
    const dep = { id: crypto.randomUUID(), accountId: account.id, usd, chips: Math.round(usd * CHIPS_PER_USD), status: 'created', createdAt: new Date() };
    await deposits.create(dep);
    try {
      const inv = await nowpayments.createInvoice({ usd, orderId: dep.id, description: `CodePlay chips (${dep.chips})`, ipnUrl: `${baseUrl}/api/wallet/ipn`, successUrl: `${siteUrl}/wallet.html?deposit=return`, cancelUrl: `${siteUrl}/wallet.html?deposit=cancelled` });
      await deposits.patch(dep.id, { invoiceId: inv.invoiceId, invoiceUrl: inv.invoiceUrl });
      res.json({ depositId: dep.id, invoiceUrl: inv.invoiceUrl, usd, chips: dep.chips });
    } catch (err) { await deposits.patch(dep.id, { status: 'failed', error: String(err.message).slice(0, 200) }); console.error('[wallet] invoice', err.message); res.status(502).json({ error: 'payment-provider-error' }); }
  }));

  router.get('/deposits', authed(async (req, res, account) => res.json({ rows: (await deposits.forAccount(account.id, 20)).map(d => ({ id: d.id, usd: d.usd, chips: d.chips, status: d.status, createdAt: d.createdAt, paidAt: d.paidAt || null, invoiceUrl: d.status === 'created' ? d.invoiceUrl : null })) })));

  // NOWPayments IPN webhook
  router.post('/ipn', wrap(async (req, res) => {
    if (!verifyIpn(req.body, req.headers['x-nowpayments-sig'], ipnSecret)) return res.status(401).json({ error: 'bad-signature' });
    const b = req.body, status = String(b.payment_status || '');
    const dep = await deposits.get(String(b.order_id || ''));
    if (!dep) { console.warn('[wallet] IPN for unknown order', b.order_id); return res.json({ ok: true, ignored: true }); }
    const history = Array.isArray(dep.history) ? dep.history : [];
    history.push({ status, at: new Date(), paymentId: b.payment_id || null, paid: b.actually_paid || null, currency: b.pay_currency || null });
    if (status === 'finished') {
      const priceOk = Math.abs(Number(b.price_amount) - dep.usd) < 0.005 && String(b.price_currency || '').toLowerCase() === 'usd';
      if (!priceOk) { await deposits.patch(dep.id, { status: 'amount-mismatch', history, nowPaymentId: b.payment_id || null }); console.error('[wallet] amount mismatch for deposit', dep.id); return res.json({ ok: true, flagged: true }); }
      await wallet.apply(dep.accountId, { amount: dep.chips, type: 'deposit', ref: dep.id, key: `deposit:${dep.id}`, meta: { paymentId: b.payment_id || null, currency: b.pay_currency || null } });
      await deposits.patch(dep.id, { status: 'completed', paidAt: dep.paidAt || new Date(), history, nowPaymentId: b.payment_id || null });
    } else if (['failed', 'expired', 'refunded'].includes(status)) {
      if (dep.status !== 'completed') await deposits.patch(dep.id, { status, history });
    } else if (dep.status !== 'completed') {
      await deposits.patch(dep.id, { status: status === 'partially_paid' ? 'partially_paid' : 'pending', history }); // partially_paid needs manual review, no automatic credit
    }
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createWalletRoutes, createNowPaymentsClient, DepositStore, ipnSignature, verifyIpn, sortKeys };
