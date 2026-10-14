'use strict';
// Accounts: Google sign-in/sign-up (mocked verifier), one-time unique usernames, sessions.
const assert = require('assert');
const express = require('express');
const { AccountStore, createAccountRoutes, validateUsername } = require('../auth/accounts');

(async () => {
  const accounts = new AccountStore(null);
  const google = { 'good-1': { sub: 'g1', email: 'Gina@Example.com', emailVerified: true, picture: 'p.png' },
                   'good-2': { sub: 'g3', email: 'Ada@Example.com', emailVerified: true },
                   'unverified': { sub: 'g2', email: 'x@example.com', emailVerified: false } };
  const app = express();
  app.use('/api/account', createAccountRoutes({ accounts, googleClientId: 'test-client', verifyGoogle: async c => { if (!google[c]) throw new Error('bad'); return google[c]; } }));
  const server = app.listen(0); const base = 'http://localhost:' + server.address().port + '/api/account';
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let b = {}; try { b = JSON.parse(txt); } catch (e) {}
    return { status: r.status, body: b };
  };

  // username rules
  assert(validateUsername('Ab_12').ok); assert(!validateUsername('ab').ok); assert(!validateUsername('has space').ok);
  assert.strictEqual(validateUsername('Admin').error, 'username-reserved');

  // Google creates the account, then a username is chosen once and is unique case-insensitively
  const ada = await call('POST', '/google', { credential: 'good-2' });
  assert.strictEqual(ada.status, 200); assert.strictEqual(ada.body.account.hasUsername, false);
  assert.strictEqual((await call('GET', '/me', null, ada.body.token)).body.account.email, 'ada@example.com');
  assert.strictEqual((await call('GET', '/me')).status, 401);
  assert.strictEqual((await call('POST', '/signup', { email: 'a@b.com', password: 'longenough' })).status, 404); // no email/password signup any more
  assert.strictEqual((await call('GET', '/username-available?u=Ada_P')).body.available, true);
  const set = await call('POST', '/username', { username: 'Ada_P', color: '#38a169' }, ada.body.token);
  assert.strictEqual(set.status, 200); assert.strictEqual(set.body.account.username, 'Ada_P'); assert.strictEqual(set.body.account.color, '#38a169');
  assert.strictEqual((await call('GET', '/username-available?u=ada_p')).body.available, false);
  assert.strictEqual((await call('POST', '/username', { username: 'Other1' }, ada.body.token)).body.error, 'username-already-set');

  // Google: creates account, links to existing email, rejects bad / unverified tokens
  const g = await call('POST', '/google', { credential: 'good-1' });
  assert.strictEqual(g.status, 200); assert.strictEqual(g.body.account.email, 'gina@example.com'); assert.strictEqual(g.body.account.hasUsername, false);
  const g2 = await call('POST', '/google', { credential: 'good-1' });
  assert.strictEqual(g2.body.account.id, g.body.account.id); // same account on repeat sign-in
  assert.strictEqual((await call('POST', '/google', { credential: 'unverified' })).status, 401);
  assert.strictEqual((await call('POST', '/google', { credential: 'garbage' })).status, 401);
  assert.strictEqual((await call('POST', '/username', { username: 'ADA_P' }, g.body.token)).body.error, 'username-taken'); // different person, same name, different case
  assert.strictEqual((await call('POST', '/username', { username: 'Gina_G' }, g.body.token)).status, 200);

  // logout kills the session
  await call('POST', '/logout', null, ada.body.token);
  assert.strictEqual((await call('GET', '/me', null, ada.body.token)).status, 401);

  server.close(); console.log('accounts ok');
})().catch(e => { console.error(e); process.exit(1); });
