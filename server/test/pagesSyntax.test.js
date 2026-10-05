'use strict';
// Every inline <script> in every page must compile. (live-ludo.html shipped with two syntax errors that silently killed the whole page.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..', '..');
for (const file of ['index.html', 'play.html', 'whot.html', 'live-ludo.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(root, 'web', file), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.trim());
  assert(scripts.length > 0, `${file} has no inline script`);
  scripts.forEach((source, i) => assert.doesNotThrow(() => new vm.Script(source, { filename: `${file}#${i + 1}` }), `${file} script ${i + 1} failed to compile`));
}
// Shared browser scripts must compile too.
for (const file of ['ludo-board.js', 'audio.js']) {
  const fp = path.join(root, 'web', file);
  if (fs.existsSync(fp)) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(fp, 'utf8'), { filename: file }), `${file} failed to compile`);
}
// Regression: play.html used WHATSAPP_GAME_TOKEN in create-room / join-room without ever defining it, so Ludo multiplayer threw a ReferenceError.
const play = fs.readFileSync(path.join(root, 'web', 'play.html'), 'utf8');
assert(/(?:var|let|const)\s+WHATSAPP_GAME_TOKEN\b/.test(play), 'play.html must define WHATSAPP_GAME_TOKEN before using it');
console.log('pagesSyntax.test.js passed');
