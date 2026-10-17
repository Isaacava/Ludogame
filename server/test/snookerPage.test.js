'use strict';
// The Snooker page in a simulated browser against the real server: computer game (place, aim, shoot, replay, the
// computer answers) and a two-player room (create -> waiting screen with the code -> second player joins).
process.env.PORT = '3066'; process.env.ADMIN_PASSWORD = 'x';
const assert = require('assert'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'); require('../index');
const { JSDOM } = require(path.join(root, 'node_modules', 'jsdom')); const { io } = require(path.join(root, 'node_modules', 'socket.io-client'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const html = fs.readFileSync(path.join(root, 'web', 'snooker.html'), 'utf8').replace(/<script src="https:\/\/cdnjs[^>]*socket\.io[^>]*><\/script>/, '').replace('<script src="social-ui.js"></script>', '');
const errors = [];
function open(query, w0 = 390, h0 = 470, disableIo = false) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost:3066/snooker.html' + query, pretendToBeVisual: true, beforeParse(w) {
    if (!disableIo) w.io = (u, o) => io('http://localhost:3066', o); w.fetch = (u, o) => fetch('http://localhost:3066' + u, o);
    w.HTMLCanvasElement.prototype.getContext = () => null; w.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: w0, height: h0, right: w0, bottom: h0 });
    w.addEventListener('error', e => errors.push(e.message));
  } });
  return dom.window;
}
const $ = (w, id) => w.document.getElementById(id), txt = (w, id) => $(w, id).textContent.replace(/\s+/g, ' ').trim(), hidden = (w, id) => $(w, id).classList.contains('hide');

