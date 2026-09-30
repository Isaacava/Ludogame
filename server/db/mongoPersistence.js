'use strict';

const { MongoClient } = require('mongodb');
function toMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  return Number(value);
}
class MongoPersistence {
  constructor({ uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_DB || 'codeplay' } = {}) {
    this.uri = uri || null; this.dbName = dbName; this.client = null; this.db = null;
  }
  get enabled() { return Boolean(this.uri); }
  async connect() {
    if (!this.enabled) return false;
    if (this.db) return true;
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, retryWrites: true });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    await Promise.all([
      this.db.collection('users').createIndex({ phone: 1 }, { unique: true, name: 'phone_unique' }),
      this.db.collection('users').createIndex({ loginCode: 1 }, { unique: true, sparse: true, name: 'login_code_lookup' }),
      this.db.collection('sessions').createIndex({ token: 1 }, { unique: true, name: 'token_unique' }),
      this.db.collection('sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'created_at_ttl' }),
      this.db.collection('matches').createIndex({ roomCode: 1, createdAt: -1 }, { name: 'room_created' }),
      this.db.collection('matches').createIndex({ createdAt: -1 }, { name: 'created_at' }),
      this.db.collection('settings').createIndex({ key: 1 }, { unique: true, name: 'settings_key_unique' })
    ]);
    return true;
  }
  async close() { if (this.client) await this.client.close(); this.client = null; this.db = null; }
  _collection(name) { return this.db ? this.db.collection(name) : null; }
  async saveUser(user) {
    const col = this._collection('users'); if (!col || !user?.phone) return;
    const doc = { ...user, createdAt: new Date(toMillis(user.createdAt) || Date.now()), updatedAt: new Date() };
    if (doc.loginCodeExpiresAt != null) doc.loginCodeExpiresAt = new Date(toMillis(doc.loginCodeExpiresAt));
    await col.updateOne({ phone: user.phone }, { $set: doc }, { upsert: true });
  }
  _userFromDoc(doc) {
    if (!doc) return null;
    const user = { ...doc }; delete user._id;
    user.createdAt = toMillis(user.createdAt) || Date.now();
    if (user.updatedAt) user.updatedAt = toMillis(user.updatedAt);
    if (user.loginCodeExpiresAt != null) user.loginCodeExpiresAt = toMillis(user.loginCodeExpiresAt);
    return user;
  }
  async loadUser(phone) {
    const col = this._collection('users'); if (!col) return null;
    return this._userFromDoc(await col.findOne({ phone }));
  }
  async findUserByLoginCode(code) {
    const col = this._collection('users'); if (!col) return null;
    return this._userFromDoc(await col.findOne({ loginCode: code, loginCodeExpiresAt: { $gt: new Date() } }));
  }
  async consumeLoginCode(phone, code) {
    const col = this._collection('users'); if (!col) return null;
    const result = await col.findOneAndUpdate(
      { phone, loginCode: code, loginCodeExpiresAt: { $gt: new Date() } },
      { $set: { loginCode: null, loginCodeExpiresAt: null, updatedAt: new Date() } },
      { returnDocument: 'before' }
    );
    return this._userFromDoc(result);
  }
  async saveSession(session) {
    const col = this._collection('sessions'); if (!col || !session?.token) return;
    await col.updateOne({ token: session.token }, { $set: { token: session.token, phone: session.phone, createdAt: new Date(session.createdAt || Date.now()) } }, { upsert: true });
  }
  async loadSession(token) {
    const col = this._collection('sessions'); if (!col) return null;
    const doc = await col.findOne({ token }); if (!doc) return null;
    return { token: doc.token, phone: doc.phone, createdAt: toMillis(doc.createdAt) || Date.now() };
  }
  async recordMatch(match) {
    const col = this._collection('matches'); if (!col) return null;
    const result = await col.insertOne({ ...match, createdAt: new Date(match.createdAt || Date.now()) });
    return String(result.insertedId);
  }
  async saveConfig(config) {
    const col = this._collection('settings'); if (!col) return false;
    await col.updateOne({ key: 'config' }, { $set: { key: 'config', value: config, updatedAt: new Date() } }, { upsert: true });
    return true;
  }
  async loadConfig() {
    const col = this._collection('settings'); if (!col) return null;
    const doc = await col.findOne({ key: 'config' });
    return doc && doc.value ? doc.value : null;
  }
}
module.exports = { MongoPersistence };
