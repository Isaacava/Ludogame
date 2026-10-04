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
  addChatMessage,
  applyOptions,
  spectateDenyReason,
  spectatorsToEvict,
  setMuted,
  addFeed
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
  assert.strictEqual(info.chat, undefined, 'chat history is only sent on join');
  assert.strictEqual(audienceInfo(room, false, true).chat.length, 1);

  removeSpectator(room, 'socket-2');
  assert.strictEqual(audienceInfo(room, false).watching, 2);

  setVisibility(room, 'public');
  assert.strictEqual(canSpectate(room, ''), true);
  // --- new behaviour ---
  const fresh = ensureAudience({});
  assert.strictEqual(fresh.visibility, 'link', 'rooms default to link-only');
  assert.strictEqual(fresh.showHands, false, 'cards hidden by default');
  assert.strictEqual(canSpectate(fresh, ''), false);
  assert.strictEqual(spectateDenyReason(fresh, ''), 'spectator-access-denied');
  setVisibility(fresh, 'private');
  assert.strictEqual(canSpectate(fresh, fresh.spectatorToken), false);
  assert.strictEqual(spectateDenyReason(fresh, fresh.spectatorToken), 'spectating-disabled');
  applyOptions(fresh, { visibility: 'public', showHands: true, chatEnabled: false });
  assert.deepStrictEqual([fresh.visibility, fresh.showHands, fresh.chatEnabled], ['public', true, false]);

  const r2 = ensureAudience({});
  setVisibility(r2, 'public');
  const v1 = addSpectator(r2, 's1', { name: 'Host', viaToken: true, reservedNames: [] });
  assert.notStrictEqual(v1.name.toLowerCase(), 'host', 'cannot impersonate the host');
  const v2 = addSpectator(r2, 's2', { name: 'Ada', viaToken: false, reservedNames: ['Ada'] });
  assert.notStrictEqual(v2.name, 'Ada', 'cannot copy a player name');
  assert.deepStrictEqual(spectatorsToEvict(r2), [], 'public rooms keep everyone');
  setVisibility(r2, 'link');
  assert.deepStrictEqual(spectatorsToEvict(r2), ['s2'], 'link-only evicts viewers who came via public');
  setVisibility(r2, 'private');
  assert.strictEqual(spectatorsToEvict(r2).length, 2);

  const r3 = ensureAudience({});
  const sp = addSpectator(r3, 'x', { name: 'Fan' });
  assert.strictEqual(addChatMessage(r3, 'x', { name: 'Fan', role: 'spectator', key: sp.key, text: 'visit https://spam.example now' }).message.text, 'visit [link removed] now');
  assert.ok(!/fuck/i.test(addChatMessage(r3, 'x2', { name: 'Fan', role: 'spectator', key: sp.key, text: 'what the fuck' }).message.text));
  setMuted(r3, sp.key, true);
  assert.strictEqual(addChatMessage(r3, 'x3', { name: 'Fan', role: 'spectator', key: sp.key, text: 'hi' }).error, 'muted');
  assert.ok(addChatMessage(r3, 'host1', { name: 'Isaac', role: 'host', text: 'players can always talk' }).message);
  r3.chatEnabled = false;
  assert.strictEqual(addChatMessage(r3, 'x4', { name: 'Fan', role: 'spectator', key: 'other', text: 'hi' }).error, 'chat-disabled');
  assert.ok(addChatMessage(r3, 'host2', { name: 'Isaac', role: 'host', text: 'still works' }).message);
  addFeed(r3, 'Ada played 5 ●', 'play');
  assert.strictEqual(audienceInfo(r3, false, true).feed.length, 1);
  assert.strictEqual(audienceInfo(r3, false).feed, undefined);
  assert.strictEqual(audienceInfo(r3, true).spectatorToken, r3.spectatorToken);
  assert.strictEqual(audienceInfo(r3, false).spectatorToken, undefined);
  console.log('audience tests passed');
}

if (require.main === module) run();
module.exports = { run };
