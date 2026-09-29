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

async function sendWhatsAppText(to, text, fetchImpl = global.fetch) {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    throw new Error('Meta WhatsApp Cloud API is not configured');
  }
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
      type: 'text',
      text: { preview_url: false, body: String(text || '') }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Meta WhatsApp send failed: ${res.status} ${body}`);
  }
  return res.json().catch(() => null);
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
          text: message.type === 'text' ? message.text?.body || '' : ''
        });
      }
    }
  }
  return out;
}

function markSeen(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, ts] of seenMessages) if (now - ts > 10 * 60 * 1000) seenMessages.delete(key);
  if (seenMessages.has(id)) return true;
  seenMessages.set(id, now);
  return false;
}

function createMetaWhatsAppApp({ users }) {
  const app = express();

  app.get('/whatsapp/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) return res.status(200).send(String(challenge || ''));
    return res.sendStatus(403);
  });

  app.post('/whatsapp/meta', express.raw({ type: 'application/json' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (!verifySignature(raw, req.get('x-hub-signature-256'))) return res.sendStatus(401);

    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { return res.sendStatus(400); }

    // Acknowledge fast so Meta does not retry the event while we process it.
    res.sendStatus(200);

    for (const message of extractMessages(body)) {
      if (!message.from || markSeen(message.id)) continue;
      if (message.type !== 'text') {
        try { await sendWhatsAppText(message.from, 'Please send a text message so I can help you register and start playing.'); }
        catch (err) { console.error('Meta WhatsApp reply failed:', err.message); }
        continue;
      }

      try {
        const phone = normalizePhone(message.from);
        const existing = await users.getAsync(phone);
        const { reply, patch } = handleMessage(existing, message.text);
        users.upsert(phone, patch);
        await sendWhatsAppText(message.from, reply);
      } catch (err) {
        console.error('Meta WhatsApp message handling failed:', err.message);
      }
    }
  });

  return app;
}

module.exports = { createMetaWhatsAppApp, sendWhatsAppText, extractMessages };
