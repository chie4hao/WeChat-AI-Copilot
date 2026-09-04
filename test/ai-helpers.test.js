import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempEnv, writeConfig } from './helpers.js';

setupTempEnv();
const config = (await import('../src/config.js')).default;
const { parseAiJson, makeStreamParser, buildUserMessageParts, buildUserMessage, formatMsgTime, formatNow } = await import('../src/ai.js');

test('parseAiJson：直接 JSON / markdown 代码块 / 前后夹带说明 / 无效', () => {
  assert.deepEqual(parseAiJson('{"message":"m","candidates":["a"]}'), { message: 'm', candidates: ['a'] });
  assert.deepEqual(parseAiJson('好的，结果如下：\n```json\n{"message":"m","candidates":["a","b"]}\n```'), { message: 'm', candidates: ['a', 'b'] });
  assert.deepEqual(parseAiJson('前言 {"message":"m","candidates":[]} 后记'), { message: 'm', candidates: [] });
  assert.throws(() => parseAiJson('完全不是 JSON'), /无效的 JSON/);
  assert.throws(() => parseAiJson(''), /为空/);
});

function collect(chunks) {
  let out = '';
  const parse = makeStreamParser(t => { out += t; });
  for (const c of chunks) parse(c);
  return out;
}

test('makeStreamParser：只吐出 message 字段的值，跳过 JSON 外壳', () => {
  assert.equal(collect(['{"mess', 'age": "你好，', '世界", "candidates": ["x"]}']), '你好，世界');
});

test('makeStreamParser：转义序列被切在块边界时正确拼接', () => {
  assert.equal(collect(['{"message":"a\\', 'nb"}']), 'a\nb');
  assert.equal(collect(['{"message":"引号\\"里\\"", "candidates":[]}']), '引号"里"');
  assert.equal(collect(['{"message":"\\u4f60', '\\u597d"}']), '你好');
  assert.equal(collect(['{"message":"\\u4f', '60"}']), '你');
  assert.equal(collect(['{"message":"反斜杠\\\\结束"}']), '反斜杠\\结束');
});

test('makeStreamParser：message 结束后不再输出 candidates 里的内容', () => {
  assert.equal(collect(['{"message":"done","candidates":["不该出现"]}', '更多']), 'done');
});

test('formatMsgTime / formatNow 按 config.timezone 换算', () => {
  // 2026-01-01 16:05 UTC = 北京 2026-01-02 00:05
  assert.equal(formatMsgTime(Date.UTC(2026, 0, 1, 16, 5)), '1月2日 00:05');
  assert.match(formatNow(), /^\d{4}年\d{1,2}月\d{1,2}日 周[一二三四五六日] \d{2}:\d{2}$/);

  writeConfig({ ...config.get(), timezone: 'America/New_York' });
  config.reload();
  assert.equal(formatMsgTime(Date.UTC(2026, 0, 1, 16, 5)), '1月1日 11:05');

  writeConfig({ ...config.get(), timezone: 'Not/AZone' });
  config.reload();
  assert.equal(formatMsgTime(Date.UTC(2026, 0, 1, 16, 5)), '1月2日 00:05', '无效时区回退到 Asia/Shanghai');

  writeConfig({ ...config.get(), timezone: 'Asia/Shanghai' });
  config.reload();
});

test('buildUserMessageParts：prefix 稳定可缓存，suffix 放当前时间与指令', () => {
  const history = [
    { is_self: 0, content: '今天爬山好累', timestamp: Date.UTC(2026, 5, 12, 6, 30) },
    { is_self: 1, content: '哪座山', timestamp: Date.UTC(2026, 5, 12, 6, 31) },
  ];
  const { prefix, suffix } = buildUserMessageParts(history, 3, '同学，喜欢户外', '小红');
  assert.ok(prefix.startsWith('【关于这个人】\n同学，喜欢户外'));
  assert.ok(prefix.includes('[6月12日 14:30] 小红: 今天爬山好累'));
  assert.ok(prefix.includes('[6月12日 14:31] 我: 哪座山'));
  assert.ok(!prefix.includes('【当前时间】'), '当前时间不能进 prefix，否则缓存永远不命中');
  assert.ok(suffix.includes('【当前时间】'));
  assert.ok(suffix.includes('3 条候选回复'));

  const noNotes = buildUserMessageParts(history, 3, '', '小红');
  assert.ok(noNotes.prefix.startsWith('以下是我们最近的聊天记录：'), '没有备注时不输出【关于这个人】');
  const full = buildUserMessage(history, 3, '', '小红');
  assert.ok(full.startsWith(noNotes.prefix));
  assert.ok(full.includes('【当前时间】'));
});
