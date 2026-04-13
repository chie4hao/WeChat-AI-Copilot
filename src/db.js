import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data.db');

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
      has_pending_suggestion INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      is_self INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      wechat_create_time INTEGER,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    -- 用于去重：同一联系人同一微信时间戳只存一次
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
      ON messages (contact_id, wechat_create_time)
      WHERE wechat_create_time IS NOT NULL;

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
}

// ── Contacts ─────────────────────────────────────────────────

function upsertContact({ wxid, name, avatar }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO contacts (wxid, name, avatar, last_time)
    VALUES (@wxid, @name, @avatar, @last_time)
    ON CONFLICT(wxid) DO UPDATE SET
      avatar = COALESCE(excluded.avatar, avatar)
  `).run({ wxid, name, avatar: avatar || null, last_time: Date.now() });

  return db.prepare('SELECT * FROM contacts WHERE wxid = ?').get(wxid);
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

function updateContactName(contactId, name) {
  getDb()
    .prepare('UPDATE contacts SET name = ? WHERE id = ?')
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
 * messages 格式: [{ content, isSelf, createTime(Unix秒), renderType }]
 * 返回实际新插入的数量。
 */
function syncMessages({ contactId, messages }) {
  const db = getDb();

  // 迁移旧库：补加 wechat_create_time 列（若不存在）
  const cols = db.prepare('PRAGMA table_info(messages)').all().map(r => r.name);
  if (!cols.includes('wechat_create_time')) {
    db.exec('ALTER TABLE messages ADD COLUMN wechat_create_time INTEGER');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
        ON messages (contact_id, wechat_create_time)
        WHERE wechat_create_time IS NOT NULL
    `);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages (contact_id, content, is_self, timestamp, type, wechat_create_time)
    VALUES (@contactId, @content, @isSelf, @timestamp, @type, @wechatCreateTime)
  `);

  const updateContact = db.prepare(`
    UPDATE contacts SET last_message = @content, last_time = @timestamp WHERE id = @contactId
  `);

  let inserted = 0;
  const insertMany = db.transaction((msgs) => {
    for (const m of msgs) {
      const timestampMs = m.createTime * 1000;
      const result = insert.run({
        contactId,
        content: m.content || '',
        isSelf: m.isSelf ? 1 : 0,
        timestamp: timestampMs,
        type: m.renderType === 'text' ? 'text' : m.renderType,
        wechatCreateTime: m.createTime,
      });
      if (result.changes > 0) inserted++;
    }
    // 用最后一条消息更新联系人预览
    const last = msgs[msgs.length - 1];
    if (last) {
      updateContact.run({ content: last.content || '', timestamp: last.createTime * 1000, contactId });
    }
  });

  insertMany(messages);
  return inserted;
}

function deleteMessage(messageId) {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(messageId);
}

function updateMessage(messageId, { content, isSelf }) {
  const db = getDb();
  if (content !== undefined) db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
  if (isSelf !== undefined)  db.prepare('UPDATE messages SET is_self = ? WHERE id = ?').run(isSelf ? 1 : 0, messageId);
}

function getRecentMessages(contactId, limit = 200) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE contact_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(contactId, limit).reverse();
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

export {
  getDb,
  upsertContact,
  getContacts,
  getContactByWxid,
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
  resetAiSession,
  getAiSession,
  insertAiRound,
  insertUserFollowup,
  getAiMessages,
  getFullAiSession,
};
