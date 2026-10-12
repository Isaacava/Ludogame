'use strict';
// The vs-computer engine: move generation must match chess.js exactly (perft + random-game fuzz), and the search must find basic tactics.
const assert = require('assert');
const path = require('path');
const { Chess } = require('chess.js');
const { create } = require(path.join(__dirname, '..', '..', 'web', 'chess-engine.js'));
const e = create();

// ---- perft against the published reference counts (covers castling, en passant, promotions, pins)
const PERFT = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 4, 197281],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3, 97862],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 5, 674624],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 4, 422333],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3, 62379],
  ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', 3, 89890]
];
PERFT.forEach(([fen, d, n]) => { e.setFen(fen); const h = e.hash(); assert.strictEqual(e.perft(d), n, 'perft ' + fen); assert.deepStrictEqual(e.hash(), h, 'hash restored after unmake'); });

// ---- random games: same legal moves as chess.js on every ply, and the incremental evaluation never drifts
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let g = 0; g < 40; g++) {
  const c = new Chess(); e.setFen(c.fen());
  for (let ply = 0; ply < 160 && !c.isGameOver(); ply++) {
    const theirs = c.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion || '')).sort();
    const ours = e.legalUci().sort();
    assert.deepStrictEqual(ours, theirs, 'legal moves differ at ' + c.fen());
    const pick = theirs[Math.floor(rnd() * theirs.length)];
    c.move({ from: pick.slice(0, 2), to: pick.slice(2, 4), promotion: pick[4] });
    assert(e.makeUci(pick));
    const ev = e.evaluate(); const f = create(); f.setFen(c.fen()); assert.strictEqual(ev, f.evaluate(), 'incremental evaluation drifted at ' + c.fen());
  }
}

// ---- tactics
const best = (fen, level, extra) => { e.setFen(fen); return e.bestMove(Object.assign({ level }, extra)); };
assert.strictEqual(best('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 5).move, 'a1a8', 'mate in one');
assert.strictEqual(best('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 4).move, 'h5f7', 'Scholar\'s mate');
{ // mate in two: whatever first move the engine picks must force mate on the next move (verified by brute force with chess.js)
  const fen = 'r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1', first = best(fen, 5).move;
  const g = new Chess(fen); g.move({ from: first.slice(0, 2), to: first.slice(2, 4) });
  const mateInOne = c => c.moves({ verbose: true }).some(m => { c.move(m); const ok = c.isCheckmate(); c.undo(); return ok; });
  const replies = g.moves({ verbose: true });
  assert(replies.length > 0 && replies.every(r => { g.move(r); const ok = mateInOne(g); g.undo(); return ok; }), 'engine failed to find a forced mate in two (played ' + first + ')');
}
assert.strictEqual(best('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 4), null, 'checkmated side has no move');
assert.strictEqual(best('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 4), null, 'stalemate has no move');
// never hang the queen when a piece can simply take it: black queen on d4 is attacked by the c3 pawn
const free = best('rnb1kbnr/pppp1ppp/8/4p3/3q4/2P5/PP1PPPPP/RNBQKBNR w KQkq - 0 3', 4);
assert.strictEqual(free.move, 'c3d4', 'wins the free queen');
// weaker levels still play legal moves and respect the clock
for (const level of [1, 2, 3, 4, 5, 6]) {
  e.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  const t = Date.now(), r = e.bestMove({ level });
  assert(e.legalUci().includes(r.move), 'level ' + level + ' returned an illegal move');
  assert(Date.now() - t < (level === 6 ? 4500 : 2500), 'level ' + level + ' too slow: ' + (Date.now() - t) + 'ms');
}
console.log('chessEngine tests passed');
