'use strict';

// Server-side turn clock. Stops one absent player from stalling a whole room:
// when the clock runs out the server plays a sensible move for them, and keeps
// the game moving quickly if they stay away.
const ALLOWED = [0, 30, 60, 90];
const DEFAULT_SECONDS = (() => {
  const n = Number(process.env.CODEPLAY_TURN_SECONDS);
  return ALLOWED.includes(n) ? n : 60;
})();
const DISCONNECTED_MS = 25000;   // a refresh or a signal blip must not cost anyone their turn
const OFFLINE_OFF_MS = 60000;    // rooms with the clock Off still never freeze on a seat that left
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
  const player = room.players[seat];
  if (!player || player.bot) return 0;
  const offline = !player.socketId;
  let ms = Number(room.turnSeconds) * 1000;
  if (!ms) return offline ? OFFLINE_OFF_MS : 0;
  if (offline) ms = Math.min(ms, DISCONNECTED_MS);
  if ((player.awayStreak || 0) >= 2) ms = Math.min(ms, AWAY_MS);
  return ms;
}

function tick(room, now, cfg) {
  if (room.turnSeconds === undefined) room.turnSeconds = DEFAULT_SECONDS;
  if (!cfg.active(room)) { room.turnDeadline = null; return; }
  const seat = cfg.seat(room);
  const sig = cfg.signature(room);
  const player = room.players[seat];
  if (sig !== room.turnSig) {
    // Something changed. If a human (not our auto-play) caused it, they are back.
    if (room.turnSig !== undefined && sig !== room.autoSig) {
      const previous = room.players[room.turnSeat];
      if (previous && !previous.bot) previous.awayStreak = 0;
    }
    room.turnSig = sig;
    room.turnSeat = seat;
    room.turnStartedAt = now;
    room.turnDeadline = undefined;
  }
  // Disconnected players are timed from the moment they left (not from the start of the turn).
  const ms = effectiveMs(room, seat, cfg);
  const from = player && !player.socketId ? Math.max(room.turnStartedAt || now, player.disconnectedAt || now) : (room.turnStartedAt || now);
  const deadline = ms ? from + ms : null;
  if (deadline !== room.turnDeadline) {
    room.turnDeadline = deadline;
    cfg.emit(room, 'turn', {
      code: room.code, turn: seat, seconds: Math.round(ms / 1000), deadline, now,
      away: !!(player && (player.awayStreak || 0) >= 2)
    });
  }
  if (!deadline || now < deadline || !player) return;
  player.awayStreak = (player.awayStreak || 0) + 1;
  room.turnDeadline = null;
  try {
    cfg.autoPlay(room, seat);
    if (cfg.announce) cfg.announce(room, `${player.name || 'A player'} ran out of time — auto-played ⏱️`);
  } finally {
    room.autoSig = cfg.signature(room);
    if (room.autoSig === sig) room.turnStartedAt = now; // the auto-play changed nothing: restart the clock instead of looping
  }
}

module.exports = { startTurnTimers, normalizeTurnSeconds, ALLOWED_TURN_SECONDS: ALLOWED, DEFAULT_TURN_SECONDS: DEFAULT_SECONDS };
