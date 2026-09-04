import { createServer as createHttp } from 'http';
import { createServer as createHttps } from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';

import webpush from 'web-push';
import config from './config.js';
import * as db from './db.js';

// 本地端上报的 secret（从 config.yaml 读取）
const syncSecret = config.get().server?.sync_secret ?? '';

// ── Web Push VAPID 初始化 ─────────────────────────────────────
const vapidPublicKey  = config.get().server?.vapid_public_key ?? '';
const vapidPrivateKey = config.get().server?.vapid_private_key ?? '';
const vapidSubject    = config.get().server?.vapid_subject ?? 'mailto:admin@example.com';
if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  console.log('[push] Web Push 已启用');
} else {
  console.log('[push] 未配置 VAPID 密钥，推送通知不可用');
}
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

// 默认上限 100kb；本地端全量同步一批 200 条带图片描述的消息就会超过，放宽
app.use(express.json({ limit: '20mb' }));

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
  const limit = Number(req.query.limit) || 350;
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

// 预览即将发给 AI 的完整内容（调试用，不实际请求 AI）
// 可选 ?upto=<messageId>：只取截止到该消息（含）的记录，配合复盘功能
app.get('/api/contacts/:id/ai-preview', (req, res) => {
  const contactId = Number(req.params.id);
  const contact = db.getContactById(contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const upto = Number(req.query.upto) || 0;
  const chatHistory = upto
    ? db.getMessagesUpTo(contactId, upto)
    : db.getRecentMessages(contactId);
  if (!chatHistory) return res.status(404).json({ error: 'Message not found' });
  res.json(ai.buildAiPreview(chatHistory, contact.notes || '', contact.name));
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
  const { contactId, uptoMessageId } = req.body;
  if (!contactId) return res.status(400).json({ error: 'contactId is required' });

  const contacts = db.getContacts();
  const contact = contacts.find(c => c.id === Number(contactId));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  // 复盘模式：以历史某条消息为最后一条，验证消息存在后把截断的记录传给 triggerAi
  let chatHistory = null;
  if (uptoMessageId) {
    chatHistory = db.getMessagesUpTo(contact.id, Number(uptoMessageId));
    if (!chatHistory?.length) return res.status(404).json({ error: 'Message not found' });
  }

  res.json({ ok: true });
  triggerAi(contact, { force: true, chatHistory }); // 手动触发无视名单
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

  // 写入数据库（按 localId 去重）
  const contact = db.upsertContact({ wxid, name, avatar: null });
  const { inserted, rows } = db.syncMessages({ contactId: contact.id, messages: textMessages });

  broadcast({ type: 'contacts_update' });
  // 让打开着的聊天窗口实时出现新消息：少量逐条推，大批量（全量同步）让前端整体重拉
  if (rows.length && rows.length <= 50) {
    for (const row of rows) broadcast({ type: 'message', contactId: contact.id, message: row });
  } else if (rows.length) {
    broadcast({ type: 'messages_reload', contactId: contact.id });
  }

  // 最后一条"真实"消息是对方发的才触发 AI：撤回提示等 system 类型 isSelf 也是 false，要跳过
  // 注意：全量同步后触发消息会被去重（inserted=0），但仍需触发 AI，所以不检查 inserted
  const lastReal = [...textMessages].reverse().find(m => m.renderType !== 'system');
  const hasNewIncoming = !skipAi && !!lastReal && !lastReal.isSelf;
  if (hasNewIncoming) {
    const fresh = db.getContactByWxid(wxid);
    res.json({ ok: true, inserted, triggered: true });
    triggerAi(fresh);
  } else {
    res.json({ ok: true, inserted, triggered: false });
  }
});

// ── API: Push Subscription ────────────────────────────────────

app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ key: vapidPublicKey || null });
});

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint and keys are required' });
  }
  db.savePushSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) db.removePushSubscription(endpoint);
  res.json({ ok: true });
});

// ── API: Settings ─────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(config.get());
});

// 当前实际生效的 AI provider（设置页顶部状态条）
app.get('/api/provider-status', (_req, res) => {
  res.json(ai.getProviderStatus());
});

// 设置页"测试连接"：按已保存的配置向当前生效的通道发一条最小请求
app.post('/api/provider-test', async (_req, res) => {
  res.json(await ai.testProvider());
});

app.post('/api/settings', (req, res) => {
  // 保留前端不管的服务器字段，防止覆盖时丢失
  const current = config.get();
  const incoming = req.body;
  if (current.server) {
    incoming.server = Object.assign({}, current.server, incoming.server);
  }
  // claude_code 同理合并（oauth_token 等字段留空时不丢失）
  if (current.claude_code) {
    incoming.claude_code = Object.assign({}, current.claude_code, incoming.claude_code);
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

async function sendPushNotifications(contactId, contactName, firstCandidate) {
  if (!vapidPublicKey || !vapidPrivateKey) return;
  const subscriptions = db.getAllPushSubscriptions();
  if (!subscriptions.length) return;

  const payload = JSON.stringify({
    title: `${contactName} — AI 建议`,
    body: firstCandidate ? firstCandidate.slice(0, 100) : 'AI 建议已生成',
    contactId,
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // 订阅已过期，清除
        db.removePushSubscription(sub.endpoint);
      } else {
        console.error('[push] 发送失败:', err.message);
      }
    }
  }
}

// force=true 时无视名单强制触发（手动点"获取建议"），收到消息自动触发时 force=false
// chatHistory 传入时直接使用（复盘模式的截断记录），否则取最近记录
async function triggerAi(contact, { force = false, chatHistory = null } = {}) {
  if (!force) {
    const cfg = config.get();
    const nameLower = contact.name.toLowerCase();
    const matchName = (s) => nameLower.includes(String(s).toLowerCase());

    // 过滤名单（黑名单）：命中则跳过
    const skipNames = cfg.skip_names || [];
    if (skipNames.some(matchName)) {
      console.log(`[triggerAi] 跳过 ${contact.name}（在过滤名单中）`);
      return;
    }

    // 只触发名单（白名单）：非空时，只有命中才触发；为空则放行全部
    const onlyNames = cfg.only_names || [];
    if (onlyNames.length && !onlyNames.some(matchName)) {
      console.log(`[triggerAi] 跳过 ${contact.name}（不在只触发名单中）`);
      return;
    }
  }

  const history = chatHistory ?? db.getRecentMessages(contact.id);
  const session = db.resetAiSession(contact.id);

  broadcast({ type: 'ai_start', contactId: contact.id, fresh: true });

  try {
    await ai.generateSuggestions(contact.id, history, {
      onChunk:    (chunk) => broadcast({ type: 'ai_chunk', contactId: contact.id, chunk }),
      onComplete: (result) => {
        // 检查 session 是否仍然有效（快速连续消息时可能已被新的 triggerAi 重置）
        const current = db.getAiSession(contact.id);
        if (!current || current.id !== session.id) return;

        db.insertAiRound({ sessionId: session.id, analysis: result.message, candidates: result.candidates });
        db.setPendingSuggestion(contact.id, true);
        broadcast({ type: 'ai_complete', contactId: contact.id, result });
        broadcast({ type: 'contacts_update' });
        sendPushNotifications(contact.id, contact.name, result.candidates?.[0]);
      },
      onError: (err) => {
        console.error('[triggerAi] AI error:', err.message);
        broadcast({ type: 'ai_error', contactId: contact.id, error: err.message });
      },
    }, contact.notes || '', contact.name);
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
