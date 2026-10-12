/* Runs the chess engine off the main thread so the interface never stutters while the computer thinks. */
importScripts('/chess-engine.js?v=1');
var engine = CPEngine.create(), START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
onmessage = function (e) {
  var d = e.data;
  try {
    engine.setFen(d.fen || START);
    (d.moves || []).forEach(function (u) { engine.makeUci(u); });
    var r = engine.bestMove({ level: d.level, movetime: d.movetime });
    postMessage({ id: d.id, result: r });
  } catch (err) { postMessage({ id: d.id, error: String(err && err.message || err) }); }
};
