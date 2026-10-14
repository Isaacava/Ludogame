'use strict';
// Friends + invites against the real server: requests, accept/decline, presence, normal and staked invites.
process.env.PORT = '3054'; process.env.ADMIN_PASSWORD = 'test'; process.env.CHIPS_TEST_TOPUP = '1';
process.env.INVITE_TTL_MS = '1500'; process.env.VERSUS_FORFEIT_MS = '60000'; process.env.NEW_ACCOUNT_MAX_STAKE = '100000';
const assert = require('assert'), path = require('path');
const { accounts, wallet, versus } = require('../index');
const { io } = require(path.join(__dirname, '..', '..', 'node_modules', 'socket.io-client'));
const base = 'http://localhost:3054', wait = ms => new Promise(r => setTimeout(r, ms));
const once = (s, ev, ms = 4000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); s.once(ev, d => { clearTimeout(t); res(d); }); });
const api = async (method, p, token, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
async function player(name, chips = 1000) {
  const a = await accounts.create({ email: name + '@x.com', emailLower: name + '@x.com', googleId: 'g' + name });
  await accounts.update(a.id, { username: name, usernameLower: name.toLowerCase(), color: '#38a169' });
  const token = await accounts.createSession(a.id);
  await api('POST', '/api/versus/confirm-age', token, { confirm: true }); if (chips) await api('POST', '/api/versus/test-topup', token, { amount: chips });
  return { id: a.id, token, name };
}
async function online(p, where = 'site') { const s = io(base); await once(s, 'connect'); s.emit('social-hello', { token: p.token, where }); await once(s, 'social-ready'); return s; }
const bal = async p => (await api('GET', '/api/versus/me', p.token)).body.balance;

(async () => {
  await wait(1200);
  const ann = await player('Ann'), bob = await player('Bob'), cy = await player('Cyrus'), broke = await player('Broke', 0);
  const A = (m, p, b) => api(m, p, ann.token, b), B = (m, p, b) => api(m, p, bob.token, b);

  // ---- requests ----
  assert.strictEqual((await api('GET', '/api/social/friends')).status, 401);
  const sock = await online(bob); const gotReq = once(sock, 'social-update');
  assert.strictEqual((await A('POST', '/api/social/friends/request', { username: 'Nobody' })).body.error, 'user-not-found');
  assert.strictEqual((await A('POST', '/api/social/friends/request', { username: 'ann' })).body.error, 'cannot-add-yourself');
  assert.strictEqual((await A('POST', '/api/social/friends/request', { username: 'BOB' })).status, 200); // case-insensitive
  assert.strictEqual((await gotReq).kind, 'request-received');
  assert.strictEqual((await A('POST', '/api/social/friends/request', { username: 'Bob' })).body.error, 'already-requested');
  const bl = (await B('GET', '/api/social/friends')).body; assert.strictEqual(bl.incoming.length, 1); assert.strictEqual(bl.incoming[0].username, 'Ann');
  const al = (await A('GET', '/api/social/friends')).body; assert.strictEqual(al.outgoing.length, 1);
  assert.strictEqual((await A('POST', '/api/social/friends/' + bl.incoming[0].friendshipId + '/accept')).status, 404); // sender cannot accept own request
  // search shows relation
  assert.deepStrictEqual((await A('GET', '/api/social/search?q=bo')).body.rows.map(r => [r.username, r.relation]), [['Bob', 'sent']]);
  assert.strictEqual((await A('GET', '/api/social/search?q=b')).body.rows.length, 0); // needs 2+ characters
  // decline, then request again, then accept
  assert.strictEqual((await B('DELETE', '/api/social/friends/' + bl.incoming[0].friendshipId)).status, 200);
  assert.strictEqual((await B('GET', '/api/social/friends')).body.incoming.length, 0);
  await A('POST', '/api/social/friends/request', { username: 'Bob' });
  const acc = once(sock, 'social-update'); // (bob's own update fires on accept)
  const fid = (await B('GET', '/api/social/friends')).body.incoming[0].friendshipId;
  assert.strictEqual((await B('POST', `/api/social/friends/${fid}/accept`)).status, 200); await acc;
  assert.strictEqual((await A('GET', '/api/social/friends')).body.friends[0].username, 'Bob');
  assert.strictEqual((await A('POST', '/api/social/friends/request', { username: 'Bob' })).body.error, 'already-friends');
  // mutual request becomes friends immediately
  await B('POST', '/api/social/friends/request', { username: 'Cyrus' });
  const m = await api('POST', '/api/social/friends/request', cy.token, { username: 'Bob' }); assert(m.body.autoAccepted);

  // ---- presence ----
  let list = (await A('GET', '/api/social/friends')).body.friends; assert.strictEqual(list[0].status, 'online'); // bob's socket is connected
  const annSock = await online(ann); const pres = once(annSock, 'presence'); sock.emit('social-hello', { token: bob.token, where: 'ludo' });
  assert.deepStrictEqual(await pres, { accountId: bob.id, status: 'playing' });
  assert.strictEqual((await A('POST', '/api/social/invite', { username: 'Bob', game: 'ludo', stake: 0 })).body.error, 'friend-busy');
  const sock2 = await online(bob); // second tab on the site; still playing in the first
  sock.disconnect(); await wait(150);
  assert.strictEqual((await A('GET', '/api/social/friends')).body.friends[0].status, 'online');
  assert.strictEqual((await B('POST', '/api/social/invite', { username: 'Cyrus', game: 'ludo' })).body.error, 'friend-offline'); // Bob's friend Cyrus is not online
  assert.strictEqual((await A('POST', '/api/social/invite', { username: 'Cyrus', game: 'ludo' })).body.error, 'not-friends');
  assert.strictEqual((await api('POST', '/api/social/invite', cy.token, { username: 'Ann', game: 'ludo' })).body.error, 'not-friends');

  // ---- normal invite -> private room, no chips ----
  const inv = once(sock2, 'friend-invite');
  const sent = await A('POST', '/api/social/invite', { username: 'Bob', game: 'ludo', stake: 0 }); assert.strictEqual(sent.status, 200);
  const got = await inv; assert.strictEqual(got.from.username, 'Ann'); assert.strictEqual(got.stake, 0);
  assert.strictEqual((await A('POST', '/api/social/invite', { username: 'Bob', game: 'whot' })).body.error, 'invite-pending');
  const r1 = once(annSock, 'match-ready'), r2 = once(sock2, 'match-ready');
  assert.strictEqual((await B('POST', `/api/social/invite/${got.inviteId}/accept`)).status, 200);
  const [ma, mb] = await Promise.all([r1, r2]); assert.strictEqual(ma.code, mb.code); assert(ma.url.includes('playerToken=' + ma.playerToken)); assert.strictEqual(ma.stake, 0);
  assert.strictEqual(await bal(ann), 1000); assert.strictEqual(await bal(bob), 1000);
  assert.strictEqual((await B('POST', `/api/social/invite/${got.inviteId}/accept`)).status, 409); // cannot accept twice
  // both connect through their game pages and the match starts
  const g1 = io(base), g2 = io(base); await Promise.all([once(g1, 'connect'), once(g2, 'connect')]);
  const rd1 = once(g1, 'game-ready'), rd2 = once(g2, 'game-ready');
  g1.emit('reconnect-player', { code: ma.code, playerToken: ma.playerToken }); await once(g1, 'you-are-player');
  g2.emit('reconnect-player', { code: mb.code, playerToken: mb.playerToken }); await Promise.all([rd1, rd2]);
  g1.disconnect(); g2.disconnect();

  // ---- decline / cancel / expire ----
  let i2 = once(sock2, 'friend-invite'); await A('POST', '/api/social/invite', { username: 'Bob', game: 'chess' }); let gi = await i2;
  const dec = once(annSock, 'invite-update'); await B('POST', `/api/social/invite/${gi.inviteId}/decline`); assert.strictEqual((await dec).status, 'declined');
  i2 = once(sock2, 'friend-invite'); const sent2 = await A('POST', '/api/social/invite', { username: 'Bob', game: 'chess' }); await i2;
  const can = once(sock2, 'invite-update'); await A('POST', `/api/social/invite/${sent2.body.invite.inviteId}/cancel`); assert.strictEqual((await can).status, 'cancelled');
  i2 = once(sock2, 'friend-invite'); const sent3 = await A('POST', '/api/social/invite', { username: 'Bob', game: 'chess' }); gi = await i2;
  assert.strictEqual((await once(sock2, 'invite-update', 4000)).status, 'expired');
  assert.strictEqual((await B('POST', `/api/social/invite/${gi.inviteId}/accept`)).status, 409);

  // ---- staked invite ----
  assert.strictEqual((await A('POST', '/api/social/invite', { username: 'Bob', game: 'whot', stake: 77 })).body.error, 'invalid-stake');
  assert.strictEqual((await A('POST', '/api/social/invite', { username: 'Bob', game: 'whot', stake: 5000 })).body.error, 'insufficient-chips');
  i2 = once(sock2, 'friend-invite'); await A('POST', '/api/social/invite', { username: 'Bob', game: 'whot', stake: 100 }); gi = await i2; assert.strictEqual(gi.stake, 100);
  assert.strictEqual(await bal(ann), 1000); // nothing is locked until it is accepted
  const s1 = once(annSock, 'match-ready'), s2 = once(sock2, 'match-ready');
  assert.strictEqual((await B('POST', `/api/social/invite/${gi.inviteId}/accept`)).status, 200); const [xa, xb] = await Promise.all([s1, s2]);
  assert.strictEqual(await bal(ann), 900); assert.strictEqual(await bal(bob), 900); assert(xa.url.startsWith('/whot.html'));
  const match = await versus.getMatch(xa.matchId); assert.strictEqual(match.kind, 'friend');
  const settle = await versus.settle(xa.matchId, ann.id); assert.strictEqual(settle.payout, 180); assert.strictEqual(settle.points, null);
  assert.strictEqual(await bal(ann), 1080); assert.strictEqual((await accounts.findById(ann.id)).points, undefined); // friends do not earn ranking points

  // recipient cannot afford the stake -> clean failure, nothing locked
  const brokeSock = await online(broke); const fr = await api('POST', '/api/social/friends/request', broke.token, { username: 'Ann' });
  const fid2 = (await A('GET', '/api/social/friends')).body.incoming[0].friendshipId; await A('POST', `/api/social/friends/${fid2}/accept`);
  i2 = once(brokeSock, 'friend-invite'); await A('POST', '/api/social/invite', { username: 'Broke', game: 'ludo', stake: 500 }); gi = await i2;
  const failed = once(annSock, 'invite-update');
  const rr = await api('POST', `/api/social/invite/${gi.inviteId}/accept`, broke.token); assert.strictEqual(rr.body.error, 'insufficient-chips'); assert.strictEqual(rr.body.mine, true);
  assert.strictEqual((await failed).status, 'failed'); assert.strictEqual(await bal(ann), 1080);

  // ---- remove friend ----
  const f = (await A('GET', '/api/social/friends')).body.friends.find(x => x.username === 'Bob');
  assert.strictEqual((await A('DELETE', '/api/social/friends/' + f.friendshipId)).status, 200);
  assert.strictEqual((await A('POST', '/api/social/invite', { username: 'Bob', game: 'ludo' })).body.error, 'not-friends');
  for (const id of [ann.id, bob.id, broke.id, 'house']) assert((await wallet.audit(id)).ok);
  console.log('friends ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
