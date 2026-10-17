'use strict';
// Regression: "Play vs computer" in Whot must open a computer game straight away (no room code, no invite button,
// no multiplayer address), a refresh must resume the same game, and if that game is gone a new computer game starts.
process.env.PORT = '3061'; process.env.ADMIN_PASSWORD = 'x';
const assert = require('assert'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
require('../index'); const whot = require('../whotServer').rooms;
const { JSDOM } = require(path.join(root, 'node_modules', 'jsdom')); const { io } = require(path.join(root, 'node_modules', 'socket.io-client'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const html = fs.readFileSync(path.join(root, 'web', 'whot.html'), 'utf8').replace(/<script src="https:\/\/cdnjs[^>]*socket\.io[^>]*><\/script>/, '');

function openPage(url, storage) {
  return new JSDOM(html, { runScripts: 'dangerously', url, pretendToBeVisual: true, beforeParse(w) {
    for (const [k, v] of Object.entries((storage || {}).local || {})) w.localStorage.setItem(k, v);
    for (const [k, v] of Object.entries((storage || {}).session || {})) w.sessionStorage.setItem(k, v); // a refresh keeps the tab's storage
    w.io = (u, o) => io('http://localhost:3061', o); w.fetch = (u, o) => fetch('http://localhost:3061' + u, o);
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, addEventListener() {} })); w.HTMLElement.prototype.scrollIntoView = () => {};
  } }).window;
}
const inline = (w, id) => { const e = w.document.getElementById(id); return e ? e.style.display : 'missing'; };
const dumpOf = st => { const o = {}; for (let i = 0; i < st.length; i++) { const k = st.key(i); o[k] = st.getItem(k); } return o; };
const dump = w => ({ local: dumpOf(w.localStorage), session: dumpOf(w.sessionStorage) });
function assertComputerUi(w, label) {
  assert(/mode=computer/.test(w.location.search) && !/mode=friends/.test(w.location.search), label + ': address stays a computer game: ' + w.location.search);
  assert.notStrictEqual(inline(w, 'game'), 'none', label + ': game board visible'); assert.strictEqual(inline(w, 'waiting'), 'none', label + ': no waiting lobby');
  assert.strictEqual(inline(w, 'roomCode'), 'none', label + ': no room code'); assert.strictEqual(inline(w, 'inviteBtn'), 'none', label + ': no invite button');
  assert.strictEqual(w.document.getElementById('watchMenuBtn').style.display, 'none', label + ': no viewers/chat tools');
}

(async () => {
  await sleep(1000);
  const start = whot.rooms.size;
  const w1 = openPage('http://localhost:3061/whot.html?mode=computer&players=3&name=Tester&color=%23e53e3e'); await sleep(1300);
  assert.strictEqual(whot.rooms.size, start + 1, 'exactly one room created');
  const room = [...whot.rooms.values()].pop();
  assert.strictEqual(room.mode, 'computer'); assert.strictEqual(room.players.filter(p => p.bot).length, 2); assert(room.engine, 'game started immediately');
  assertComputerUi(w1, 'first load'); assert(/action=reconnect/.test(w1.location.search) && w1.location.search.includes(room.code));
  const search = w1.location.search, saved = dump(w1); w1.close();

  // refresh -> resumes the same room, does not create another one
  await sleep(300);
  const w2 = openPage('http://localhost:3061/whot.html' + search, saved); await sleep(1300);
  assert.strictEqual(whot.rooms.size, start + 1, 'refresh did not create a second room');
  assertComputerUi(w2, 'after refresh'); assert(w2.document.querySelectorAll('#hand .card, .hand .card, [data-card]').length > 0, 'hand is shown after refresh'); w2.close();

  // the saved game has expired -> a fresh computer game starts (never joins a stranger's room)
  await sleep(300); whot.rooms.delete(room.code);
  const w3 = openPage('http://localhost:3061/whot.html' + search, saved); await sleep(1500);
  const fresh = [...whot.rooms.values()].pop(); assert(fresh && fresh.code !== room.code && fresh.mode === 'computer' && fresh.engine, 'a new computer game was started');
  assertComputerUi(w3, 'after expiry'); w3.close();
  console.log('whot computer page ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
