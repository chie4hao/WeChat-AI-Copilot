import { createServer as createHttp } from 'http';
import { createServer as createHttps } from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';

import config from './config.js';
import * as db from './db.js';
import * as ai from './ai.js';
import wechat from './wechat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const { certPath, keyPath } = config.get().server ?? {};
const isHttps = !!(certPath && keyPath);
const server = isHttps
  ? createHttps({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : createHttp(app);

const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── WebSocket ─────────────────────────────────────────────────

function broadcast(data) {
  const json = JSON.stringify(data);
  const count = [...wss.clients].filter(c => c.readyState === 1).length;
  console.log(`[broadcast] type=${data.type} clients=${count}`);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(json);
  }
}

// ── Pages ─────────────────────────────────────────────────────

app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.get('/settings', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html')));

// ── API: Contacts ─────────────────────────────────────────────

app.get('/api/contacts', (_req, res) => {
  res.json(db.getContacts());
});

// ── API: Messages ─────────────────────────────────────────────

app.get('/api/contacts/:id/messages', (req, res) => {
  const contactId = Number(req.params.id);
  const limit = Number(req.query.limit) || 30;
  res.json(db.getRecentMessages(contactId, limit));
});

// ── API: AI Session ───────────────────────────────────────────

app.get('/api/contacts/:id/ai-session', (req, res) => {
  const contactId = Number(req.params.id);
  res.json(db.getFullAiSession(contactId));
});

// ── API: Follow-up ────────────────────────────────────────────

app.post('/api/contacts/:id/followup', (req, res) => {
  const contactId = Number(req.params.id);
  const { text } = req.body;

  if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

  const session = db.getAiSession(contactId);
  if (!session) return res.status(400).json({ error: 'No active AI session. Please trigger AI generation first.' });

  db.insertUserFollowup({ sessionId: session.id, content: text });
  res.json({ ok: true });

  broadcast({ type: 'ai_start', contactId });
  ai.followUp(contactId, text, {
    onChunk:    (chunk) => broadcast({ type: 'ai_chunk', contactId, chunk }),
    onComplete: (result) => {
      db.insertAiRound({ sessionId: session.id, analysis: result.message, candidates: result.candidates });
      db.setPendingSuggestion(contactId, true);
      broadcast({ type: 'ai_complete', contactId, result });
      broadcast({ type: 'contacts_update' });
    },
    onError: (err) => broadcast({ type: 'ai_error', contactId, error: err.message }),
  });
});

// ── API: Clear pending suggestion ─────────────────────────────

app.post('/api/contacts/:id/read', (req, res) => {
  const contactId = Number(req.params.id);
  db.setPendingSuggestion(contactId, false);
  res.json({ ok: true });
});

// ── API: Contact Notes ────────────────────────────────────────

app.post('/api/contacts/:id/notes', (req, res) => {
  const contactId = Number(req.params.id);
  const { notes } = req.body;
  db.updateContactNotes(contactId, notes ?? null);
  res.json({ ok: true });
});

// ── API: Mock ─────────────────────────────────────────────────

// 注入单条消息
app.post('/api/mock/message', (req, res) => {
  const { wxid, name, content, isSelf = false, noAi = false } = req.body;
  if (!wxid || !name || !content) {
    return res.status(400).json({ error: 'wxid, name, content are required' });
  }

  if (noAi) {
    // 仅存库广播，不触发 AI
    const contact = db.upsertContact({ wxid, name, avatar: null });
    const timestamp = Date.now();
    const msgId = db.insertMessage({ contactId: contact.id, content, isSelf, timestamp, type: 'text' });
    broadcast({
      type: 'message', contactId: contact.id,
      message: { id: msgId, contact_id: contact.id, content, is_self: isSelf ? 1 : 0, timestamp, type: 'text' },
    });
    broadcast({ type: 'contacts_update' });
  } else {
    // 完整走一遍逻辑（触发 wechat 'message' 事件）
    wechat.receive({ wxid, name, content, isSelf });
  }

  res.json({ ok: true });
});

// 手动为某个联系人触发 AI 生成（不注入新消息，直接用现有聊天记录）
app.post('/api/mock/trigger', (req, res) => {
  const { contactId } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });

  const contacts = db.getContacts();
  const contact = contacts.find(c => c.id === Number(contactId));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  res.json({ ok: true });
  triggerAi(contact);
});

// ── API: Settings ─────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(config.get());
});

app.post('/api/settings', (req, res) => {
  config.save(req.body);
  res.json({ ok: true });
});

// ── Core: WeChat message handler ──────────────────────────────

wechat.on('message', (msg) => {
  const contact = db.upsertContact({ wxid: msg.wxid, name: msg.name, avatar: null });

  const msgId = db.insertMessage({
    contactId: contact.id,
    content:   msg.content,
    isSelf:    msg.isSelf,
    timestamp: msg.timestamp,
    type:      msg.type,
  });

  broadcast({
    type:      'message',
    contactId: contact.id,
    message: {
      id:         msgId,
      contact_id: contact.id,
      content:    msg.content,
      is_self:    msg.isSelf ? 1 : 0,
      timestamp:  msg.timestamp,
      type:       msg.type,
    },
  });
  broadcast({ type: 'contacts_update' });

  if (!msg.isSelf) {
    // 重新从 db 取以获得最新的 notes 字段
    const fresh = db.getContactByWxid(msg.wxid);
    triggerAi(fresh);
  }
});

async function triggerAi(contact) {
  console.log(`[triggerAi] contactId=${contact.id} name=${contact.name}`);
  const chatHistory = db.getRecentMessages(contact.id);
  console.log(`[triggerAi] chatHistory length=${chatHistory.length}`);
  const session = db.resetAiSession(contact.id);

  broadcast({ type: 'ai_start', contactId: contact.id });

  try {
    await ai.generateSuggestions(contact.id, chatHistory, {
      onChunk:    (chunk) => broadcast({ type: 'ai_chunk', contactId: contact.id, chunk }),
      onComplete: (result) => {
        console.log(`[triggerAi] complete, candidates=${result.candidates?.length}`);
        db.insertAiRound({ sessionId: session.id, analysis: result.message, candidates: result.candidates });
        db.setPendingSuggestion(contact.id, true);
        broadcast({ type: 'ai_complete', contactId: contact.id, result });
        broadcast({ type: 'contacts_update' });
      },
      onError: (err) => {
        console.error('[triggerAi] AI error:', err.message);
        broadcast({ type: 'ai_error', contactId: contact.id, error: err.message });
      },
    }, contact.notes || '');
  } catch (err) {
    console.error('[triggerAi] 未捕获异常:', err);
    broadcast({ type: 'ai_error', contactId: contact.id, error: err.message });
  }
}

// ── Start ─────────────────────────────────────────────────────

const PORT = config.get().server?.port ?? 3000;
server.listen(PORT, () => {
  const proto = isHttps ? 'https' : 'http';
  console.log(`[server] 已启动：${proto}://localhost:${PORT}`);
  wechat.start();
});
