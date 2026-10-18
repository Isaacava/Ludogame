'use strict';
// Snooker: full-size table, 15 reds + 6 colours + cue ball, standard scoring and fouls.
// The server is the referee and the physics engine: a client only sends an aim angle + power, the server simulates the
// whole shot deterministically and sends back the frames so every screen replays exactly the same thing.
// Units are millimetres, +x runs from the baulk (left) cushion to the top (right) cushion, +y runs down the screen.
const L = 3569, W = 1778, R = 26;           // table playing area and ball radius
const BAULK = 737, D_RADIUS = 292;          // baulk line (x) and the radius of the "D"
const POCKETS = [
  { x: 0, y: 0, r: 62 }, { x: L, y: 0, r: 62 }, { x: 0, y: W, r: 62 }, { x: L, y: W, r: 62 }, // corners
  { x: L / 2, y: 0, r: 56 }, { x: L / 2, y: W, r: 56 }                                       // middles
];
const NAMES = ['cue', ...Array(15).fill('red'), 'yellow', 'green', 'brown', 'blue', 'pink', 'black'];
const VALUE = [0, ...Array(15).fill(1), 2, 3, 4, 5, 6, 7];
const COLOURS = [16, 17, 18, 19, 20, 21];            // in the order they must be potted at the end
const SPOT = {
  16: { x: BAULK, y: W / 2 + D_RADIUS }, 17: { x: BAULK, y: W / 2 - D_RADIUS }, 18: { x: BAULK, y: W / 2 },
  19: { x: L / 2, y: W / 2 }, 20: { x: L * 0.75, y: W / 2 }, 21: { x: L - 324, y: W / 2 }
};
const SPOT_PRIORITY = [21, 20, 19, 18, 17, 16];      // when a colour's own spot is taken it goes to the highest free spot

// physics
const STEP = 1 / 480, FRAME_EVERY = 16;             // 480 Hz simulation, 30 fps output
const DECEL = 420, DRAG = 0.12, STOP_V = 14;         // cloth friction (mm/s^2, 1/s) and the speed below which a ball stops
const E_BALL = 0.95, E_WALL = 0.72, WALL_SLIP = 0.985;
const V_MIN = 150, V_MAX = 4700, MAX_SIM_SEC = 45;

const isRed = (id) => id >= 1 && id <= 15, isColour = (id) => id >= 16;
const clone = (b) => b.map(x => ({ ...x }));

function initialBalls() {
  const b = []; b[0] = { id: 0, x: BAULK - 90, y: W / 2 + 40, potted: true }; // the cue ball starts in hand
  const apexX = SPOT[20].x + 2 * R + 0.6; let id = 1;
  for (let k = 0; k < 5; k++) for (let j = 0; j <= k; j++) b[id] = { id: id++, x: apexX + k * (Math.sqrt(3) * R + 0.5), y: W / 2 + (j - k / 2) * (2 * R + 0.4), potted: false };
  for (const c of COLOURS) b[c] = { id: c, x: SPOT[c].x, y: SPOT[c].y, potted: false };
  return b;
}

