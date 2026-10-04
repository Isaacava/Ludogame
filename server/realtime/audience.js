'use strict';

const crypto = require('crypto');

const CHAT_MAX_LENGTH = 280;
const CHAT_HISTORY_MAX = 100;
const CHAT_RATE_MS = 750;
const FEED_MAX = 40;
const NAME_MAX = 24;
// Names a viewer may not use, so nobody can pretend to be the host / staff in chat.
const RESERVED_NAMES = ['host', 'admin', 'administrator', 'moderator', 'mod', 'codeplay', 'support', 'system', 'staff'];
// Deliberately short list of strong profanity; matched as whole words, case-insensitive.
const BAD_WORDS = ['fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy', 'whore', 'slut', 'nigga', 'nigger'];
const BAD_WORD_RE = new RegExp('\\b(' + BAD_WORDS.join('|') + ')\\b', 'gi');
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

function ensureAudience(room) {
  if (!room.spectators) room.spectators = new Map();
  if (!Array.isArray(room.chat)) room.chat = [];
  if (!room.chatRate) room.chatRate = new Map();
  if (!room.seenViewerIds) room.seenViewerIds = new Set();
  if (!(room.mutedKeys instanceof Set)) room.mutedKeys = new Set();
  if (!Array.isArray(room.feed)) room.feed = [];
  if (!Number.isFinite(room.totalViews)) room.totalViews = 0;
  if (!Number.isFinite(room.reactionTotal)) room.reactionTotal = 0;
  // Safe default: watchable only through the host's private watch link (never guessable from the 4-letter room code).
  if (!room.visibility) room.visibility = 'link';
  if (typeof room.chatEnabled !== 'boolean') room.chatEnabled = true;
  if (typeof room.showHands !== 'boolean') room.showHands = false;
  if (!room.spectatorToken) room.spectatorToken = crypto.randomBytes(18).toString('hex');
  return room;
}

// public  = anyone with the room code may watch and the match is listed under "Watch live"
// link    = only people holding the host's watch link (token) may watch
// private = spectating is switched off
function normalizeVisibility(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'public') return 'public';
  if (v === 'private') return 'private';
  return 'link';
}

function setVisibility(room, visibility) {
  ensureAudience(room);
  room.visibility = normalizeVisibility(visibility);
  return room.visibility;
}

// Host options. Only keys that are present are changed.
function applyOptions(room, opts) {
  ensureAudience(room);
  const o = opts || {};
  if (o.visibility !== undefined) setVisibility(room, o.visibility);
  if (o.showHands !== undefined) room.showHands = o.showHands === true || o.showHands === 'true' || o.showHands === '1' || o.showHands === 1;
  if (o.chatEnabled !== undefined) room.chatEnabled = !(o.chatEnabled === false || o.chatEnabled === 'false' || o.chatEnabled === '0' || o.chatEnabled === 0);
  return { visibility: room.visibility, showHands: room.showHands, chatEnabled: room.chatEnabled };
}

