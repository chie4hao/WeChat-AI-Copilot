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
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
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
}

// ── Contacts ─────────────────────────────────────────────────

function upsertContact({ wxid, name, avatar }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO contacts (wxid, name, avatar, last_time)
    VALUES (@wxid, @name, @avatar, @last_time)
    ON CONFLICT(wxid) DO UPDATE SET
      name = excluded.name,
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
