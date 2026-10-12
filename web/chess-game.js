/* CodePlay chess — one rules + clock model used by BOTH the server (multiplayer) and the browser (vs computer).
 * Wraps chess.js (legal moves, check/mate/draw detection) and adds clocks, results, draw offers and a compact JSON view. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(function () { return require('chess.js').Chess; });
  else root.CPChessGame = factory(function () { return root.Chess; });
})(typeof self !== 'undefined' ? self : this, function (getChess) {
  'use strict';

  var VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var PRESETS = [
    { id: '1+0', base: 60, inc: 0, label: '1 min', kind: 'Bullet' },
    { id: '3+2', base: 180, inc: 2, label: '3 | 2', kind: 'Blitz' },
    { id: '5+0', base: 300, inc: 0, label: '5 min', kind: 'Blitz' },
    { id: '10+0', base: 600, inc: 0, label: '10 min', kind: 'Rapid' },
    { id: '15+10', base: 900, inc: 10, label: '15 | 10', kind: 'Rapid' },
    { id: '0+0', base: 0, inc: 0, label: 'No clock', kind: 'Casual' }
  ];
  var other = function (c) { return c === 'w' ? 'b' : 'w'; };

  function kindOf(base, inc) {
    if (!base) return 'Casual';
    var t = base + 40 * inc; // the same estimate Lichess and chess.com use
    return t < 179 ? 'Bullet' : t < 479 ? 'Blitz' : t < 1499 ? 'Rapid' : 'Classical';
  }
  function normalizeTimeControl(tc) {
    var base = Math.max(0, Math.min(10800, Math.round(Number(tc && tc.base) || 0)));
    var inc = Math.max(0, Math.min(180, Math.round(Number(tc && tc.inc) || 0)));
    if (!base) inc = 0;
    return { base: base, inc: inc };
  }
  // Can this colour still deliver mate? (used for "flagged, but the opponent cannot win" = draw)
  function canMate(chess, color) {
    var pieces = [], board = chess.board();
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) { var p = board[r][c]; if (p && p.color === color && p.type !== 'k') pieces.push(p.type); }
    if (pieces.some(function (t) { return t === 'p' || t === 'r' || t === 'q'; })) return true;
    return pieces.length >= 2;
  }

  function ChessGame(opts) {
    opts = opts || {};
    var Chess = getChess();
    this.chess = opts.fen ? new Chess(opts.fen) : new Chess();
    this.tc = normalizeTimeControl(opts);
    this.clocks = { w: this.tc.base * 1000, b: this.tc.base * 1000 };
    this.running = null;
    this.lastTick = null;
    this.moves = [];            // verbose move records
    this.result = null;
    this.drawOffer = null;      // colour that offered
    this.startedAt = opts.now || Date.now();
    this.seq = 0;
  }
  var P = ChessGame.prototype;

  P.turn = function () { return this.chess.turn(); };
  P.plies = function () { return this.moves.length; };
  P.isOver = function () { return !!this.result; };
  Object.defineProperty(P, 'gameOver', { get: function () { return !!this.result; } });

  P.legal = function () {
    var dests = {}, promos = {}, list = this.chess.moves({ verbose: true });
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      (dests[m.from] = dests[m.from] || []);
      if (dests[m.from].indexOf(m.to) === -1) dests[m.from].push(m.to);
      if (m.promotion) promos[m.from + m.to] = 1;
    }
    return { dests: dests, promos: Object.keys(promos) };
  };

  P.remaining = function (color, now) {
    var ms = this.clocks[color];
    if (this.running === color && this.lastTick != null) ms -= Math.max(0, (now || Date.now()) - this.lastTick);
    return Math.max(0, ms);
  };

  function finish(game, winner, reason) {
    if (game.result) return game.result;
    game.running = null; game.drawOffer = null;
    game.result = { winner: winner, reason: reason };
    game.seq++;
    return game.result;
  }

  // Settles the running clock; returns the colour that ran out of time (and ends the game), if any.
  P.tick = function (now) {
    now = now || Date.now();
    if (this.result || !this.running || !this.tc.base) return null;
    if (this.remaining(this.running, now) > 0) return null;
    var loser = this.running;
    this.clocks[loser] = 0; this.lastTick = now;
    return this.flag(loser) && loser;
  };
  P.flag = function (color) {
    if (this.result) return null;
    var winner = other(color);
    if (!canMate(this.chess, winner)) return finish(this, null, 'timeout-draw');
    return finish(this, winner, 'timeout');
  };

  P.move = function (color, m, now) {
    now = now || Date.now();
    if (this.result) return { ok: false, error: 'game-over' };
    if (color !== this.chess.turn()) return { ok: false, error: 'not-your-turn' };
    if (this.tick(now)) return { ok: false, error: 'game-over' };
    var pliesBefore = this.moves.length, clocksWereRunning = this.running === color, rec;
    try { rec = this.chess.move({ from: m.from, to: m.to, promotion: m.promotion }); }
    catch (e) { return { ok: false, error: 'illegal-move' }; }
    var tcOn = this.tc.base > 0;
    if (tcOn) {
      if (clocksWereRunning) {
        this.clocks[color] = Math.max(0, this.clocks[color] - Math.max(0, now - this.lastTick)) + this.tc.inc * 1000;
      }
    }
    var entry = { san: rec.san, from: rec.from, to: rec.to, color: rec.color, piece: rec.piece, captured: rec.captured || null, promotion: rec.promotion || null, flags: rec.flags, at: now, ply: pliesBefore + 1 };
    this.moves.push(entry);
    this.drawOffer = null;
    this.running = (tcOn && this.moves.length >= 2) ? this.chess.turn() : null;   // clocks start once both sides have moved
    this.lastTick = this.running ? now : null;
    this.seq++;
    var c = this.chess;
    if (c.isCheckmate()) finish(this, color, 'checkmate');
    else if (c.isStalemate()) finish(this, null, 'stalemate');
    else if (c.isInsufficientMaterial()) finish(this, null, 'insufficient');
    else if (c.isThreefoldRepetition()) finish(this, null, 'repetition');
    else if (c.isDrawByFiftyMoves()) finish(this, null, 'fifty-move');
    return { ok: true, move: entry, over: !!this.result };
  };

  P.resign = function (color) { return this.result ? null : finish(this, other(color), 'resign'); };
  P.abandon = function (color) { return this.result ? null : finish(this, other(color), 'abandoned'); };
  P.abort = function () { if (this.result || this.moves.length >= 2) return null; return finish(this, null, 'aborted'); };
  P.offerDraw = function (color) {
    if (this.result || this.drawOffer || this.moves.length < 2) return false;
    this.drawOffer = color; this.seq++; return true;
  };
  P.respondDraw = function (color, accept) {
    if (this.result || !this.drawOffer || this.drawOffer === color) return false;
    if (accept) finish(this, null, 'agreement'); else { this.drawOffer = null; this.seq++; }
    return true;
  };

  P.captured = function () {
    var byW = [], byB = [];
    this.moves.forEach(function (m) { if (m.captured) (m.color === 'w' ? byW : byB).push(m.captured); });
    var order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
    var sort = function (a, b) { return order[a] - order[b]; };
    return { w: byW.sort(sort), b: byB.sort(sort) };   // w = black pieces that White has taken
  };
  P.material = function () {
    var score = { w: 0, b: 0 }, board = this.chess.board();
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) { var p = board[r][c]; if (p) score[p.color] += VALUES[p.type]; }
    return score;
  };
  P.kingInCheck = function () {
    if (!this.chess.inCheck()) return null;
    var t = this.chess.turn(), board = this.chess.board();
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) { var p = board[r][c]; if (p && p.type === 'k' && p.color === t) return 'abcdefgh'[c] + (8 - r); }
    return null;
  };

  P.toJSON = function (now) {
    now = now || Date.now();
    var legal = this.result ? { dests: {}, promos: [] } : this.legal();
    var last = this.moves.length ? this.moves[this.moves.length - 1] : null;
    return {
      fen: this.chess.fen(), turn: this.chess.turn(), plies: this.moves.length, seq: this.seq,
      san: this.moves.map(function (m) { return m.san; }),
      last: last ? { from: last.from, to: last.to, san: last.san, color: last.color, captured: last.captured, flags: last.flags, promotion: last.promotion } : null,
      check: this.result && this.result.reason === 'checkmate' ? this.kingInCheck() : this.kingInCheck(),
      dests: legal.dests, promos: legal.promos,
      clocks: { w: this.remaining('w', now), b: this.remaining('b', now) },
      running: this.running, now: now, timeControl: { base: this.tc.base, inc: this.tc.inc, kind: kindOf(this.tc.base, this.tc.inc) },
      result: this.result, drawOffer: this.drawOffer,
      captured: this.captured(), material: this.material(),
      gameOver: !!this.result
    };
  };

  P.pgn = function (info) {
    info = info || {};
    var Chess = getChess(), c = new Chess();
    var result = !this.result ? '*' : this.result.winner === 'w' ? '1-0' : this.result.winner === 'b' ? '0-1' : '1/2-1/2';
    var d = new Date(this.startedAt), pad = function (n) { return String(n).padStart(2, '0'); };
    var headers = { Event: info.event || 'CodePlay game', Site: info.site || 'CodePlay', Date: d.getUTCFullYear() + '.' + pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()), White: info.white || 'White', Black: info.black || 'Black', Result: result, TimeControl: this.tc.base ? this.tc.base + (this.tc.inc ? '+' + this.tc.inc : '') : '-' };
    Object.keys(headers).forEach(function (k) { c.setHeader(k, headers[k]); });
    this.moves.forEach(function (m) { c.move(m.san); });
    return c.pgn();
  };

  return { ChessGame: ChessGame, PRESETS: PRESETS, normalizeTimeControl: normalizeTimeControl, kindOf: kindOf, canMate: canMate, other: other };
});
