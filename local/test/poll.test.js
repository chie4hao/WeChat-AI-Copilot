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

const SIG_PATH = path.join(process.env.HAKUREI_DATA_DIR, 'session_sig.json');

// 不走 start()（它会立刻异步轮询、起定时器），直接把字段摆好，测试才是确定的
function makeBridge({ keepSigs = false } = {}) {
  if (!keepSigs) { try { fs.unlinkSync(SIG_PATH); } catch {} }
  const b = new WeChatBridge();
  b._baseUrl = 'http://fake';
  b._contextLimit = 5;
  b._sessionsLimit = 200;
  b._pollIntervalMs = 60_000;
  b._heartbeatMs = 60_000;
  b._ignoreGroups = true;
  b._debugSelfTrigger = false;
  b._analyzeImages = false;
  b._running = true;
  if (keepSigs) b._loadSigs();
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

test('指纹落盘：重启后第一轮就能发现停机期间有变化的联系人', async () => {
  const a = makeBridge();
  a._doIncrementalSync = async () => {};
  sessions = [sess('r1', 'R1', '你好', '10:00'), sess('r2', 'R2', '在吗', '09:00')];
  await a._poll('startup');
  assert.ok(fs.existsSync(SIG_PATH), '轮询后指纹已落盘');
  const saved = JSON.parse(fs.readFileSync(SIG_PATH, 'utf8'));
  assert.ok(saved.savedAt > 0);
  assert.equal(saved.sessions.r1.msg, '你好');

  // "停机期间" r2 来了新消息；新实例载入旧指纹后第一轮应当只同步 r2
  sessions[1] = sess('r2', 'R2', '新消息', '10:30');
  const b = makeBridge({ keepSigs: true });
  assert.ok(b._prevSnapshotAt > 0, '载入指纹后不再当作首次运行');
  const synced = [];
  b._doIncrementalSync = async (u) => { synced.push(u); };
  await b._poll('startup');
  assert.deepEqual(synced, ['r2']);
});

test('首次运行没有历史指纹：把已跟踪的联系人排进补漏队列，后台逐个核对', async () => {
  const b = makeBridge();
  state.updateLastLocalId('cu1', 5);           // 已跟踪
  sessions = [sess('cu1', 'CU1', 'x', '10:00'), sess('cu2', 'CU2', 'y', '09:00')];   // cu2 未跟踪
  const polls = [];
  b._schedulePoll = (r) => { polls.push(r); };
  await b._poll('startup');
  assert.deepEqual(b._catchup.map(c => c.username), ['cu1'], '只排已跟踪的联系人');
  assert.deepEqual(polls, ['catchup']);
  assert.equal(b.getStatus().catchupPending, 1);

  // _runPolls 在没有事件时处理补漏队列
  const synced = [];
  b._doIncrementalSync = async (u, name) => { synced.push(u + '/' + name); b._running = false; };  // 处理完就停，免得等 3 秒间隔
  b._dirty = false;
  await b._runPolls('catchup');
  assert.deepEqual(synced, ['cu1/CU1']);
  assert.equal(b._catchup.length, 0);

  // 重复入队会去重，未跟踪的不入队
  b._running = true;
  b._enqueueCatchup('x', ['cu1', 'cu2']);
  b._enqueueCatchup('x', ['cu1']);
  assert.deepEqual(b._catchup.map(c => c.username), ['cu1']);
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
  state.advanceCursor('second', [msg(10, 1010, 'm10', false)]);
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

test('start() 会载入指纹、起定时器，stop() 能全部清掉', async () => {
  makeBridge();   // 清掉指纹文件
  const b = new WeChatBridge();
  b.start({ wcda: { url: 'http://fake', sse: false, poll_interval_ms: 60_000, context_limit: 5, catchup_interval_hours: 1 }, ignore_groups: true });
  assert.ok(b._pollTimer && b._catchupTimer);
  b.stop();
  assert.equal(b._pollTimer, null);
  assert.equal(b._catchupTimer, null);
  assert.equal(b.getStatus().running, false);
  await new Promise(r => setTimeout(r, 50));   // 让 start() 触发的那次异步轮询结束
});

test('回归：旧库 localId=83，新库 1/2/3/4 都上报，重启后不重发', async () => {
  const b = makeBridge();
  const old = { ...msg(83, 1000, '旧库末条', true), id: 'message_0:Msg_f:83' };
  state.advanceCursor('filehelper-rotate', [old], { fullSynced: true });
  const fresh = [1, 2, 3, 4].map(i => ({ ...msg(i, 2000 + i, `新${i}`, true), id: `message_4:Msg_f:${i}` }));
  messagesByUser['filehelper-rotate'] = [old, ...fresh];
  const events = [];
  b.on('new_message', async e => events.push(e));
  await b._doIncrementalSync('filehelper-rotate', 'F', false, 0);
  assert.deepEqual(events[0].messages.map(m => m.localId), [1, 2, 3, 4]);
  assert.equal(events[0].isFullSync, true);
  assert.equal(state.getSyncCursor('filehelper-rotate').lastCreateTime, 2004);
  const next = makeBridge();
  next.on('new_message', e => events.push(e));
  await next._doIncrementalSync('filehelper-rotate', 'F', false, 0);
  assert.equal(events.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.HAKUREI_DATA_DIR, 'sync_state.json')));
  assert.deepEqual(saved['filehelper-rotate'].keysAtLastTime, ['wcda:message_4:Msg_f:4']);
});

test('同秒跨库的消息超过窗口仍补全，localId 较小不会让分页提前停止', async () => {
  const b = makeBridge();
  const old = { ...msg(83, 1000, 'old', true), id: 'message_0:Msg_s:83' };
  state.advanceCursor('same-second', [old], { fullSynced: true });
  const fresh = Array.from({ length: 508 }, (_, i) => ({ ...msg(i + 1, 1000, `m${i}`, true), id: `message_4:Msg_s:${i + 1}` }));
  messagesByUser['same-second'] = [msg(82, 999, 'older', true), old, ...fresh];
  const events = [];
  b.on('new_message', e => events.push(e));
  await b._doIncrementalSync('same-second', 'S', false, 0);
  assert.equal(events[0].messages.length, 508);
  assert.equal(new Set(events[0].messages.map(m => m.messageKey)).size, 508);
  await b._doIncrementalSync('same-second', 'S', false, 0);
  assert.equal(events.length, 1);
});

test('旧版只有 localId 的进度迁移：保守重放，保留所有跨库消息且不触发历史 AI', async () => {
  const b = makeBridge();
  state.markFullSynced('legacy', 83);
  messagesByUser.legacy = [msg(83, 1000, 'old'), msg(1, 2000, 'new')];
  const events = [];
  b.on('new_message', e => events.push(e));
  await b._doIncrementalSync('legacy', 'L', false, 3000000);
  assert.deepEqual(events[0].messages.map(m => m.localId), [83, 1]);
  assert.equal(events[0].isFullSync, true);
  assert.equal(state.getSyncCursor('legacy').lastCreateTime, 2000);
});

test('分页失败、实时模式回退时不交付、不推进游标', async () => {
  const b = makeBridge();
  const old = msg(83, 1000, 'old', true);
  state.advanceCursor('page-error', [old], { fullSynced: true });
  let emitted = 0;
  b.on('new_message', () => emitted++);
  b._fetch = async url => new URL(url).searchParams.get('offset') === '0'
    ? { ok: true, json: async () => ({ messages: [msg(1, 2000, 'new', true)], hasMore: true }) }
    : { ok: false, status: 503 };
  await assert.rejects(b._doIncrementalSync('page-error', 'E', false, 0), /503/);
  assert.equal(emitted, 0);
  assert.equal(state.getSyncCursor('page-error').lastCreateTime, 1000);
  b._fetch = async () => ({ ok: true, json: async () => ({ messages: [old], sourceFallback: true }) });
  await assert.rejects(b._doIncrementalSync('page-error', 'E', false, 0), /非实时/);
});

test('等待上报完成再推进；上报失败保留旧指纹，下轮继续同步', async () => {
  const b = makeBridge();
  state.advanceCursor('delivery-error', [msg(83, 1000, 'old', true)], { fullSynced: true });
  b._sig.set('delivery-error', { t: '09:00', msg: 'old', unread: 0 });
  b._prevSnapshotAt = 1000000;
  sessions = [sess('delivery-error', 'D', 'new', '10:00')];
  messagesByUser['delivery-error'] = [msg(1, 2000, 'new', true)];
  let tries = 0;
  b.on('new_message', async () => {
    tries++;
    await new Promise(r => setTimeout(r, 5));
    assert.equal(state.getSyncCursor('delivery-error').lastCreateTime, 1000);
    if (tries === 1) throw new Error('VPS 403');
  });
  await b._poll('sse');
  assert.equal(b._sig.get('delivery-error').msg, 'old');
  assert.equal(state.getSyncCursor('delivery-error').lastCreateTime, 1000);
  await b._poll('heartbeat');
  assert.equal(tries, 2);
  assert.equal(b._sig.get('delivery-error').msg, 'new');
  assert.equal(state.getSyncCursor('delivery-error').lastCreateTime, 2000);
});
