'use strict';

// Server-side turn clock. Stops one absent player from stalling a whole room:
// when the clock runs out the server plays a sensible move for them, and keeps
// the game moving quickly if they stay away.
const ALLOWED = [0, 30, 60, 90];
const DEFAULT_SECONDS = (() => {
  const n = Number(process.env.CODEPLAY_TURN_SECONDS);
  return ALLOWED.includes(n) ? n : 60;
})();
const DISCONNECTED_MS = 10000;
const AWAY_MS = 8000;

function normalizeTurnSeconds(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback === undefined ? DEFAULT_SECONDS : fallback;
  const n = Number(value);
  return ALLOWED.includes(n) ? n : (fallback === undefined ? DEFAULT_SECONDS : fallback);
}

/**
 * @param {object} cfg
 * @param {() => Iterable<object>} cfg.rooms              all rooms of one game
 * @param {(room) => boolean} cfg.active                  engine exists and the game is running
 * @param {(room) => string} cfg.signature                changes whenever anything happens in the game
 * @param {(room) => number} cfg.seat                     index of the player whose turn it is
 * @param {(room, event, payload) => void} cfg.emit       send an event to everyone in the room
 * @param {(room, seat) => void} cfg.autoPlay             make a move for the seated player
 * @param {(room, text) => void} [cfg.announce]           optional feed line
 */
function startTurnTimers(cfg) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of cfg.rooms()) {
      try { tick(room, now, cfg); } catch (err) { console.error('[turn-timer]', err.message); }
    }
  }, 1000);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

function effectiveMs(room, seat, cfg) {
  const base = Number(room.turnSeconds) * 1000;
  const player = room.players[seat];
  if (!player || player.bot) return 0;
  let ms = base;
  if (!player.socketId) ms = Math.min(ms, DISCONNECTED_MS);
  if ((player.awayStreak || 0) >= 2) ms = Math.min(ms, AWAY_MS);
  return ms;
}

function tick(room, now, cfg) {
  if (room.turnSeconds === undefined) room.turnSeconds = DEFAULT_SECONDS;
  if (!room.turnSeconds || !cfg.active(room)) { room.turnDeadline = null; return; }
  const seat = cfg.seat(room);
  const sig = cfg.signature(room);
  if (sig !== room.turnSig) {
    // Something changed. If a human (not our auto-play) caused it, they are back.
    if (room.turnSig !== undefined && sig !== room.autoSig) {
      const previous = room.players[room.turnSeat];
      if (previous && !previous.bot) previous.awayStreak = 0;
    }
    room.turnSig = sig;
    room.turnSeat = seat;
    const ms = effectiveMs(room, seat, cfg);
    room.turnDeadline = ms ? now + ms : null;
    cfg.emit(room, 'turn', {
      code: room.code, turn: seat, seconds: Math.round(ms / 1000), deadline: room.turnDeadline, now,
      away: !!(room.players[seat] && (room.players[seat].awayStreak || 0) >= 2)
    });
    return;
  }
  if (!room.turnDeadline || now < room.turnDeadline) return;
  const player = room.players[seat];
  if (!player) return;
  player.awayStreak = (player.awayStreak || 0) + 1;
  room.turnDeadline = null;
  try {
    cfg.autoPlay(room, seat);
    if (cfg.announce) cfg.announce(room, `${player.name || 'A player'} ran out of time — auto-played ⏱️`);
  } finally {
    room.autoSig = cfg.signature(room);
  }
}

module.exports = { startTurnTimers, normalizeTurnSeconds, ALLOWED_TURN_SECONDS: ALLOWED, DEFAULT_TURN_SECONDS: DEFAULT_SECONDS };
