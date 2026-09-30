'use strict';

const assert = require('assert');
const {
  extractMessages,
  normalizeInteractiveCommand,
  interactiveForState
} = require('../bot/metaWhatsAppAdapter');

const payload = {
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        messages: [
          { id: 'text1', from: '2348000000000', type: 'text', text: { body: 'menu' } },
          { id: 'btn1', from: '2348000000000', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'game_whot', title: 'Whot' } } },
          { id: 'list1', from: '2348000000000', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'whot_count_4', title: '4' } } }
        ]
      }
    }]
  }]
};

const messages = extractMessages(payload);
assert.equal(messages.length, 3);
assert.equal(messages[0].text, 'menu');
assert.equal(messages[1].text, 'game_whot');
assert.equal(messages[2].text, 'whot_count_4');

assert.equal(normalizeInteractiveCommand('game_whot'), '2');
assert.equal(normalizeInteractiveCommand('whot_count_4'), '4');
assert.equal(normalizeInteractiveCommand('JOIN WHOT R3HT'), 'JOIN WHOT R3HT');

let ui = interactiveForState({}, {
  patch: { stage: 'game_menu' },
  reply: 'Nice to meet you, Isaac! 🎉\\n\\nYour CodePlay login code: *123456* (valid 10 minutes)\\n\\nGo to https://codeplay.example/signin',
});
assert.equal(ui.kind, 'buttons');
assert.equal(ui.buttons.length, 3);
assert(ui.body.includes('123456'), 'interactive game menu must preserve the login code in its body');

ui = interactiveForState({}, {
  patch: { stage: 'game_menu' },
  reply: 'Tap to create your room: ' + 'https' + '://game.test/whot.html?mode=friends&action=create&players=4',
});
assert.equal(ui.kind, 'buttons');
assert.equal(ui.body, 'Your game link is above. Choose another game any time.');

ui = interactiveForState({ pendingMode: 'friends' }, { patch: { stage: 'whot_count' }, allowedWhotCounts: [2, 3, 4] });
assert.equal(ui.kind, 'list');
assert.equal(ui.rows.length, 3);
assert.equal(ui.rows[2].id, 'whot_count_4');

console.log('metaWhatsAppAdapter.test.js passed');
