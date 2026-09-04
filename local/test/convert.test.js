import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HAKUREI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
const { WeChatBridge, sortByTime, NON_TRIGGER_TYPES } = await import('../src/wechat_bridge.js');

const b = new WeChatBridge();
b._analyzeImages = false;
b._baseUrl = 'http://127.0.0.1:1';
const conv = (m) => b._convert({ localId: 1, createTime: 100, isSent: false, ...m }, 'wxid_x');

test('文本 / 空文本', async () => {
  assert.deepEqual(await conv({ renderType: 'text', content: '你好' }), { localId: 1, isSelf: false, createTime: 100, renderType: 'text', content: '你好' });
  assert.equal(await conv({ renderType: 'text', content: '  ' }), null);
});

test('图片：未配置 Gemini 时是占位', async () => {
  assert.equal((await conv({ renderType: 'image' })).content, '[图片]');
});

test('语音：微信自带转写优先，没有则占位带时长', async () => {
  assert.equal((await conv({ renderType: 'voice', voiceLength: 5867, voiceTranscript: '明天见' })).content, '[语音 6s：明天见]');
  assert.equal((await conv({ renderType: 'voice', voiceLength: 5867 })).content, '[语音 6s]');
  assert.equal((await conv({ renderType: 'voice' })).content, '[语音]');
});

test('引用消息带上被引用内容并截断', async () => {
  const r = await conv({ renderType: 'quote', content: '？', quoteTitle: '小红', quoteContent: 'x'.repeat(80) });
  assert.equal(r.content, `「小红: ${'x'.repeat(60)}…」\n？`);
  assert.equal(await conv({ renderType: 'quote', content: '' }), null);
});

test('系统消息：以"你"开头视为自己的动作，且不算对方来消息', async () => {
  const mine = await conv({ renderType: 'system', content: '你撤回了一条消息' });
  assert.equal(mine.isSelf, true);
  assert.equal(mine.content, '[系统消息] 你撤回了一条消息');
  const theirs = await conv({ renderType: 'system', content: '"小红" 撤回了一条消息' });
  assert.equal(theirs.isSelf, false);
  assert.ok(NON_TRIGGER_TYPES.has('system'));
  assert.equal(b._isTriggering({ isSent: false, renderType: 'system' }), false);
  assert.equal(b._isTriggering({ isSent: false, renderType: 'text' }), true);
  assert.equal(b._isTriggering({ isSent: true, renderType: 'text' }), false);
});

test('链接 / 转发记录 / 表情 / 视频 / 文件 / 位置 / 转账 / 通话 / 未知类型', async () => {
  assert.equal((await conv({ renderType: 'link', title: '一篇文章', content: '点击查看' })).content, '[链接：一篇文章]');
  assert.equal((await conv({ renderType: 'link' })).content, '[链接：无标题]');
  const ch = await conv({ renderType: 'chatHistory', title: 'A与B的聊天记录', content: 'A: 你好 B: 好' });
  assert.equal(ch.content, '[转发的聊天记录：A与B的聊天记录]\nA: 你好 B: 好');
  assert.equal((await conv({ renderType: 'emoji', content: '[表情]' })).content, '[表情]');
  assert.equal((await conv({ renderType: 'video' })).content, '[视频]');
  assert.equal((await conv({ renderType: 'file', title: '合同.pdf' })).content, '[文件：合同.pdf]');
  assert.equal((await conv({ renderType: 'location', locationPoiname: '人民广场' })).content, '[位置：人民广场]');
  assert.equal((await conv({ renderType: 'transfer', content: '转账 ¥100' })).content, '[转账] 转账 ¥100');
  assert.equal(await conv({ renderType: 'voip', content: '通话时长 01:00' }), null);
  assert.equal((await conv({ renderType: 'weird', content: 'x' })).content, '[weird] x');
  assert.equal(await conv({ renderType: '' }), null);
});

test('sortByTime 按 createTime 再按 localId', () => {
  const s = sortByTime([{ createTime: 2, localId: 5 }, { createTime: 1, localId: 9 }, { createTime: 2, localId: 3 }]);
  assert.deepEqual(s.map(m => m.localId), [9, 3, 5]);
});

test('getStatus 有完整字段', () => {
  const s = b.getStatus();
  for (const k of ['running', 'sseConnected', 'wcdaReachable', 'wcdaRealtime', 'lastPollOkAt', 'lastEventAt', 'sessions', 'fullSyncing']) assert.ok(k in s, k);
});
