// 会话指纹比对 + 增量同步的判定逻辑，用假的 WCDA 接口驱动
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAKUREI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-poll-'));
const { WeChatBridge } = await import('../src/wechat_bridge.js');
const state = await import('../src/sync_state.js');

// ── 假 WCDA ──────────────────────────────────────────────────
let sessions = [];
let messagesByUser = {};   // username -> 全部消息（升序）
let sessionsExtra = {};
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  calls.push(u.pathname + u.search);
  if (u.pathname === '/api/chat/sessions') {
    return { ok: true, status: 200, json: async () => ({ sessions, ...sessionsExtra }) };
  }
  if (u.pathname === '/api/chat/messages') {
    // 模拟 2.3.0 实时模式语义：从最新往旧取，offset 从最新数起，asc 只是反转这一页
    const all = messagesByUser[u.searchParams.get('username')] ?? [];
    const limit = Number(u.searchParams.get('limit'));
    const offset = Number(u.searchParams.get('offset') || 0);
    const desc = [...all].reverse();
    const page = desc.slice(offset, offset + limit).reverse();
    return { ok: true, status: 200, json: async () => ({ messages: page, hasMore: offset + limit < all.length }) };
  }
  throw new Error('unexpected ' + url);
};
after(() => { globalThis.fetch = realFetch; });

function makeBridge() {
  const b = new WeChatBridge();
  b.start({ wcda: { url: 'http://fake', sse: false, poll_interval_ms: 60_000, context_limit: 5 }, ignore_groups: true });
  clearTimeout(b._pollTimer); // 不要真的定时轮询
  b._polling = false; b._dirty = false;
  return b;
}
const sess = (username, name, lastMessage, lastMessageTime, unreadCount = 0, isGroup = false) => ({ username, name, lastMessage, lastMessageTime, unreadCount, isGroup });
const msg = (localId, createTime, content, isSent = false, renderType = 'text') => ({ localId, createTime, content, isSent, renderType });

test('第一轮只建基线；之后只对指纹变化的会话拉消息', async () => {
  const b = makeBridge();
  const synced = [];
  b._doIncrementalSync = async (username) => { synced.push(username); };

  sessions = [sess('u1', 'A', '你好', '10:00'), sess('u2', 'B', '在吗', '09:00'), sess('g1', 'G', 'x', '08:00', 0, true)];
  await b._poll('startup');
  assert.deepEqual(synced, [], '启动第一轮不拉消息');
  assert.equal(b._sig.size, 2, '群聊被忽略');

  await b._poll('sse');
  assert.deepEqual(synced, [], '没变化不拉');

  sessions[0] = sess('u1', 'A', '再见', '10:01');
  await b._poll('sse');
  assert.deepEqual(synced, ['u1']);

  sessions[1] = sess('u2', 'B', '在吗', '09:00', 3);   // 未读数增加
  await b._poll('sse');
  assert.deepEqual(synced, ['u1', 'u2']);

  sessions[1] = sess('u2', 'B', '在吗', '09:00', 0);   // 只是被读掉了
  await b._poll('sse');
  assert.deepEqual(synced, ['u1', 'u2'], '未读数减少不算变化');

  sessions.push(sess('u3', 'C', '新朋友', '10:05'));
  await b._poll('sse');
  assert.deepEqual(synced, ['u1', 'u2', 'u3'], '新出现的会话当作有变化');
});

test('WCDA 回退到解密快照时记录原因', async () => {
  const b = makeBridge();
  b._doIncrementalSync = async () => {};
  sessions = [sess('u1', 'A', 'x', '10:00')];
  sessionsExtra = { sourceFallback: true, sourceFallbackReason: 'wcdb not connected' };
  await b._poll('startup');
  assert.equal(b.getStatus().wcdaRealtime, false);
  assert.equal(b.getStatus().wcdaFallbackReason, 'wcdb not connected');
  sessionsExtra = {};
  await b._poll('sse');
  assert.equal(b.getStatus().wcdaRealtime, true);
});

test('增量同步：首次见到的联系人按时间判断新旧', async () => {
  const b = makeBridge();
  const events = [];
  b.on('new_message', e => events.push(e));
  const now = Math.floor(Date.now() / 1000);
  messagesByUser.first = [msg(1, now - 3600, '旧消息'), msg(2, now - 3500, '也是旧的')];
  await b._doIncrementalSync('first', 'F', false, Date.now() - 60_000);
  assert.equal(events.length, 0, '全是旧消息只记基线');
  assert.equal(state.getLastLocalId('first'), 2);

  messagesByUser.first.push(msg(3, now, '新来的'));
  await b._doIncrementalSync('first', 'F', false, Date.now() - 60_000);
  // 从未全量同步过 → 先全量（isFullSync=true）再上报新消息（isFullSync=false）
  assert.equal(events.length, 2);
  assert.equal(events[0].isFullSync, true);
  assert.equal(events[0].messages.length, 3);
  assert.equal(events[1].isFullSync, false);
  assert.deepEqual(events[1].messages.map(m => m.content), ['新来的']);
  assert.equal(state.isFullSynced('first'), true);
  assert.equal(state.getLastLocalId('first'), 3);
});

test('增量同步：只有自己发的消息 → 入库不触发；窗口全新 → 分页补拉', async () => {
  const b = makeBridge();
  const events = [];
  b.on('new_message', e => events.push(e));
  state.markFullSynced('second', 10);
  messagesByUser.second = [];
  for (let i = 1; i <= 11; i++) messagesByUser.second.push(msg(i, 1000 + i, `m${i}`, i % 2 === 1));   // 奇数号是自己发的

  await b._doIncrementalSync('second', 'S', false, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].isFullSync, true, '11 号是自己发的，只入库');
  assert.equal(state.getLastLocalId('second'), 11);

  // 离线期间来了 8 条对方消息（超过 context_limit=5），窗口里全是新消息 → 走补拉，拿全 8 条
  for (let i = 12; i <= 19; i++) messagesByUser.second.push(msg(i, 1000 + i, `m${i}`, false));
  await b._doIncrementalSync('second', 'S', false, 0);
  assert.equal(events.length, 2);
  assert.equal(events[1].isFullSync, false);
  assert.deepEqual(events[1].messages.map(m => m.localId), [12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(state.getLastLocalId('second'), 19);
});

test('SSE change 事件去抖后触发一次轮询', async () => {
  const b = makeBridge();
  let polls = 0;
  b._schedulePoll = () => { polls++; };
  b._handleSseFrame('data: {"type":"ready"}');
  b._handleSseFrame('data: {"type":"change","ts":1}');
  b._handleSseFrame('data: {"type":"change","ts":2}');
  b._handleSseFrame(': ping');
  assert.equal(polls, 0);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(polls, 1, '两次 change 合并成一次');
  assert.ok(b.getStatus().lastEventAt > 0);
  b.stop();
});
