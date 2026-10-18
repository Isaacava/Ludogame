# CodePlay Ludo

Real-time Ludo backend and WhatsApp onboarding bot.

## Current architecture

- **Vercel** serves the static web client in `web/`.
- **Railway** is the intended home for the persistent Node/Socket.IO backend and WAHA service.
- **MongoDB Atlas** stores durable player/session/match data.
- Active game state remains in memory for low-latency Socket.IO play.
- **WhatsApp Cloud API (Meta)** is the preferred production WhatsApp transport. The Railway backend exposes `/whatsapp/meta`, so no second WhatsApp container is required.
- **Guest mode** lets anyone play without a WhatsApp account; friends mode also works without registration.

## Environment

Copy `.env.example` and configure:

- `MONGODB_URI`
- `MONGODB_DB=codeplay`
- `ADMIN_PASSWORD`
- `SITE_URL`
- `SITE_ORIGIN`
- `PUBLIC_BASE_URL`
- `CORS_ORIGIN`
- `WAHA_URL`
- `WAHA_WEBHOOK_SECRET`

Never commit real secrets.

## Local

```bash
npm install
npm start
```

The HTTP/Socket.IO server listens on port 3001 by default.

## Game integrity

The server is authoritative for dice consumption. A die cannot be reused, split/combine mode is validated server-side, and reconnect tokens preserve player seats.

## GitHub

Repository: https://github.com/Isaacava/Ludogame


## WhatsApp Cloud API setup

The Railway webhook is:
`https://codeplay-ludo-production.up.railway.app/whatsapp/meta`

In Meta's WhatsApp/Developer configuration, set that callback URL, choose a verify token matching `META_WHATSAPP_VERIFY_TOKEN`, and subscribe the app/WABA to the `messages` webhook. Meta verifies the callback with a GET request and sends incoming events as signed POST requests.

For sending messages, configure a WhatsApp Business Account phone number, its Phone Number ID, and a system-user access token with WhatsApp Business Messaging permission. The adapter uses Graph API v26.0 by default.

## Deploying on Render

`render.yaml` describes the game backend (`codeplay-game-server`, `npm install` then `npm start`, health check `/health`) next to the older WhatsApp-only bot. In the Render dashboard choose New > Blueprint (or create a Web Service from this repo with those commands) and fill in the secret environment variables listed in the file. The backend also serves the website files, so its own URL is a complete game address; if you also host `web/` on Vercel, point the `/api` and `/health` rewrites in `vercel.json` at the Render URL. The server reports its own address to browsers (`/api/config/public`), taken from `SOCKET_URL` or the `RENDER_EXTERNAL_URL` that Render sets. Use a paid instance: a free one sleeps and drops live games. MongoDB is required for accounts, chips and tournaments to survive a restart.

## Accounts (email + Google) and usernames

Players sign up or log in with Google (one button does both), in addition to WhatsApp and guest mode (guest mode is unchanged). There is no email/password option.

- Server: `server/auth/accounts.js`, mounted at `/api/account/*` (`google`, `me`, `username-available`, `username`, `logout`, `config`). Accounts live in the `accounts` / `account_sessions` MongoDB collections, separate from WhatsApp `users`.
- After the first Google sign-in the player must choose a username: 3-16 letters/numbers/underscore, unique case-insensitively (enforced by a unique index), set once.
- Sessions are random bearer tokens (30 days, only a hash is stored). Auth endpoints are rate limited.
- Google: set `GOOGLE_CLIENT_ID` (OAuth client of type Web) and add your site domain under Authorized JavaScript origins. Without it the Google button is hidden, so set it before deploying.
- Without `MONGODB_URI` accounts fall back to memory (lost on restart) - fine for local development only.

## Chips and Versus mode

- Chips are whole numbers (100 chips = $1) in an append-only ledger (`server/wallet/chipWallet.js`). Every change has a unique key, so retries can never apply twice, and balances can never go negative. Only signed-in accounts have chips; guests do not.
- Versus (`server/versus/`): a player locks a stake (10, 20, 50, 100, 500, 1000, 5000 or 10000 chips), is paired at random with someone at the same game and stake, and the winner receives the pot minus a 10% house fee (`VERSUS_FEE_RATE`). Draws, no-shows and server restarts refund both stakes. A player who is disconnected for 90s forfeits. Each match settles exactly once.
- Points are Elo-style (win up, loss down, never below 0) with weekly and all-time leaderboards.
- Safeguards: 18+ confirmation, a lower stake cap for accounts under 24h old, and one active match per player.
- Versus works for Ludo, Whot, Chess and Snooker (`VERSUS_GAMES`). Chess versus uses a 5 minute clock per side (`VERSUS_CHESS_BASE`). Lobby page: `web/versus.html`.
- Wallet page `web/wallet.html`: crypto deposits through NOWPayments hosted invoices (`server/wallet/walletRoutes.js`). Set `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` and `PUBLIC_BASE_URL`, and register `PUBLIC_BASE_URL/api/wallet/ipn` as the IPN URL. Chips are credited only on the signed `finished` status, exactly once, and only if the paid amount matches the invoice. `partially_paid` and mismatched payments are held for manual review. Try it first with `NOWPAYMENTS_SANDBOX=1`.
- `CHIPS_TEST_TOPUP=1` lets players add free chips for testing. Never leave it on once real deposits or withdrawals exist.
- Not built yet: withdrawals (cash-out).
- Real-money play can be regulated as gambling. Get legal advice before enabling deposits or withdrawals.

