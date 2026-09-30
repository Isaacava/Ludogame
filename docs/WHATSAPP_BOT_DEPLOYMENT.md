# CodePlay WhatsApp Bot — production deployment

## Architecture

The production WhatsApp bot is a standalone Node/Express service:

- Entry point: `node server/whatsappServer.js`
- Meta webhook: `GET/POST /whatsapp/meta`
- Health: `GET /health`
- Web login verification: `POST /api/auth/verify`
- Web session lookup: `GET /api/auth/session`
- Persistent users/sessions: MongoDB Atlas when `MONGODB_URI` is set
- WhatsApp transport: Meta WhatsApp Cloud API
- Render blueprint: `render.yaml`

The bot shares the same conversation logic used by the existing Ludo/Whot application. WhatsApp starts the game; the actual board opens on `/play.html` or `/whot.html`.

## Render

Create the web service from the `Isaacava/Ludogame` repository.

Build command:

```
npm install
```

Start command:

```
node server/whatsappServer.js
```

Health check:

```
/health
```

Required environment variables:

```
NODE_ENV=production
MONGODB_URI=<MongoDB Atlas connection string>
MONGODB_DB=codeplay

SITE_URL=https://<your-live-game-site>
SITE_ORIGIN=https://<your-live-game-site>
PUBLIC_BASE_URL=https://<your-render-service>.onrender.com

META_GRAPH_API_VERSION=v26.0
META_WHATSAPP_VERIFY_TOKEN=<random webhook verification token>
META_WHATSAPP_APP_SECRET=<Meta app secret>
META_WHATSAPP_ACCESS_TOKEN=<WhatsApp Cloud API access token>
META_WHATSAPP_PHONE_NUMBER_ID=<WhatsApp phone number ID>
WHATSAPP_PUBLIC_NUMBER=+<bot number>
```

Do not put secrets in GitHub.

## Meta webhook

Use:

```
https://<your-render-service>.onrender.com/whatsapp/meta
```

Meta first performs the GET verification handshake. The service checks `hub.verify_token` and returns `hub.challenge`.

Incoming POST deliveries are verified with `X-Hub-Signature-256` using the Meta app secret before the JSON body is processed. The handler also deduplicates message IDs during the running process.

Subscribe the WhatsApp Business Account/app to the `messages` webhook field.

## User flow

1. New WhatsApp number sends any message.
2. Bot asks for the player's name.
3. Bot creates a 6-digit login code valid for 10 minutes.
4. Bot presents the game menu.
5. Ludo and Whot choices use native WhatsApp buttons/lists where supported.
6. Friend mode returns a real room-creation URL.
7. A player can join with `JOIN LUDO ABCD` or `JOIN WHOT ABCD`.
8. Web login verification consumes the one-time 6-digit code and creates a persistent session.

## Important deployment note

The bot must have `SITE_URL` set to the actual deployed game URL. Do not leave the source default `https://codeplay.com` in production unless that domain is actually live.

Graph API v26.0 is the current version used by this project as of September 2026. Meta webhook deliveries use the GET challenge flow and `X-Hub-Signature-256` verification.
