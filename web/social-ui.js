/* CodePlay social client — loaded on every page for signed-in players.
 * - keeps the player "online" (or "playing" on game pages) so friends can see and invite them
 * - shows incoming game invites anywhere on the site (not during a game)
 * - toasts for friend requests, and sends both players into a match when an invite is accepted
 */
(function () {
  'use strict';
  var TOKEN = null; try { TOKEN = localStorage.getItem('codeplay_acct_token'); } catch (e) {}
  var API = window.CODEPLAY_API_BASE || '';
  var WHERE = window.CODEPLAY_WHERE || 'site';
  var IN_GAME = ['ludo', 'whot', 'chess'].indexOf(WHERE) > -1;
  var GAME_NAME = { ludo: 'Ludo', whot: 'Whot', chess: 'Chess' };
  var listeners = {};
  var Social = window.CodePlaySocial = { enabled: !!TOKEN, requests: 0, socket: null };

  function emit(name, data) { (listeners[name] || []).forEach(function (f) { try { f(data); } catch (e) {} }); }
  Social.on = function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); };
  Social.api = function (path, opts) {
    opts = opts || {}; var h = { 'Content-Type': 'application/json' }; if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
    return fetch(API + '/api/social' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  };
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* ---------- styles ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '.cp-toasts{position:fixed;left:0;right:0;top:calc(10px + env(safe-area-inset-top,0px));z-index:100000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;padding:0 12px}',
    '.cp-toast{pointer-events:auto;max-width:420px;width:100%;background:#162c24;color:#f2f7f4;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:12px 14px;font:600 14px/1.35 system-ui,sans-serif;box-shadow:0 14px 34px rgba(0,0,0,.45);display:flex;gap:10px;align-items:center;animation:cpIn .25s cubic-bezier(.16,1,.3,1)}',
    '.cp-toast button{margin-left:auto;background:#ffd75a;color:#2a1c00;border:0;border-radius:10px;padding:8px 12px;font-weight:800;cursor:pointer;min-height:36px}',
    '.cp-scrim{position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.66);display:flex;align-items:flex-end;justify-content:center;animation:cpFade .2s ease-out}',
    '.cp-sheet{width:100%;max-width:460px;background:#10211b;border:1px solid rgba(255,255,255,.14);border-bottom:0;border-radius:22px 22px 0 0;padding:20px 18px calc(18px + env(safe-area-inset-bottom,0px));color:#f2f7f4;font-family:system-ui,sans-serif;animation:cpUp .3s cubic-bezier(.16,1,.3,1)}',
    '.cp-av{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:19px;color:#fff;flex:none;text-transform:uppercase}',
    '.cp-row{display:flex;gap:12px;align-items:center}.cp-title{font-size:17px;font-weight:800;line-height:1.25}.cp-sub{font-size:13px;color:#93a99f;margin-top:2px}',
    '.cp-chip{display:inline-block;margin-top:14px;padding:6px 12px;border-radius:99px;font-size:13px;font-weight:700;border:1px solid rgba(255,255,255,.15)}',
    '.cp-chip.stk{border-color:#ffd75a;color:#ffd75a;background:rgba(255,215,90,.1)}.cp-chip.fun{border-color:#2fd27a;color:#2fd27a;background:rgba(47,210,122,.1)}',
    '.cp-bar{height:4px;border-radius:4px;background:rgba(255,255,255,.1);margin:16px 0 14px;overflow:hidden}.cp-bar i{display:block;height:100%;background:#ffd75a;transform-origin:left;animation:cpBar linear forwards}',
    '.cp-btns{display:flex;gap:10px}.cp-btns button{flex:1;min-height:50px;border-radius:14px;font-weight:800;font-size:16px;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:transparent;color:#f2f7f4}',
    '.cp-btns button.go{background:linear-gradient(180deg,#ffd75a,#f5a524);color:#2a1c00;border:0}.cp-btns button:disabled{opacity:.45;cursor:not-allowed}',
    '.cp-note{font-size:13px;color:#ff8a8a;margin:0 0 10px;min-height:0}.cp-note a{color:#ffd75a}',
    '@keyframes cpIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}@keyframes cpUp{from{transform:translateY(40px);opacity:.4}to{transform:none;opacity:1}}@keyframes cpFade{from{opacity:0}to{opacity:1}}@keyframes cpBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}',
    '@media (prefers-reduced-motion:reduce){.cp-toast,.cp-sheet,.cp-scrim{animation:none}.cp-bar i{animation-duration:0s!important}}'
  ].join('\n');
  document.head.appendChild(css);

  /* ---------- toasts ---------- */
  var toastBox = el('div', 'cp-toasts'); toastBox.setAttribute('aria-live', 'polite'); toastBox.setAttribute('role', 'status');
  function ready(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () { document.body.appendChild(toastBox); });
  Social.toast = function (text, action) {
    var t = el('div', 'cp-toast'); t.appendChild(el('span', '', text));
    if (action) { var b = el('button', '', action.label); b.onclick = function () { t.remove(); action.run(); }; t.appendChild(b); }
    toastBox.appendChild(t); setTimeout(function () { if (t.parentNode) t.remove(); }, action ? 7000 : 4200);
  };

  /* ---------- incoming invite dialog ---------- */
  var queue = [], current = null, ticking = null;
  function closeCurrent() { if (current && current.scrim.parentNode) current.scrim.remove(); clearTimeout(ticking); current = null; showNext(); }
  function showNext() {
    if (current || !queue.length || IN_GAME) return;
    var inv = queue.shift(); if (Date.now() > inv.expiresAt) return showNext();
    var scrim = el('div', 'cp-scrim'), sheet = el('div', 'cp-sheet');
    sheet.setAttribute('role', 'alertdialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Game invite');
    var row = el('div', 'cp-row'), av = el('div', 'cp-av', (inv.from.username || '?').charAt(0)); av.style.background = inv.from.color || '#3182ce';
    var who = el('div'); who.appendChild(el('div', 'cp-title', inv.from.username + ' invited you to play ' + (GAME_NAME[inv.game] || inv.game)));
    who.appendChild(el('div', 'cp-sub', inv.stake ? 'Winner takes the pot' : 'Just for fun — no chips at stake'));
    row.appendChild(av); row.appendChild(who); sheet.appendChild(row);
    var chip = el('span', 'cp-chip ' + (inv.stake ? 'stk' : 'fun'), inv.stake ? 'Staked · ' + fmt(inv.stake) + ' chips each' : 'Friendly match');
    sheet.appendChild(chip);
    var left = Math.max(1000, inv.expiresAt - Date.now()), bar = el('div', 'cp-bar'), fill = el('i'); fill.style.animationDuration = left + 'ms'; bar.appendChild(fill); sheet.appendChild(bar);
    var note = el('p', 'cp-note'); note.setAttribute('aria-live', 'polite'); sheet.appendChild(note);
    var btns = el('div', 'cp-btns'), no = el('button', '', 'Decline'), yes = el('button', 'go', 'Accept'); btns.appendChild(no); btns.appendChild(yes); sheet.appendChild(btns);
    scrim.appendChild(sheet); document.body.appendChild(scrim); current = { inv: inv, scrim: scrim, note: note, yes: yes };
    yes.focus();
    if (inv.stake) { // warn early if the player cannot afford the stake
      fetch(API + '/api/versus/me', { headers: { Authorization: 'Bearer ' + TOKEN } }).then(function (r) { return r.json(); }).then(function (me) {
        if (!current || current.inv !== inv) return;
        if (me.balance < inv.stake) { yes.disabled = true; note.textContent = 'You need ' + fmt(inv.stake - me.balance) + ' more chips to accept. '; var a = el('a', '', 'Add chips'); a.href = 'wallet.html'; note.appendChild(a); }
        else if (!me.ageConfirmed) { note.textContent = 'Confirm you are 18+ on the Versus page before accepting staked matches.'; yes.disabled = true; }
      }).catch(function () {});
    }
    no.onclick = function () { Social.api('/invite/' + inv.inviteId + '/decline', { method: 'POST' }); closeCurrent(); };
    yes.onclick = function () {
      yes.disabled = no.disabled = true; yes.textContent = 'Starting…';
      Social.api('/invite/' + inv.inviteId + '/accept', { method: 'POST' }).then(function (r) {
        if (r.ok && r.data.match) { goToMatch(r.data.match); return; }
        yes.textContent = 'Accept'; no.disabled = false;
        var m = { 'insufficient-chips': 'You do not have enough chips for this stake.', 'invite-expired': 'This invite has expired.', 'friend-busy': 'Your friend is no longer available.', 'you-are-busy': 'Finish your current match first.', 'match-in-progress': 'A match is already in progress.', 'stake-too-high-for-new-account': 'New accounts have a lower stake limit for the first 24 hours.', 'age-confirmation-required': 'Confirm you are 18+ first (Versus page).' };
        note.textContent = m[r.data.error] || 'Could not start the match.';
        if (r.data.error === 'invite-expired' || r.data.error === 'friend-busy') yes.disabled = true; else yes.disabled = false;
      });
    };
    scrim.addEventListener('keydown', function (e) { if (e.key === 'Escape') no.click(); });
    ticking = setTimeout(function () { if (current && current.inv === inv) { Social.toast('Invite from ' + inv.from.username + ' expired'); closeCurrent(); } }, left + 400);
  }
  Social.showInvite = function (inv) { if (IN_GAME) return; if (queue.some(function (q) { return q.inviteId === inv.inviteId; }) || (current && current.inv.inviteId === inv.inviteId)) return; queue.push(inv); showNext(); };

  /* ---------- hand-off into a match ---------- */
  var redirecting = false;
  function goToMatch(m) {
    if (redirecting || !m || !m.url) return; redirecting = true;
    var scrim = el('div', 'cp-scrim'); scrim.style.alignItems = 'center';
    var box = el('div', 'cp-sheet'); box.style.borderRadius = '22px'; box.style.textAlign = 'center'; box.style.maxWidth = '340px'; box.style.margin = '0 16px';
    box.appendChild(el('div', 'cp-title', 'Match ready'));
    box.appendChild(el('div', 'cp-sub', 'Starting ' + (GAME_NAME[m.game] || m.game) + ' against ' + m.opponent + '…'));
    scrim.appendChild(box); document.body.appendChild(scrim);
    setTimeout(function () { location.href = m.url; }, 650);
  }
  Social.goToMatch = goToMatch;

  /* ---------- connection ---------- */
  function connect(url) {
    var s = Social.socket = io(url, { transports: ['websocket', 'polling'] });
    function hello() { s.emit('social-hello', { token: TOKEN, where: WHERE }); }
    s.on('connect', hello);
    s.on('social-ready', function (d) { Social.requests = d.requests || 0; emit('badge', Social.requests); (d.invites || []).forEach(Social.showInvite); emit('ready', d); });
    s.on('social-update', function (d) {
      if (d.kind === 'request-received') { Social.requests++; emit('badge', Social.requests); if (!IN_GAME) Social.toast(d.username + ' sent you a friend request', WHERE === 'friends' ? null : { label: 'View', run: function () { location.href = 'friends.html?tab=requests'; } }); }
      if (d.kind === 'request-accepted' && !IN_GAME) Social.toast(d.username + ' accepted your friend request');
      emit('update', d);
    });
    s.on('presence', function (d) { emit('presence', d); });
    s.on('friend-invite', Social.showInvite);
    s.on('invite-update', function (d) {
      if (current && current.inv.inviteId === d.inviteId) { if (d.status !== 'accepted') { if (d.status === 'cancelled') Social.toast('Invite was cancelled'); closeCurrent(); } }
      queue = queue.filter(function (q) { return q.inviteId !== d.inviteId; });
      emit('invite', d);
    });
    s.on('match-ready', goToMatch);
    s.on('tournament-match', function (m) {
      emit('tournament', m);
      if (IN_GAME) return;
      Social.toast('🏆 ' + m.name + ': round ' + m.round + ' vs ' + m.opponent + ' is ready', { label: 'Play now', run: function () { location.href = m.url; } });
    });
    s.on('tournament-update', function (d) {
      emit('tournament', d);
      if (IN_GAME) return;
      var go = { label: 'View', run: function () { location.href = 'tournaments.html#' + d.tournamentId; } };
      if (d.status === 'cancelled') Social.toast(d.name + ' was cancelled' + (d.refunded ? ' — your entry fee was refunded' : ''));
      else if (d.status === 'running') Social.toast('🏆 ' + d.name + ' has started', go);
      else if (d.status === 'eliminated') Social.toast('You are out of ' + d.name + ' (round ' + d.round + ')', go);
      else if (d.status === 'replay') Social.toast('Draw — a replay of your ' + d.name + ' match is ready', go);
      else if (d.status === 'completed') Social.toast(d.place ? '🏆 ' + d.name + ': you finished #' + d.place + (d.prize ? ' and won ' + fmt(d.prize) + ' chips' : '') : d.name + ' has finished', go);
    });
    s.on('banned', function () { try { localStorage.removeItem('codeplay_acct_token'); } catch (e) {} location.href = 'index.html'; });
  }
  function start() {
    if (!TOKEN || Social.socket || Social._starting) return; Social._starting = true;
    function go() {
      var p = window.CODEPLAY_SOCKET_URL ? Promise.resolve(window.CODEPLAY_SOCKET_URL) : fetch(API + '/api/config/public').then(function (r) { return r.json(); }).then(function (c) { return c.socketUrl || location.origin; }).catch(function () { return location.origin; });
      p.then(connect);
    }
    if (typeof io !== 'undefined') return go();
    var sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js'; sc.onload = go; document.head.appendChild(sc);
  }
  Social.start = function (t) { if (t) { TOKEN = t; Social.enabled = true; } start(); };
  Social.stop = function () { TOKEN = null; Social.enabled = false; Social._starting = false; if (Social.socket) { Social.socket.disconnect(); Social.socket = null; } queue = []; if (current) closeCurrent(); Social.requests = 0; emit('badge', 0); };
  start();
})();