## Snooker

- Full-size table, 15 reds + 6 colours + cue ball, standard scoring: red then colour, colours re-spotted while reds remain, then yellow to black. Fouls (no contact, wrong ball first, wrong ball potted, cue ball potted, out of time) give the opponent 4-7 points, and after a potted cue ball the opponent places it in the D. A level score on the black is decided by a re-spotted black. Not implemented: free ball, "miss" replay requests, spin.
- The server is the referee and the physics engine (`server/engine/snookerEngine.js`, 480 Hz simulation). Clients only send an aim angle and power; the server replays the whole shot to both players as recorded frames, so nobody can cheat or see a different result. Sockets: `server/snookerServer.js`, rooms: `server/rooms/snookerRoomManager.js`.
- Page: `web/snooker.html` (upright table on phones, landscape on wide screens, zoom button, aiming guide with ghost ball, opponent's cue line, sound effects). Play vs computer (3 levels), friends rooms by 4-letter code, and rematches.
- Snooker is a first-class game everywhere: staked versus, tournaments, friend invites (friendly or staked), admin dashboards and settings.
- Shot clock: 90s per shot in friends/versus/tournament rooms (a timeout is a 4-point foul).

## Friends and invites

- Friends (`web/friends.html`, `server/social/`): search by username, send/accept/decline/cancel requests, remove friends. The list shows who is online, in a game, or offline in real time.
- Invites: an online friend can be invited to a friendly match (private room, no chips) or a staked match. The invite lasts 60s (`INVITE_TTL_MS`). A staked match locks both stakes only when the friend accepts, and fails cleanly if either player cannot afford it. Friend matches never change ranking points.
- Invites pop up on any CodePlay page (not during a game). Presence comes from `web/social-ui.js`, which every page loads.

## Tournaments

- One tournament is for one game (Ludo, Whot or Chess) and is a single-elimination knockout (`server/tournaments/`). Players browse and join at `web/tournaments.html`.
- Tournament matches are private reserved rooms, so tournament players only ever meet each other and never the general versus queue. While a player has a tournament match they cannot join versus or accept staked invites.
- The admin sets, per tournament: game, start time, entry fee (0 = free), guaranteed prize, house cut of entry fees, prize split (1st/2nd/3rd, 3rd is shared by the semi-final losers), min/max players, how long to wait for a no-show, chess clock, and weekly repeat.
- Entry fees are held until the start. Leaving before the start, cancelling, or too few players all refund automatically. Prizes are paid exactly once at the end.
- No-show: the player who shows up advances (walkover). Draw: replayed once, then the higher seed advances. Disconnecting for 2 minutes mid-game forfeits (`TOURNAMENT_FORFEIT_MS`).

## Admin panel

`web/admin.html` (sign in with `ADMIN_PASSWORD`, sessions last 12 hours, login attempts are limited). Sections: Dashboard (players online, chips in circulation, deposits, house fees, alerts, charts), Live rooms and queues, Players (search, ban/unban, adjust chips with an audit reason), Versus matches, Money (deposits needing review, ledger audit, chip movements), Tournaments (create, edit, publish, start now, cancel and refund, bracket and results), Settings (versus games, house fee, stakes, new-account cap, chess clock, plus all game-rule settings) and System & logs (config health checks and an admin activity log). The previous rules editor is still available at `web/admin-classic.html`.

## Guest mode

The landing page now offers "Continue as Guest — no registration". Guests can choose a display name/colour, play against the computer, create friend rooms, or join an existing room. The guest profile stays only in the browser unless the player later chooses WhatsApp login.


### Whot

`server/engine/whotEngine.js` implements the 54-card Nigerian deck, hidden hands, shape/number matching, WHOT calls, Pick 2/Pick 3 stacking, Hold On, Suspension, General Market, scoring, draw-pile recycling, last-card enforcement, and round-end state. `server/whotServer.js` adds friends rooms, reconnect, cross-tab seat recovery, a two-player computer mode, reactions, and rematches. Open `/whot.html` from the site game selector.


## WhatsApp bot service

A standalone WhatsApp service entrypoint is available for Render or another web host:

`node server/whatsappServer.js`

It exposes Meta Cloud API webhook verification at `/whatsapp/meta` and `/health`, and uses the same MongoDB-backed user/session stores as the main server.
