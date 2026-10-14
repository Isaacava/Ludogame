'use strict';
// Friends: one document per pair of accounts. status 'pending' (requester -> other) or 'accepted'.
// Declining or cancelling deletes the document, so a later request can be sent again.
const crypto = require('crypto');

const MAX_FRIENDS = 200, MAX_OUTGOING = 30;

class FriendStore {
  constructor(persistence = null) { this.persistence = persistence; this.mem = new Map(); this._indexed = false; }
  get _db() { return this.persistence && this.persistence.db ? this.persistence.db : null; }
  async _idx() {
    if (this._indexed || !this._db) return;
    const c = this._db.collection('friendships');
    await Promise.all([
      c.createIndex({ id: 1 }, { unique: true, name: 'friend_id' }),
      c.createIndex({ pairKey: 1 }, { unique: true, name: 'friend_pair' }),
      c.createIndex({ a: 1 }, { name: 'friend_a' }), c.createIndex({ b: 1 }, { name: 'friend_b' })
    ]);
    this._indexed = true;
  }
  pairKey(x, y) { return [x, y].sort().join(':'); }
  _strip(d) { if (!d) return null; const { _id, ...r } = d; return r; }
  async get(id) {
    if (this._db) { await this._idx(); return this._strip(await this._db.collection('friendships').findOne({ id })); }
    const d = this.mem.get(id); return d ? { ...d } : null;
  }
  async findPair(x, y) {
    const pairKey = this.pairKey(x, y);
    if (this._db) { await this._idx(); return this._strip(await this._db.collection('friendships').findOne({ pairKey })); }
    return [...this.mem.values()].find(d => d.pairKey === pairKey) || null;
  }
  async create(doc) {
    if (this._db) { await this._idx(); await this._db.collection('friendships').insertOne({ ...doc }); return doc; }
    if ([...this.mem.values()].some(d => d.pairKey === doc.pairKey)) { const e = new Error('dup'); e.code = 11000; throw e; }
    this.mem.set(doc.id, { ...doc }); return doc;
  }
  async patch(id, patch) { if (this._db) await this._db.collection('friendships').updateOne({ id }, { $set: patch }); else { const d = this.mem.get(id); if (d) Object.assign(d, patch); } }
  async remove(id) { if (this._db) await this._db.collection('friendships').deleteOne({ id }); else this.mem.delete(id); }
  async forAccount(accountId) {
    if (this._db) { await this._idx(); return (await this._db.collection('friendships').find({ $or: [{ a: accountId }, { b: accountId }] }).toArray()).map(d => this._strip(d)); }
    return [...this.mem.values()].filter(d => d.a === accountId || d.b === accountId).map(d => ({ ...d }));
  }
}

class FriendsService {
  constructor({ store, accounts }) { this.store = store; this.accounts = accounts; }
  other(doc, me) { return doc.a === me ? doc.b : doc.a; }

  async request(fromId, username) {
    const target = await this.accounts.findByUsername(String(username || '').trim());
    if (!target || !target.usernameLower) return { error: 'user-not-found' };
    if (target.id === fromId) return { error: 'cannot-add-yourself' };
    const existing = await this.store.findPair(fromId, target.id);
    if (existing) {
      if (existing.status === 'accepted') return { error: 'already-friends' };
      if (existing.requester === fromId) return { error: 'already-requested' };
      await this.store.patch(existing.id, { status: 'accepted', respondedAt: new Date() }); // they already asked me: just accept
      return { ok: true, autoAccepted: true, friendshipId: existing.id, target };
    }
    const mine = await this.store.forAccount(fromId);
    if (mine.filter(d => d.status === 'pending' && d.requester === fromId).length >= MAX_OUTGOING) return { error: 'too-many-requests' };
    if (mine.filter(d => d.status === 'accepted').length >= MAX_FRIENDS) return { error: 'friends-limit' };
    const [a, b] = [fromId, target.id].sort();
    const doc = { id: crypto.randomUUID(), a, b, pairKey: this.store.pairKey(a, b), requester: fromId, status: 'pending', createdAt: new Date() };
    try { await this.store.create(doc); } catch (err) { if (err && err.code === 11000) return { error: 'already-requested' }; throw err; }
    return { ok: true, friendshipId: doc.id, target };
  }

  async accept(id, byId) {
    const d = await this.store.get(id);
    if (!d || d.status !== 'pending' || (d.a !== byId && d.b !== byId) || d.requester === byId) return { error: 'request-not-found' };
    const mine = await this.store.forAccount(byId);
    if (mine.filter(x => x.status === 'accepted').length >= MAX_FRIENDS) return { error: 'friends-limit' };
    await this.store.patch(id, { status: 'accepted', respondedAt: new Date() });
    return { ok: true, otherId: this.other(d, byId) };
  }
  // pending: the sender cancels, the receiver declines. accepted: either side removes the friend.
  async end(id, byId) {
    const d = await this.store.get(id);
    if (!d || (d.a !== byId && d.b !== byId)) return { error: 'not-found' };
    await this.store.remove(id);
    return { ok: true, otherId: this.other(d, byId), wasPending: d.status === 'pending', declined: d.status === 'pending' && d.requester !== byId };
  }

  async areFriends(x, y) { const d = await this.store.findPair(x, y); return !!(d && d.status === 'accepted'); }
  async friendIds(accountId) { return (await this.store.forAccount(accountId)).filter(d => d.status === 'accepted').map(d => this.other(d, accountId)); }

  async list(accountId) {
    const docs = await this.store.forAccount(accountId);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const d of docs) {
      const o = await this.accounts.findById(this.other(d, accountId)); if (!o || !o.usernameLower) continue;
      const row = { friendshipId: d.id, accountId: o.id, username: o.username, color: o.color || null, since: d.respondedAt || d.createdAt };
      if (d.status === 'accepted') out.friends.push(row);
      else if (d.requester === accountId) out.outgoing.push({ ...row, sentAt: d.createdAt });
      else out.incoming.push({ ...row, sentAt: d.createdAt });
    }
    out.friends.sort((x, y) => x.username.localeCompare(y.username, undefined, { sensitivity: 'base' }));
    return out;
  }

  // Username search for the "Add friend" box, with the relationship to the searcher.
  async search(query, selfId, limit = 8) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const found = await this.accounts.searchUsernames(q, limit + 1);
    const mine = await this.store.forAccount(selfId);
    const rel = new Map(mine.map(d => [this.other(d, selfId), d.status === 'accepted' ? 'friend' : (d.requester === selfId ? 'sent' : 'received')]));
    return found.filter(a => a.id !== selfId).slice(0, limit).map(a => ({ accountId: a.id, username: a.username, color: a.color || null, relation: rel.get(a.id) || 'none' }));
  }
}

module.exports = { FriendStore, FriendsService, MAX_FRIENDS, MAX_OUTGOING };
