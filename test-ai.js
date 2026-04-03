/**
 * Gemini API 测试脚本
 * 用法：node test-ai.js [stream|block]
 *   stream = 流式模式（默认）
 *   block  = 非流式模式
 */

import config from './src/config.js';
import { generateSuggestions } from './src/ai.js';

// 命令行参数决定测试模式
const mode = process.argv[2] ?? 'stream';
const cfg = config.get();
cfg.gemini.stream = (mode !== 'block');
console.log(`\n▶ 测试模式：${cfg.gemini.stream ? '流式 (stream)' : '非流式 (block)'}\n`);

// 模拟一段聊天记录
const mockHistory = [
  { is_self: 0, content: '今天爬山好累' },
  { is_self: 1, content: '哪座山' },
  { is_self: 0, content: '梅岭，你也喜欢爬山？' },
];

console.log('── 聊天记录 ──');
mockHistory.forEach(m => console.log(`${m.is_self ? '我' : '她'}: ${m.content}`));
console.log('\n── AI 响应 ──');

const contactId = 1; // 测试用，随便给个 id

generateSuggestions(contactId, mockHistory, {
  onChunk(chunk) {
    // 流式模式下逐块打印，不换行
    process.stdout.write(chunk);
  },
  onComplete(result) {
    if (cfg.gemini.stream) {
      // 流式结束后补一个换行
      console.log('\n');
    }
    console.log('── 解析结果 ──');
    console.log('message:', result.message);
    console.log('\ncandidates:');
    result.candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  },
  onError(err) {
    console.error('\n错误:', err.message);
    process.exit(1);
  },
});