(async () => {
  await sleep(1000);
  // ---- vs computer ----
  const w = open('?mode=computer&level=1&name=Tester'); await sleep(1500);
  assert(hidden(w, 'waitOv'), 'no waiting overlay in a computer game'); assert.strictEqual(txt(w, 'n0'), 'Tester'); assert(/Computer/.test(txt(w, 'n1')));
  assert.strictEqual(txt(w, 'redsLeft'), '15 reds left'); assert.strictEqual(txt(w, 'onTxt'), 'on: red'); assert(/Drag the cue ball/.test(txt(w, 'hint')), txt(w, 'hint'));
  assert.strictEqual($(w, 'shoot').textContent, 'Place cue ball here'); assert(/mode=computer/.test(w.location.search) && !/mode=friends/.test(w.location.search));
  const snk = w.__snk; assert(snk.S.cueInHand && snk.S.turn === 0);
  const pt = snk.T(640, 960), ev = t => { const e = new w.MouseEvent(t, { clientX: pt[0], clientY: pt[1], bubbles: true }); Object.defineProperty(e, 'pointerId', { value: 1 }); $(w, 'cv').dispatchEvent(e); };
  ev('pointerdown'); ev('pointerup'); $(w, 'shoot').click(); await sleep(500);
  assert(!snk.S.cueInHand && Math.abs(snk.S.balls[0][1] - 640) < 2, 'cue ball placed where it was dropped'); assert.strictEqual($(w, 'shoot').textContent, 'Shoot'); assert(/Drag to aim/.test(txt(w, 'hint')));
  // Touching the drawn cue stick must preserve its direction; dragging around the cue ball rotates it smoothly.
  const cue = snk.S.balls[0], a0 = snk.aim.angle, radius = 420;
  const polar0 = Math.atan2(-Math.sin(a0) * radius, -Math.cos(a0) * radius);
  const p0 = snk.T(cue[1] - Math.cos(a0) * radius, cue[2] - Math.sin(a0) * radius);
  const p1 = snk.T(cue[1] + Math.cos(polar0 + 0.65) * radius, cue[2] + Math.sin(polar0 + 0.65) * radius);
  const touch = (type, p) => { const e = new w.MouseEvent(type, { clientX: p[0], clientY: p[1], bubbles: true, cancelable: true }); Object.defineProperties(e, { pointerId: { value: 7 }, pointerType: { value: 'touch' } }); $(w, 'cv').dispatchEvent(e); };
  touch('pointerdown', p0); assert(Math.abs(snk.aim.angle - a0) < 0.03, 'touching the cue stick does not flip aim'); touch('pointermove', p1);
  const touchDelta = ((snk.aim.angle - a0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  assert(touchDelta > 0.4 && touchDelta < 0.9, 'dragging along the cue stick rotates the cue on touch'); touch('pointerup', p1);
  // aim straight at the pack, soft power
  const before = snk.aim.angle; $(w, 'nR').dispatchEvent(Object.assign(new w.MouseEvent('pointerdown', { bubbles: true }))); $(w, 'nR').dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true }));
  assert(snk.aim.angle !== before, 'the nudge button changes the aim');
  $(w, 'power').value = 35; $(w, 'power').dispatchEvent(new w.Event('input')); assert.strictEqual(txt(w, 'pwVal'), '35%');
  $(w, 'shoot').click(); await sleep(400); assert(snk.anim, 'the shot is being replayed'); assert($(w, 'ctl').classList.contains('off'), 'controls locked during the replay');
  for (let i = 0; i < 40 && snk.anim; i++) await sleep(250); assert(!snk.anim, 'replay finished');
  assert(/scored|missed|Foul/.test(txt(w, 'banner')), 'result banner: ' + txt(w, 'banner'));
  const afterMine = snk.S; assert.strictEqual(afterMine.shots >= 1, true);
  if (afterMine.turn === 1) { for (let i = 0; i < 60 && snk.S.turn === 1; i++) await sleep(250); assert(snk.S.shots >= 2 || snk.S.turn === 0, 'the computer took its turn'); }
  const sc = [Number(txt(w, 's0')), Number(txt(w, 's1'))]; assert.deepStrictEqual(sc, snk.S.scores);
  // refreshing resumes the same game
  const code = snk.S && w.location.search.match(/code=([A-Z0-9]{4})/)[1]; assert(code, 'address carries the room code'); w.close();

  // ---- two players ----
  const a = open('?mode=friends&action=create&name=Ann'); await sleep(1200);
  assert(!hidden(a, 'waitOv') && /Waiting for your opponent/.test(txt(a, 'waitPanel')), 'host sees the waiting screen'); const room = txt(a, 'waitPanel').match(/\b([A-Z0-9]{4})\b/);
  const rc = a.location.search.match(/code=([A-Z0-9]{4})/)[1]; assert(txt(a, 'waitPanel').includes(rc), 'room code shown');
  const b = open('?mode=friends&action=join&code=' + rc + '&name=Bob'); await sleep(1500);
  assert(hidden(a, 'waitOv') && hidden(b, 'waitOv'), 'game starts for both'); assert.strictEqual(txt(a, 'n1'), 'Bob'); assert.strictEqual(txt(b, 'n0'), 'Ann');
  assert.strictEqual($(a, 'shoot').textContent, 'Place cue ball here'); assert(/Waiting for Ann/.test(txt(b, 'hint')), txt(b, 'hint')); assert($(b, 'ctl').classList.contains('off'), 'second player cannot act yet');
  assert(a.__snk.S.turn === 0 && b.__snk.S.you === 1 && a.__snk.S.you === 0);
  const bad = open('?mode=friends&action=join&code=ZZZZ&name=Eve'); await sleep(1200); assert(/no longer available/.test(txt(bad, 'waitPanel')), 'unknown room: ' + txt(bad, 'waitPanel'));
  // If Socket.IO fails to load, the page must offer a retry rather than strand the player on a spinner.
  const offline = open('?mode=computer&name=Offline', 390, 470, true); await sleep(100);
  assert(!hidden(offline, 'waitOv'), 'missing connection library displays a recoverable error');
  assert(Array.from(offline.document.querySelectorAll('#waitPanel button')).some(b => b.textContent === 'Retry connection'), 'loading failure includes a retry button');
  assert.deepStrictEqual(errors, [], 'no script errors: ' + errors.join('; ')); a.close(); b.close(); bad.close(); offline.close();
  console.log('snooker page ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
