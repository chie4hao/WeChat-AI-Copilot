import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeChatLog } from '../public/wechat-log-parser.js';

const SAMPLE = `小明 和 小红 在微信上的聊天记录如下，请查收。

—————  2026-04-06  —————


小红  16:21

有点事，一会儿回

小明  16:21

好的

—————  2026/04/07  —————

小红  9:05

昨天忘了回你

小明  09:06

没事
`;

test('解析发送者、内容、日期分隔线与时间戳', () => {
  const { names, messages } = parseWeChatLog(SAMPLE);
  assert.deepEqual(names, ['小红', '小明']);
  const msgs = messages.filter(m => m.type === 'msg');
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map(m => m.content), ['有点事，一会儿回', '好的', '昨天忘了回你', '没事']);
  assert.deepEqual(messages.filter(m => m.type === 'time').map(m => m.content), ['2026-04-06', '2026/04/07']);
  assert.equal(msgs[0].timestamp, new Date('2026-04-06T16:21:00').getTime());
  assert.equal(msgs[2].timestamp, new Date('2026-04-07T09:05:00').getTime());
  assert.ok(msgs[2].timestamp > msgs[1].timestamp);
});

test('没有头部和日期分隔线也能解析，时间戳为 null', () => {
  const { names, messages } = parseWeChatLog('小红  10:00\n\n在吗\n\n小明  10:01\n\n在');
  assert.deepEqual(names, ['小红', '小明']);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].timestamp, null);
});

test('中文日期格式与单空格行不被误判', () => {
  const text = '小明 和 小红 在微信上的聊天记录如下，请查收。\n———— 2026年4月8日 ————\n小红  8:00\n\n早\n\n这一行 只有一个空格 12:00\n';
  const { messages } = parseWeChatLog(text);
  assert.equal(messages.find(m => m.type === 'time').content, '2026年4月8日');
  const msgs = messages.filter(m => m.type === 'msg');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].timestamp, new Date('2026-04-08T08:00:00').getTime());
});

test('空内容的发送者行被跳过', () => {
  const { messages } = parseWeChatLog('小红  10:00\n\n\n');
  assert.equal(messages.length, 0);
});
