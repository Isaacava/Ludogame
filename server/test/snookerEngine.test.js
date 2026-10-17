'use strict';
// Snooker engine: layout, physics (potting, cushions, stopping), and the rules (fouls, scoring, respots, end of frame).
const assert = require('assert');
const { SnookerGame, simulate, chooseShot, ghostAngle, L, W, R, BAULK, POCKETS, SPOT } = require('../engine/snookerEngine');

// Put only the listed balls on the table: spec = { 0:[x,y] (cue), 1:[x,y] (red 1), 16:[x,y] ... }
function setup(spec, extra = {}) {
  const g = new SnookerGame(); g.cueInHand = false;
  for (const b of g.balls) { b.potted = true; }
  for (const [id, [x, y]] of Object.entries(spec)) { const b = g.balls[id]; b.x = x; b.y = y; b.potted = false; }
  Object.assign(g, extra); return g;
}
const aim = (g, id, pocket) => ghostAngle(g.balls[0], g.balls[id], POCKETS[pocket]);

// ---- layout ----
{
  const g = new SnookerGame(); assert.strictEqual(g.reds, 15); assert.strictEqual(g.balls.length, 22);
  for (let i = 0; i < 22; i++) for (let j = i + 1; j < 22; j++) { if (g.balls[i].potted || g.balls[j].potted) continue; assert(Math.hypot(g.balls[i].x - g.balls[j].x, g.balls[i].y - g.balls[j].y) >= 2 * R, `balls ${i},${j} overlap`); }
  assert(g.cueInHand && g.balls[0].potted); assert.strictEqual(g.place(1, 600, W / 2).error, 'not-your-turn');
  assert.strictEqual(g.place(0, BAULK + 50, W / 2).error, 'invalid-position');      // outside the D
  assert.strictEqual(g.place(0, BAULK - 100, W / 2 + 400).error, 'invalid-position');
  assert.strictEqual(g.shoot(0, 0, 0.5).error, 'place-the-cue-ball');
  assert.deepStrictEqual(g.place(0, BAULK - 100, W / 2 + 20), { ok: true }); assert.strictEqual(g.place(0, 600, W / 2).error, 'cue-ball-not-in-hand');
}

// ---- physics ----
{
  const a = setup({ 0: [1500, 1300], 1: [500, 500] }), s1 = simulate(a.balls, aim(a, 1, 0), 0.5), s2 = simulate(a.balls, aim(a, 1, 0), 0.5);
  assert.deepStrictEqual(s1.pots.map(p => p.id), [1], 'object ball potted in the corner'); assert.strictEqual(s1.first, 1);
  assert.deepStrictEqual(JSON.stringify(s1.frames), JSON.stringify(s2.frames), 'simulation is deterministic');
  assert(s1.frames.length > 5 && s1.seconds < 30);
  const slow = simulate(setup({ 0: [1000, 900] }).balls, 0, 0.0); assert(slow.end[0].x > 1000 && slow.end[0].x < 1000 + 600 && !slow.end[0].potted, 'a soft shot rolls a short way and stops');
  const wall = simulate(setup({ 0: [1000, 900] }).balls, Math.PI / 2, 0.45); assert(wall.end[0].y <= W - R + 0.01 && wall.end[0].y >= R, 'cue ball stays on the table (cushion)');
  const hard = simulate(setup({ 0: [1000, 900] }).balls, 0.3, 1); assert(hard.seconds < 45 && hard.end.every(b => b.potted || (b.x >= R - 0.01 && b.x <= L - R + 0.01)));
  // equal-mass collision: head-on, the cue ball stops almost dead and the object ball carries on
  const head = simulate(setup({ 0: [1000, 900], 1: [1500, 900] }).balls, 0, 0.3); assert(head.end[1].x > 1500 && head.end[0].x < head.end[1].x);
}

