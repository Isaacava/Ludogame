/* Shared "versus match finished" popup for the game pages. */
(function () {
  window.showVersusResult = function (r, mySeat) {
    if (document.getElementById('versusResult')) return;
    var msg, back = 'Back to Versus', href = 'versus.html';
    if (r.tournament) {
      back = 'Back to tournament'; href = 'tournaments.html#' + r.tournamentId;
      if (r.replay || r.result === 'draw') msg = 'Draw — a replay is ready. Check the tournament page.';
      else if (r.winnerIndex === mySeat) msg = r.final ? '🏆 You won the tournament!' : (r.reason === 'walkover' || r.reason === 'forfeit' ? 'Your opponent left — you advance!' : 'You won! You advance to the next round.');
      else msg = r.reason === 'walkover' ? 'You missed the start time — your opponent advances.' : 'You are out of the tournament. Thanks for playing!';
    } else if (r.result === 'cancelled') msg = 'Match cancelled — your stake was returned.';
    else if (r.result === 'draw') msg = 'Draw — both stakes returned.';
    else if (r.result === 'win') msg = (r.winnerIndex === mySeat ? '🏆 You won ' + r.payout + ' chips!' : 'You lost this match.') + (r.reason === 'forfeit' ? ' (opponent left)' : '');
    else msg = 'Match finished.';
    var d = document.createElement('div'); d.id = 'versusResult';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:24px';
    var b = document.createElement('div');
    b.style.cssText = 'background:#10211b;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:22px;max-width:320px;width:100%;text-align:center;color:#f2f7f4;font-family:system-ui,sans-serif';
    var t = document.createElement('div'); t.style.cssText = 'font-size:20px;font-weight:800;margin-bottom:14px'; t.textContent = msg;
    var a = document.createElement('button'); a.textContent = back;
    a.style.cssText = 'width:100%;padding:13px;border:0;border-radius:12px;background:#ffd75a;color:#2a1c00;font-weight:800;font-size:16px;cursor:pointer';
    a.onclick = function () { location.href = href; };
    b.appendChild(t); b.appendChild(a); d.appendChild(b); document.body.appendChild(d);
  };
})();
