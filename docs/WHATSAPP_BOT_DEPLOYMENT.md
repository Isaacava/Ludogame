# CodePlay WhatsApp Bot — WAHA + Railway deployment

## Current architecture

CodePlay uses a single Railway service containing two processes:

- CodePlay Node/Express + Socket.IO on the Railway PORT (3000 in production).
- WAHA NOWEB on an internal-only port (3001).
- WAHA sends message webhooks to CodePlay at http://127.0.0.1:3000/waha/webhook.
- CodePlay sends replies back to WAHA at http://127.0.0.1:3001.
- WAHA session data should be persisted in /app/.sessions on a Railway Volume so the WhatsApp account does not need to be paired after every restart.
- MongoDB Atlas remains the persistent application database.

Railway private networking is not needed between the two processes because they share one container. The public Railway domain is for CodePlay only.

## Why WAHA NOWEB

WAHA NOWEB communicates directly with WhatsApp over WebSocket and does not run Chromium/Chrome, which saves CPU and memory. WAHA documents NOWEB as a lightweight engine and supports session creation, QR authentication, phone-number pairing code, sendText, and message webhooks. citeturn421684search0turn421684search1

This project uses NOWEB because Railway Free is memory constrained and the previous WEBJS configuration was killed by memory pressure. NOWEB removes the browser process entirely.

The Docker image is devlikeapro/waha:noweb, which WAHA documents as the browserless image for NOWEB. citeturn421684search1

## Railway service

The Railway codeplay-ludo service should use the repository Dockerfile.

Docker base image: devlikeapro/waha:noweb

The container runs node /codeplay/server/runCombined.js. That supervisor starts both CodePlay and WAHA and shuts the sibling process down if either process exits.

## Required Railway variables

PORT=3000
NODE_ENV=production
SITE_URL=https://<railway-domain>
SITE_ORIGIN=https://<railway-domain>
PUBLIC_BASE_URL=https://<railway-domain>
CORS_ORIGIN=https://<railway-domain>
ADMIN_PASSWORD=<long-random-secret>

WAHA_URL=http://127.0.0.1:3001
WAHA_API_PORT=3001
WAHA_SESSION=default
WHATSAPP_DEFAULT_ENGINE=NOWEB
WAHA_NOWEB_WA_VERSION=auto-web
WAHA_NOWEB_WA_VERSION_FORCE=False
WAHA_API_KEY=<long-random-secret>
WAHA_WEBHOOK_SECRET=<long-random-secret>
WAHA_PAIRING_PASSWORD=<long-random-secret>
WAHA_DASHBOARD_ENABLED=false
WHATSAPP_SWAGGER_ENABLED=false
WAHA_WORKER_RESTART_SESSIONS=true

WHATSAPP_HOOK_URL=http://127.0.0.1:3000/waha/webhook
WHATSAPP_HOOK_EVENTS=message
WHATSAPP_HOOK_HMAC_KEY=<same value as WAHA_WEBHOOK_SECRET>
WHATSAPP_HOOK_RETRIES_POLICY=exponential
WHATSAPP_HOOK_RETRIES_DELAY_SECONDS=2
WHATSAPP_HOOK_RETRIES_ATTEMPTS=8

WHATSAPP_PUBLIC_NUMBER=<connected whatsapp number, international digits>
WHATSAPP_GAME_LINK_SECRET=<long-random-secret>
MONGODB_URI=<mongodb-atlas-uri>
MONGODB_DB=codeplay

WAHA's API key is required for its REST API. WAHA hashes a plaintext key internally at startup; CodePlay keeps the plaintext in its own Railway variable so it can authenticate API requests.

WAHA webhook HMAC uses SHA-512 and the X-Webhook-Hmac header. CodePlay verifies that HMAC before processing incoming messages.

## Pairing the WhatsApp account

After deployment, open:

https://<railway-domain>/waha/pairing

The route is protected with HTTP Basic Auth:
- username: codeplay
- password: the value of WAHA_PAIRING_PASSWORD

CodePlay creates/starts the default WAHA session automatically.

When the page shows SCAN_QR_CODE, scan the displayed QR from WhatsApp on the phone that will act as the bot account: WhatsApp → Settings → Linked devices → Link a device.

The QR expires quickly, so the page refreshes it automatically.

The pairing page also supports WAHA's phone-number pairing code. Enter the bot WhatsApp number in international digits and click Get pairing code. Then on that phone use WhatsApp → Settings → Linked Devices → Link with phone number instead and enter the code returned by WAHA.

WAHA currently documents POST /api/{session}/auth/request-code for NOWEB as well as the other supported engines. citeturn421684search1

Do not set a custom WAHA device name in the session creation request.

## How incoming messages work

1. A user sends a WhatsApp message to the paired bot number.
2. WAHA receives the message from WhatsApp.
3. WAHA posts a message event to /waha/webhook.
4. CodePlay verifies the WAHA HMAC.
5. CodePlay extracts the sender chat ID and normalizes the sender phone number.
6. handleMessage() loads or creates the user's CodePlay record.
7. The bot reply is sent through WAHA POST /api/sendText.
8. When a game link is generated, CodePlay encrypts the WhatsApp phone identity into wa_token.
9. The game backend decrypts wa_token when the player opens or joins a Ludo/Whot room.

## Game result notifications

Only room players linked to a WhatsApp identity receive WhatsApp game results.

Winner: 🏆 You won! — You won against <opponent name>.
Loser: 😔 You lost. — You lost to <winner name>.

The room tracks successful notifications separately so a failed send can be retried without re-sending to players whose delivery already succeeded.

## Railway storage

Attach one Railway Volume to the codeplay-ludo service and mount it at /app/.sessions. That directory is WAHA's persistent session storage.

## Important WhatsApp policy caveat

WAHA automates WhatsApp through WhatsApp Web/linked-device mechanisms rather than Meta's official Cloud API. WhatsApp's published Terms and Business Terms restrict unauthorized automated use and can allow accounts to be suspended for violations.

For a production/commercial deployment, the official WhatsApp Business Platform Cloud API is the Meta-supported integration. WAHA is appropriate here as a self-hosted test/experimental transport, but there is operational/account risk that is outside CodePlay's control.

References:
- https://www.whatsapp.com/legal/terms-of-service
- https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-App

## Legacy files

server/whatsappServer.js, server/bot/metaWhatsAppAdapter.js, and the old Render/Meta environment entries remain in the repository for compatibility/history. The active Railway bot transport is server/bot/wahaAdapter.js and the combined server/runCombined.js.
