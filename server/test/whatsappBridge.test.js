'use strict';

process.env.WHATSAPP_GAME_LINK_SECRET='test-secret';

const assert=require('assert');
const {
  createWhatsAppGameToken,
  resolveWhatsAppGameToken,
  gameResultMessage
}=require('../bot/whatsappBridge');

const token=createWhatsAppGameToken('+2348000000000');
assert(token);
assert.deepEqual(resolveWhatsAppGameToken(token),{phone:'+2348000000000'});
assert.equal(resolveWhatsAppGameToken(token+'.tampered'),null);

assert.equal(gameResultMessage({won:true,opponents:['Musa']}),
  '🏆 You won!\n\nYou won against Musa.');
assert.equal(gameResultMessage({won:false,opponents:['Isaac']}),
  '😔 You lost.\n\nYou lost to Isaac.');

console.log('whatsappBridge.test.js passed');