function tokenMatches(room, watchToken) {
  const a = Buffer.from(String(watchToken || ''));
  const b = Buffer.from(String(room.spectatorToken || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function spectateDenyReason(room, watchToken) {
  ensureAudience(room);
  if (room.visibility === 'private') return 'spectating-disabled';
  if (room.visibility === 'public' || tokenMatches(room, watchToken)) return null;
  return 'spectator-access-denied';
}

function canSpectate(room, watchToken) {
  return spectateDenyReason(room, watchToken) === null;
}

function cleanViewerName(room, rawName, takenNames) {
  let name = String(rawName || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Guest';
  const lower = name.toLowerCase();
  const taken = new Set((takenNames || []).map(n => String(n || '').trim().toLowerCase()));
  if (RESERVED_NAMES.includes(lower) || taken.has(lower)) name = (name.slice(0, NAME_MAX - 9) + ' (viewer)').trim();
  // keep viewer names unique so chat is never ambiguous
  const existing = new Set(Array.from(room.spectators.values()).map(s => s.name.toLowerCase()));
  let candidate = name, n = 2;
  while (existing.has(candidate.toLowerCase())) candidate = name.slice(0, NAME_MAX - 3) + ' ' + n++;
  return candidate;
}

function addSpectator(room, socketId, payload) {
  ensureAudience(room);
  const input = typeof payload === 'string' ? { name: payload } : (payload || {});
  const viewerId = String(input.viewerId || '').trim().slice(0, 120);
  const spectator = {
    socketId,
    key: crypto.randomBytes(5).toString('hex'),
    viewerId: viewerId || null,
    viaToken: !!input.viaToken,
    name: cleanViewerName(room, input.name, input.reservedNames),
    joinedAt: Date.now()
  };
  room.spectators.set(socketId, spectator);
  if (!viewerId || !room.seenViewerIds.has(viewerId)) {
    room.totalViews += 1;
    if (viewerId) room.seenViewerIds.add(viewerId);
  }
  return spectator;
}

function removeSpectator(room, socketId) {
  ensureAudience(room);
  return room.spectators.delete(socketId);
}

// Spectators who no longer qualify after the host changed visibility.
function spectatorsToEvict(room) {
  ensureAudience(room);
  const out = [];
  room.spectators.forEach((s, socketId) => {
    if (room.visibility === 'private' || (room.visibility === 'link' && !s.viaToken)) out.push(socketId);
  });
  return out;
}

function setMuted(room, key, muted) {
  ensureAudience(room);
  const k = String(key || '');
  if (!k) return false;
  if (muted) room.mutedKeys.add(k); else room.mutedKeys.delete(k);
  return true;
}

function audienceInfo(room, includeSecret = false, includeHistory = false) {
  ensureAudience(room);
  const info = {
    watching: room.spectators.size,
    viewerCount: room.spectators.size,
    views: room.totalViews,
    totalViews: room.totalViews,
    messages: room.chat.length,
    reactions: room.reactionTotal,
    visibility: room.visibility,
    chatEnabled: room.chatEnabled,
    showHands: room.showHands,
    audience: Array.from(room.spectators.values()).map(s => ({ key: s.key, name: s.name, joinedAt: s.joinedAt }))
  };
  // Chat + move history are only sent when someone joins, not on every viewer join/leave broadcast.
  if (includeHistory) {
    info.chat = room.chat.slice(-50);
    info.feed = room.feed.slice(-20);
  }
  if (includeSecret) {
    info.spectatorToken = room.spectatorToken;
    info.muted = Array.from(room.mutedKeys);
  }
  return info;
}

function sanitizeChatText(text) {
  return String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH)
    .replace(URL_RE, '[link removed]')
    .replace(BAD_WORD_RE, w => w.charAt(0) + '*'.repeat(w.length - 1));
}

function addChatMessage(room, socketId, { name, role, text, key }) {
  ensureAudience(room);
  const isViewer = !(role === 'player' || role === 'host');
  if (isViewer && !room.chatEnabled) return { error: 'chat-disabled' };
  if (isViewer && key && room.mutedKeys.has(String(key))) return { error: 'muted' };
  const cleanText = sanitizeChatText(text);
  if (!cleanText) return { error: 'empty-message' };
  const now = Date.now();
  const previous = room.chatRate.get(socketId) || 0;
  if (now - previous < CHAT_RATE_MS) return { error: 'chat-rate-limit' };
  room.chatRate.set(socketId, now);
  const message = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || 'Guest').trim().slice(0, 30) || 'Guest',
    role: role === 'host' ? 'host' : role === 'player' ? 'player' : 'spectator',
    text: cleanText,
    at: now
  };
  if (message.role === 'spectator' && key) message.key = String(key);
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY_MAX) room.chat.splice(0, room.chat.length - CHAT_HISTORY_MAX);
  return { message };
}

function addFeed(room, text, kind) {
  ensureAudience(room);
  const item = { id: crypto.randomBytes(5).toString('hex'), text: String(text || '').slice(0, 140), kind: kind || 'move', at: Date.now() };
  room.feed.push(item);
  if (room.feed.length > FEED_MAX) room.feed.splice(0, room.feed.length - FEED_MAX);
  return item;
}

module.exports = {
  CHAT_MAX_LENGTH,
  CHAT_HISTORY_MAX,
  FEED_MAX,
  ensureAudience,
  normalizeVisibility,
  setVisibility,
  applyOptions,
  canSpectate,
  spectateDenyReason,
  addSpectator,
  removeSpectator,
  spectatorsToEvict,
  setMuted,
  audienceInfo,
  addChatMessage,
  addFeed,
  sanitizeChatText
};
