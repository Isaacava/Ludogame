# CodePlay Ludo

Real-time Ludo backend and WhatsApp onboarding bot.

## Current architecture

- **Vercel** serves the static web client in `web/`.
- **Railway** is the intended home for the persistent Node/Socket.IO backend and WAHA service.
- **MongoDB Atlas** stores durable player/session/match data.
- Active game state remains in memory for low-latency Socket.IO play.
- **WAHA** provides the free self-hosted WhatsApp bridge for development/low-volume use.

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
