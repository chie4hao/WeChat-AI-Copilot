/**
 * 解析微信"多选消息 → 分享/复制"得到的聊天记录文本。
 * 被 import.html 和测试共用。
 *
 * 实际格式：
 *   小明 和 小红 在微信上的聊天记录如下，请查收。
 *
 *   —————  2026-04-06  —————
 *
 *   小红  16:21
 *
 *   有点事，一会儿回
 *
 *   小明  16:21
 *
 *   好的
 *
 * 规律：
 * - 头部包含"在微信上的聊天记录"
 * - 日期分隔线：——— 2026-04-06 ———（破折号，也兼容 2026/04/06、2026年4月6日）
 * - 发送者行：`发送者名  HH:MM`（两个以上空格分隔，时间在末尾）
 * - 消息内容：发送者行的下一个非空行
 *
 * 返回 { names: string[], messages: [{ type: 'time', content } | { type: 'msg', sender, content, timestamp }] }
 * timestamp 为本地时间的毫秒时间戳；没有日期分隔线时为 null。
 */
export function parseWeChatLog(text) {
  const names = new Set();
  const messages = [];

  // 时间模式：HH:MM 或 H:MM
  const TIME_RE = /\s{2,}(\d{1,2}:\d{2})\s*$/;
  // 日期分隔线
  const DATE_SEP_RE = /^[—\-─\s]+(\d{4}[-\/年]\d{1,2}[-\/月]\d{1,2}[日]?)[—\-─\s]*$/;

  // 将各种日期格式统一成 'YYYY-MM-DD'
  function normDateStr(str) {
    return str
      .replace(/(\d{4})年(\d{1,2})月(\d{1,2})日?/, (_, y, m, d) =>
        `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
      .replace(/\//g, '-');
  }

  let currentDate = null; // 'YYYY-MM-DD'

  function makeTimestamp(timeStr) {
    if (!currentDate) return null;
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(`${currentDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  const lines = text.split('\n');
  let i = 0;

  // 跳过头部（含"在微信上的聊天记录"的行）；没有头部就从第一行开始
  const headIdx = lines.findIndex(l => l.includes('在微信上的聊天记录'));
  if (headIdx !== -1) i = headIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;

    if (!trimmed) continue;

    // 日期分隔线
    const dateMatch = trimmed.match(DATE_SEP_RE);
    if (dateMatch) {
      currentDate = normDateStr(dateMatch[1]);
      messages.push({ type: 'time', content: trimmed.replace(/^[—\-─\s]+|[—\-─\s]+$/g, '').trim() });
      continue;
    }

    // 检查是否是"发送者  HH:MM"格式
    const timeMatch = line.match(TIME_RE);
    if (timeMatch) {
      const sender = line.replace(TIME_RE, '').trim();
      if (!sender) continue;
      const timestamp = makeTimestamp(timeMatch[1]);

      // 下一条非空行是消息内容
      while (i < lines.length && !lines[i].trim()) i++;
      const content = lines[i] ? lines[i].trim() : '';
      i++;

      if (content) {
        names.add(sender);
        messages.push({ type: 'msg', sender, content, timestamp });
      }
      continue;
    }
  }

  return { names: [...names], messages };
}
