'use strict';

const crypto = require('crypto');

const CHAT_MAX_LENGTH = 240;
const CHAT_HISTORY_MAX = 100;
const CHAT_RATE_MS = 750;

function ensureAudience(room) {
  if (!room.spectators) room.spectators = new Map();
  if (!Array.isArray(room.chat)) room.chat = [];
  if (!room.chatRate) room.chatRate = new Map();
  if (!room.visibility) room.visibility = 'public';
  if (!room.spectatorToken) room.spectatorToken = crypto.randomBytes(18).toString('hex');
  return room;
}

function setVisibility(room, visibility) {
  ensureAudience(room);
  room.visibility = String(visibility || '').toLowerCase() === 'private' ? 'private' : 'public';
  return room.visibility;
}

function canSpectate(room, watchToken) {
  ensureAudience(room);
  return room.visibility === 'public' || (!!watchToken && watchToken === room.spectatorToken);
}

function addSpectator(room, socketId, name) {
  ensureAudience(room);
  const spectator = {
    socketId,
    name: String(name || 'Guest').trim().slice(0, 30) || 'Guest',
    joinedAt: Date.now()
  };
  room.spectators.set(socketId, spectator);
  return spectator;
}

function removeSpectator(room, socketId) {
  ensureAudience(room);
  return room.spectators.delete(socketId);
}

function audienceInfo(room, includeSecret = false) {
  ensureAudience(room);
  const info = {
    viewerCount: room.spectators.size,
    visibility: room.visibility,
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
  setVisibility,
  canSpectate,
  addSpectator,
  removeSpectator,
  audienceInfo,
  addChatMessage
};
