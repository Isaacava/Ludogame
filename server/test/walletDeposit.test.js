'use strict';
// NOWPayments deposits: invoice creation, signed IPN, credit exactly once, tamper / mismatch protection.
const assert = require('assert'), express = require('express');
const { AccountStore } = require('../auth/accounts');
const { ChipWallet } = require('../wallet/chipWallet');
const { createWalletRoutes, DepositStore, ipnSignature } = require('../wallet/walletRoutes');

(async () => {
  const accounts = new AccountStore(null), wallet = new ChipWallet(null), deposits = new DepositStore(null);
  const SECRET = 'ipn-secret'; const invoices = [];
  const nowpayments = { configured: true, createInvoice: async (x) => { invoices.push(x); return { invoiceId: 'inv' + invoices.length, invoiceUrl: 'https://nowpayments.io/payment/?iid=' + invoices.length }; } };
  const app = express(); app.use('/api/wallet', createWalletRoutes({ accounts, wallet, deposits, nowpayments, ipnSecret: SECRET, baseUrl: 'https://api.example.com', siteUrl: 'https://site.example.com' }));
  const server = app.listen(0); const base = 'http://localhost:' + server.address().port + '/api/wallet';
  const call = async (method, path, body, token, headers = {}) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const ipn = (body, sig) => call('POST', '/ipn', body, null, { 'x-nowpayments-sig': sig === undefined ? ipnSignature(body, SECRET) : sig });

  const a = await accounts.create({ email: 'a@x.com', emailLower: 'a@x.com', googleId: 'ga' });
  await accounts.update(a.id, { username: 'Ann', usernameLower: 'ann', ageConfirmed: true });
  const token = await accounts.createSession(a.id);

  assert.strictEqual((await call('POST', '/deposit', { usd: 10 })).status, 401);
  assert.strictEqual((await call('POST', '/deposit', { usd: 0.5 }, token)).body.error, 'invalid-amount');
  assert.strictEqual((await call('POST', '/deposit', { usd: 5000 }, token)).body.error, 'invalid-amount');
  const d = await call('POST', '/deposit', { usd: 10 }, token);
  assert.strictEqual(d.status, 200); assert.strictEqual(d.body.chips, 1000); assert(d.body.invoiceUrl.startsWith('https://nowpayments.io'));
  const inv = invoices[0]; assert.strictEqual(inv.usd, 10); assert.strictEqual(inv.orderId, d.body.depositId); assert.strictEqual(inv.ipnUrl, 'https://api.example.com/api/wallet/ipn');

  const base_ = { order_id: d.body.depositId, price_amount: 10, price_currency: 'usd', payment_id: 555, pay_currency: 'usdttrc20', actually_paid: 10 };
  // bad / missing signature never credits
  assert.strictEqual((await ipn({ ...base_, payment_status: 'finished' }, 'deadbeef')).status, 401);
  assert.strictEqual((await ipn({ ...base_, payment_status: 'finished' }, null)).status, 401);
  assert.strictEqual(await wallet.balance(a.id), 0);
  // non-final statuses do not credit
  for (const st of ['waiting', 'confirming', 'confirmed', 'sending']) assert.strictEqual((await ipn({ ...base_, payment_status: st })).status, 200);
  assert.strictEqual(await wallet.balance(a.id), 0);
  assert.strictEqual((await call('GET', '/deposits', null, token)).body.rows[0].status, 'pending');
  // a tampered body with a valid signature for different content is rejected
  const sig = ipnSignature({ ...base_, payment_status: 'confirming' }, SECRET);
  assert.strictEqual((await ipn({ ...base_, payment_status: 'finished' }, sig)).status, 401);
  // finished credits once, retries do not credit again
  assert.strictEqual((await ipn({ ...base_, payment_status: 'finished' })).status, 200);
  assert.strictEqual(await wallet.balance(a.id), 1000);
  await ipn({ ...base_, payment_status: 'finished' }); await ipn({ ...base_, payment_status: 'finished' });
  assert.strictEqual(await wallet.balance(a.id), 1000);
  assert.strictEqual((await call('GET', '/deposits', null, token)).body.rows[0].status, 'completed');
  // key order in the body does not matter for the signature
  const shuffled = JSON.parse(JSON.stringify({ payment_status: 'finished', actually_paid: 10, order_id: d.body.depositId, price_currency: 'usd', pay_currency: 'usdttrc20', payment_id: 555, price_amount: 10 }));
  assert.strictEqual((await ipn(shuffled, ipnSignature({ ...base_, payment_status: 'finished' }, SECRET))).status, 200);

  // amount mismatch is flagged, not credited
  const d2 = await call('POST', '/deposit', { usd: 25 }, token);
  const bad = { order_id: d2.body.depositId, price_amount: 1, price_currency: 'usd', payment_id: 556, payment_status: 'finished' };
  assert.strictEqual((await ipn(bad)).body.flagged, true); assert.strictEqual(await wallet.balance(a.id), 1000);
  // partially paid is held for review, expired marked, unknown order ignored
  const d3 = await call('POST', '/deposit', { usd: 5 }, token);
  await ipn({ order_id: d3.body.depositId, price_amount: 5, price_currency: 'usd', payment_status: 'partially_paid' });
  assert.strictEqual((await deposits.get(d3.body.depositId)).status, 'partially_paid'); assert.strictEqual(await wallet.balance(a.id), 1000);
  const d4 = await call('POST', '/deposit', { usd: 5 }, token);
  await ipn({ order_id: d4.body.depositId, price_amount: 5, price_currency: 'usd', payment_status: 'expired' }); assert.strictEqual((await deposits.get(d4.body.depositId)).status, 'expired');
  assert((await ipn({ order_id: 'nope', payment_status: 'finished' })).body.ignored);

  // other users cannot see my deposits; config reflects setup
  const b = await accounts.create({ email: 'b@x.com', emailLower: 'b@x.com', googleId: 'gb' }); const tb = await accounts.createSession(b.id);
  assert.strictEqual((await call('GET', '/deposits', null, tb)).body.rows.length, 0);
  assert.strictEqual((await call('GET', '/config')).body.depositsEnabled, true);
  assert((await wallet.audit(a.id)).ok);
  server.close(); console.log('wallet deposits ok');
})().catch(e => { console.error(e); process.exit(1); });
