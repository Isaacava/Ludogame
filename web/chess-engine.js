/* CodePlay chess engine — a compact 0x88 alpha-beta searcher for the "vs computer" mode.
 * Make/unmake move generation, incremental Zobrist hash + evaluation, transposition table, null-move pruning,
 * late-move reductions, quiescence search and iterative deepening with a time budget.
 * Move generation is verified against chess.js with perft in server/test/chessEngine.test.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CPEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  var MATE = 30000, INF = 32000;
  var VAL = [0, 100, 320, 330, 500, 900, 0];
  var PHASE_W = [0, 0, 1, 1, 2, 4, 0];
  var KN = [-33, -31, -18, -14, 14, 18, 31, 33], KD = [-17, -16, -15, -1, 1, 15, 16, 17], BD = [-17, -15, 15, 17], RD = [-16, -1, 1, 16];

  var PST_MG = [null,
    [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
    [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20]
  ];
  var PST_EG = PST_MG.slice();
  PST_EG[1] = [0,0,0,0,0,0,0,0, 90,90,90,90,90,90,90,90, 60,60,60,60,60,60,60,60, 40,40,40,40,40,40,40,40, 25,25,25,25,25,25,25,25, 10,10,10,10,10,10,10,10, 5,5,5,5,5,5,5,5, 0,0,0,0,0,0,0,0];
  PST_EG[6] = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];

  // pre-computed per piece code (white 1..6, black 9..14) and 0x88 square
  var MGT = [], EGT = [];
  (function () {
    for (var c = 0; c < 2; c++) for (var t = 1; t <= 6; t++) {
      var code = t | (c << 3), mg = new Int16Array(128), eg = new Int16Array(128), sign = c === 0 ? 1 : -1;
      for (var sq = 0; sq < 128; sq++) {
        if (sq & 0x88) continue;
        var f = sq & 7, r = sq >> 4, idx = c === 0 ? (7 - r) * 8 + f : r * 8 + f;
        mg[sq] = sign * (VAL[t] + PST_MG[t][idx]); eg[sq] = sign * (VAL[t] + PST_EG[t][idx]);
      }
      MGT[code] = mg; EGT[code] = eg;
    }
  })();

  // deterministic pseudo-random numbers for Zobrist keys
  var seed = 0x9e3779b9;
  function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
  var Z1 = new Int32Array(16 * 128), Z2 = new Int32Array(16 * 128), ZC1 = new Int32Array(16), ZC2 = new Int32Array(16), ZE1 = new Int32Array(8), ZE2 = new Int32Array(8);
  var ZS1, ZS2;
  (function () { var i; for (i = 0; i < Z1.length; i++) { Z1[i] = rnd(); Z2[i] = rnd(); } for (i = 0; i < 16; i++) { ZC1[i] = rnd(); ZC2[i] = rnd(); } for (i = 0; i < 8; i++) { ZE1[i] = rnd(); ZE2[i] = rnd(); } ZS1 = rnd(); ZS2 = rnd(); })();

  var CMASK = new Uint8Array(128).fill(15);
  CMASK[0x04] = 12; CMASK[0x00] = 13; CMASK[0x07] = 14; CMASK[0x74] = 3; CMASK[0x70] = 7; CMASK[0x77] = 11;

  function sqName(sq) { return 'abcdefgh'[sq & 7] + ((sq >> 4) + 1); }
  function sqFrom(name) { return (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97); }

  function createEngine() {
    var b = new Int8Array(128), side = 0, castle = 0, ep = -1, half = 0, ksq = [0, 0];
    var h1 = 0, h2 = 0, mg = 0, eg = 0, phase = 0, cnt = new Int16Array(16);
    var SP = 0, MAXSTACK = 2048;
    var sCap = new Int8Array(MAXSTACK), sCastle = new Uint8Array(MAXSTACK), sEp = new Int16Array(MAXSTACK), sHalf = new Int16Array(MAXSTACK);
    var sH1 = new Int32Array(MAXSTACK), sH2 = new Int32Array(MAXSTACK), sMg = new Int32Array(MAXSTACK), sEg = new Int32Array(MAXSTACK), sPh = new Int16Array(MAXSTACK);
    var sMove = new Int32Array(MAXSTACK), rootSP = 0;
    var TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
    var ttK = new Int32Array(TT_SIZE), ttD = new Int8Array(TT_SIZE), ttF = new Int8Array(TT_SIZE), ttS = new Int32Array(TT_SIZE), ttM = new Int32Array(TT_SIZE);
    var MAXPLY = 64, lists = [], scores = [];
    for (var i = 0; i < MAXPLY + 8; i++) { lists.push(new Int32Array(256)); scores.push(new Int32Array(256)); }
    var killers = [new Int32Array(MAXPLY + 8), new Int32Array(MAXPLY + 8)], history = new Int32Array(16 * 128);
    var nodes = 0, deadline = 0, stopped = false;

    function put(p, sq) { b[sq] = p; var k = p * 128 + sq; h1 ^= Z1[k]; h2 ^= Z2[k]; mg += MGT[p][sq]; eg += EGT[p][sq]; phase += PHASE_W[p & 7]; cnt[p]++; }
    function del(sq) { var p = b[sq], k = p * 128 + sq; b[sq] = 0; h1 ^= Z1[k]; h2 ^= Z2[k]; mg -= MGT[p][sq]; eg -= EGT[p][sq]; phase -= PHASE_W[p & 7]; cnt[p]--; }

    function attacked(sq, by) {
      var i, to, p, hi = by << 3;
      var pd = by === 0 ? -16 : 16;
      to = sq + pd - 1; if (!(to & 0x88) && b[to] === (P | hi)) return true;
      to = sq + pd + 1; if (!(to & 0x88) && b[to] === (P | hi)) return true;
      for (i = 0; i < 8; i++) { to = sq + KN[i]; if (!(to & 0x88) && b[to] === (N | hi)) return true; }
      for (i = 0; i < 8; i++) { to = sq + KD[i]; if (!(to & 0x88) && b[to] === (K | hi)) return true; }
      for (i = 0; i < 4; i++) { var d = BD[i]; to = sq + d; while (!(to & 0x88)) { p = b[to]; if (p) { if (p === (B | hi) || p === (Q | hi)) return true; break; } to += d; } }
      for (i = 0; i < 4; i++) { var d2 = RD[i]; to = sq + d2; while (!(to & 0x88)) { p = b[to]; if (p) { if (p === (R | hi) || p === (Q | hi)) return true; break; } to += d2; } }
      return false;
    }
    function inCheck(s) { return attacked(ksq[s], s ^ 1); }

    // ---- move generation (pseudo-legal; legality is checked after making the move) ----
    function gen(list, caps) {
      var n = 0, us = side, them = us ^ 1, sq, p, t, i, to, target, d;
      for (sq = 0; sq < 128; sq++) {
        if (sq & 0x88) { sq += 7; continue; }
        p = b[sq]; if (!p || (p >> 3) !== us) continue;
        t = p & 7;
        if (t === P) {
          var dir = us === 0 ? 16 : -16, startR = us === 0 ? 1 : 6, promoR = us === 0 ? 7 : 0, r = sq >> 4;
          to = sq + dir;
          if (!b[to]) {
            if ((to >> 4) === promoR) { list[n++] = sq | (to << 7) | (Q << 14); if (!caps) { list[n++] = sq | (to << 7) | (R << 14); list[n++] = sq | (to << 7) | (B << 14); list[n++] = sq | (to << 7) | (N << 14); } }
            else if (!caps) { list[n++] = sq | (to << 7); if (r === startR && !b[to + dir]) list[n++] = sq | ((to + dir) << 7) | (1 << 17); }
          }
          for (i = -1; i <= 1; i += 2) {
            to = sq + dir + i; if (to & 0x88) continue; target = b[to];
            if (target && (target >> 3) === them) {
              if ((to >> 4) === promoR) { list[n++] = sq | (to << 7) | (Q << 14); list[n++] = sq | (to << 7) | (R << 14); list[n++] = sq | (to << 7) | (B << 14); list[n++] = sq | (to << 7) | (N << 14); }
              else list[n++] = sq | (to << 7);
            } else if (to === ep) list[n++] = sq | (to << 7) | (2 << 17);
          }
        } else if (t === N || t === K) {
          var offs = t === N ? KN : KD;
          for (i = 0; i < 8; i++) {
            to = sq + offs[i]; if (to & 0x88) continue; target = b[to];
            if (!target) { if (!caps) list[n++] = sq | (to << 7); }
            else if ((target >> 3) === them) list[n++] = sq | (to << 7);
          }
          if (t === K && !caps) {
            if (us === 0 && sq === 0x04) {
              if ((castle & 1) && !b[0x05] && !b[0x06] && b[0x07] === R && !attacked(0x04, 1) && !attacked(0x05, 1) && !attacked(0x06, 1)) list[n++] = sq | (0x06 << 7) | (4 << 17);
              if ((castle & 2) && !b[0x03] && !b[0x02] && !b[0x01] && b[0x00] === R && !attacked(0x04, 1) && !attacked(0x03, 1) && !attacked(0x02, 1)) list[n++] = sq | (0x02 << 7) | (8 << 17);
            } else if (us === 1 && sq === 0x74) {
              if ((castle & 4) && !b[0x75] && !b[0x76] && b[0x77] === (R | 8) && !attacked(0x74, 0) && !attacked(0x75, 0) && !attacked(0x76, 0)) list[n++] = sq | (0x76 << 7) | (4 << 17);
              if ((castle & 8) && !b[0x73] && !b[0x72] && !b[0x71] && b[0x70] === (R | 8) && !attacked(0x74, 0) && !attacked(0x73, 0) && !attacked(0x72, 0)) list[n++] = sq | (0x72 << 7) | (8 << 17);
            }
          }
        } else {
          var dirs = t === B ? BD : t === R ? RD : KD, nd = dirs.length;
          for (i = 0; i < nd; i++) {
            d = dirs[i]; to = sq + d;
            while (!(to & 0x88)) {
              target = b[to];
              if (!target) { if (!caps) list[n++] = sq | (to << 7); }
              else { if ((target >> 3) === them) list[n++] = sq | (to << 7); break; }
              to += d;
            }
          }
        }
      }
      return n;
    }

    function make(m) {
      var from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 15, p = b[from], us = side, cap = b[to];
      sCap[SP] = cap; sCastle[SP] = castle; sEp[SP] = ep; sHalf[SP] = half; sH1[SP] = h1; sH2[SP] = h2; sMg[SP] = mg; sEg[SP] = eg; sPh[SP] = phase; sMove[SP] = m; SP++;
      if (ep >= 0) { h1 ^= ZE1[ep & 7]; h2 ^= ZE2[ep & 7]; }
      h1 ^= ZC1[castle]; h2 ^= ZC2[castle];
      half++; ep = -1;
      if ((p & 7) === P || cap) half = 0;
      if (flag & 2) { var csq = us === 0 ? to - 16 : to + 16; sCap[SP - 1] = b[csq]; del(csq); }
      else if (cap) del(to);
      del(from);
      put(promo ? (promo | (us << 3)) : p, to);
      if ((p & 7) === K) ksq[us] = to;
      if (flag & 4) { var rf = us === 0 ? 0x07 : 0x77, rt = us === 0 ? 0x05 : 0x75, rk = b[rf]; del(rf); put(rk, rt); }
      else if (flag & 8) { var rf2 = us === 0 ? 0x00 : 0x70, rt2 = us === 0 ? 0x03 : 0x73, rk2 = b[rf2]; del(rf2); put(rk2, rt2); }
      if (flag & 1) { ep = us === 0 ? from + 16 : from - 16; h1 ^= ZE1[ep & 7]; h2 ^= ZE2[ep & 7]; }
      castle &= CMASK[from] & CMASK[to];
      h1 ^= ZC1[castle]; h2 ^= ZC2[castle];
      side ^= 1; h1 ^= ZS1; h2 ^= ZS2;
    }
    function unmake() {
      SP--;
      var m = sMove[SP], from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 15;
      side ^= 1; var us = side, p = b[to], cap = sCap[SP];
      if (promo) p = P | (us << 3);
      b[from] = p; b[to] = 0;
      if (flag & 2) { b[us === 0 ? to - 16 : to + 16] = cap; }
      else b[to] = cap;
      if ((p & 7) === K) ksq[us] = from;
      if (flag & 4) { var rf = us === 0 ? 0x07 : 0x77, rt = us === 0 ? 0x05 : 0x75; b[rf] = b[rt]; b[rt] = 0; }
      else if (flag & 8) { var rf2 = us === 0 ? 0x00 : 0x70, rt2 = us === 0 ? 0x03 : 0x73; b[rf2] = b[rt2]; b[rt2] = 0; }
      // restore counters (cnt is rebuilt from the board changes above)
      if (promo) { cnt[promo | (us << 3)]--; cnt[p]++; }
      if (cap) cnt[cap]++;
      castle = sCastle[SP]; ep = sEp[SP]; half = sHalf[SP]; h1 = sH1[SP]; h2 = sH2[SP]; mg = sMg[SP]; eg = sEg[SP]; phase = sPh[SP];
    }
    function makeNull() {
      sCap[SP] = 0; sCastle[SP] = castle; sEp[SP] = ep; sHalf[SP] = half; sH1[SP] = h1; sH2[SP] = h2; sMg[SP] = mg; sEg[SP] = eg; sPh[SP] = phase; sMove[SP] = 0; SP++;
      if (ep >= 0) { h1 ^= ZE1[ep & 7]; h2 ^= ZE2[ep & 7]; }
      ep = -1; side ^= 1; h1 ^= ZS1; h2 ^= ZS2; half++;
    }
    function unmakeNull() { SP--; side ^= 1; castle = sCastle[SP]; ep = sEp[SP]; half = sHalf[SP]; h1 = sH1[SP]; h2 = sH2[SP]; }

    function legalMoves(list) { var n = gen(list, false), k = 0, i, us = side; for (i = 0; i < n; i++) { make(list[i]); if (!attacked(ksq[us], us ^ 1)) list[k++] = list[i]; unmake(); } return k; }

    // ---- evaluation ----
    function evaluate() {
      if (!cnt[1] && !cnt[9] && !(cnt[4] + cnt[5] + cnt[12] + cnt[13]) && (cnt[2] + cnt[3] + cnt[10] + cnt[11]) <= 1) return 0;
      var ph = phase > 24 ? 24 : phase;
      var s = (mg * ph + eg * (24 - ph)) / 24 | 0;
      if (cnt[3] >= 2) s += 30; if (cnt[11] >= 2) s -= 30;
      return side === 0 ? s + 10 : -s + 10;
    }
    function isRepetition() {
      var lim = SP - half; if (lim < 0) lim = 0;
      for (var i = SP - 2; i >= lim; i -= 2) if (sH1[i] === h1 && sH2[i] === h2) return true;
      return false;
    }

    function scoreMoves(list, sc, n, ttMove, ply) {
      for (var i = 0; i < n; i++) {
        var m = list[i], to = (m >> 7) & 127, from = m & 127, victim = b[to], s;
        if (m === ttMove) s = 2000000;
        else if (victim || ((m >> 17) & 2)) s = 1000000 + 10 * VAL[victim ? victim & 7 : 1] - VAL[b[from] & 7] / 10 + (((m >> 14) & 7) === Q ? 800 : 0);
        else if (((m >> 14) & 7) === Q) s = 950000;
        else if (m === killers[0][ply]) s = 900000;
        else if (m === killers[1][ply]) s = 800000;
        else s = history[b[from] * 128 + to];
        sc[i] = s;
      }
    }
    function pickBest(list, sc, n, start) {
      var best = start, bs = sc[start], i;
      for (i = start + 1; i < n; i++) if (sc[i] > bs) { bs = sc[i]; best = i; }
      if (best !== start) { var tm = list[start]; list[start] = list[best]; list[best] = tm; var ts = sc[start]; sc[start] = sc[best]; sc[best] = ts; }
    }

    function quiesce(alpha, beta, ply) {
      nodes++;
      if ((nodes & 2047) === 0 && Date.now() > deadline) stopped = true;
      if (stopped || ply >= MAXPLY) return evaluate();
      var stand = evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      var list = lists[ply], sc = scores[ply], n = gen(list, true), us = side, i, score;
      scoreMoves(list, sc, n, 0, ply);
      for (i = 0; i < n; i++) {
        pickBest(list, sc, n, i);
        make(list[i]);
        if (attacked(ksq[us], us ^ 1)) { unmake(); continue; }
        score = -quiesce(-beta, -alpha, ply + 1);
        unmake();
        if (stopped) return 0;
        if (score >= beta) return score;
        if (score > alpha) alpha = score;
      }
      return alpha;
    }

    function search(depth, alpha, beta, ply, allowNull) {
      nodes++;
      if ((nodes & 2047) === 0 && Date.now() > deadline) stopped = true;
      if (stopped) return 0;
      var isRoot = ply === 0, us = side, check = attacked(ksq[us], us ^ 1), origAlpha = alpha, i;
      if (!isRoot) {
        if (half >= 100 || isRepetition()) return 0;
        if (ply >= MAXPLY) return evaluate();
        // mate distance pruning
        var mating = MATE - ply; if (mating < beta) { beta = mating; if (alpha >= mating) return mating; }
        var mated = -MATE + ply; if (mated > alpha) { alpha = mated; if (beta <= mated) return mated; }
      }
      if (check) depth++;
      if (depth <= 0) return quiesce(alpha, beta, ply);
      var idx = h1 & TT_MASK, ttMove = 0;
      if (ttK[idx] === h2 && ttF[idx] !== 0) {
        ttMove = ttM[idx];
        if (!isRoot && ttD[idx] >= depth) {
          var ts = ttS[idx]; if (ts > MATE - 100) ts -= ply; else if (ts < -MATE + 100) ts += ply;
          var f = ttF[idx];
          if (f === 1) return ts;
          if (f === 2 && ts >= beta) return ts;
          if (f === 3 && ts <= alpha) return ts;
        }
      }
      var staticEval = check ? -INF : evaluate();
      if (allowNull && !check && depth >= 3 && staticEval >= beta && (cnt[2] + cnt[3] + cnt[4] + cnt[5] + cnt[10] + cnt[11] + cnt[12] + cnt[13]) > 0) {
        makeNull(); var ns = -search(depth - 3, -beta, -beta + 1, ply + 1, false); unmakeNull();
        if (stopped) return 0;
        if (ns >= beta) return beta;
      }
      var list = lists[ply], sc = scores[ply], n = gen(list, false), legal = 0, best = -INF, bestMove = 0, score;
      scoreMoves(list, sc, n, ttMove, ply);
      for (i = 0; i < n; i++) {
        pickBest(list, sc, n, i);
        var m = list[i], quiet = !b[(m >> 7) & 127] && !((m >> 14) & 7) && !(((m >> 17) & 2));
        make(m);
        if (attacked(ksq[us], us ^ 1)) { unmake(); continue; }
        legal++;
        var givesCheck = attacked(ksq[side], side ^ 1);
        if (legal === 1) score = -search(depth - 1, -beta, -alpha, ply + 1, true);
        else {
          var red = (depth >= 3 && legal > 4 && quiet && !check && !givesCheck) ? 1 + (legal > 12 ? 1 : 0) : 0;
          score = -search(depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && red) score = -search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && score < beta) score = -search(depth - 1, -beta, -alpha, ply + 1, true);
        }
        unmake();
        if (stopped) return 0;
        if (score > best) { best = score; bestMove = m; }
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) {
            if (quiet) { if (killers[0][ply] !== m) { killers[1][ply] = killers[0][ply]; killers[0][ply] = m; } history[b[m & 127] * 128 + ((m >> 7) & 127)] += depth * depth; }
            break;
          }
        }
      }
      if (!legal) return check ? -MATE + ply : 0;
      var flag = best >= beta ? 2 : best > origAlpha ? 1 : 3, st = best;
      if (st > MATE - 100) st += ply; else if (st < -MATE + 100) st -= ply;
      if (!stopped) { ttK[idx] = h2; ttD[idx] = depth; ttF[idx] = flag; ttS[idx] = st; ttM[idx] = bestMove; }
      return best;
    }

    // ---- public helpers ----
    function setFen(fen) {
      var parts = fen.trim().split(/\s+/), rows = parts[0].split('/'), r, c, ch, sq, code;
      b.fill(0); h1 = h2 = 0; mg = eg = phase = 0; cnt.fill(0); SP = 0; castle = 0; ep = -1;
      var map = { p: P, n: N, b: B, r: R, q: Q, k: K };
      for (r = 0; r < 8; r++) {
        c = 0; var rank = 7 - r;
        for (var i = 0; i < rows[r].length; i++) {
          ch = rows[r][i];
          if (ch >= '1' && ch <= '8') { c += +ch; continue; }
          code = map[ch.toLowerCase()] | (ch === ch.toLowerCase() ? 8 : 0); sq = rank * 16 + c;
          put(code, sq); if ((code & 7) === K) ksq[code >> 3] = sq; c++;
        }
      }
      side = parts[1] === 'b' ? 1 : 0;
      var cs = parts[2] || '-'; if (cs.indexOf('K') >= 0) castle |= 1; if (cs.indexOf('Q') >= 0) castle |= 2; if (cs.indexOf('k') >= 0) castle |= 4; if (cs.indexOf('q') >= 0) castle |= 8;
      ep = parts[3] && parts[3] !== '-' ? sqFrom(parts[3]) : -1;
      half = parseInt(parts[4] || '0', 10) || 0;
      h1 ^= ZC1[castle]; h2 ^= ZC2[castle]; if (ep >= 0) { h1 ^= ZE1[ep & 7]; h2 ^= ZE2[ep & 7]; } if (side) { h1 ^= ZS1; h2 ^= ZS2; }
      ttF.fill(0); history.fill(0); killers[0].fill(0); killers[1].fill(0);
    }
    function moveToUci(m) { var p = (m >> 14) & 7; return sqName(m & 127) + sqName((m >> 7) & 127) + (p ? 'nbrq'[p === N ? 0 : p === B ? 1 : p === R ? 2 : 3] : ''); }
    function legalList() { var l = new Int32Array(256), n = legalMoves(l), out = []; for (var i = 0; i < n; i++) out.push(l[i]); return out; }
    function makeUci(u) {
      var moves = legalList();
      for (var i = 0; i < moves.length; i++) if (moveToUci(moves[i]) === u) { make(moves[i]); return true; }
      return false;
    }
    function perft(depth) {
      if (depth === 0) return 1;
      var list = new Int32Array(256), n = gen(list, false), total = 0, us = side;
      for (var i = 0; i < n; i++) { make(list[i]); if (!attacked(ksq[us], us ^ 1)) total += depth === 1 ? 1 : perft(depth - 1); unmake(); }
      return total;
    }

    var LEVELS = {
      1: { depth: 1, ms: 200, temp: 260 }, 2: { depth: 2, ms: 400, temp: 120 }, 3: { depth: 3, ms: 700, temp: 45 },
      4: { depth: 5, ms: 800, temp: 0 }, 5: { depth: 8, ms: 1600, temp: 0 }, 6: { depth: 12, ms: 3200, temp: 0 }
    };

    // Searches the current position; returns { move:'e2e4', score, depth, nodes } or null when there are no legal moves.
    function bestMove(opts) {
      opts = opts || {};
      var lvl = LEVELS[opts.level] || LEVELS[4], maxDepth = opts.maxDepth || lvl.depth, ms = opts.movetime || lvl.ms, temp = opts.temp != null ? opts.temp : lvl.temp;
      var rootMoves = legalList();
      if (!rootMoves.length) return null;
      if (rootMoves.length === 1) return { move: moveToUci(rootMoves[0]), score: 0, depth: 0, nodes: 0 };
      var us = side; rootSP = SP; nodes = 0; stopped = false; deadline = Date.now() + ms;
      history.fill(0); killers[0].fill(0); killers[1].fill(0);
      var i, scoresRoot, chosen;
      if (temp > 0) {
        // human-like levels: score every root move at a fixed shallow depth, then choose with a softmax so mistakes look natural
        deadline = Date.now() + 5000; scoresRoot = [];
        for (i = 0; i < rootMoves.length; i++) {
          make(rootMoves[i]); var s = -search(maxDepth - 1, -INF, INF, 1, true); unmake(); scoresRoot.push(s);
        }
        var top = Math.max.apply(null, scoresRoot), weights = scoresRoot.map(function (s) { return Math.exp(Math.max(-30, (s - top) / temp)); }), sum = weights.reduce(function (a, c) { return a + c; }, 0), r = (opts.random ? opts.random() : Math.random()) * sum, acc = 0;
        chosen = rootMoves[0];
        for (i = 0; i < weights.length; i++) { acc += weights[i]; if (r <= acc) { chosen = rootMoves[i]; break; } }
        return { move: moveToUci(chosen), score: top, depth: maxDepth, nodes: nodes };
      }
      var bestM = rootMoves[0], bestS = 0, doneDepth = 0, d, ttm;
      for (d = 1; d <= maxDepth; d++) {
        var alpha = -INF, localBest = 0, localScore = -INF;
        // order root moves: previous best first
        var ordered = rootMoves.slice(); ordered.sort(function (x, y) { return (y === bestM) - (x === bestM); });
        for (i = 0; i < ordered.length; i++) {
          make(ordered[i]);
          var sc2;
          if (i === 0) sc2 = -search(d - 1, -INF, -alpha, 1, true);
          else { sc2 = -search(d - 1, -alpha - 1, -alpha, 1, true); if (!stopped && sc2 > alpha) sc2 = -search(d - 1, -INF, -alpha, 1, true); }
          unmake();
          if (stopped) break;
          if (sc2 > localScore) { localScore = sc2; localBest = ordered[i]; }
          if (sc2 > alpha) alpha = sc2;
        }
        if (stopped) { if (localBest && d > 1 && localScore > bestS - 150) { bestM = localBest; bestS = localScore; } break; }
        bestM = localBest; bestS = localScore; doneDepth = d;
        if (Date.now() - (deadline - ms) > ms * 0.6) break;
        if (Math.abs(bestS) > MATE - 100) break;
      }
      return { move: moveToUci(bestM), score: bestS, depth: doneDepth, nodes: nodes };
    }

    return { setFen: setFen, bestMove: bestMove, makeUci: makeUci, perft: perft, legalUci: function () { return legalList().map(moveToUci); }, inCheck: function () { return inCheck(side); }, side: function () { return side; }, hash: function () { return [h1, h2]; }, evaluate: evaluate, LEVELS: LEVELS };
  }

  return { create: createEngine };
});
