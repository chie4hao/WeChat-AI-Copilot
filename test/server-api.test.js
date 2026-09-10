// 端到端：真的把 Express 服务起在随机端口上，走 HTTP 验证同步接口、心跳与状态接口。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempEnv } from './helpers.js';

setupTempEnv({ config: { server: { port: 0, sync_secret: 'test-secret' } } });
const { server, wss } = await import('../src/server.js');
if (!server.listening) await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => new Promise((resolve) => { wss.close(); server.close(() => resolve()); }));

const json = async (path, { method = 'GET', body, secret } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(secret && { 'X-Secret': secret }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const sync = (messages, extra = {}) => json('/api/sync', {
  method: 'POST', secret: 'test-secret',
  body: { wxid: 'wxid_t', name: '小红', isGroup: false, skipAi: true, messages, ...extra },
});

test('secret 不对时拒绝', async () => {
  const r = await json('/api/sync', { method: 'POST', secret: 'wrong', body: { wxid: 'x', name: 'x', messages: [{ content: 'a' }] } });
  assert.equal(r.status, 403);
  const h = await json('/api/bridge/heartbeat', { method: 'POST', secret: 'wrong', body: {} });
  assert.equal(h.status, 403);
});

const base_ct = Math.floor(Date.now() / 1000) - 600;   // 十分钟前，让"24 小时内"统计能算到

test('同步入库、去重、联系人可查（新联系人的预览由同步来的消息填上）', async () => {
  let r = await sync([
    { localId: 1, createTime: base_ct, content: '你好', isSelf: false, renderType: 'text' },
    { localId: 2, createTime: base_ct, content: '在吗', isSelf: false, renderType: 'text' },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.data.inserted, 2);
  assert.equal(r.data.triggered, false, 'skipAi=true 不触发 AI');

  r = await sync([{ localId: 2, createTime: base_ct, content: '在吗', isSelf: false, renderType: 'text' }]);
  assert.equal(r.data.inserted, 0);

  const contacts = (await json('/api/contacts')).data;
  const c = contacts.find(x => x.wxid === 'wxid_t');
  assert.ok(c);
  assert.equal(c.last_message, '在吗');
  const msgs = (await json(`/api/contacts/${c.id}/messages`)).data;
  assert.equal(msgs.length, 2);
});

test('最后一条是撤回提示（system）时不触发 AI', async () => {
  const r = await sync([{ localId: 3, createTime: base_ct + 1, content: '[系统消息] 对方撤回了一条消息', isSelf: false, renderType: 'system' }], { skipAi: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.triggered, false);
});

test('状态接口：心跳前后', async () => {
  let s = (await json('/api/status')).data;
  assert.equal(s.bridge.lastSeenAt, null);
  assert.equal(s.bridge.stale, true);
  assert.equal(s.ai.provider, 'gemini');
  assert.equal(s.token.relevant, false);
  assert.equal(s.sync.insertedSince, 3);

  const hb = await json('/api/bridge/heartbeat', { method: 'POST', secret: 'test-secret', body: { host: 'pc', version: '0.2.0', sseConnected: true, pending: { contacts: 0, messages: 0 } } });
  assert.equal(hb.status, 200);
  s = (await json('/api/status')).data;
  assert.ok(Date.now() - s.bridge.lastSeenAt < 5000);
  assert.equal(s.bridge.stale, false);
  assert.equal(s.bridge.host, 'pc');
  assert.equal(s.bridge.sseConnected, true);
});

test('手动新建的联系人排在最前', async () => {
  const r = await json('/api/contacts', { method: 'POST', body: { name: '手动的' } });
  assert.equal(r.status, 200);
  assert.ok(r.data.last_time > 0);
  const contacts = (await json('/api/contacts')).data;
  assert.equal(contacts[0].name, '手动的');
});

test('provider-status 与 settings 读写（换 token 自动记日期）', async () => {
  const ps = (await json('/api/provider-status')).data;
  assert.equal(ps.provider, 'gemini');
  const cfg = (await json('/api/settings')).data;
  const saved = await json('/api/settings', { method: 'POST', body: { ...cfg, claude_code: { enabled: false, model: 'claude-opus-5', oauth_token: 'sk-ant-oat01-test' } } });
  assert.equal(saved.status, 200);
  const cfg2 = (await json('/api/settings')).data;
  assert.equal(cfg2.claude_code.oauth_token, 'sk-ant-oat01-test');
  assert.match(cfg2.claude_code.token_created_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(cfg2.server.sync_secret, 'test-secret', 'server 字段合并保留');
});

test('HTTP 回归：跨库复用 localId 后完整入库，重传零新增且不触发 AI', async () => {
  const extra = { wxid: 'filehelper', name: '文件传输助手' };
  const old = { localId: 1, createTime: base_ct - 10, content: '旧库消息', isSelf: true, renderType: 'text' };
  assert.equal((await sync([old], extra)).data.inserted, 1);
  const messages = Array.from({ length: 4 }, (_, i) => ({
    localId: i + 1, messageKey: `srv:682456380753473335${i}`,
    createTime: base_ct + i, content: `新库消息${i + 1}`, isSelf: true, renderType: 'text',
  }));
  const uploaded = await sync(messages, extra);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.inserted, 4);
  assert.equal(uploaded.data.triggered, false);
  assert.equal((await sync(messages, extra)).data.inserted, 0);
  const contact = (await json('/api/contacts')).data.find(c => c.wxid === 'filehelper');
  const stored = (await json(`/api/contacts/${contact.id}/messages`)).data;
  assert.equal(stored.length, 5);
  assert.deepEqual(stored.filter(m => m.message_key).map(m => m.message_key).sort(), messages.map(m => m.messageKey).sort());
});
