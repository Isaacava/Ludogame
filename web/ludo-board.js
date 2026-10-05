/* CodePlay Ludo — board geometry, rendering and animation. Shared by play.html and live-ludo.html.
 * Motion rules: only transform/opacity are animated (compositor-only, no layout), tokens are positioned with
 * percentage transforms (resolution independent, no resize handling) and all moves go through a per-token queue. */
(function (global) {
  'use strict';

  var PATH = [[6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0]];
  var START_INDEX = { green: 0, red: 13, yellow: 26, blue: 39 };
  var HOME_COLS = { green: [[7,1],[7,2],[7,3],[7,4],[7,5]], red: [[1,7],[2,7],[3,7],[4,7],[5,7]], yellow: [[7,13],[7,12],[7,11],[7,10],[7,9]], blue: [[13,7],[12,7],[11,7],[10,7],[9,7]] };
  var HOME_BASE_POS = { green: [[2,2],[2,3],[3,2],[3,3]], red: [[2,11],[2,12],[3,11],[3,12]], yellow: [[11,11],[11,12],[12,11],[12,12]], blue: [[11,2],[11,3],[12,2],[12,3]] };
  var SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]); // used by optional rules only; never drawn on the board
  var COLORHEX = { green: '#2fd27a', red: '#ff5a6a', yellow: '#ffc53d', blue: '#4a9bff' };
  var YARD = { green: [0, 0], red: [0, 60], yellow: [60, 60], blue: [60, 0] }; // [top%, left%] of each 6x6 base
  var VIEW_ROTATION = { green: -90, red: 180, yellow: 90, blue: 0 }; // puts the viewer's base bottom-left

  function pathIdx(rel, color) { return (START_INDEX[color] + rel) % 52; }
  function globalCell(color, rel) {
    if (rel <= 50) return PATH[pathIdx(rel, color)];
    if (rel <= 55) return HOME_COLS[color][rel - 51];
    return [7, 7];
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  var homeColSet = {}, startCells = {};
  Object.keys(HOME_COLS).forEach(function (c) { HOME_COLS[c].forEach(function (rc) { homeColSet[rc[0] + ',' + rc[1]] = c; }); });
  Object.keys(START_INDEX).forEach(function (c) {
    var i = START_INDEX[c], a = PATH[i], b = PATH[(i + 1) % 52];
    startCells[a[0] + ',' + a[1]] = { color: c, angle: Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI };
  });
  var slotSet = {};
  Object.keys(HOME_BASE_POS).forEach(function (c) { HOME_BASE_POS[c].forEach(function (rc) { slotSet[rc[0] + ',' + rc[1]] = c; }); });

  function baseColor(r, c) {
    if (r < 6 && c < 6) return 'green';
    if (r < 6 && c > 8) return 'red';
    if (r > 8 && c > 8) return 'yellow';
    if (r > 8 && c < 6) return 'blue';
    return null;
  }
  var REDUCED = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var K = 0.8; // token diameter in cells
  function pctX(c, dx) { return ((c + 0.5 + (dx || 0)) / K) * 100 - 50; }
  function pctY(r, dy) { return ((r + 0.5 + (dy || 0)) / K) * 100 - 50; }
  function tf(r, c, dx, dy, s, lift) {
    return 'translate3d(' + pctX(c, dx).toFixed(2) + '%,' + (pctY(r, dy) - (lift || 0)).toFixed(2) + '%,0) scale(' + (s || 1) + ')';
  }
  var STACK = {
    2: [[-0.2, -0.2], [0.2, 0.2]],
    3: [[-0.22, -0.18], [0.22, -0.18], [0, 0.24]],
    4: [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]
  };

  function mount(opts) {
    var wrap = opts.wrap, gridEl = opts.grid, tokEl = opts.tokens;
    var cells = new Array(225), tokens = new Map(), yards = {}, labels = {};
    var busy = 0, idleWaiters = [];

    function build() {
      gridEl.innerHTML = '';
      for (var r = 0; r < 15; r++) for (var c = 0; c < 15; c++) {
        var d = document.createElement('div'), key = r + ',' + c, bc = baseColor(r, c), cls = 'cell ';
        if (bc) cls += 'base base-' + bc + (slotSet[key] ? ' slot' : '');
        else if (r >= 6 && r <= 8 && c >= 6 && c <= 8) cls += 'center';
        else if (homeColSet[key]) cls += 'lane lane-' + homeColSet[key];
        else cls += 'path';
        if (startCells[key]) { cls += ' start start-' + startCells[key].color; d.style.setProperty('--a', startCells[key].angle.toFixed(0) + 'deg'); }
        d.className = cls; gridEl.appendChild(d); cells[r * 15 + c] = d;
      }
      var home = document.createElement('div'); home.className = 'centerHome'; gridEl.appendChild(home);
      Object.keys(YARD).forEach(function (color) {
        var y = document.createElement('div'); y.className = 'yard yard-' + color;
        y.style.top = YARD[color][0] + '%'; y.style.left = YARD[color][1] + '%';
        var n = document.createElement('span'); n.className = 'yardName'; y.appendChild(n);
        wrap.appendChild(y); yards[color] = y; labels[color] = n;
      });
    }
    function setViewer(color) {
      var deg = color && VIEW_ROTATION[color] != null ? VIEW_ROTATION[color] : 0;
      wrap.style.setProperty('--rot', deg + 'deg');
      wrap.classList.toggle('rotated', deg !== 0);
    }
    function setLabels(map) {
      Object.keys(labels).forEach(function (c) {
        var name = map && map[c];
        labels[c].textContent = name ? name : '';
        yards[c].classList.toggle('empty', !name);
      });
    }
    function setTurn(colors) {
      var set = new Set(colors || []);
      Object.keys(yards).forEach(function (c) { yards[c].classList.toggle('turn', set.has(c)); });
    }
    function flash(list) {
      (list || []).forEach(function (rc) {
        var el = cells[rc[0] * 15 + rc[1]]; if (!el) return;
        el.classList.remove('trail'); void el.offsetWidth; el.classList.add('trail');
        setTimeout(function () { el.classList.remove('trail'); }, 1500);
      });
    }
    function burst(r, c, color) {
      if (REDUCED) return;
      var b = document.createElement('div'); b.className = 'burst'; b.style.setProperty('--bc', COLORHEX[color] || '#fff');
      b.style.left = ((c + 0.5) / 15 * 100) + '%'; b.style.top = ((r + 0.5) / 15 * 100) + '%';
      tokEl.appendChild(b);
      var a = b.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 0.95 }, { transform: 'translate(-50%,-50%) scale(2.6)', opacity: 0 }], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
      a.onfinish = function () { b.remove(); };
    }
    function track(promise) {
      busy++; return promise.then(function () { busy--; if (!busy) { var w = idleWaiters; idleWaiters = []; w.forEach(function (f) { f(); }); } });
    }
    function whenIdle() { return busy ? new Promise(function (res) { idleWaiters.push(res); }) : Promise.resolve(); }

    // Runs animations for one token strictly one after another so rapid server updates never make it jump.
    function enqueue(t, job) { t.chain = t.chain.then(job); return track(t.chain); }

    function animateKeyframes(t, frames, duration, easing) {
      if (REDUCED || !t.el.animate) return Promise.resolve();
      t.el.style.zIndex = 20; t.el.classList.add('moving');
      var a = t.el.animate(frames, { duration: duration, easing: easing || 'linear' });
      return a.finished.catch(function () {}).then(function () { t.el.style.zIndex = ''; t.el.classList.remove('moving'); });
    }

    function placeNow(t, r, c, dx, dy, s) {
      t.shown = [r, c, dx, dy, s];
      t.el.style.transition = 'none'; t.el.style.transform = tf(r, c, dx, dy, s);
      requestAnimationFrame(function () { t.el.style.transition = ''; });
    }

    function stepCells(color, from, to) { var out = []; for (var p = from + 1; p <= to; p++) out.push(globalCell(color, p)); return out; }

    function moveToken(t, item, fin) {
      var prev = t.item, from = t.shown, color = item.color;
      var finalT = tf(fin.r, fin.c, fin.dx, fin.dy, fin.s);
      t.shown = [fin.r, fin.c, fin.dx, fin.dy, fin.s];
      t.el.style.transition = 'none';
      if (!from || REDUCED) { t.el.style.transform = finalT; return enqueue(t, function () { return Promise.resolve(); }); }
      var fromT = tf(from[0], from[1], from[2], from[3], from[4]);
      var frames, dur, ease = 'linear';
      if (prev.pos >= 0 && item.pos > prev.pos && item.pos - prev.pos <= 13) {          // walk the track, square by square
        var steps = stepCells(color, prev.pos, item.pos), per = Math.max(70, Math.min(130, 900 / steps.length));
        frames = [{ transform: fromT, offset: 0 }]; var n = steps.length;
        steps.forEach(function (rc, i) {
          var isLast = i === n - 1, mid = (i + 0.5) / n, end = (i + 1) / n;
          frames.push({ transform: tf(rc[0], rc[1], 0, 0, 1.12, 26), offset: mid, easing: 'ease-out' });
          frames.push({ transform: isLast ? finalT : tf(rc[0], rc[1], 0, 0, 1), offset: end, easing: 'ease-in' });
        });
        dur = per * n;
      } else if (prev.pos === -1 && item.pos >= 0) {                                       // leaves the yard onto the start square
        frames = [{ transform: fromT }, { transform: tf((from[0] + fin.r) / 2, (from[1] + fin.c) / 2, 0, 0, 1.25, 70), offset: 0.5 }, { transform: finalT }]; dur = 420; ease = 'cubic-bezier(.3,.7,.4,1)';
      } else if (item.pos === -1) {                                                        // captured: fly back to the yard
        burst(from[0], from[1], color);
        frames = [{ transform: fromT, offset: 0 }, { transform: tf(from[0], from[1], 0, 0, 1.3, 20), offset: 0.2 }, { transform: tf((from[0] + fin.r) / 2, (from[1] + fin.c) / 2, 0, 0, 0.8, 90), offset: 0.65 }, { transform: finalT, offset: 1 }];
        dur = 620; ease = 'cubic-bezier(.4,.1,.3,1)';
      } else { t.el.style.transform = finalT; return enqueue(t, function () { return Promise.resolve(); }); }
      t.el.style.transform = finalT;
      var ghostFrom = from;
      return enqueue(t, function () { return animateKeyframes(t, frames, dur, ease).then(function () { t.el.style.transition = ''; }); });
    }

    function finishToken(t) {
      t.dead = true; var from = t.shown;
      var steps = stepCells(t.item.color, Math.max(t.item.pos, 50), 56);
      var frames = [{ transform: tf(from[0], from[1], 0, 0, 1), opacity: 1, offset: 0 }];
      steps.forEach(function (rc, i) { frames.push({ transform: tf(rc[0], rc[1], 0, 0, i === steps.length - 1 ? 1.5 : 1.1, 18), opacity: i === steps.length - 1 ? 0 : 1, offset: (i + 1) / steps.length }); });
      return enqueue(t, function () { return animateKeyframes(t, frames, 160 * steps.length + 200, 'ease-in-out').then(function () { t.el.remove(); }); });
    }

    function render(list) {
      var groups = {}, seen = new Set();
      list.forEach(function (it) { if (it.done) return; var k = it.r + ',' + it.c; (groups[k] = groups[k] || []).push(it); });
      list.forEach(function (it) {
        seen.add(it.key);
        var t = tokens.get(it.key);
        if (it.done) {
          if (t && !t.dead) { t.item = Object.assign({}, t.item); finishToken(t); }
          return;
        }
        var g = groups[it.r + ',' + it.c], n = g.length, slot = g.indexOf(it), off = (n > 1 && it.pos !== -1) ? STACK[Math.min(n, 4)][slot % 4] : [0, 0], sc = (n > 1 && it.pos !== -1) ? 0.74 : 1;
        var fin = { r: it.r, c: it.c, dx: off[0], dy: off[1], s: sc };
        if (!t || t.dead) {
          var el = document.createElement('div'); el.className = 'tok tok-' + it.color; el.dataset.key = it.key;
          el.style.setProperty('--tc', COLORHEX[it.color]);
          el.innerHTML = '<i class="tbody"><b class="tn"></b></i>';
          el.querySelector('.tn').textContent = String(it.idx + 1);
          tokEl.appendChild(el);
          t = { el: el, item: it, shown: null, chain: Promise.resolve(), dead: false };
          tokens.set(it.key, t);
          placeNow(t, fin.r, fin.c, fin.dx, fin.dy, fin.s);
          el.classList.add('spawn');
        } else if (t.item.pos !== it.pos) {
          moveToken(t, it, fin);
        } else if (!t.shown || t.shown[0] !== fin.r || t.shown[1] !== fin.c || t.shown[2] !== fin.dx || t.shown[3] !== fin.dy || t.shown[4] !== fin.s) {
          t.shown = [fin.r, fin.c, fin.dx, fin.dy, fin.s];
          t.el.style.transform = tf(fin.r, fin.c, fin.dx, fin.dy, fin.s); // re-fan a stack (CSS transition)
        }
        t.item = it;
        var mv = !!it.movable;
        t.el.classList.toggle('movable', mv);
        t.el.setAttribute('role', mv ? 'button' : 'img');
        t.el.setAttribute('aria-label', cap(it.color) + ' token ' + (it.idx + 1) + (mv ? ', tap to move' : ''));
        t.el.tabIndex = mv ? 0 : -1;
        t.el.onclick = mv ? function () { it.onTap && it.onTap(); } : null;
        t.el.onkeydown = mv ? function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.onTap && it.onTap(); } } : null;
      });
      tokens.forEach(function (t, key) { if (!seen.has(key)) { t.el.remove(); tokens.delete(key); } });
    }

    build();
    return { render: render, setViewer: setViewer, setLabels: setLabels, setTurn: setTurn, flash: flash, whenIdle: whenIdle, cells: cells, reset: function () { tokens.forEach(function (t) { t.el.remove(); }); tokens.clear(); } };
  }

  /* ---------------- dice ---------------- */
  var PIP_LAYOUTS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function buildFace(el) {
    if (el.children.length === 9) return;
    el.innerHTML = '';
    for (var i = 0; i < 9; i++) { var p = document.createElement('div'); p.className = 'pip'; el.appendChild(p); }
  }
  function showFace(el, value) {
    if (!PIP_LAYOUTS[value]) return;
    for (var i = 0; i < 9; i++) el.children[i].classList.toggle('on', PIP_LAYOUTS[value].indexOf(i) !== -1);
  }
  function rollDice(dieA, faceA, dieB, faceB, v1, v2) {
    buildFace(faceA); buildFace(faceB);
    if (REDUCED || !dieA.animate) { showFace(faceA, v1); showFace(faceB, v2); return Promise.resolve(); }
    var DUR = 820, timer, start = performance.now();
    function throwFrames(dir) {
      return [
        { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)', offset: 0 },
        { transform: 'translate3d(' + (-16 * dir) + 'px,-62px,0) rotate(' + (200 * dir) + 'deg) scale(1.16)', offset: 0.32 },
        { transform: 'translate3d(' + (8 * dir) + 'px,0,0) rotate(' + (430 * dir) + 'deg) scale(.95,.88)', offset: 0.64 },
        { transform: 'translate3d(' + (-3 * dir) + 'px,-12px,0) rotate(' + (610 * dir) + 'deg) scale(1.04)', offset: 0.82 },
        { transform: 'translate3d(0,0,0) rotate(' + (720 * dir) + 'deg) scale(1)', offset: 1 }
      ];
    }
    var a = dieA.animate(throwFrames(1), { duration: DUR, easing: 'cubic-bezier(.3,.7,.45,1)' });
    var b = dieB.animate(throwFrames(-1), { duration: DUR + 90, easing: 'cubic-bezier(.3,.7,.45,1)' });
    return new Promise(function (resolve) {
      var last = 0;
      (function tick(now) {
        var t = now - start;
        if (t - last > 75 && t < DUR * 0.78) { showFace(faceA, 1 + Math.floor(Math.random() * 6)); showFace(faceB, 1 + Math.floor(Math.random() * 6)); last = t; }
        if (t < DUR * 0.78) { timer = requestAnimationFrame(tick); return; }
        showFace(faceA, v1); showFace(faceB, v2);
        Promise.all([a.finished, b.finished]).catch(function () {}).then(resolve);
      })(start);
    });
  }

  global.LudoBoard = { mount: mount, PATH: PATH, START_INDEX: START_INDEX, HOME_COLS: HOME_COLS, HOME_BASE_POS: HOME_BASE_POS, SAFE_CELLS: SAFE_CELLS, COLORHEX: COLORHEX, pathIdx: pathIdx, globalCell: globalCell, rollDice: rollDice, buildFace: buildFace, showFace: showFace, cap: cap };
})(window);
