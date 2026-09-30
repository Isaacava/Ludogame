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

## Guest mode

The landing page now offers "Continue as Guest — no registration". Guests can choose a display name/colour, play against the computer, create friend rooms, or join an existing room. The guest profile stays only in the browser unless the player later chooses WhatsApp login.
\n\n### Whot\n\n`server/engine/whotEngine.js` implements the 54-card Nigerian deck, hidden hands, shape/number matching, WHOT calls, Pick 2/Pick 3 stacking, Hold On, Suspension, General Market, scoring, draw-pile recycling, and round-end state. `server/whotServer.js` adds friends rooms, reconnect, a two-player computer mode, reactions, and rematches. Open `/whot.html` from the site game selector.\n