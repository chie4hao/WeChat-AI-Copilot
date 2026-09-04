import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// COPILOT_DB_PATH 供迁移测试指向副本库，平时不设
const DB_PATH = process.env.COPILOT_DB_PATH || path.join(__dirname, '..', 'data.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wxid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      notes TEXT,
      last_message TEXT,
      last_time INTEGER,
      has_pending_suggestion INTEGER DEFAULT 0,
      name_manual INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      wechat_create_time INTEGER,
      local_id INTEGER,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
  `);

  // 旧库迁移（SQLite 不支持 ADD COLUMN IF NOT EXISTS，用 PRAGMA 判断）
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(r => r.name);
  if (!msgCols.includes('wechat_create_time')) db.exec('ALTER TABLE messages ADD COLUMN wechat_create_time INTEGER');
  if (!msgCols.includes('local_id'))           db.exec('ALTER TABLE messages ADD COLUMN local_id INTEGER');
  const contactCols = db.prepare('PRAGMA table_info(contacts)').all().map(r => r.name);
  if (!contactCols.includes('name_manual'))    db.exec('ALTER TABLE contacts ADD COLUMN name_manual INTEGER DEFAULT 0');

  // 去重改为按微信本地消息 id（local_id）。旧的 (contact_id, wechat_create_time) 唯一索引精度只有秒，
  // 同一秒内的多条消息会被它吞掉，必须删掉；没有 local_id 的旧行在 syncMessages 里按"同秒同内容"兜底去重。
  db.exec(`
    DROP INDEX IF EXISTS idx_messages_dedup;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id
      ON messages (contact_id, local_id) WHERE local_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_contact_time
      ON messages (contact_id, wechat_create_time);
    CREATE INDEX IF NOT EXISTS idx_messages_contact_ts
      ON messages (contact_id, timestamp);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    -- type = 'ai_round': content 是 JSON { analysis, candidates[] }
    -- type = 'user':     content 是用户追问的文本
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('ai_round', 'user')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES ai_sessions(id)
    );
  `);

  // 迁移：ai_sessions 增加 cc_session_id（Claude Code provider 的会话 id，服务重启后恢复追问用）
  try {
    db.exec('ALTER TABLE ai_sessions ADD COLUMN cc_session_id TEXT');
  } catch (_) { /* 列已存在 */ }

  // 小型键值表：本地端心跳、最近一次 AI 结果等运行状态，重启后仍能显示"上次见到是什么时候"
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

// ── KV（运行状态） ─────────────────────────────────────────────

function kvGet(key) {
  const row = getDb().prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(key);
  if (!row) return null;
  try { return { value: JSON.parse(row.value), updatedAt: row.updated_at }; } catch { return null; }
}

function kvSet(key, value) {
  getDb().prepare(`
    INSERT INTO kv (key, value, updated_at) VALUES (@key, @value, @updatedAt)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run({ key, value: JSON.stringify(value), updatedAt: Date.now() });
}

// 最近一次 AI 成功生成的时间（ai_round 的 created_at）
function getLastAiSuccessAt() {
  return getDb().prepare("SELECT MAX(created_at) t FROM ai_messages WHERE type = 'ai_round'").get()?.t ?? null;
}

// 最近一条同步进来的消息时间 & sinceMs 以来入库条数（只算本地端同步的，按微信时间戳）
function getSyncStats(sinceMs) {
  const db = getDb();
  const last = db.prepare('SELECT MAX(timestamp) t FROM messages WHERE local_id IS NOT NULL OR wechat_create_time IS NOT NULL').get()?.t ?? null;
  const count = db.prepare('SELECT COUNT(*) c FROM messages WHERE (local_id IS NOT NULL OR wechat_create_time IS NOT NULL) AND timestamp >= ?').get(sinceMs)?.c ?? 0;
  return { lastMessageAt: last, insertedSince: count };
}

// ── Contacts ─────────────────────────────────────────────────

