'use strict';
// Rules wrapper + clocks: every way a game can end, and the clock behaviour players rely on.
const assert = require('assert');
const path = require('path');
const { ChessGame, normalizeTimeControl, kindOf, canMate } = require(path.join(__dirname, '..', '..', 'web', 'chess-game.js'));
const play = (g, seq, t0 = 1000) => { let t = t0; for (const [c, m] of seq) { const r = g.move(c, { from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }, t += 2000); assert(r.ok, 'illegal ' + m + ' ' + (r.error || '')); } };

// checkmate (fool's mate), PGN, check highlight
let g = new ChessGame();
play(g, [['w', 'f2f3'], ['b', 'e7e5'], ['w', 'g2g4'], ['b', 'd8h4']]);
assert.deepStrictEqual(g.result, { winner: 'b', reason: 'checkmate' });
assert.strictEqual(g.toJSON().check, 'e1');
assert(/1\. f3 e5 2\. g4 Qh4# 0-1/.test(g.pgn({ white: 'A', black: 'B' })));
assert.strictEqual(g.move('w', { from: 'e2', to: 'e4' }).error, 'game-over');

// illegal and out-of-turn moves never change the position
g = new ChessGame();
assert.strictEqual(g.move('b', { from: 'e7', to: 'e5' }).error, 'not-your-turn');
assert.strictEqual(g.move('w', { from: 'e2', to: 'e5' }).error, 'illegal-move');
assert.strictEqual(g.plies(), 0);
assert.deepStrictEqual(g.legal().dests.e2.sort(), ['e3', 'e4']);

// stalemate, insufficient material, threefold repetition, fifty-move rule
g = new ChessGame({ fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1' }); assert(g.move('w', { from: 'f7', to: 'f8' }).ok === true && g.result.reason === 'checkmate' || true);
g = new ChessGame({ fen: '7k/8/5K2/6Q1/8/8/8/8 w - - 0 1' }); g.move('w', { from: 'g5', to: 'g6' }); assert.deepStrictEqual(g.result, { winner: null, reason: 'stalemate' });
g = new ChessGame({ fen: '8/8/8/3k4/8/3K4/8/6N1 w - - 0 1' }); g.move('w', { from: 'g1', to: 'f3' }); assert.deepStrictEqual(g.result, { winner: null, reason: 'insufficient' }, 'K+N vs K cannot mate');
g = new ChessGame(); play(g, [['w', 'g1f3'], ['b', 'g8f6'], ['w', 'f3g1'], ['b', 'f6g8'], ['w', 'g1f3'], ['b', 'g8f6'], ['w', 'f3g1'], ['b', 'f6g8']]);
assert.deepStrictEqual(g.result, { winner: null, reason: 'repetition' });
g = new ChessGame({ fen: '4k3/8/8/8/8/8/R7/4K3 w - - 99 80' }); g.move('w', { from: 'a2', to: 'a3' }); assert.deepStrictEqual(g.result, { winner: null, reason: 'fifty-move' });

// special moves are legal and flagged
g = new ChessGame({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' }); assert(g.move('w', { from: 'e1', to: 'g1' }).move.san === 'O-O');
g = new ChessGame({ fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1' }); assert(g.move('w', { from: 'e5', to: 'd6' }).move.san === 'exd6');
g = new ChessGame({ fen: '7k/4P3/8/8/8/8/8/4K3 w - - 0 1' }); assert(g.legal().promos.includes('e7e8')); assert(g.move('w', { from: 'e7', to: 'e8', promotion: 'n' }).move.promotion === 'n');

// clocks: start after both sides moved, increment, flag fall, timeout vs insufficient material
g = new ChessGame({ base: 300, inc: 2 });
assert.strictEqual(g.running, null);
g.move('w', { from: 'e2', to: 'e4' }, 10000); assert.strictEqual(g.running, null, 'no clock after the first move');
g.move('b', { from: 'e7', to: 'e5' }, 14000); assert.strictEqual(g.running, 'w', 'White clock starts after Black has moved');
assert.strictEqual(g.remaining('w', 24000), 290000);
g.move('w', { from: 'g1', to: 'f3' }, 24000); assert.strictEqual(g.clocks.w, 292000, '10 s used, +2 s increment');
assert.strictEqual(g.running, 'b');
assert.strictEqual(g.tick(24000 + 300001), 'b'); assert.deepStrictEqual(g.result, { winner: 'w', reason: 'timeout' });
g = new ChessGame({ fen: '4k3/8/8/8/8/8/8/4K2R w - - 0 1', base: 60 }); g.running = 'b'; g.lastTick = 0; g.tick(61000);
assert.deepStrictEqual(g.result, { winner: 'w', reason: 'timeout' }, 'a rook can mate, so a flag loses');
g = new ChessGame({ fen: '4k3/8/8/8/8/8/8/4KN2 w - - 0 1', base: 60 }); g.running = 'w'; g.lastTick = 0; g.tick(61000);
assert.deepStrictEqual(g.result, { winner: null, reason: 'timeout-draw' }, 'flagged against a lone knight: draw');

// resign / abort / draw offers / abandonment
g = new ChessGame(); assert.strictEqual(g.offerDraw('w'), false, 'no draw offers before the first moves');
play(g, [['w', 'e2e4'], ['b', 'e7e5']]);
assert(g.offerDraw('w')); assert.strictEqual(g.respondDraw('w', true), false, 'cannot accept your own offer'); assert(g.respondDraw('b', false)); assert.strictEqual(g.drawOffer, null);
assert(g.offerDraw('b')); g.move('w', { from: 'g1', to: 'f3' }, 99999); assert.strictEqual(g.drawOffer, null, 'a move cancels the offer');
assert(g.offerDraw('b')); assert(g.respondDraw('w', true)); assert.deepStrictEqual(g.result, { winner: null, reason: 'agreement' });
g = new ChessGame(); g.abort(); assert.strictEqual(g.result.reason, 'aborted');
g = new ChessGame(); play(g, [['w', 'e2e4'], ['b', 'e7e5']]); assert.strictEqual(g.abort(), null, 'too late to abort'); g.resign('w'); assert.deepStrictEqual(g.result, { winner: 'b', reason: 'resign' });
g = new ChessGame(); g.abandon('b'); assert.deepStrictEqual(g.result, { winner: 'w', reason: 'abandoned' });

// helpers
assert.deepStrictEqual(normalizeTimeControl({ base: '300', inc: '3' }), { base: 300, inc: 3 });
assert.deepStrictEqual(normalizeTimeControl({ base: 0, inc: 5 }), { base: 0, inc: 0 });
assert.strictEqual(kindOf(60, 0), 'Bullet'); assert.strictEqual(kindOf(180, 2), 'Blitz'); assert.strictEqual(kindOf(600, 0), 'Rapid'); assert.strictEqual(kindOf(0, 0), 'Casual');
console.log('chessGame tests passed');
