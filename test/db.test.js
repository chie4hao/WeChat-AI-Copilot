import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempEnv } from './helpers.js';

setupTempEnv();

// 1. 先用旧版 schema 建库并塞旧数据（无 local_id、有按秒的唯一索引），模拟线上老库
const Database = (await import('better-sqlite3')).default;
{
  const old = new Database(process.env.COPILOT_DB_PATH);
  old.exec(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, wxid TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT, notes TEXT, last_message TEXT, last_time INTEGER, has_pending_suggestion INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, content TEXT NOT NULL, is_self INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'text', wechat_create_time INTEGER, local_id INTEGER, FOREIGN KEY (contact_id) REFERENCES contacts(id));
    CREATE UNIQUE INDEX idx_messages_dedup ON messages (contact_id, wechat_create_time) WHERE wechat_create_time IS NOT NULL;
    CREATE UNIQUE INDEX idx_messages_local_id ON messages (contact_id, local_id) WHERE local_id IS NOT NULL;
    CREATE TABLE ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('ai_round','user')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO contacts (wxid, name, last_time) VALUES ('wxid_a', 'Alice', 101000);
    INSERT INTO messages (contact_id, content, is_self, timestamp, type, wechat_create_time) VALUES (1, 'a', 0, 100000, 'text', 100), (1, 'b', 1, 101000, 'text', 101);
  `);
  old.close();
}

// 2. 新代码打开 → 自动迁移
const db = await import('../src/db.js');
const raw = db.getDb();

test('旧库迁移：删掉按秒唯一索引，补上 local_id / name_manual / cc_session_id / kv', () => {
  const idx = raw.prepare('PRAGMA index_list(messages)').all().map(r => r.name);
  assert.ok(!idx.includes('idx_messages_dedup'), '旧索引应被删除');
  assert.ok(!idx.includes('idx_messages_local_id'), '跨库会重置 localId，旧唯一索引应删除');
  assert.ok(idx.includes('idx_messages_key'));
  assert.ok(raw.prepare('PRAGMA table_info(messages)').all().some(r => r.name === 'local_id'));
  assert.ok(raw.prepare('PRAGMA table_info(contacts)').all().some(r => r.name === 'name_manual'));
  assert.ok(raw.prepare('PRAGMA table_info(ai_sessions)').all().some(r => r.name === 'cc_session_id'));
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get());
});

const contactId = db.getContactByWxid('wxid_a').id;
const msg = (localId, createTime, content, isSelf = false, renderType = 'text') => ({ localId, createTime, content, isSelf, renderType });

test('syncMessages：旧行按同秒同内容去重', () => {
  const r = db.syncMessages({ contactId, messages: [msg(1, 100, 'a'), msg(2, 101, 'b', true)] });
  assert.equal(r.inserted, 0);
});

test('syncMessages：同一秒两条不同消息都入库，同 localId 重发不重复', () => {
  let r = db.syncMessages({ contactId, messages: [msg(3, 102, 'c'), msg(4, 102, 'd')] });
  assert.equal(r.inserted, 2);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows[0].id > 0 && r.rows[0].contact_id === contactId);
  r = db.syncMessages({ contactId, messages: [msg(3, 102, 'c')] });
  assert.equal(r.inserted, 0);
});

test('syncMessages：没有 localId 的旧版本地端消息按同秒同内容去重', () => {
  const r = db.syncMessages({ contactId, messages: [{ createTime: 102, content: 'd', isSelf: false, renderType: 'text' }] });
  assert.equal(r.inserted, 0);
});

test('syncMessages：预览只用更新的消息刷新，补传旧消息不回退', () => {
  db.syncMessages({ contactId, messages: [msg(5, 103, 'e', true)] });
  let c = db.getContactByWxid('wxid_a');
  assert.equal(c.last_message, 'e');
  assert.equal(c.last_time, 103000);
  const r = db.syncMessages({ contactId, messages: [msg(6, 50, 'old', false, 'image')] });
  assert.equal(r.inserted, 1);
  c = db.getContactByWxid('wxid_a');
  assert.equal(c.last_message, 'e');
});

test('getRecentMessages 按时间排序并保留 renderType', () => {
  const all = db.getRecentMessages(contactId);
  assert.equal(all.length, 6);
  assert.equal(all[0].content, 'old');
  assert.equal(all[0].type, 'image');
  assert.equal(all[5].content, 'e');
});

test('手动改名后同步不再覆盖；未改名的照常更新', () => {
  db.updateContactName(contactId, 'Bob');
  db.upsertContact({ wxid: 'wxid_a', name: 'Alice-remark', avatar: null });
  assert.equal(db.getContactByWxid('wxid_a').name, 'Bob');
  db.upsertContact({ wxid: 'wxid_new', name: 'New', avatar: null });
  db.upsertContact({ wxid: 'wxid_new', name: 'New2', avatar: null });
  assert.equal(db.getContactByWxid('wxid_new').name, 'New2');
});

test('kv 与统计', () => {
  assert.equal(db.kvGet('nope'), null);
  db.kvSet('k', { a: 1 });
  assert.deepEqual(db.kvGet('k').value, { a: 1 });
  db.kvSet('k', [1, 2]);
  assert.deepEqual(db.kvGet('k').value, [1, 2]);
  const stats = db.getSyncStats(0);
  assert.equal(stats.lastMessageAt, 103000);
  assert.equal(stats.insertedSince, 6);
  assert.equal(db.getLastAiSuccessAt(), null);
  const s = db.resetAiSession(contactId);
  db.insertAiRound({ sessionId: s.id, analysis: 'x', candidates: ['y'] });
  assert.ok(db.getLastAiSuccessAt() > 0);
});

test('getMessagesUpTo 复盘截断', () => {
  const all = db.getRecentMessages(contactId);
  const mid = all[2];
  const upto = db.getMessagesUpTo(contactId, mid.id);
  assert.equal(upto.length, 3);
  assert.equal(upto[2].id, mid.id);
  assert.equal(db.getMessagesUpTo(contactId, 999999), null);
});

test('换库后 localId 重复仍入库；完整标识重传、同秒不同消息正确去重', () => {
  const c = db.upsertContact({ wxid: 'rotate', name: 'Rotate' });
  const a = { ...msg(1, 1000, '你好', true), messageKey: 'srv:9007199254740992' };
  const b = { ...msg(1, 2000, '你好', true), messageKey: 'srv:9007199254740993' };
  const d = { ...b, messageKey: 'wcda:message_5:Msg_x:1' };
  assert.equal(db.syncMessages({ contactId: c.id, messages: [a, b, d] }).inserted, 3);
  assert.equal(db.syncMessages({ contactId: c.id, messages: [b, a, d] }).inserted, 0);
  assert.equal(db.getRecentMessages(c.id).length, 3);
  assert.equal(db.getContactByWxid('rotate').last_time, 2000000);
});

test('旧客户端重用 localId 时按时间区分；新标识接管旧行不覆盖已编辑内容', () => {
  const c = db.upsertContact({ wxid: 'legacy-rotate', name: 'Legacy' });
  const a = msg(1, 3000, '旧消息', true);
  const b = msg(1, 4000, '新消息', true);
  assert.equal(db.syncMessages({ contactId: c.id, messages: [a, b] }).inserted, 2);
  const original = db.getRecentMessages(c.id)[0];
  db.updateMessage(original.id, { content: '手动编辑后的内容' });
  const keyed = { ...a, messageKey: 'srv:1234567890123456789' };
  assert.equal(db.syncMessages({ contactId: c.id, messages: [keyed, keyed, b] }).inserted, 0);
  assert.equal(db.getRecentMessages(c.id)[0].content, '手动编辑后的内容');
  assert.equal(raw.prepare('SELECT message_key FROM messages WHERE id=?').get(original.id).message_key, keyed.messageKey);
});