// 新建时 last_time 留空：由第一条消息（哪怕是同步来的旧消息）来填，否则同步历史时预览永远填不上
function upsertContact({ wxid, name, avatar }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO contacts (wxid, name, avatar)
    VALUES (@wxid, @name, @avatar)
    ON CONFLICT(wxid) DO UPDATE SET
      name   = CASE WHEN name_manual = 1 THEN name ELSE excluded.name END,
      avatar = COALESCE(excluded.avatar, avatar)
  `).run({ wxid, name, avatar: avatar || null });

  return db.prepare('SELECT * FROM contacts WHERE wxid = ?').get(wxid);
}

// 手动新建的联系人没有消息，把它顶到列表最上面
function touchContact(contactId) {
  getDb().prepare('UPDATE contacts SET last_time = ? WHERE id = ?').run(Date.now(), contactId);
}

function getContacts() {
  return getDb()
    .prepare('SELECT * FROM contacts ORDER BY last_time DESC')
    .all();
}

function getContactByWxid(wxid) {
  return getDb()
    .prepare('SELECT * FROM contacts WHERE wxid = ?')
    .get(wxid);
}

function getContactById(id) {
  return getDb()
    .prepare('SELECT * FROM contacts WHERE id = ?')
    .get(id);
}

function updateContactNotes(contactId, notes) {
  getDb()
    .prepare('UPDATE contacts SET notes = ? WHERE id = ?')
    .run(notes || null, contactId);
}

function setPendingSuggestion(contactId, value) {
  getDb()
    .prepare('UPDATE contacts SET has_pending_suggestion = ? WHERE id = ?')
    .run(value ? 1 : 0, contactId);
}

// 手动改名后置 name_manual=1，之后本地端同步上来的微信昵称不再覆盖它
function updateContactName(contactId, name) {
  getDb()
    .prepare('UPDATE contacts SET name = ?, name_manual = 1 WHERE id = ?')
    .run(name, contactId);
}

function clearMessages(contactId) {
  getDb()
    .prepare('DELETE FROM messages WHERE contact_id = ?')
    .run(contactId);
  getDb()
    .prepare('UPDATE contacts SET last_message = NULL, last_time = ? WHERE id = ?')
    .run(Date.now(), contactId);
}

function deleteContact(contactId) {
  const db = getDb();
  // 级联删除：ai_messages → ai_sessions → messages → contact
  const session = db.prepare('SELECT id FROM ai_sessions WHERE contact_id = ?').get(contactId);
  if (session) {
    db.prepare('DELETE FROM ai_messages WHERE session_id = ?').run(session.id);
    db.prepare('DELETE FROM ai_sessions WHERE id = ?').run(session.id);
  }
  db.prepare('DELETE FROM messages WHERE contact_id = ?').run(contactId);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
}

// ── Messages ──────────────────────────────────────────────────

function insertMessage({ contactId, content, isSelf, timestamp, type = 'text' }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO messages (contact_id, content, is_self, timestamp, type)
    VALUES (@contactId, @content, @isSelf, @timestamp, @type)
  `).run({ contactId, content, isSelf: isSelf ? 1 : 0, timestamp, type });

  db.prepare(`
    UPDATE contacts SET last_message = @content, last_time = @timestamp WHERE id = @contactId
  `).run({ content, timestamp, contactId });

  return result.lastInsertRowid;
}

/**
 * 批量同步来自本地端的消息，自动去重。
 * messages 格式: [{ localId?, content, isSelf, createTime(Unix秒), renderType }]
 * 返回 { inserted, rows }，rows 是实际新插入的行（供广播给前端）。
 *
 * 去重规则：
 *   - 带 localId：库里已有同 local_id 的行，或有"无 local_id 且同秒同内容"的旧行 → 跳过
 *   - 不带 localId（旧版本地端）：库里已有同秒同内容的行 → 跳过
 * 微信时间戳精度只有秒，所以不能单靠它去重，否则同一秒内的多条消息会丢。
 */
function syncMessages({ contactId, messages }) {
  const db = getDb();

  const insert = db.prepare(`
    INSERT INTO messages (contact_id, content, is_self, timestamp, type, wechat_create_time, local_id)
    SELECT @contactId, @content, @isSelf, @timestamp, @type, @wechatCreateTime, @localId
    WHERE NOT EXISTS (
      SELECT 1 FROM messages
      WHERE contact_id = @contactId
        AND (
          (@localId IS NOT NULL AND local_id = @localId)
          OR ((local_id IS NULL OR @localId IS NULL)
              AND wechat_create_time = @wechatCreateTime AND content = @content)
        )
    )
  `);

  // 只用更新的消息刷新预览，补传的旧消息不会把预览和排序拉回去
  const updateContact = db.prepare(`
    UPDATE contacts SET last_message = @content, last_time = @timestamp
    WHERE id = @contactId AND (last_time IS NULL OR last_time <= @timestamp)
  `);

  const rows = [];
  const insertMany = db.transaction((msgs) => {
    for (const m of msgs) {
      const timestamp = m.createTime * 1000;
      const type = m.renderType || 'text';
      const content = m.content || '';
      const isSelf = m.isSelf ? 1 : 0;
      const localId = Number.isInteger(m.localId) ? m.localId : null;
      const result = insert.run({ contactId, content, isSelf, timestamp, type, wechatCreateTime: m.createTime, localId });
      if (result.changes > 0) {
        rows.push({ id: Number(result.lastInsertRowid), contact_id: contactId, content, is_self: isSelf, timestamp, type });
      }
    }
    if (rows.length) {
      const newest = rows.reduce((a, b) => (b.timestamp >= a.timestamp ? b : a));
      updateContact.run({ content: newest.content, timestamp: newest.timestamp, contactId });
    }
  });

  insertMany(messages);
  return { inserted: rows.length, rows };
}

