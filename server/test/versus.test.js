'use strict';
// Chip wallet + versus: escrow, random pairing, payout minus fee, draw/cancel refunds, exactly-once settlement, points.
const assert = require('assert');
const { AccountStore } = require('../auth/accounts');
const { ChipWallet, HOUSE } = require('../wallet/chipWallet');
const { VersusService, eloDelta } = require('../versus/versusService');

(async () => {
  const accounts = new AccountStore(null), wallet = new ChipWallet(null);
  const mk = async (name, ageHours = 48) => {
    const a = await accounts.create({ email: name + '@x.com', emailLower: name + '@x.com', googleId: 'g' + name });
    await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), ageConfirmed: true, createdAt: new Date(Date.now() - ageHours * 3600e3), color: '#e53e3e' });
    return accounts.findById(a.id);
  };
  const [ann, bob, cy] = [await mk('Ann'), await mk('Bob'), await mk('Cy')];
  for (const a of [ann, bob, cy]) await wallet.apply(a.id, { amount: 1000, type: 'test_topup' });

  const events = [];
  const versus = new VersusService({ wallet, accounts, games: ['ludo'], createRoom: async (g, players) => ({ code: 'ABCD', tokens: players.map((_, i) => 't' + i) }) });
  versus.onEvent(e => events.push(e.type));

  // wallet basics
  assert.strictEqual((await wallet.apply(ann.id, { amount: -5000, type: 'x' })).error, 'insufficient');
  const dup = await wallet.apply(ann.id, { amount: 10, type: 't', key: 'same' }); const dup2 = await wallet.apply(ann.id, { amount: 10, type: 't', key: 'same' });
  assert(dup2.duplicate); assert.strictEqual(dup2.balance, 1010); await wallet.apply(ann.id, { amount: -10, type: 'x' });

  // validation
  assert.strictEqual((await versus.join(ann, 'chess', 100)).error, 'game-unavailable');
  assert.strictEqual((await versus.join(ann, 'ludo', 77)).error, 'invalid-stake');
  assert.strictEqual((await versus.join({ ...ann, ageConfirmed: false }, 'ludo', 100)).error, 'age-confirmation-required');
  assert.strictEqual((await versus.join({ ...ann, usernameLower: undefined }, 'ludo', 100)).error, 'username-required');
  const fresh = await mk('Newbie', 1); await wallet.apply(fresh.id, { amount: 10000, type: 'test_topup' });
  assert.strictEqual((await versus.join(fresh, 'ludo', 5000)).error, 'stake-too-high-for-new-account');
  assert.strictEqual((await versus.join(ann, 'ludo', 5000)).error, 'insufficient-chips');

  // queue locks the stake, cancel refunds it
  const q1 = await versus.join(ann, 'ludo', 100); assert(q1.queued); assert.strictEqual(await wallet.balance(ann.id), 900);
  assert.strictEqual((await versus.join(ann, 'ludo', 100)).error, 'already-queued');
  assert.strictEqual((await versus.cancel(ann.id)).balance, 1000);

  // pairing only within same stake; match locks both; winner gets pot minus 10% fee
  await versus.join(ann, 'ludo', 100);
  const other = await versus.join(cy, 'ludo', 500); assert(other.queued); // different stake, no match
  const m = await versus.join(bob, 'ludo', 100); assert(m.matched);
  assert.strictEqual(await wallet.balance(ann.id), 900); assert.strictEqual(await wallet.balance(bob.id), 900);
  assert.strictEqual((await versus.join(ann, 'ludo', 100)).error, 'match-in-progress');
  await versus.cancel(cy.id);
  await versus.markActive(m.match.id);
  const s = await versus.settle(m.match.id, bob.id);
  assert.strictEqual(s.payout, 180); assert.strictEqual(s.fee, 20);
  assert.strictEqual(await wallet.balance(bob.id), 1080); assert.strictEqual(await wallet.balance(ann.id), 900); assert.strictEqual(await wallet.balance(HOUSE), 20);
  assert.strictEqual((await versus.settle(m.match.id, bob.id)).error, 'already-closed'); // never paid twice
  assert.strictEqual((await versus.settle(m.match.id, ann.id)).error, 'already-closed');
  assert.strictEqual((await versus.cancelMatch(m.match.id)).error, 'already-closed');

  // points move opposite ways and never go below zero
  const b2 = await accounts.findById(bob.id), a2 = await accounts.findById(ann.id);
  assert(b2.points > 1000 && a2.points < 1000 && b2.wins === 1 && a2.losses === 1); assert.strictEqual(b2.points - 1000, 1000 - a2.points);
  const e = eloDelta(1000, 1000); assert.strictEqual(e.gain, 16); assert(eloDelta(800, 1200).gain > eloDelta(1200, 800).gain);
  const lb = await versus.leaderboard('weekly'); assert.strictEqual(lb[0].username, 'Bob');

  // draw refunds both, cancel refunds both
  await versus.join(ann, 'ludo', 50); const d = await versus.join(bob, 'ludo', 50);
  await versus.settle(d.match.id, null, 'draw'); assert.strictEqual(await wallet.balance(ann.id), 900); assert.strictEqual(await wallet.balance(bob.id), 1080);
  await versus.join(ann, 'ludo', 50); const c = await versus.join(bob, 'ludo', 50);
  await versus.cancelMatch(c.match.id, 'no-show'); assert.strictEqual(await wallet.balance(ann.id), 900); assert.strictEqual(await wallet.balance(bob.id), 1080);

  // queue timeout refunds
  await versus.join(cy, 'ludo', 10); versus.now = () => Date.now() + 10 * 60 * 1000; assert.strictEqual(await versus.sweepQueue(), 1);
  assert.strictEqual(await wallet.balance(cy.id), 1000);

  // books balance: ledger sums equal balances
  for (const id of [ann.id, bob.id, cy.id, HOUSE]) assert((await wallet.audit(id)).ok);
  assert(events.includes('matched') && events.includes('settled') && events.includes('cancelled'));
  console.log('versus ok');
})().catch(e => { console.error(e); process.exit(1); });
