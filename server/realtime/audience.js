'use strict';

const crypto = require('crypto');

const CHAT_MAX_LENGTH = 280;
const CHAT_HISTORY_MAX = 100;
const CHAT_RATE_MS = 750;

function ensureAudience(room) {
  if (!room.spectators) room.spectators = new Map();
  if (!Array.isArray(room.chat)) room.chat = [];
  if (!room.chatRate) room.chatRate = new Map();
  if (!room.seenViewerIds) room.seenViewerIds = new Set();
  if (!Number.isFinite(room.totalViews)) room.totalViews = 0;
  if (!Number.isFinite(room.reactionTotal)) room.reactionTotal = 0;
  if (!room.visibility) room.visibility = 'public';
  if (!room.spectatorToken) room.spectatorToken = crypto.randomBytes(18).toString('hex');
  return room;
}

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

function canSpectate(room, watchToken) {
  ensureAudience(room);
  return room.visibility === 'public' || (!!watchToken && watchToken === room.spectatorToken);
}

function addSpectator(room, socketId, payload) {
  ensureAudience(room);
  const input = typeof payload === 'string' ? { name: payload } : (payload || {});
  const viewerId = String(input.viewerId || '').trim().slice(0, 120);
  const name = String(input.name || 'Guest').trim().slice(0, 30) || 'Guest';
  const spectator = {
    socketId,
    viewerId: viewerId || null,
    name,
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

function audienceInfo(room, includeSecret = false) {
  ensureAudience(room);
  const audience = Array.from(room.spectators.values()).map(s => ({
    name: s.name,
    viewerId: s.viewerId,
    joinedAt: s.joinedAt
  }));
  const info = {
    watching: room.spectators.size,
    viewerCount: room.spectators.size,
    views: room.totalViews,
    totalViews: room.totalViews,
    messages: room.chat.length,
    reactions: room.reactionTotal,
    visibility: room.visibility,
    audience,
    chat: room.chat.slice(-50)
  };
  if (includeSecret) info.spectatorToken = room.spectatorToken;
  return info;
}

function addChatMessage(room, socketId, { name, role, text }) {
  ensureAudience(room);
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
  if (!cleanText) return { error: 'empty-message' };
  const now = Date.now();
  const previous = room.chatRate.get(socketId) || 0;
  if (now - previous < CHAT_RATE_MS) return { error: 'chat-rate-limit' };
  room.chatRate.set(socketId, now);
  const message = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || 'Guest').trim().slice(0, 30) || 'Guest',
    role: role === 'player' ? 'player' : 'spectator',
    text: cleanText,
    at: now
  };
  room.chat.push(message);
  if (room.chat.length > CHAT_HISTORY_MAX) room.chat.splice(0, room.chat.length - CHAT_HISTORY_MAX);
  return { message };
}

module.exports = {
  CHAT_MAX_LENGTH,
  CHAT_HISTORY_MAX,
  ensureAudience,
  normalizeVisibility,
  setVisibility,
  canSpectate,
  addSpectator,
  removeSpectator,
  audienceInfo,
  addChatMessage
};
