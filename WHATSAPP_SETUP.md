# CodePlay WhatsApp Bot — Meta setup

## What is already built

The repository now contains a standalone bot service:

`node server/whatsappServer.js`

It exposes:

- `GET /health`
- `GET /whatsapp/meta` — Meta webhook verification
- `POST /whatsapp/meta` — incoming WhatsApp messages

The bot uses the same MongoDB user/session storage as the main application.

## Render

The repository contains `render.yaml` with:

- Node web service
- `npm install` build
- `node server/whatsappServer.js` start
- `/health` health check

After creating the Render service, copy its public URL.

## Required Render environment variables

Set:

`MONGODB_URI`
`MONGODB_DB=codeplay`
`SITE_URL`
`SITE_ORIGIN`
`PUBLIC_BASE_URL`
`META_GRAPH_API_VERSION`
`META_WHATSAPP_VERIFY_TOKEN`
`META_WHATSAPP_APP_SECRET`
`META_WHATSAPP_ACCESS_TOKEN`
`META_WHATSAPP_PHONE_NUMBER_ID`
`WHATSAPP_PUBLIC_NUMBER`

The Meta values are secrets and must not be committed to Git.

## Meta webhook

Use:

`https://YOUR-RENDER-DOMAIN/whatsapp/meta`

for the webhook callback.

Use the same value you put in `META_WHATSAPP_VERIFY_TOKEN` in Meta's webhook verification settings.

Subscribe the WhatsApp Business app to the `messages` webhook.

The adapter verifies Meta's `x-hub-signature-256` request signature when `META_WHATSAPP_APP_SECRET` is configured.

## Bot conversation

The bot supports both interactive WhatsApp controls and text commands.

Typical flow:

`Hello` → enter name → choose Ludo or Whot → choose Computer/Friends → choose 2/3/4 players → receive the game link.

Text commands remain supported:

- `MENU`
- `LUDO`
- `WHOT`
- `JOIN WHOT ABCD`
- `JOIN LUDO ABCD`

Interactive buttons and lists are used when the WhatsApp client supports them, while ordinary text remains the fallback.
