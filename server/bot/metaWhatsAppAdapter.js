'use strict';

const crypto = require('crypto');
const express = require('express');
const { handleMessage, normalizePhone } = require('../whatsappBot');

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v26.0';
const VERIFY_TOKEN = process.env.META_WHATSAPP_VERIFY_TOKEN || '';
const PHONE_NUMBER_ID = process.env.META_WHATSAPP_PHONE_NUMBER_ID || '';
const ACCESS_TOKEN = process.env.META_WHATSAPP_ACCESS_TOKEN || '';
const APP_SECRET = process.env.META_WHATSAPP_APP_SECRET || '';
const seenMessages = new Map();

function timingSafeHexCompare(expected, actual) {
  const a = Buffer.from(expected || '', 'utf8');
  const b = Buffer.from(actual || '', 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature(rawBody, signature) {
  if (!APP_SECRET) return process.env.NODE_ENV !== 'production';
  if (!signature || !signature.startsWith('sha256=')) return false;
  const digest = crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  return timingSafeHexCompare(digest, signature.slice(7));
}

async function sendWhatsAppMessage(to, message, fetchImpl = global.fetch) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) throw new Error('Meta WhatsApp Cloud API is not configured');
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(to).replace(/\D/g, ''),
      ...message
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta WhatsApp send failed: ${res.status} ${body}`);
  }
  return res.json().catch(() => null);
}

function sendWhatsAppText(to, text, fetchImpl = global.fetch) {
  return sendWhatsAppMessage(to, {
    type: 'text',
    text: { preview_url: false, body: String(text || '') }
  }, fetchImpl);
}

function sendWhatsAppButtonMessage(to, body, buttons, fetchImpl = global.fetch) {
  return sendWhatsAppMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(body || '') },
      action: {
        buttons: (buttons || []).slice(0, 3).map(button => ({
          type: 'reply',
          reply: {
            id: String(button.id),
            title: String(button.title).slice(0, 20)
          }
        }))
      }
    }
  }, fetchImpl);
}

function sendWhatsAppListMessage(to, body, buttonText, rows, fetchImpl = global.fetch) {
  return sendWhatsAppMessage(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(body || '') },
      action: {
        button: String(buttonText || 'Choose').slice(0, 20),
        sections: [{
          title: 'CodePlay',
          rows: (rows || []).slice(0, 10).map(row => ({
            id: String(row.id),
            title: String(row.title).slice(0, 24),
            ...(row.description ? { description: String(row.description).slice(0, 72) } : {})
          }))
        }]
      }
    }
  }, fetchImpl);
}

function interactiveTextFromMessage(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type !== 'interactive') return '';
  if (message.interactive?.type === 'button_reply') {
    return message.interactive.button_reply?.id || message.interactive.button_reply?.title || '';
  }
  if (message.interactive?.type === 'list_reply') {
    return message.interactive.list_reply?.id || message.interactive.list_reply?.title || '';
  }
  return '';
}

function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== 'messages') continue;
      for (const message of change?.value?.messages || []) {
        out.push({
          id: message.id,
          from: message.from,
          type: message.type,
          text: interactiveTextFromMessage(message),
          raw: message
        });
      }
    }
  }
  return out;
}

function normalizeInteractiveCommand(input) {
  const id = String(input || '').trim().toLowerCase();
  const map = {
    game_ludo: '1',
    game_whot: '2',
    game_chess: '3',
    whot_computer: '1',
    whot_friends: '2',
    ludo_computer: '1',
    ludo_friends: '2'
  };
  if (map[id]) return map[id];
  const count = id.match(/^(?:whot|ludo)_count_([234])$/);
  if (count) return count[1];
  return input;
}

function interactiveForState(userBefore, result) {
  const stage = result?.patch?.stage;
  if (!stage) return null;

  if (stage === 'game_menu') {
    const reply = String(result.reply || '');
    return {
      kind: 'buttons',
      body: (/https?:\/\//i.test(reply)
        ? 'Your game link is above. Choose another game any time.'
        : reply || 'Choose a game to start.'
      ).slice(0, 1024),
      buttons: [
        { id: 'game_ludo', title: '🎲 Ludo' },
        { id: 'game_whot', title: '🃏 Whot' },
        { id: 'game_chess', title: '♟️ Chess' }
      ]
    };
  }

  if (stage === 'whot_mode_menu') {
    return {
      kind: 'buttons',
      body: String(result.reply || 'How do you want to play Whot?').slice(0, 1024),
      buttons: [
        { id: 'whot_computer', title: '🤖 Computer' },
        { id: 'whot_friends', title: '👥 Friends' }
      ]
    };
  }

  if (stage === 'whot_count') {
    const allowed = (result?.allowedWhotCounts || [2, 3, 4]).map(Number);
    return {
      kind: 'list',
      body: String(result.reply || (
        userBefore?.pendingMode === 'computer'
          ? 'How many players should be in the computer match?'
          : 'How many players should be in the Whot room?'
      )).slice(0, 1024),
      buttonText: 'Choose players',
      rows: allowed.map(n => ({
        id: `whot_count_${n}`,
        title: String(n),
        description: n === 2 ? 'Classic 2-player Whot' : `${n} players`
      }))
    };
  }

  if (stage === 'ludo_mode_menu') {
    return {
      kind: 'buttons',
      body: String(result.reply || 'How do you want to play Ludo?').slice(0, 1024),
      buttons: [
        { id: 'ludo_computer', title: '🤖 Computer' },
        { id: 'ludo_friends', title: '👥 Friends' }
      ]
    };
  }

  if (stage === 'ludo_count') {
    return {
      kind: 'list',
      body: String(result.reply || 'How many players?').slice(0, 1024),
      buttonText: 'Choose players',
      rows: [2, 3, 4].map(n => ({
        id: `ludo_count_${n}`,
        title: String(n),
        description: n === 2 ? '2-player teams' : `${n} players`
      }))
    };
  }

  return null;
}

async function sendInteractiveOrText(to, result, userBefore, fetchImpl = global.fetch) {
  const interactive = interactiveForState(userBefore, result);
  if (!interactive) return sendWhatsAppText(to, result.reply, fetchImpl);

  const reply = String(result.reply || '');
  if (/https?:\/\//i.test(reply)) await sendWhatsAppText(to, reply, fetchImpl);

  if (interactive.kind === 'buttons') {
    return sendWhatsAppButtonMessage(to, interactive.body, interactive.buttons, fetchImpl);
  }
  return sendWhatsAppListMessage(to, interactive.body, interactive.buttonText, interactive.rows, fetchImpl);
}

function markSeen(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, ts] of seenMessages) if (now - ts > 10 * 60 * 1000) seenMessages.delete(key);
  if (seenMessages.has(id)) return true;
  seenMessages.set(id, now);
  return false;
}

function createMetaWhatsAppApp({ users, configStore }) {
  if (!users || !configStore) throw new Error('users and configStore are required');
  const app = express();

  app.get('/whatsapp/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(String(challenge || ''));
    }
    return res.sendStatus(403);
  });

  app.post('/whatsapp/meta', express.raw({ type: 'application/json' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!verifySignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);

    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { return res.sendStatus(400); }

    res.sendStatus(200);

    for (const message of extractMessages(body)) {
      if (!message.from || markSeen(message.id)) continue;
      if (!['text', 'interactive'].includes(message.type)) {
        try {
          await sendWhatsAppText(message.from, 'Please send a text message, or start with MENU to choose a game.');
        } catch (err) {
          console.error('Meta WhatsApp reply failed:', err.message);
        }
        continue;
      }

      try {
        const phone = normalizePhone(message.from);
        const existing = await users.getAsync(phone);
        const command = normalizeInteractiveCommand(message.text);
        const result = handleMessage(existing, command, configStore);
        users.upsert(phone, result.patch || {});
        result.allowedWhotCounts = configStore.get('whot')?.playerCounts || [2, 3, 4];
        await sendInteractiveOrText(message.from, result, existing);
      } catch (err) {
        console.error('Meta WhatsApp message handling failed:', err.message);
      }
    }
  });

  return app;
}

module.exports = {
  createMetaWhatsAppApp,
  sendWhatsAppText,
  sendWhatsAppButtonMessage,
  sendWhatsAppListMessage,
  extractMessages,
  normalizeInteractiveCommand,
  interactiveForState
};
