import { createServer as createHttp } from 'http';
import { createServer as createHttps } from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';

import config from './config.js';
import * as db from './db.js';

// 本地端上报的 secret（从 config.yaml 读取）
const syncSecret = config.get().server?.sync_secret ?? '';
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

// ── IP 白名单 ─────────────────────────────────────────────────
const allowedIPs = config.get().server?.allowedIPs;
if (allowedIPs?.length) {
  app.use((req, res, next) => {
    const ip = req.ip.replace(/^::ffff:/, ''); // IPv4-mapped IPv6 → IPv4
    if (allowedIPs.includes(ip)) return next();
    res.status(403).end('Forbidden');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── WebSocket ─────────────────────────────────────────────────

if (allowedIPs?.length) {
  wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!allowedIPs.includes(ip)) {
      ws.close(1008, 'Forbidden');
    }
  });
}

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(json);
  }
}

// ── Pages ─────────────────────────────────────────────────────

app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.get('/settings', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'settings.html')));

app.get('/import', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'import.html')));

// ── API: Contacts ─────────────────────────────────────────────

app.get('/api/contacts', (_req, res) => {
  res.json(db.getContacts());
});

// ── API: Messages ─────────────────────────────────────────────

app.get('/api/contacts/:id/messages', (req, res) => {
  const contactId = Number(req.params.id);
  const limit = Number(req.query.limit) || 200;
  res.json(db.getRecentMessages(contactId, limit));
});

// ── API: Message management ───────────────────────────────────

app.delete('/api/messages/:id', (req, res) => {
  db.deleteMessage(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/messages/:id', (req, res) => {
  const { content, isSelf } = req.body;
  db.updateMessage(Number(req.params.id), { content, isSelf });
  res.json({ ok: true });
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

// ── API: Contact management ───────────────────────────────────

// 新建联系人
app.post('/api/contacts', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const wxid = `manual_${Date.now()}`;
  const contact = db.upsertContact({ wxid, name: name.trim(), avatar: null });
  broadcast({ type: 'contacts_update' });
  res.json(contact);
});

// 修改联系人名称
app.post('/api/contacts/:id/rename', (req, res) => {
  const contactId = Number(req.params.id);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  db.updateContactName(contactId, name.trim());
  broadcast({ type: 'contacts_update' });
  res.json({ ok: true });
});

// 清空聊天记录（保留联系人）
app.post('/api/contacts/:id/clear-messages', (req, res) => {
  const contactId = Number(req.params.id);
  db.clearMessages(contactId);
  broadcast({ type: 'contacts_update' });
  res.json({ ok: true });
});

// 删除联系人（级联删除消息和 AI session）
app.delete('/api/contacts/:id', (req, res) => {
  const contactId = Number(req.params.id);
  db.deleteContact(contactId);
  broadcast({ type: 'contacts_update' });
  res.json({ ok: true });
});

// ── API: Contact Notes ────────────────────────────────────────

app.post('/api/contacts/:id/notes', (req, res) => {
  const contactId = Number(req.params.id);
  const { notes } = req.body;
  db.updateContactNotes(contactId, notes ?? null);
  res.json({ ok: true });
});

// ── API: Import (批量导入聊天记录) ────────────────────────────

app.post('/api/import', (req, res) => {
  const { wxid, otherName, messages } = req.body;
  if (!wxid || !otherName || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'wxid, otherName, messages[] are required' });
  }

  const contact = db.upsertContact({ wxid, name: otherName, avatar: null });
  const now = Date.now();
  let count = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m.content) continue;
    // 优先用解析出的真实时间戳；加 i*100ms 偏移确保同分钟消息顺序正确
    // 没有时间戳时退回到按导入顺序递增的虚拟时间戳
    const base = (typeof m.timestamp === 'number') ? m.timestamp : (now - (messages.length - i) * 1000);
    const timestamp = base + i * 100;
    db.insertMessage({
      contactId: contact.id,
      content: m.content,
      isSelf: m.isSelf,
      timestamp,
      type: 'text',
    });
    count++;
  }

  broadcast({ type: 'contacts_update' });
  res.json({ ok: true, count, contactId: contact.id });
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

// ── API: Sync（本地端上报） ───────────────────────────────────

app.post('/api/sync', (req, res) => {
  // 验证 secret
  if (syncSecret && req.headers['x-secret'] !== syncSecret) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { wxid, name, messages, skipAi = false } = req.body;
  if (!wxid || !name || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'wxid, name, messages[] are required' });
  }

  // 本地端已将图片/语音转换为文字描述，这里只过滤掉空内容的消息
  const textMessages = messages.filter(m => m.content?.trim());
  if (textMessages.length === 0) {
    return res.json({ ok: true, inserted: 0, triggered: false });
  }

  // 写入数据库（自动去重）
  const contact = db.upsertContact({ wxid, name, avatar: null });
  const inserted = db.syncMessages({ contactId: contact.id, messages: textMessages });

  broadcast({ type: 'contacts_update' });

  // 有新消息且最新一条是对方发的，触发 AI
  const hasNewIncoming = !skipAi && inserted > 0 && !textMessages[textMessages.length - 1].isSelf;
  if (hasNewIncoming) {
    const fresh = db.getContactByWxid(wxid);
    res.json({ ok: true, inserted, triggered: true });
    triggerAi(fresh);
  } else {
    res.json({ ok: true, inserted, triggered: false });
  }
});

// ── API: Settings ─────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(config.get());
});

app.post('/api/settings', (req, res) => {
  // 保留前端不管的服务器字段，防止覆盖时丢失
  const current = config.get();
  const incoming = req.body;
  if (current.server) {
    incoming.server = Object.assign({}, current.server, incoming.server);
  }
  config.save(incoming);
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
  const chatHistory = db.getRecentMessages(contact.id);
  const session = db.resetAiSession(contact.id);

  broadcast({ type: 'ai_start', contactId: contact.id, fresh: true });

  try {
    await ai.generateSuggestions(contact.id, chatHistory, {
      onChunk:    (chunk) => broadcast({ type: 'ai_chunk', contactId: contact.id, chunk }),
      onComplete: (result) => {
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