// ---------------------------------------------------------------------------------------------------------------
// Physics. Pure: takes ball positions, returns what happened. `record` adds the replay frames.
function simulate(balls, angle, power, { record = true } = {}) {
  const n = balls.length;
  const X = new Float64Array(n), Y = new Float64Array(n), VX = new Float64Array(n), VY = new Float64Array(n), alive = new Uint8Array(n);
  for (const b of balls) { X[b.id] = b.x; Y[b.id] = b.y; alive[b.id] = b.potted ? 0 : 1; }
  const speed = V_MIN + Math.max(0, Math.min(1, power)) * (V_MAX - V_MIN);
  VX[0] = Math.cos(angle) * speed; VY[0] = Math.sin(angle) * speed;
  const events = record ? [{ f: 0, t: 'cue', v: Math.round(speed) }] : [], frames = [], pots = []; let first = null, step = 0;
  const lastX = new Float64Array(X), lastY = new Float64Array(Y);
  const maxSteps = Math.round(MAX_SIM_SEC / STEP);
  const r2 = (2 * R) * (2 * R);
  const frameNo = () => frames.length;

  const mv = new Int32Array(n); let mc = 0; // indices of balls that are currently moving
  mv[mc++] = 0;
  for (; step < maxSteps; step++) {
    // 1. move + friction (only balls in motion)
    let nm = 0;
    for (let k = 0; k < mc; k++) {
      const i = mv[k]; if (!alive[i]) continue;
      X[i] += VX[i] * STEP; Y[i] += VY[i] * STEP;
      const s = Math.hypot(VX[i], VY[i]), ds = (DECEL + DRAG * s) * STEP;
      if (s <= ds || s < STOP_V) { VX[i] = 0; VY[i] = 0; } else { const kk = (s - ds) / s; VX[i] *= kk; VY[i] *= kk; mv[nm++] = i; }
    }
    mc = nm;
    // 2. pockets first, so a ball heading into a pocket is never bounced off the jaws
    for (let k = 0; k < mc; k++) {
      const i = mv[k];
      for (let p = 0; p < 6; p++) {
        const P = POCKETS[p], dx = X[i] - P.x, dy = Y[i] - P.y;
        if (dx * dx + dy * dy < P.r * P.r) { alive[i] = 0; VX[i] = 0; VY[i] = 0; pots.push({ id: i, pocket: p, f: frameNo() }); if (record) events.push({ f: frameNo(), t: 'pot', id: i, pocket: p }); break; }
      }
    }
    // 3. ball-ball: every moving ball against every other live ball
    for (let k = 0; k < mc; k++) {
      const i = mv[k]; if (!alive[i]) continue;
      for (let j = 0; j < n; j++) {
        if (j === i || !alive[j]) continue;
        const jMoving = VX[j] !== 0 || VY[j] !== 0; if (jMoving && j < i) continue; // each moving pair once
        const dx = X[j] - X[i], dy = Y[j] - Y[i], d2 = dx * dx + dy * dy;
        if (d2 >= r2 || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, vrel = (VX[i] - VX[j]) * nx + (VY[i] - VY[j]) * ny;
        const overlap = 2 * R - d; X[i] -= nx * overlap / 2; Y[i] -= ny * overlap / 2; X[j] += nx * overlap / 2; Y[j] += ny * overlap / 2;
        if (vrel > 0) {
          const imp = (1 + E_BALL) / 2 * vrel; VX[i] -= imp * nx; VY[i] -= imp * ny; VX[j] += imp * nx; VY[j] += imp * ny;
          if (first === null && (i === 0 || j === 0)) first = i === 0 ? j : i;
          if (record && vrel > 40) events.push({ f: frameNo(), t: 'ball', v: Math.round(vrel) });
          if (!jMoving) mv[mc++] = j; // a struck ball starts moving
        }
      }
    }
    // 4. cushions
    for (let k = 0; k < mc; k++) {
      const i = mv[k]; if (!alive[i]) continue;
      let hit = 0;
      if (X[i] < R) { X[i] = R; if (VX[i] < 0) { VX[i] = -VX[i] * E_WALL; VY[i] *= WALL_SLIP; hit = Math.abs(VX[i]); } }
      else if (X[i] > L - R) { X[i] = L - R; if (VX[i] > 0) { VX[i] = -VX[i] * E_WALL; VY[i] *= WALL_SLIP; hit = Math.abs(VX[i]); } }
      if (Y[i] < R) { Y[i] = R; if (VY[i] < 0) { VY[i] = -VY[i] * E_WALL; VX[i] *= WALL_SLIP; hit = Math.max(hit, Math.abs(VY[i])); } }
      else if (Y[i] > W - R) { Y[i] = W - R; if (VY[i] > 0) { VY[i] = -VY[i] * E_WALL; VX[i] *= WALL_SLIP; hit = Math.max(hit, Math.abs(VY[i])); } }
      if (record && hit > 60) events.push({ f: frameNo(), t: 'cushion', v: Math.round(hit) });
    }
    // dedupe the moving list (a ball can be added by two collisions in one step) and drop pocketed balls
    let w = 0; for (let k = 0; k < mc; k++) { const i = mv[k]; if (!alive[i]) continue; let dup = false; for (let q = 0; q < w; q++) if (mv[q] === i) { dup = true; break; } if (!dup) mv[w++] = i; } mc = w;
    if (record && step % FRAME_EVERY === 0) {
      const fr = [];
      for (let i = 0; i < n; i++) if (alive[i] && (X[i] !== lastX[i] || Y[i] !== lastY[i])) { fr.push(i, Math.round(X[i] * 10) / 10, Math.round(Y[i] * 10) / 10); lastX[i] = X[i]; lastY[i] = Y[i]; }
      frames.push(fr);
    }
    if (mc === 0) break;
  }
  if (record) { const fr = []; for (let i = 0; i < n; i++) if (alive[i]) fr.push(i, Math.round(X[i] * 10) / 10, Math.round(Y[i] * 10) / 10); frames.push(fr); }
  const end = balls.map(b => ({ id: b.id, x: alive[b.id] ? X[b.id] : b.x, y: alive[b.id] ? Y[b.id] : b.y, potted: !alive[b.id] }));
  return { frames, events, pots, first, end, seconds: Math.round(step * STEP * 10) / 10 };
}

// ---------------------------------------------------------------------------------------------------------------
class SnookerGame {
  constructor({ names = ['Player 1', 'Player 2'], mode = 'friends', level = 2 } = {}) {
    this.names = names.slice(0, 2); this.mode = mode; this.level = level;
    this.reset();
  }
  reset() {
    this.balls = initialBalls();
    this.turn = 0; this.scores = [0, 0]; this.breakPts = 0;
    this.on = 'red'; this.nextColour = 0; this.tieBreak = false;
    this.cueInHand = true; this.over = false; this.winner = null; this.endReason = null;
    this.shots = 0; this.lastShot = null; this.history = [];
  }
  get reds() { return this.balls.filter(b => isRed(b.id) && !b.potted).length; }
  get gameOver() { return this.over; }
  opponent(p) { return 1 - p; }
  targetColour() { return COLOURS[this.nextColour]; }
  onLabel() { return this.on === 'red' ? 'red' : this.on === 'colour' ? 'any colour' : NAMES[this.targetColour()]; }

  // --- cue ball placement (in hand, inside the D) ---
  canPlace(x, y) {
    if (!(x <= BAULK && x >= R && y >= R && y <= W - R)) return false;
    if ((x - BAULK) ** 2 + (y - W / 2) ** 2 > D_RADIUS ** 2) return false;
    return this.balls.every(b => b.id === 0 || b.potted || (b.x - x) ** 2 + (b.y - y) ** 2 >= (2 * R) ** 2);
  }
  place(player, x, y) {
    if (this.over) return { error: 'game-over' }; if (player !== this.turn) return { error: 'not-your-turn' }; if (!this.cueInHand) return { error: 'cue-ball-not-in-hand' };
    if (![x, y].every(Number.isFinite) || !this.canPlace(x, y)) return { error: 'invalid-position' };
    const c = this.balls[0]; c.x = x; c.y = y; c.potted = false; this.cueInHand = false; return { ok: true };
  }
  defaultCuePosition() { for (const [x, y] of [[BAULK - 60, W / 2], [BAULK - 120, W / 2 + 80], [BAULK - 120, W / 2 - 80], [BAULK - 200, W / 2]]) if (this.canPlace(x, y)) return { x, y }; return { x: BAULK - 150, y: W / 2 }; }

  // --- the rules, as a pure judgement of one simulated shot ---
  judge(sim) {
    const on = this.on, first = sim.first, target = this.targetColour();
    const potIds = sim.pots.map(p => p.id), cuePotted = potIds.includes(0), obj = potIds.filter(id => id > 0);
    const reasons = []; let foul = false; const involved = [];
    if (first === null) { foul = true; reasons.push('no-contact'); }
    else {
      involved.push(VALUE[first]);
      if (on === 'red' && !isRed(first)) { foul = true; reasons.push('wrong-ball-hit'); }
      else if (on === 'colour' && !isColour(first)) { foul = true; reasons.push('wrong-ball-hit'); }
      else if (on === 'ordered' && first !== target) { foul = true; reasons.push('wrong-ball-hit'); }
    }
    if (cuePotted) { foul = true; reasons.push('in-off'); }
    let legal = [], illegal = [];
    if (on === 'red') { legal = obj.filter(isRed); illegal = obj.filter(isColour); }
    else if (on === 'colour') { const col = obj.filter(isColour); if (col.length === 1 && col[0] === first && !obj.some(isRed)) legal = col; else illegal = obj.slice(); }
    else { if (obj.length === 1 && obj[0] === target && first === target) legal = obj.slice(); else illegal = obj.slice(); }
    if (foul) { illegal = illegal.concat(legal); legal = []; }
    if (illegal.length) { foul = true; if (!reasons.includes('wrong-ball-potted')) reasons.push('wrong-ball-potted'); illegal.forEach(id => involved.push(VALUE[id])); }
    const onValue = on === 'red' ? 1 : on === 'ordered' ? VALUE[target] : 4;
    const penalty = foul ? Math.max(4, Math.min(7, Math.max(onValue, ...involved, 0))) : 0;
    return { foul, reasons, penalty, legal, illegal, cuePotted, points: legal.reduce((a, id) => a + VALUE[id], 0), first, pots: potIds };
  }

  // choose where a re-spotted colour goes
  respotPosition(id, taken) {
    const free = (x, y) => this.balls.every(b => b.potted || taken.has(b.id) || (b.x - x) ** 2 + (b.y - y) ** 2 >= (2 * R) ** 2);
    const own = SPOT[id]; if (free(own.x, own.y)) return own;
    for (const c of SPOT_PRIORITY) { const s = SPOT[c]; if (VALUE[c] >= 0 && free(s.x, s.y)) return s; }
    for (let x = own.x; x > R; x -= R) if (free(x, W / 2)) return { x, y: W / 2 }; return own;
  }

  // Apply a shot for the player whose turn it is.
  shoot(player, angle, power, { record = true } = {}) {
    if (this.over) return { error: 'game-over' }; if (player !== this.turn) return { error: 'not-your-turn' }; if (this.cueInHand) return { error: 'place-the-cue-ball' };
    if (![angle, power].every(Number.isFinite)) return { error: 'invalid-shot' };
    const sim = simulate(this.balls, angle, power, { record }), j = this.judge(sim), me = this.turn, opp = this.opponent(me);
    const before = { reds: this.reds, on: this.on };
    this.balls = sim.end; this.shots++;
    const respot = [], taken = new Set();
    const bringBack = (id) => { const p = this.respotPosition(id, taken); const b = this.balls[id]; b.x = p.x; b.y = p.y; b.potted = false; taken.add(id); respot.push(id); };
    let next = { on: this.on, turn: me };
    if (j.foul) {
      this.scores[opp] += j.penalty; this.breakPts = 0;
      j.illegal.filter(isColour).forEach(bringBack);                       // wrongly potted colours come back
      this.cueInHand = j.cuePotted; if (j.cuePotted) this.balls[0].potted = true;
      next.turn = opp;
      if (this.tieBreak) { this.finish(opp, 'foul-on-black'); }
    } else if (j.legal.length) {
      this.scores[me] += j.points; this.breakPts += j.points;
      if (this.on === 'red') next.on = 'colour';
      else if (this.on === 'colour') { j.legal.forEach(bringBack); next.on = this.reds > 0 ? 'red' : 'ordered'; if (next.on === 'ordered') this.nextColour = 0; }
      else { // ordered phase: the colour stays down
        if (this.tieBreak) this.finish(me, 'black-ball');
        else if (this.nextColour === 5) { const t = this.blackPotted(); if (t) { next.turn = t.turn; next.on = 'ordered'; } }
        else this.nextColour++;
      }
    } else { // legal contact, nothing potted
      this.breakPts = 0; next.turn = opp;
    }
    if (!this.over) {
      this.turn = next.turn; this.on = next.on;
      // after a miss or a foul move on to the right phase
      if (this.on === 'colour' && (j.foul || !j.legal.length)) this.on = this.reds > 0 ? 'red' : 'ordered';
      if (this.on === 'red' && this.reds === 0) { this.on = 'ordered'; this.nextColour = Math.max(this.nextColour, 0); }
    }
    this.lastShot = { player: me, points: j.points, foul: j.foul, reasons: j.reasons, penalty: j.penalty, pots: j.pots.map(id => NAMES[id]), respot, firstHit: j.first === null ? null : NAMES[j.first], before };
    return { ok: true, sim: { frames: sim.frames, events: sim.events, seconds: sim.seconds }, result: this.lastShot };
  }
  // The last black went down. Returns the next turn if the scores are level (black is re-spotted, next pot wins), else null.
  blackPotted() {
    if (this.scores[0] === this.scores[1]) {
      this.tieBreak = true; this.balls[21].potted = false; this.balls[21].x = SPOT[21].x; this.balls[21].y = SPOT[21].y; this.nextColour = 5;
      this.cueInHand = true; this.balls[0].potted = true; this.breakPts = 0; return { turn: this.opponent(this.turn) };
    }
    this.finish(this.scores[0] > this.scores[1] ? 0 : 1, 'frame-complete'); return null;
  }
  finish(winner, reason) { this.over = true; this.winner = winner; this.endReason = reason; }
  resign(player) { if (this.over) return { error: 'game-over' }; this.finish(this.opponent(player), 'resigned'); return { ok: true }; }
  // time ran out on the shot clock: a minimum foul, turn passes
  timeout(player) {
    if (this.over || player !== this.turn) return { error: 'not-your-turn' };
    this.scores[this.opponent(player)] += 4; this.breakPts = 0; this.turn = this.opponent(player); this.on = this.reds > 0 ? 'red' : 'ordered';
    if (this.cueInHand) { const p = this.defaultCuePosition(); this.balls[0].x = p.x; this.balls[0].y = p.y; this.balls[0].potted = false; this.cueInHand = false; }
    this.lastShot = { player, points: 0, foul: true, reasons: ['out-of-time'], penalty: 4, pots: [], respot: [], firstHit: null };
    return { ok: true, result: this.lastShot };
  }

  remainingPoints() { // what is still on the table, for a "can they catch up" display
    const reds = this.reds; if (this.on === 'ordered') { let s = 0; for (let k = this.nextColour; k < 6; k++) s += VALUE[COLOURS[k]]; return s; }
    return reds * 8 + 27;
  }
  stateFor(index) {
    return {
      balls: this.balls.map(b => [b.id, Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, b.potted ? 1 : 0]),
      turn: this.turn, scores: this.scores.slice(), breakPts: this.breakPts, on: this.on, onLabel: this.onLabel(), nextColour: this.nextColour,
      reds: this.reds, cueInHand: this.cueInHand, over: this.over, winner: this.winner, endReason: this.endReason, tieBreak: this.tieBreak,
      names: this.names.slice(), you: index, mode: this.mode, lastShot: this.lastShot, remaining: this.remainingPoints(), shots: this.shots
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Computer opponent: tries many shots on a copy of the table and plays the one that scores best, with a little human error.
function legalTargets(game) {
  if (game.on === 'red') return game.balls.filter(b => isRed(b.id) && !b.potted).map(b => b.id);
  if (game.on === 'colour') return game.balls.filter(b => isColour(b.id) && !b.potted).map(b => b.id);
  return [game.targetColour()];
}
function ghostAngle(cue, obj, pocket) { // angle for the cue ball so that `obj` is sent toward `pocket`
  const dx = pocket.x - obj.x, dy = pocket.y - obj.y, d = Math.hypot(dx, dy) || 1;
  const gx = obj.x - dx / d * 2 * R, gy = obj.y - dy / d * 2 * R;
  return Math.atan2(gy - cue.y, gx - cue.x);
}
function chooseShot(game, level = 2, rng = Math.random) {
  const cue = game.balls[0], targets = legalTargets(game), cands = [];
  for (const id of targets) {
    const o = game.balls[id]; if (o.potted) continue;
    const dist = Math.hypot(o.x - cue.x, o.y - cue.y);
    for (const P of POCKETS) { const a = ghostAngle(cue, o, P); for (const pw of [0.3, 0.45, 0.6, 0.8]) cands.push({ angle: a, power: Math.min(1, pw + dist / 9000) }); }
    const direct = Math.atan2(o.y - cue.y, o.x - cue.x); cands.push({ angle: direct, power: 0.2 }, { angle: direct, power: 0.4 });
  }
  if (!cands.length) for (let k = 0; k < 12; k++) cands.push({ angle: rng() * Math.PI * 2, power: 0.3 });
  const budget = level === 1 ? 24 : level === 2 ? 48 : 90; const shuffled = cands.sort(() => rng() - 0.5).slice(0, budget);
  let best = null;
  for (const c of shuffled) {
    const sim = simulate(game.balls, c.angle, c.power, { record: false }), j = game.judge(sim);
    let score = j.foul ? -j.penalty * 2 : j.points * 3 + (j.legal.length ? 2 : 0);
    if (!j.foul && !j.legal.length) score += 0.5 - c.power * 0.3;       // a safe, soft miss beats a hard one
    if (j.legal.length && game.on === 'red' && !j.cuePotted) score += 1;
    if (!best || score > best.score) best = { ...c, score };
  }
  const sd = level === 1 ? 0.03 : level === 2 ? 0.012 : 0.003;           // aiming error in radians
  const noise = (rng() + rng() + rng() - 1.5) * sd * 2;
  return { angle: best.angle + noise, power: Math.max(0.08, Math.min(1, best.power + (rng() - 0.5) * (level === 1 ? 0.2 : 0.08))) };
}

module.exports = { SnookerGame, simulate, chooseShot, ghostAngle, legalTargets, L, W, R, BAULK, D_RADIUS, POCKETS, NAMES, VALUE, COLOURS, SPOT, isRed, isColour, V_MIN, V_MAX };
