/**
 * sync_client.js
 *
 * 负责把桥接产出的消息批次 POST 到 VPS（/api/sync），以及定时上报心跳（/api/bridge/heartbeat）。
 *
 * - 消息带 localId + createTime，VPS 端按它们去重，重发、乱序到达都安全
 * - 上报失败（网络错误 / 5xx / 超时）进重试队列并落盘（pending_queue.json），30 秒后重试，重启不丢
 * - 4xx 是配置类错误（secret 不匹配等），重试无意义，丢弃并提示
 * - 413（请求体过大）对半拆开重发，前半段不触发 AI，由后半段决定
 *
 * fetchImpl 可注入，方便测试。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

export class SyncClient {
  constructor({
    vpsUrl,
    secret,
    queuePath,
    fetchImpl = globalThis.fetch,
    retryIntervalMs = 30_000,
    maxQueuePerContact = 1000,
    flushBatch = 200,
    postTimeoutMs = 90_000,
    log = console,
  }) {
    this.vpsUrl = String(vpsUrl).replace(/\/+$/, '');
    this.secret = secret;
    this.queuePath = queuePath;
    this.fetch = fetchImpl;
    this.retryIntervalMs = retryIntervalMs;
    this.maxQueuePerContact = maxQueuePerContact;
    this.flushBatch = flushBatch;
    this.postTimeoutMs = postTimeoutMs;
    this.log = log;
    this.pending = new Map(this._loadQueue());   // wxid -> { name, isGroup, messages: [], skipAi }
    this._retryTimer = null;
    this._heartbeatFailing = false;
  }

  // ── 队列落盘 ────────────────────────────────────────────────────

  _loadQueue() {
    try {
      if (this.queuePath && existsSync(this.queuePath)) {
        return Object.entries(JSON.parse(readFileSync(this.queuePath, 'utf8')));
      }
    } catch (err) {
      this.log.error('[sync] 读取重试队列失败，忽略:', err.message);
    }
    return [];
  }

  _saveQueue() {
    if (!this.queuePath) return;
    try {
      writeFileSync(this.queuePath, JSON.stringify(Object.fromEntries(this.pending)), 'utf8');
    } catch (err) {
      this.log.error('[sync] 重试队列写盘失败:', err.message);
    }
  }

  stats() {
    let messages = 0;
    for (const item of this.pending.values()) messages += item.messages.length;
    return { contacts: this.pending.size, messages };
  }

  /** 启动时若有积压则安排重试 */
  start() {
    if (this.pending.size) {
      this.log.log(`[sync] 发现上次未上报的积压：${this.pending.size} 个联系人，${this.retryIntervalMs / 1000}s 后重试`);
      this._scheduleRetry();
    }
  }

  stop() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
  }

  // ── HTTP ────────────────────────────────────────────────────────

  async _post(path, body) {
    const res = await this.fetch(`${this.vpsUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Secret': this.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.postTimeoutMs),
    });
    if (!res.ok) {
      const err = new Error(`VPS ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  postSync({ wxid, name, isGroup, messages, skipAi }) {
    return this._post('/api/sync', { wxid, name, isGroup, messages, skipAi, syncedAt: Date.now() });
  }

  /** 心跳：把桥接状态报给 VPS，主页状态卡用；失败只在状态变化时打一条日志 */
  async heartbeat(payload) {
    try {
      const r = await this._post('/api/bridge/heartbeat', { ...payload, sentAt: Date.now() });
      if (this._heartbeatFailing) {
        this._heartbeatFailing = false;
        this.log.log('[heartbeat] 已恢复上报');
      }
      return r;
    } catch (err) {
      if (!this._heartbeatFailing) {
        this._heartbeatFailing = true;
        this.log.warn(`[heartbeat] 上报失败: ${err.message}（恢复前不再重复提示）`);
      }
      return null;
    }
  }

  // 发送一批；413 时对半拆开重发，前半段不触发 AI，由后半段决定
  async sendBatch(item) {
    try {
      return await this.postSync(item);
    } catch (err) {
      if (err.status === 413 && item.messages.length > 1) {
        const mid = Math.ceil(item.messages.length / 2);
        this.log.warn(`[sync] ${item.name} 单批 ${item.messages.length} 条过大（413），拆成两半重发`);
        const a = await this.sendBatch({ ...item, messages: item.messages.slice(0, mid), skipAi: true });
        const b = await this.sendBatch({ ...item, messages: item.messages.slice(mid) });
        return { ok: true, inserted: (a.inserted ?? 0) + (b.inserted ?? 0), triggered: !!b.triggered };
      }
      throw err;
    }
  }

  // ── 重试队列 ────────────────────────────────────────────────────

  enqueueFailed({ wxid, name, isGroup, messages, skipAi }) {
    const item = this.pending.get(wxid) ?? { name, isGroup, messages: [], skipAi: true };
    item.name = name;
    item.isGroup = isGroup;
    item.messages.push(...messages);
    item.skipAi = item.skipAi && skipAi;  // 任一批次需要触发 AI，重试时就不跳过
    if (item.messages.length > this.maxQueuePerContact) {
      item.messages = item.messages.slice(-this.maxQueuePerContact);
    }
    this.pending.set(wxid, item);
    this._saveQueue();
    this.log.warn(`[sync] 已入重试队列：${name} 积压 ${item.messages.length} 条，${this.retryIntervalMs / 1000}s 后重试`);
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this._retryTimer || !this.pending.size) return;
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      await this.flushPending();
      this._scheduleRetry();  // 仍有积压则继续排下一轮
    }, this.retryIntervalMs);
    this._retryTimer.unref?.();
  }

  async flushPending() {
    for (const [wxid, item] of [...this.pending]) {
      this.pending.delete(wxid);  // 先摘下，失败的部分再放回
      this._saveQueue();
      for (let i = 0; i < item.messages.length; i += this.flushBatch) {
        const batch = item.messages.slice(i, i + this.flushBatch);
        try {
          const data = await this.sendBatch({ wxid, name: item.name, isGroup: item.isGroup, messages: batch, skipAi: item.skipAi });
          this.log.log(`[sync] 重试成功 ${item.name}：补传 ${batch.length} 条（触发AI: ${data.triggered ?? false}）`);
        } catch (err) {
          if (err.status && err.status < 500) {
            this.log.error(`[sync] 重试遇 ${err.status}，放弃 ${item.name} 剩余 ${item.messages.length - i} 条（请检查本地/VPS 配置）: ${err.message}`);
          } else {
            this.enqueueFailed({ wxid, name: item.name, isGroup: item.isGroup, messages: item.messages.slice(i), skipAi: item.skipAi });
            this.log.error(`[sync] 重试仍失败 ${item.name}: ${err.message}`);
          }
          break;
        }
      }
    }
  }

  // ── 处理桥接事件 ────────────────────────────────────────────────

  async handleEvent(event) {
    const { wxid, name, isGroup, messages, isFullSync } = event;
    const label = isFullSync ? `[入库 ${messages.length}条]` : messages[messages.length - 1].content.slice(0, 30);
    this.log.log(`[新消息] ${name}(${wxid})${isGroup ? ' [群]' : ''}: ${label}`);

    // 实时消息：若该联系人有积压的失败消息，合并到最前面一起上报（保持时间顺序）
    // 全量同步不合并（防止丢已读但未上报的消息），积压交给重试定时器
    let toSend = messages;
    let skipAi = isFullSync;
    if (!isFullSync && this.pending.has(wxid)) {
      const prev = this.pending.get(wxid);
      this.pending.delete(wxid);
      this._saveQueue();
      toSend = [...prev.messages, ...messages];
      skipAi = prev.skipAi && skipAi;
      this.log.log(`[sync] 合并 ${prev.messages.length} 条积压消息一起上报`);
    }

    const BATCH = toSend.length > this.flushBatch ? this.flushBatch : toSend.length;
    for (let i = 0; i < toSend.length; i += BATCH) {
      const batch = toSend.slice(i, i + BATCH);
      const isLast = i + BATCH >= toSend.length;
      try {
        // 多批时只有最后一批决定是否触发 AI
        const data = await this.sendBatch({ wxid, name, isGroup, messages: batch, skipAi: skipAi || !isLast });
        if (isFullSync) {
          this.log.log(`[sync] ${name} 入库批次 ${Math.floor(i / BATCH) + 1}：写入 ${data.inserted} 条`);
        } else {
          this.log.log(`[sync] 已上报 ${name} 的新消息（写入 ${data.inserted} 条，触发AI: ${data.triggered}）`);
        }
      } catch (err) {
        this.log.error(`[sync] 上报失败: ${err.message}`);
        // 网络错误 / 超时（无 status）或 5xx 入队重试；4xx 配置类错误不重试
        if (!err.status || err.status >= 500) {
          this.enqueueFailed({ wxid, name, isGroup, messages: toSend.slice(i), skipAi });
        }
        break;
      }
    }
  }
}