function deleteMessage(messageId) {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(messageId);
}

function updateMessage(messageId, { content, isSelf }) {
  const db = getDb();
  if (content !== undefined) db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
  if (isSelf !== undefined)  db.prepare('UPDATE messages SET is_self = ? WHERE id = ?').run(isSelf ? 1 : 0, messageId);
}

function getRecentMessages(contactId, limit = 350) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE contact_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(contactId, limit).reverse();
}

// 复盘用：取截止到某条消息（含）的最近 limit 条，找不到该消息返回 null
function getMessagesUpTo(contactId, messageId, limit = 350) {
  const target = getDb()
    .prepare('SELECT * FROM messages WHERE id = ? AND contact_id = ?')
    .get(messageId, contactId);
  if (!target) return null;

  return getDb().prepare(`
    SELECT * FROM messages
    WHERE contact_id = ?
      AND (timestamp < ? OR (timestamp = ? AND id <= ?))
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(contactId, target.timestamp, target.timestamp, target.id, limit).reverse();
}

// ── AI Sessions ───────────────────────────────────────────────

function resetAiSession(contactId) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM ai_sessions WHERE contact_id = ?').get(contactId);
  if (existing) {
    db.prepare('DELETE FROM ai_messages WHERE session_id = ?').run(existing.id);
    db.prepare('DELETE FROM ai_sessions WHERE id = ?').run(existing.id);
  }

  db.prepare('INSERT INTO ai_sessions (contact_id, created_at) VALUES (?, ?)').run(contactId, Date.now());
  return db.prepare('SELECT * FROM ai_sessions WHERE contact_id = ?').get(contactId);
}

function getAiSession(contactId) {
  return getDb()
    .prepare('SELECT * FROM ai_sessions WHERE contact_id = ?')
    .get(contactId);
}

// Claude Code provider：记录其内部会话 id，服务重启后可 resume 继续追问
function setCcSessionId(contactId, ccSessionId) {
  getDb()
    .prepare('UPDATE ai_sessions SET cc_session_id = ? WHERE contact_id = ?')
    .run(ccSessionId || null, contactId);
}

// ── AI Messages ───────────────────────────────────────────────

function insertAiRound({ sessionId, analysis, candidates }) {
  getDb().prepare(`
    INSERT INTO ai_messages (session_id, type, content, created_at)
    VALUES (?, 'ai_round', ?, ?)
  `).run(sessionId, JSON.stringify({ analysis: analysis || null, candidates }), Date.now());
}

function insertUserFollowup({ sessionId, content }) {
  getDb().prepare(`
    INSERT INTO ai_messages (session_id, type, content, created_at)
    VALUES (?, 'user', ?, ?)
  `).run(sessionId, content, Date.now());
}

function getAiMessages(sessionId) {
  return getDb()
    .prepare('SELECT * FROM ai_messages WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId)
    .map(row => {
      if (row.type === 'ai_round') {
        return { ...row, content: JSON.parse(row.content) };
      }
      return row;
    });
}

// ── 完整 AI Session（供前端切换联系人时加载） ─────────────────

function getFullAiSession(contactId) {
  const session = getAiSession(contactId);
  if (!session) return null;
  return {
    session,
    messages: getAiMessages(session.id),
  };
}

// ── Push Subscriptions ────────────────────────────────────────

function savePushSubscription({ endpoint, p256dh, auth }) {
  getDb().prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
    VALUES (@endpoint, @p256dh, @auth, @createdAt)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).run({ endpoint, p256dh, auth, createdAt: Date.now() });
}

function removePushSubscription(endpoint) {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function getAllPushSubscriptions() {
  return getDb().prepare('SELECT * FROM push_subscriptions').all();
}

export {
  getDb,
  upsertContact,
  touchContact,
  getContacts,
  getContactByWxid,
  getContactById,
  updateContactNotes,
  updateContactName,
  setPendingSuggestion,
  clearMessages,
  deleteContact,
  insertMessage,
  syncMessages,
  deleteMessage,
  updateMessage,
  getRecentMessages,
  getMessagesUpTo,
  resetAiSession,
  getAiSession,
  setCcSessionId,
  insertAiRound,
  insertUserFollowup,
  getAiMessages,
  getFullAiSession,
  savePushSubscription,
  removePushSubscription,
  getAllPushSubscriptions,
  kvGet,
  kvSet,
  getLastAiSuccessAt,
  getSyncStats,
};
