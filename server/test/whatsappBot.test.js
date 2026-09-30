'use strict';

const assert = require('assert');
const { handleMessage } = require('../whatsappBot');

const cfg = {
  get(section) {
    if (section === 'bot') return { welcomeMessage: 'Welcome to CodePlay!' };
    if (section === 'whot') return { enabled: true, playerCounts: [2, 3, 4] };
    return {};
  }
};

let user = null;
let result = handleMessage(user, 'hello', cfg);
assert.equal(result.patch.stage, 'awaiting_name');
user = { phone: '+2348000000000', stage: result.patch.stage, name: null };

result = handleMessage(user, 'Isaac', cfg);
assert.equal(result.patch.stage, 'game_menu');
assert.equal(result.patch.name, 'Isaac');
assert(result.patch.loginCode && /^\d{6}$/.test(result.patch.loginCode));

user = { ...user, ...result.patch };
result = handleMessage(user, '2', cfg);
assert.equal(result.patch.stage, 'whot_mode_menu');

user = { ...user, ...result.patch };
result = handleMessage(user, '2', cfg);
assert.equal(result.patch.stage, 'whot_count');
assert.equal(result.patch.pendingMode, 'friends');

user = { ...user, ...result.patch };
result = handleMessage(user, '4', cfg);
assert.equal(result.patch.stage, 'game_menu');
assert.match(result.reply, /whot\.html\?mode=friends&action=create&players=4/);

user = { ...user, ...result.patch };
result = handleMessage(user, 'menu', cfg);
assert.equal(result.patch.stage, 'game_menu');

user = { ...user, ...result.patch };
result = handleMessage(user, 'JOIN WHOT R3HT', cfg);
assert.match(result.reply, /whot\.html\?mode=friends&action=join&code=R3HT/);

console.log('whatsappBot.test.js passed');
