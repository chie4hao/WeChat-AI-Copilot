import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncClient } from '../src/sync_client.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-client-'));
const quiet = { log() {}, warn() {}, error() {} };

// 可编程的假 VPS：handlers 依次消费每个请求
function fakeFetch(handlers) {
  const requests = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push({ url, body, headers: opts.headers });
    const h = handlers.length > 1 ? handlers.shift() : handlers[0];
    const r = typeof h === 'function' ? h(body) : h;
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.json ?? {}, text: async () => r.text ?? '' };
  };
  return { fetchImpl, requests };
}
const ok = (json = { ok: true, inserted: 1, triggered: false }) => ({ status: 200, json });
const mk = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ localId: from + i, createTime: 100 + i, content: `m${from + i}`, isSelf: false, renderType: 'text' }));
const event = (messages, isFullSync = false) => ({ wxid: 'w1', name: 'A', isGroup: false, messages, isFullSync });

test('正常上报：带 secret，最后一批决定 skipAi', async () => {
  const { fetchImpl, requests } = fakeFetch([ok()]);
  const c = new SyncClient({ vpsUrl: 'http://vps/', secret: 's3', queuePath: path.join(dir, 'q1.json'), fetchImpl, log: quiet });
  await c.handleEvent(event(mk(3)));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://vps/api/sync');
  assert.equal(requests[0].headers['X-Secret'], 's3');
  assert.equal(requests[0].body.skipAi, false);
  assert.equal(requests[0].body.messages.length, 3);
});

test('全量同步分批，只有最后一批不带 skipAi（但全量本身 skipAi=true）', async () => {
  const { fetchImpl, requests } = fakeFetch([ok()]);
  const c = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath: path.join(dir, 'q2.json'), fetchImpl, log: quiet, flushBatch: 100 });
  await c.handleEvent(event(mk(250), true));
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.body.skipAi === true));
  assert.deepEqual(requests.map(r => r.body.messages.length), [100, 100, 50]);
});

test('413 对半拆分重发，前半段不触发 AI', async () => {
  const { fetchImpl, requests } = fakeFetch([
    { status: 413, text: 'too large' },
    ok({ ok: true, inserted: 2, triggered: false }),
    ok({ ok: true, inserted: 2, triggered: true }),
  ]);
  const c = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath: path.join(dir, 'q3.json'), fetchImpl, log: quiet });
  await c.handleEvent(event(mk(4)));
  assert.equal(requests.length, 3);
  assert.equal(requests[1].body.messages.length, 2);
  assert.equal(requests[1].body.skipAi, true);
  assert.equal(requests[2].body.messages.length, 2);
  assert.equal(requests[2].body.skipAi, false);
  assert.equal(c.stats().messages, 0);
});

test('5xx / 网络错误进队列并落盘；4xx 向桥接抛错，禁止推进游标', async () => {
  const queuePath = path.join(dir, 'q4.json');
  const { fetchImpl, requests } = fakeFetch([{ status: 502, text: 'bad gateway' }, ok()]);
  const c = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath, fetchImpl, log: quiet, retryIntervalMs: 3_600_000 });
  await c.handleEvent(event(mk(2)));
  assert.deepEqual(c.stats(), { contacts: 1, messages: 2 });
  assert.ok(fs.existsSync(queuePath));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(queuePath, 'utf8'))).length, 1);

  // 重启后从文件恢复
  const c2 = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath, fetchImpl, log: quiet, retryIntervalMs: 3_600_000 });
  assert.deepEqual(c2.stats(), { contacts: 1, messages: 2 });
  await c2.flushPending();
  assert.deepEqual(c2.stats(), { contacts: 0, messages: 0 });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.skipAi, false, '积压里有需要触发 AI 的批次，重试时不跳过');
  assert.deepEqual(JSON.parse(fs.readFileSync(queuePath, 'utf8')), {});
  c.stop(); c2.stop();

  const net = fakeFetch([new Error('fetch failed')]);
  const c3 = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath: path.join(dir, 'q5.json'), fetchImpl: net.fetchImpl, log: quiet, retryIntervalMs: 3_600_000 });
  await c3.handleEvent(event(mk(1)));
  assert.equal(c3.stats().messages, 1, '网络错误入队');
  c3.stop();

  const bad = fakeFetch([{ status: 403, text: 'Forbidden' }]);
  const c4 = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath: path.join(dir, 'q6.json'), fetchImpl: bad.fetchImpl, log: quiet });
  await assert.rejects(c4.handleEvent(event(mk(1))), /403/);
  assert.equal(c4.stats().messages, 0, '4xx 不入队');
});

test('新消息到达时合并该联系人的积压一起上报', async () => {
  const { fetchImpl, requests } = fakeFetch([{ status: 500, text: 'x' }, ok()]);
  const c = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath: path.join(dir, 'q7.json'), fetchImpl, log: quiet, retryIntervalMs: 3_600_000 });
  await c.handleEvent(event(mk(2), true));          // 失败入队（skipAi=true）
  await c.handleEvent(event(mk(1, 3)));             // 新消息合并
  assert.equal(requests[1].body.messages.length, 3);
  assert.deepEqual(requests[1].body.messages.map(m => m.localId), [1, 2, 3]);
  assert.equal(requests[1].body.skipAi, false);
  assert.equal(c.stats().messages, 0);
  c.stop();
});

test('心跳失败只记一次，不抛异常', async () => {
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: () => {} };
  const { fetchImpl } = fakeFetch([new Error('fetch failed')]);
  const c = new SyncClient({ vpsUrl: 'http://vps', secret: 's', queuePath: path.join(dir, 'q8.json'), fetchImpl, log });
  assert.equal(await c.heartbeat({ a: 1 }), null);
  assert.equal(await c.heartbeat({ a: 1 }), null);
  assert.equal(logs.filter(l => l.includes('[heartbeat]')).length, 1);
});
