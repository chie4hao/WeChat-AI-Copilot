const Database = require('better-sqlite3');
const path = require('path');

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

    CREATE TABLE IF NOT EXISTS ai_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      analysis TEXT,
      candidates TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES ai_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS followup_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES ai_sessions(id)
    );
  `);
}

// ── Contacts ────────────────────────────────────────────────

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

function setPendingSuggestion(contactId, value) {
  getDb()
    .prepare('UPDATE contacts SET has_pending_suggestion = ? WHERE id = ?')
    .run(value ? 1 : 0, contactId);
}

// ── Messages ─────────────────────────────────────────────────

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

function getRecentMessages(contactId, limit = 30) {
  return getDb().prepare(`
    SELECT * FROM messages
    WHERE contact_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(contactId, limit).reverse();
}

// ── AI Sessions ──────────────────────────────────────────────

function resetAiSession(contactId) {
  const db = getDb();
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM ai_sessions WHERE contact_id = ?').get(contactId);
  if (existing) {
    db.prepare('DELETE FROM followup_messages WHERE session_id = ?').run(existing.id);
    db.prepare('DELETE FROM ai_rounds WHERE session_id = ?').run(existing.id);
    db.prepare('DELETE FROM ai_sessions WHERE id = ?').run(existing.id);
  }

  db.prepare(`
    INSERT INTO ai_sessions (contact_id, created_at) VALUES (?, ?)
  `).run(contactId, now);

  return db.prepare('SELECT * FROM ai_sessions WHERE contact_id = ?').get(contactId);
}

function getAiSession(contactId) {
  return getDb()
    .prepare('SELECT * FROM ai_sessions WHERE contact_id = ?')
    .get(contactId);
}

// ── AI Rounds（每次生成的分析 + 候选） ──────────────────────

function insertAiRound({ sessionId, analysis, candidates }) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO ai_rounds (session_id, analysis, candidates, created_at)
    VALUES (@sessionId, @analysis, @candidates, @createdAt)
  `).run({
    sessionId,
    analysis: analysis || null,
    candidates: JSON.stringify(candidates),
    createdAt: Date.now(),
  });
  return result.lastInsertRowid;
}

function getAiRounds(sessionId) {
  return getDb()
    .prepare('SELECT * FROM ai_rounds WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId)
    .map(row => ({ ...row, candidates: JSON.parse(row.candidates) }));
}

// ── Followup Messages ────────────────────────────────────────

function insertFollowupMessage({ sessionId, role, content }) {
  getDb().prepare(`
    INSERT INTO followup_messages (session_id, role, content, created_at)
    VALUES (@sessionId, @role, @content, @createdAt)
  `).run({ sessionId, role, content, createdAt: Date.now() });
}

function getFollowupMessages(sessionId) {
  return getDb()
    .prepare('SELECT * FROM followup_messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId);
}

// ── 加载完整 AI Session（供前端切换联系人时使用） ────────────

function getFullAiSession(contactId) {
  const session = getAiSession(contactId);
  if (!session) return null;

  return {
    session,
    rounds: getAiRounds(session.id),
    followups: getFollowupMessages(session.id),
  };
}

module.exports = {
  getDb,
  upsertContact,
  getContacts,
  getContactByWxid,
  setPendingSuggestion,
  insertMessage,
  getRecentMessages,
  resetAiSession,
  getAiSession,
  insertAiRound,
  getAiRounds,
  insertFollowupMessage,
  getFollowupMessages,
  getFullAiSession,
};
