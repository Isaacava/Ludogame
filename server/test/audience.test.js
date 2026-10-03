'use strict';

const assert = require('assert');
const {
  ensureAudience,
  normalizeVisibility,
  setVisibility,
  canSpectate,
  addSpectator,
  removeSpectator,
  audienceInfo,
  addChatMessage
} = require('../realtime/audience');

function run() {
  const room = {};
  ensureAudience(room);

  assert.strictEqual(normalizeVisibility('public'), 'public');
  assert.strictEqual(normalizeVisibility('private'), 'private');
  assert.strictEqual(normalizeVisibility('link'), 'link');
  assert.strictEqual(normalizeVisibility('anything'), 'link');

  setVisibility(room, 'link');
  assert.strictEqual(canSpectate(room, ''), false);
  const token = room.spectatorToken;
  assert.strictEqual(canSpectate(room, token), true);

  addSpectator(room, 'socket-1', { viewerId: 'viewer-1', name: 'Ada' });
  addSpectator(room, 'socket-2', { viewerId: 'viewer-1', name: 'Ada (reconnect)' });
  addSpectator(room, 'socket-3', { viewerId: 'viewer-2', name: 'James' });

  let info = audienceInfo(room, false);
  assert.strictEqual(info.watching, 3);
  assert.strictEqual(info.views, 2);
  assert.strictEqual(info.audience.length, 3);

  const a = addChatMessage(room, 'socket-1', { name: 'Ada', role: 'spectator', text: 'Hello live chat' });
  assert.ok(a.message);
  info = audienceInfo(room, false);
  assert.strictEqual(info.messages, 1);
  assert.strictEqual(info.chat.length, 1);

  removeSpectator(room, 'socket-2');
  assert.strictEqual(audienceInfo(room, false).watching, 2);

  setVisibility(room, 'public');
  assert.strictEqual(canSpectate(room, ''), true);
  console.log('audience tests passed');
}

if (require.main === module) run();
module.exports = { run };
