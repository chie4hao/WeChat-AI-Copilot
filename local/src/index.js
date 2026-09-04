/**
 * index.js — 本地端入口
 *
 *   WeChatDataAnalysis 实时接口 ──(SSE + 会话指纹)──> wechat_bridge ──new_message──> SyncClient ──POST /api/sync──> VPS
 *                                                           └──getStatus()──> 每分钟心跳 POST /api/bridge/heartbeat ──> VPS 主页状态卡
 */

import fs from 'fs';
import os from 'os';
import config from './config.js';
import bridge from './wechat_bridge.js';
import { SyncClient } from './sync_client.js';
import { installFileLogger } from './logger.js';
import { dataFile, LOG_DIR } from './paths.js';
import { trackedCount } from './sync_state.js';

// 日志同时写到 logs/bridge-YYYY-MM-DD.log（后台服务模式下没有控制台）
installFileLogger(LOG_DIR, { keepDays: 14 });

const cfg = config.load();
const { url: vpsUrl, secret, heartbeat_ms = 60_000 } = cfg.vps;
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const startedAt = Date.now();

const client = new SyncClient({ vpsUrl, secret, queuePath: dataFile('pending_queue.json') });
bridge.on('new_message', (event) => client.handleEvent(event));
client.start();

// ── 心跳：把桥接状态报给 VPS ───────────────────────────────────────
async function heartbeat() {
  await client.heartbeat({
    version,
    startedAt,
    host: os.hostname(),
    pid: process.pid,
    ...bridge.getStatus(),
    tracked: trackedCount(),
    pending: client.stats(),
  });
}
const hbTimer = setInterval(heartbeat, Math.max(15_000, heartbeat_ms));
setTimeout(heartbeat, 5_000);

// ── 退出时收尾 ───────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[hakurei-bot] 收到 ${signal}，退出`);
  clearInterval(hbTimer);
  bridge.stop();
  client.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => { console.error('[hakurei-bot] 未捕获异常:', err); });
process.on('unhandledRejection', (err) => { console.error('[hakurei-bot] 未处理的 Promise 拒绝:', err); });

bridge.start(cfg);
console.log(`[hakurei-bot] 本地端 v${version} 已启动（pid ${process.pid}），日志目录 ${LOG_DIR}`);
