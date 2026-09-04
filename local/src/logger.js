/**
 * logger.js
 *
 * 把 console.log / info / warn / error 同时写到按天切割的日志文件（logs/bridge-YYYY-MM-DD.log），
 * 控制台输出照旧。超过 keepDays 天的旧日志自动删除。
 * 作为后台服务运行时没有控制台，这就是唯一的日志来源。
 */

import fs from 'fs';
import path from 'path';
import util from 'util';

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeStr(d) { return `${dateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

export function installFileLogger(logDir, { keepDays = 14, prefix = 'bridge' } = {}) {
  fs.mkdirSync(logDir, { recursive: true });

  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  let stream = null;
  let streamDate = '';

  function prune() {
    try {
      const cutoff = Date.now() - keepDays * 86_400_000;
      for (const f of fs.readdirSync(logDir)) {
        if (!f.startsWith(`${prefix}-`) || !f.endsWith('.log')) continue;
        const p = path.join(logDir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch { /* 清理失败不影响运行 */ }
  }

  function ensureStream(d) {
    const ds = dateStr(d);
    if (ds !== streamDate) {
      stream?.end();
      stream = fs.createWriteStream(path.join(logDir, `${prefix}-${ds}.log`), { flags: 'a' });
      streamDate = ds;
      prune();
    }
    return stream;
  }

  function write(level, args) {
    const d = new Date();
    try {
      ensureStream(d).write(`${timeStr(d)} [${level}] ${util.format(...args)}\n`);
    } catch { /* 写盘失败不影响运行 */ }
  }

  for (const [level, fn] of Object.entries(original)) {
    console[level] = (...args) => {
      fn(...args);
      write(level.toUpperCase(), args);
    };
  }

  return { logDir, prune, currentFile: () => stream?.path };
}