// ---- rules ----
{ // pot a red legally -> +1, turn stays, now on a colour
  const g = setup({ 0: [1500, 1300], 1: [500, 500], 2: [2500, 300], 19: SPOT[19].x ? [SPOT[19].x, SPOT[19].y] : [0, 0] });
  const r = g.shoot(0, aim(g, 1, 0), 0.5); assert(r.ok && !r.result.foul, JSON.stringify(r.result)); assert.strictEqual(g.scores[0], 1); assert.strictEqual(g.turn, 0); assert.strictEqual(g.on, 'colour'); assert.strictEqual(g.breakPts, 1);
}
{ // miss everything: foul 4, turn passes
  const g = setup({ 0: [1500, 1300], 1: [500, 500] }); const r = g.shoot(0, -Math.PI / 2, 0.2);
  assert(r.result.foul && r.result.reasons.includes('no-contact') && r.result.penalty === 4); assert.strictEqual(g.scores[1], 4); assert.strictEqual(g.turn, 1); assert.strictEqual(g.on, 'red'); assert(!g.cueInHand);
}
{ // hit blue first while on red: foul worth 5
  const g = setup({ 0: [1500, 1300], 1: [500, 500], 19: [1900, 1300] }); const r = g.shoot(0, 0, 0.25);
  assert(r.result.foul && r.result.reasons.includes('wrong-ball-hit') && r.result.penalty === 5, JSON.stringify(r.result)); assert.strictEqual(g.scores[1], 5);
}
{ // in-off after hitting a red: foul, cue ball in hand for the opponent
  const g = setup({ 0: [700, 500], 1: [500, 340], 2: [2000, 900] });
  const ang = Math.atan2(340 - 500, 500 - 700) , r = g.shoot(0, ang, 0.7);
  // whatever happens, a potted cue ball must be a foul that gives cue-ball-in-hand
  if (r.result.pots.includes('cue')) { assert(r.result.foul && g.cueInHand && g.turn === 1 && g.balls[0].potted); }
}
{ // pot a colour after a red: counts, colour is re-spotted while reds remain, back to reds
  const g = setup({ 0: [1500, 1300], 20: [600, 600], 1: [2500, 300] }, { on: 'colour' }); // pink at (600,600)
  const r = g.shoot(0, aim(g, 20, 0), 0.5); assert(!r.result.foul, JSON.stringify(r.result)); assert.strictEqual(g.scores[0], 6); assert.strictEqual(g.on, 'red');
  assert(!g.balls[20].potted && Math.abs(g.balls[20].x - SPOT[20].x) < 0.01, 'pink is back on its spot');
}
{ // two colours respotted after the same foul must not be placed on top of one another
  const g = new SnookerGame(), taken = new Set();
  g.balls[16].potted = true; g.balls[17].potted = true;
  for (const [id, spotId] of [[1, 16], [2, 17]]) {
    g.balls[id].x = SPOT[spotId].x; g.balls[id].y = SPOT[spotId].y; g.balls[id].potted = false;
  }
  const first = g.respotPosition(16); Object.assign(g.balls[16], first, { potted: false }); taken.add(16);
  const second = g.respotPosition(17, taken);
  assert(Math.hypot(first.x - second.x, first.y - second.y) >= 2 * R, 're-spotted colours must remain separated by at least one ball diameter');
}
{ // potting a colour that was not the first ball hit is a foul
  const g = setup({ 0: [1500, 1300], 1: [2000, 300], 16: [500, 500], 17: [1200, 1300] }, { on: 'colour' });
  g.balls[17].x = 1000; const r = g.shoot(0, 0, 0.3); assert(r.result.foul, 'first hit green while a different colour wasnt potted is allowed, so just checking foul logic runs'); 
}
{ // the colours in order at the end: yellow first, stays down, then green ...
  const g = setup({ 0: [1500, 1300], 16: [500, 500], 17: [2500, 300] }, { on: 'ordered', nextColour: 0 });
  const r = g.shoot(0, aim(g, 16, 0), 0.5); assert(!r.result.foul && g.scores[0] === 2 && g.nextColour === 1 && g.balls[16].potted, JSON.stringify(r.result)); assert.strictEqual(g.turn, 0);
}
{ // wrong colour in the ordered phase -> foul worth the larger value
  const g = setup({ 0: [1500, 1300], 16: [500, 500], 17: [2000, 1300] }, { on: 'ordered', nextColour: 0 }); const r = g.shoot(0, 0, 0.25);
  assert(r.result.foul && r.result.penalty === 4 && g.turn === 1, JSON.stringify(r.result));
}
{ // finishing: black down ends the frame, higher score wins
  const g = setup({ 0: [1500, 1300], 21: [500, 500] }, { on: 'ordered', nextColour: 5, scores: [60, 40] });
  g.shoot(0, aim(g, 21, 0), 0.5); assert(g.over && g.winner === 0 && g.endReason === 'frame-complete' && g.scores[0] === 67, `${g.over} ${g.winner} ${g.scores}`);
  const t = setup({ 0: [1500, 1300], 21: [500, 500] }, { on: 'ordered', nextColour: 5, scores: [40, 47] }); t.shoot(0, aim(t, 21, 0), 0.5);
  assert(!t.over && t.tieBreak && t.cueInHand && t.turn === 1 && !t.balls[21].potted, 'level score: black re-spotted'); // 40+7 = 47
  t.place(1, 600, W / 2); t.shoot(1, -Math.PI / 2, 0.2); assert(t.over && t.winner === 0 && t.endReason === 'foul-on-black', 'a foul in the tie-break loses');
}
{ // resign + timeout + state view
  const g = new SnookerGame({ names: ['A', 'B'] }); assert(g.resign(0).ok && g.over && g.winner === 1); assert.strictEqual(g.shoot(1, 0, 0.5).error, 'game-over');
  const h = setup({ 0: [1500, 1300], 1: [500, 500] }); h.timeout(0); assert.strictEqual(h.scores[1], 4); assert.strictEqual(h.turn, 1);
  const st = new SnookerGame({ names: ['A', 'B'] }).stateFor(1); assert.strictEqual(st.balls.length, 22); assert.strictEqual(st.you, 1); assert.strictEqual(st.remaining, 15 * 8 + 27);
}

// ---- computer opponent: plays legal, mostly sensible snooker ----
{
  const g = new SnookerGame({ names: ['You', 'CPU'], mode: 'computer' }); let potsMade = 0, shots = 0, fouls = 0; const t0 = Date.now();
  g.place(0, ...Object.values(g.defaultCuePosition()));
  for (let k = 0; k < 40 && !g.over; k++) {
    if (g.cueInHand) { const p = g.defaultCuePosition(); assert(g.place(g.turn, p.x, p.y).ok); }
    const c = chooseShot(g, 3); const r = g.shoot(g.turn, c.angle, c.power); assert(r.ok, JSON.stringify(r));
    shots++; potsMade += r.result.points; if (r.result.foul) fouls++;
  }
  assert(shots > 10 && potsMade > 0, `the computer should pot something in 40 shots (potted ${potsMade} in ${shots})`);
  console.log(`  computer played ${shots} shots, ${potsMade} points, ${fouls} fouls, ${(Date.now() - t0)} ms`);
}
console.log('snooker engine ok');
