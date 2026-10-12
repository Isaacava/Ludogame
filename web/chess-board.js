/* CodePlay chess board — rendering, tap/drag input and smooth piece animation (transform + opacity only).
 * Usage: var board = CPBoard.mount(el, { onMove(from,to,promotion), onSelect() }); board.set(state, { animate:true }); */
(function (global) {
  'use strict';
  var FILES = 'abcdefgh', REDUCED = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function parseFen(fen) {
    var rows = fen.split(' ')[0].split('/'), map = {};
    for (var r = 0; r < 8; r++) {
      var f = 0;
      for (var i = 0; i < rows[r].length; i++) {
        var ch = rows[r][i];
        if (ch >= '1' && ch <= '8') { f += +ch; continue; }
        map[FILES[f] + (8 - r)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
        f++;
      }
    }
    return map;
  }
  function dist(a, b) { return Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0])) + Math.abs(+a[1] - +b[1]); }

  function mount(root, opts) {
    opts = opts || {};
    root.classList.add('cbBoard'); root.innerHTML = '';
    var sqLayer = document.createElement('div'); sqLayer.className = 'cbSquares';
    var pcLayer = document.createElement('div'); pcLayer.className = 'cbPieces';
    var hintLayer = document.createElement('div'); hintLayer.className = 'cbHints';
    root.appendChild(sqLayer); root.appendChild(hintLayer); root.appendChild(pcLayer);

    var orientation = 'w', sq = {}, pieces = {}, ghost = null, state = null;
    var sel = null, dragging = null, interactive = false, myColor = null, lastMove = null, check = null, dests = {}, promos = [], hint = null;
    var turnColor = 'w';

    function xy(s) { var f = FILES.indexOf(s[0]), r = +s[1] - 1; return orientation === 'w' ? [f, 7 - r] : [7 - f, r]; }
    function place(el, s) { var p = xy(s); el.style.transform = 'translate(' + (p[0] * 100) + '%,' + (p[1] * 100) + '%)'; }

    function buildSquares() {
      sqLayer.innerHTML = ''; sq = {};
      for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
        var f = orientation === 'w' ? x : 7 - x, r = orientation === 'w' ? 7 - y : y, name = FILES[f] + (r + 1);
        var d = document.createElement('div'); d.className = 'cbSq ' + ((f + r) % 2 === 0 ? 'dark' : 'light'); d.dataset.sq = name;
        if (x === 0) { var rk = document.createElement('i'); rk.className = 'rk'; rk.textContent = r + 1; d.appendChild(rk); }
        if (y === 7) { var fl = document.createElement('i'); fl.className = 'fl'; fl.textContent = FILES[f]; d.appendChild(fl); }
        sqLayer.appendChild(d); sq[name] = d;
      }
    }
    function pieceEl(code) {
      var el = document.createElement('div'); el.className = 'cbPc ' + code; el.dataset.pc = code;
      el.setAttribute('role', 'img'); el.setAttribute('aria-label', (code[0] === 'w' ? 'White ' : 'Black ') + ({ K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' })[code[1]]);
      return el;
    }
    function fade(el) {
      if (!el) return;
      if (REDUCED || !el.animate) { el.remove(); return; }
      el.style.zIndex = 1;
      var a = el.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '.6' }], { duration: 220, easing: 'ease-out' });
      a.onfinish = a.oncancel = function () { el.remove(); };
    }
    function slide(el, from, to, dur) {
      if (REDUCED || !el.animate) { place(el, to); return; }
      var a = xy(from), b = xy(to), dx = (a[0] - b[0]) * 100, dy = (a[1] - b[1]) * 100;
      place(el, to); el.style.zIndex = 20;
      var an = el.animate([{ translate: dx + '% ' + dy + '%' }, { translate: '0 0' }], { duration: dur || Math.min(320, 140 + dist(from, to) * 28), easing: 'cubic-bezier(.22,.9,.3,1)' });
      an.onfinish = an.oncancel = function () { el.style.zIndex = ''; };
    }

    function paintMarks() {
      Object.keys(sq).forEach(function (k) { sq[k].classList.remove('last', 'sel', 'chk', 'hint'); });
      hintLayer.innerHTML = '';
      if (lastMove) { if (sq[lastMove.from]) sq[lastMove.from].classList.add('last'); if (sq[lastMove.to]) sq[lastMove.to].classList.add('last'); }
      if (check && sq[check]) sq[check].classList.add('chk');
      if (hint) { if (sq[hint.from]) sq[hint.from].classList.add('hint'); if (sq[hint.to]) sq[hint.to].classList.add('hint'); }
      if (sel) {
        sq[sel].classList.add('sel');
        (dests[sel] || []).forEach(function (t) {
          var d = document.createElement('div'); d.className = 'cbDot' + (pieces[t] ? ' cap' : '');
          // en passant lands on an empty square but still captures: show it as a capture ring
          if (!pieces[t] && state && state.fen && state.fen.split(' ')[3] === t && pieces[sel] && pieces[sel].dataset.pc[1] === 'P') d.className = 'cbDot cap';
          place(d, t); hintLayer.appendChild(d);
        });
      }
    }

    function canPickUp(s) {
      var el = pieces[s]; if (!el || !interactive || !myColor) return false;
      return el.dataset.pc[0] === myColor && turnColor === myColor && !!dests[s];
    }
    function select(s) { sel = s; paintMarks(); if (opts.onSelect) opts.onSelect(s); }
    function deselect() { sel = null; paintMarks(); }

    function tryMove(from, to, viaDrag) {
      var legal = (dests[from] || []).indexOf(to) >= 0;
      if (!legal) return false;
      var needsPromo = promos.indexOf(from + to) >= 0;
      var commit = function (promotion) {
        if (promotion === null) { deselect(); resetDragged(); return; }
        var cap = pieces[to];
        if (opts.onMove) opts.onMove(from, to, promotion);
        deselect();
        // optimistic update so the piece never snaps back while the server confirms
        var el = pieces[from];
        if (el) {
          if (cap) { fade(cap); }
          delete pieces[from]; pieces[to] = el;
          if (viaDrag) place(el, to); else slide(el, from, to);
          if (promotion) { el.dataset.pc = el.dataset.pc[0] + promotion.toUpperCase(); el.className = 'cbPc ' + el.dataset.pc; }
        }
      };
      if (needsPromo && opts.pickPromotion) { opts.pickPromotion(myColor, to, orientation).then(commit); }
      else commit(needsPromo ? 'q' : undefined);
      return true;
    }
    function resetDragged() { if (dragging) { dragging.el.classList.remove('drag'); place(dragging.el, dragging.from); dragging.el.style.zIndex = ''; dragging = null; } }

    function squareAt(clientX, clientY) {
      var r = root.getBoundingClientRect(), x = Math.floor((clientX - r.left) / r.width * 8), y = Math.floor((clientY - r.top) / r.height * 8);
      if (x < 0 || x > 7 || y < 0 || y > 7) return null;
      var f = orientation === 'w' ? x : 7 - x, rk = orientation === 'w' ? 7 - y : y;
      return FILES[f] + (rk + 1);
    }
    root.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var s = squareAt(e.clientX, e.clientY); if (!s) return;
      if (sel && sel !== s && (dests[sel] || []).indexOf(s) >= 0) { tryMove(sel, s, false); e.preventDefault(); return; }
      if (canPickUp(s)) {
        var el = pieces[s];
        if (sel !== s) select(s);
        dragging = { el: el, from: s, startX: e.clientX, startY: e.clientY, moved: false, id: e.pointerId, wasSel: sel === s };
        try { root.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
        e.preventDefault();
      } else if (sel) { deselect(); }
    });
    root.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== dragging.id) return;
      var dx = e.clientX - dragging.startX, dy = e.clientY - dragging.startY;
      if (!dragging.moved && Math.hypot(dx, dy) < 6) return;
      if (!dragging.moved) { dragging.moved = true; dragging.el.classList.add('drag'); dragging.el.style.zIndex = 40; }
      var r = root.getBoundingClientRect(), size = r.width / 8, p = xy(dragging.from);
      dragging.el.style.transform = 'translate(' + ((e.clientX - r.left) / size - 0.5) * 100 + '%,' + ((e.clientY - r.top) / size - 0.5 - 0.35) * 100 + '%)';
      e.preventDefault();
    });
    function endDrag(e) {
      if (!dragging || (e && e.pointerId !== dragging.id)) return;
      var d = dragging, target = e ? squareAt(e.clientX, e.clientY) : null;
      try { root.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
      if (!d.moved) { dragging = null; if (d.wasSel && sel === d.from && !d.justSelected) { /* tap on selected piece keeps selection */ } return; }
      d.el.classList.remove('drag');
      if (target && target !== d.from && (dests[d.from] || []).indexOf(target) >= 0) { dragging = null; place(d.el, d.from); tryMove(d.from, target, true); }
      else { dragging = null; slide(d.el, d.from, d.from, 120); place(d.el, d.from); d.el.style.zIndex = ''; }
    }
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', function (e) { if (dragging) { resetDragged(); } });

    function setOrientation(o) {
      if (o === orientation && Object.keys(sq).length) return;
      orientation = o; buildSquares();
      Object.keys(pieces).forEach(function (s) { place(pieces[s], s); });
      paintMarks();
    }

    // Reconcile the DOM with a new position, animating whatever moved.
    function set(st, o) {
      o = o || {};
      state = st; turnColor = st.turn; dests = st.dests || {}; promos = st.promos || [];
      lastMove = st.last ? { from: st.last.from, to: st.last.to } : (o.last || null);
      check = st.check || null; hint = o.hint || null;
      var next = parseFen(st.fen), animate = o.animate !== false && !REDUCED;
      if (o.keepSelection !== true) sel = null;
      if (dragging) resetDragged();
      var removed = [], added = [], k;
      Object.keys(pieces).forEach(function (s) { if (next[s] !== pieces[s].dataset.pc) removed.push(s); });
      Object.keys(next).forEach(function (s) { if (!pieces[s] || pieces[s].dataset.pc !== next[s]) added.push(s); });
      var old = {}; removed.forEach(function (s) { old[s] = pieces[s]; delete pieces[s]; });
      var usedAdded = {}, moves = [];
      var mv = st.last && o.animate !== false ? st.last : null;
      function take(code, preferTo, preferFrom) {
        var bestR = null, bestA = null, bestD = 99;
        removed.forEach(function (rs) {
          if (!old[rs] || old[rs].dataset.pc !== code) return;
          added.forEach(function (as) {
            if (usedAdded[as] || next[as] !== code) return;
            var d = dist(rs, as) - (rs === preferFrom && as === preferTo ? 50 : 0);
            if (d < bestD) { bestD = d; bestR = rs; bestA = as; }
          });
        });
        return bestR ? [bestR, bestA] : null;
      }
      // promotion: the pawn walks to the last rank and turns into the new piece
      if (mv && mv.promotion && old[mv.from] && next[mv.to]) {
        var pel = old[mv.from]; delete old[mv.from]; usedAdded[mv.to] = 1;
        pel.dataset.pc = next[mv.to]; pel.className = 'cbPc ' + next[mv.to];
        pieces[mv.to] = pel; moves.push([pel, mv.from, mv.to]);
      }
      var codes = {}; removed.forEach(function (rs) { if (old[rs]) codes[old[rs].dataset.pc] = 1; });
      Object.keys(codes).forEach(function (code) {
        var m; while ((m = take(code, mv && mv.to, mv && mv.from))) {
          var rs = m[0], as = m[1]; usedAdded[as] = 1;
          var el = old[rs]; delete old[rs]; pieces[as] = el; moves.push([el, rs, as]);
        }
      });
      // anything left: captured/removed pieces fade out, brand-new pieces appear
      Object.keys(old).forEach(function (rs) { if (animate) fade(old[rs]); else old[rs].remove(); });
      added.forEach(function (as) {
        if (usedAdded[as]) return;
        var el = pieceEl(next[as]); pcLayer.appendChild(el); place(el, as); pieces[as] = el;
        if (animate && removed.length === 0 && Object.keys(pieces).length > 0 && o.appear) el.animate && el.animate([{ opacity: 0, scale: '.7' }, { opacity: 1, scale: '1' }], { duration: 240, easing: 'ease-out' });
      });
      moves.forEach(function (m) { if (animate) slide(m[0], m[1], m[2]); else place(m[0], m[2]); });
      // make sure every element sits on its square (covers flips and un-animated updates)
      Object.keys(pieces).forEach(function (s) { if (!pieces[s].parentNode) pcLayer.appendChild(pieces[s]); if (!animate) place(pieces[s], s); });
      paintMarks();
    }

    buildSquares();
    return {
      set: set, setOrientation: setOrientation, orientation: function () { return orientation; },
      setInteractive: function (on, color) { interactive = !!on; myColor = color || null; if (!on && sel) deselect(); },
      deselect: deselect, el: root,
      hint: function (h) { hint = h; paintMarks(); },
      clear: function () { Object.keys(pieces).forEach(function (s) { pieces[s].remove(); }); pieces = {}; sel = null; paintMarks(); }
    };
  }

  global.CPBoard = { mount: mount, parseFen: parseFen };
})(window);
