'use strict';

const http = require('http');
const express = require('express');
const { ConfigStore } = require('./config/configStore');
const { MongoPersistence } = require('./db/mongoPersistence');
const { UserStore, SessionStore, createBotApp } = require('./whatsappBot');
const { createMetaWhatsAppApp } = require('./bot/metaWhatsAppAdapter');

const PORT = Number(process.env.PORT || process.env.BOT_PORT || 3002);
const configStore = new ConfigStore();
const persistence = new MongoPersistence();
const users = new UserStore(persistence);
const sessions = new SessionStore(persistence);

async function start() {
  try {
    if (persistence.enabled) {
      await persistence.connect();
      await configStore.hydrateFromPersistence(persistence);
      console.log(`MongoDB connected: ${persistence.dbName}`);
    }

    const app = express();
    app.use(createMetaWhatsAppApp({ users, configStore }));
    app.use(createBotApp({ users, sessions, configStore }));
    app.get('/health', (req, res) => res.json({ ok: true, service: 'codeplay-whatsapp-bot' }));

    const server = http.createServer(app);
    server.listen(PORT, () => {
      console.log(`CodePlay WhatsApp bot listening on :${PORT}`);
    });

    const shutdown = async () => {
      server.close(async () => {
        await persistence.close().catch(() => {});
        process.exit(0);
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return server;
  } catch (err) {
    console.error('WhatsApp bot startup failed:', err);
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { start, configStore, persistence, users, sessions };
