/**
 * wechat_bridge.js
 *
 * 监听 WeChatDataAnalysis（WCDA）实时模式，检测新消息并转成统一格式。
 *
 * 检测策略（2.3.0 实测：messages 接口单次 3~18 秒，sessions 接口约 2.5 秒，
 * 所以不能像旧版那样每轮对全部会话逐个拉消息，那样一轮要几十分钟）：
 *   1. 订阅 WCDA 的 SSE 变更事件 /api/chat/realtime/stream（message/session 库有写入就推送）
 *   2. 收到事件后只拉一次会话列表，比较每个会话的 lastMessage / lastMessageTime / unreadCount
 *      指纹，只对指纹变化的联系人拉最近 context_limit 条消息
 *   3. SSE 断开时退回定时轮询会话列表（poll_interval_ms）；SSE 正常时也每 heartbeat_ms 兜底拉一次
 *
 * WCDA messages 接口语义：realtime 模式总是从最新一条往旧取，offset 从最新数起，
 * order=asc 只是把取到的那一页反转。分页补拉时按这个语义判断是否已覆盖缺口。
 *
 * emit 'new_message' 事件格式：
 * {
 *   wxid:        string,
 *   name:        string,
 *   isGroup:     boolean,
 *   messages:    [{ localId, content, isSelf, createTime, renderType }],
 *   isFullSync:  boolean   // true = 只入库不触发 AI
 * }
 */

import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { initImageAnalyzer, analyzeImage, transcribeVoice } from './image_analyzer.js';
import { isFullSynced, getLastLocalId, markFullSynced, updateLastLocalId } from './sync_state.js';
import { dataFile } from './paths.js';

const PAGE_SIZE = 500;                    // 全量同步每页条数（API 上限）
const FETCH_TIMEOUT_MS = 120_000;         // WCDA 单次请求超时（messages 接口偶尔要十几秒）
const SSE_DEBOUNCE_MS = 800;              // 一条消息会让多个库文件先后变更，合并成一次轮询
const SSE_STALL_MS = 60_000;              // SSE 超过这么久没有任何数据（服务端每 15s 有 ping）就重连
const FIRST_SIGHT_SLACK_MS = 2 * 60_000;  // 首次见到的联系人：比上一轮快照再早这么久的消息都视为旧消息
const WCDA_DOWN_RETRY_MS = 30_000;        // WCDA 连不上（没开软件 / 没开实时模式）时的重试间隔
const CATCHUP_GAP_MS = 3_000;             // 后台补漏时两个联系人之间的间隔，给 WCDA 前端留出余量
const SIG_FILE = 'session_sig.json';      // 会话指纹落盘：重启后能发现停机期间有变化的联系人

// 这些类型即使 isSent=false 也不算"对方来消息"（撤回提示、通话记录），不触发 AI
const NON_TRIGGER_TYPES = new Set(['system', 'voip']);

function sortByTime(list) {
  return [...list].sort((a, b) => (a.createTime - b.createTime) || (a.localId - b.localId));
}

function voiceSeconds(m) {
  return m.voiceLength ? Math.round(Number(m.voiceLength) / 1000) : 0;
}

const text = (s) => String(s ?? '').trim();

class WeChatBridge extends EventEmitter {
  constructor() {
    super();
    this._running = false;
    this._baseUrl = '';
    this._sig = new Map();          // username -> { t, msg, unread } 会话指纹
    this._prevSnapshotAt = 0;       // 上一轮成功拉取会话列表的时间（ms），0 = 还没拉过
    this._polling = false;
    this._dirty = false;
    this._pollTimer = null;
    this._sseDebounce = null;
    this._sseAbort = null;
    this._sseConnected = false;
    this._sseFailures = 0;
    this._fullSyncingNow = new Set();
    // 以下供 getStatus() 上报心跳
    this._lastPollOkAt = 0;
    this._lastPollError = null;
    this._lastEventAt = 0;
    this._wcdaFallback = null;   // WCDA 不在实时模式时 sessions 接口的回退原因
    this._wcdaDown = false;      // WCDA 连不上
    // 后台补漏队列：指纹比对可能漏掉"停机期间到达"或"同一分钟同样预览"的消息，
    // 启动时和每隔几小时对已跟踪的联系人逐个核对一次 lastLocalId
    this._catchup = [];
    this._catchupTimer = null;
    this._catchupDone = 0;
    this._sigPath = dataFile(SIG_FILE);
  }

  /** 当前状态快照（心跳上报 / 排障用） */
  getStatus() {
    return {
      running: this._running,
      sseConnected: this._sseConnected,
      wcdaReachable: !this._wcdaDown,
      wcdaRealtime: !this._wcdaDown && !this._wcdaFallback,
      wcdaFallbackReason: this._wcdaFallback,
      lastPollOkAt: this._lastPollOkAt || null,
      lastPollError: this._lastPollError,
      lastEventAt: this._lastEventAt || null,
      sessions: this._sig.size,
      fullSyncing: [...this._fullSyncingNow],
      catchupPending: this._catchup.length,
    };
  }

  // ── 会话指纹落盘 ────────────────────────────────────────────────

  _loadSigs() {
    if (!existsSync(this._sigPath)) return false;
    try {
      const data = JSON.parse(readFileSync(this._sigPath, 'utf8'));
      if (!data?.sessions || !data.savedAt) return false;
      for (const [u, s] of Object.entries(data.sessions)) this._sig.set(u, s);
      this._prevSnapshotAt = data.savedAt;
      return true;
    } catch {
      return false;
    }
  }

  _saveSigs() {
    try {
      writeFileSync(this._sigPath, JSON.stringify({ savedAt: Date.now(), sessions: Object.fromEntries(this._sig) }), 'utf8');
    } catch (err) {
      console.warn('[bridge] 指纹落盘失败:', err.message);
    }
  }

  // ── 后台补漏 ────────────────────────────────────────────────────

  /** 把已跟踪（有 lastLocalId）的联系人排进补漏队列，逐个核对有没有漏掉的新消息 */
  _enqueueCatchup(reason, usernames = [...this._sig.keys()]) {
    const queued = new Set(this._catchup.map(c => c.username));
    let added = 0;
    for (const username of usernames) {
      if (queued.has(username) || getLastLocalId(username) === -1) continue;
      this._catchup.push({ username, name: this._sig.get(username)?.name || username });
      added++;
    }
    if (added) {
      console.log(`[bridge] 补漏（${reason}）：排队核对 ${added} 个联系人，后台逐个进行，每个几秒`);
      this._schedulePoll('catchup');
    }
  }

  start(config) {
    if (this._running) return;

    const {
      url,
      poll_interval_ms = 5000,
      context_limit = 30,
      sessions_limit = 200,
      sse = true,
      heartbeat_ms = 60_000,
      catchup_interval_hours = 6,
    } = config.wcda;

    this._baseUrl = String(url).replace(/\/+$/, '');
    this._contextLimit = context_limit;
    this._sessionsLimit = sessions_limit;
    this._pollIntervalMs = Math.max(1000, poll_interval_ms);
    this._heartbeatMs = Math.max(10_000, heartbeat_ms);
    this._ignoreGroups = config.ignore_groups ?? true;
    this._debugSelfTrigger = config.debug?.self_trigger ?? false;
    this._analyzeImages = !!(config.gemini?.api_key);

    if (this._analyzeImages) {
      initImageAnalyzer(config.gemini);
      console.log('[bridge] 图片/语音分析已启用（Gemini）');
    } else {
      console.log('[bridge] 未配置 gemini.api_key，图片显示为 [图片]，语音只用微信自带转写');
    }
    if (this._debugSelfTrigger) console.log('[bridge] debug.self_trigger=true，自发消息也会触发');

    this._running = true;
    console.log(
      `[bridge] 启动，后端 ${this._baseUrl}；SSE ${sse ? '开启' : '关闭'}，` +
      `兜底轮询 ${this._heartbeatMs / 1000}s，SSE 不可用时每 ${this._pollIntervalMs / 1000}s 轮询`
    );

    // 上次运行保存的会话指纹：第一轮就能发现停机期间有变化的联系人，而不是把当前状态当基线
    if (this._loadSigs()) {
      console.log(`[bridge] 已载入 ${this._sig.size} 个会话的指纹（保存于 ${new Date(this._prevSnapshotAt).toLocaleString('zh-CN', { hour12: false })}），先比对停机期间的变化`);
    }

    if (sse) this._sseLoop();
    this._armTimer();
    this._schedulePoll('startup');

    // 每隔几小时把已跟踪的联系人逐个核对一遍，兜住指纹比对漏掉的情况
    if (catchup_interval_hours > 0) {
      this._catchupTimer = setInterval(() => this._enqueueCatchup('定时'), catchup_interval_hours * 3600_000);
      this._catchupTimer.unref?.();
    }
  }

  stop() {
    this._running = false;
    clearTimeout(this._pollTimer);
    this._pollTimer = null;
    clearTimeout(this._sseDebounce);
    this._sseDebounce = null;
    clearInterval(this._catchupTimer);
    this._catchupTimer = null;
    this._sseAbort?.abort();
    this._sseAbort = null;
  }

  _fetch(url) {
    return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  }

  // ── 轮询调度：同一时间只跑一个 _poll，期间的触发合并到下一轮 ─────────

  _schedulePoll(reason) {
    this._dirty = true;
    if (this._polling) return;
    this._runPolls(reason);
  }

  async _runPolls(reason) {
    this._polling = true;
    try {
      while (this._running) {
        if (this._dirty) {
          this._dirty = false;
          try {
            await this._poll(reason);
          } catch (err) {
            this._lastPollError = err.message;
            // 连接类错误（没开 WCDA、后端没起来）：只报一次，降低重试频率，恢复后再恢复节奏
            const connErr = err.name === 'TimeoutError' || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(err.message);
            if (connErr && !this._wcdaDown) {
              this._wcdaDown = true;
              console.error(`[bridge] WCDA 不可达（${err.message}），改为每 ${WCDA_DOWN_RETRY_MS / 1000}s 重试，恢复前不再重复提示`);
              this._armTimer();
            } else if (!connErr) {
              console.error('[bridge] 轮询出错:', err.message);
            }
          }
          reason = 'coalesced';
          continue;
        }
        // 没有待处理的事件时，后台补漏一个联系人（事件优先：每处理一个都回到循环顶部看有没有新事件）
        if (this._catchup.length && !this._wcdaDown) {
          const { username, name } = this._catchup.shift();
          try {
            await this._doIncrementalSync(username, name, false, (this._prevSnapshotAt || Date.now()) - FIRST_SIGHT_SLACK_MS);
          } catch (err) {
            console.error(`[bridge] 补漏 ${name} 出错:`, err.message);
          }
          this._catchupDone++;
          if (!this._catchup.length) console.log(`[bridge] 补漏完成，共核对 ${this._catchupDone} 个联系人`);
          if (this._running && !this._dirty) await new Promise(r => setTimeout(r, CATCHUP_GAP_MS));
          continue;
        }
        break;
      }
    } finally {
      this._polling = false;
    }
  }

  // 定时兜底：SSE 正常时每 heartbeat_ms 一次，SSE 断开时每 poll_interval_ms 一次
  _armTimer() {
    clearTimeout(this._pollTimer);
    if (!this._running) return;
    const delay = this._wcdaDown ? WCDA_DOWN_RETRY_MS
      : this._sseConnected ? this._heartbeatMs
      : this._pollIntervalMs;
    this._pollTimer = setTimeout(() => {
      this._schedulePoll(this._sseConnected ? 'heartbeat' : 'timer');
      this._armTimer();
    }, delay);
  }

  // ── SSE 订阅（断线自动重连，期间由定时轮询兜底） ──────────────────────

  _setSseConnected(on) {
    if (this._sseConnected === on) return;
    this._sseConnected = on;
    console.log(on ? '[bridge] SSE 已连接，改为事件驱动' : '[bridge] SSE 已断开，退回定时轮询');
    this._armTimer();
  }

  async _sseLoop() {
    let backoff = 2000;
    while (this._running) {
      const ac = new AbortController();
      this._sseAbort = ac;
      let lastDataAt = Date.now();
      const stallTimer = setInterval(() => {
        if (Date.now() - lastDataAt > SSE_STALL_MS) ac.abort(new Error('SSE 长时间无数据'));
      }, 10_000);

      try {
        const res = await fetch(
          `${this._baseUrl}/api/chat/realtime/stream?interval_ms=500&scope=chat`,
          { signal: ac.signal, headers: { Accept: 'text/event-stream' } }
        );
        if (!res.ok || !res.body) throw new Error(`SSE 接口返回 ${res.status}`);
        this._setSseConnected(true);
        this._sseFailures = 0;
        backoff = 2000;

        let buf = '';
        for await (const chunk of res.body) {
          lastDataAt = Date.now();
          buf += Buffer.from(chunk).toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            this._handleSseFrame(frame);
          }
        }
        throw new Error('连接被服务端关闭');
      } catch (err) {
        if (!this._running) break;
        this._setSseConnected(false);
        const reason = ac.signal.reason?.message || err.message;
        // WCDA 长时间没开时每分钟都会失败一次，只在首次和之后每 10 次打一条
        this._sseFailures++;
        if (this._sseFailures === 1 || this._sseFailures % 10 === 0) {
          console.warn(`[bridge] SSE 中断（${reason}），${backoff / 1000}s 后重连（第 ${this._sseFailures} 次）`);
        }
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      } finally {
        clearInterval(stallTimer);
      }
    }
  }

  _handleSseFrame(frame) {
    const data = frame
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .join('\n');
    if (!data) return;  // ": ping" 心跳行
    let evt;
    try { evt = JSON.parse(data); } catch { return; }
    if (evt.type !== 'change') return;
    this._lastEventAt = Date.now();
    clearTimeout(this._sseDebounce);
    this._sseDebounce = setTimeout(() => this._schedulePoll('sse'), SSE_DEBOUNCE_MS);
  }

  // ── 一轮：拉会话列表，只对指纹变化的联系人拉消息 ──────────────────────

  async _poll(reason) {
    const t0 = Date.now();
    const res = await this._fetch(
      `${this._baseUrl}/api/chat/sessions?source=realtime&limit=${this._sessionsLimit}`
    );
    if (!res.ok) throw new Error(`sessions 接口返回 ${res.status}`);
    const data = await res.json();
    const { sessions } = data;
    this._lastPollOkAt = Date.now();
    this._lastPollError = null;
    if (this._wcdaDown) {
      this._wcdaDown = false;
      console.log('[bridge] WCDA 已恢复');
      this._armTimer();
    }
    // WCDA 没开实时模式时 sessions 会回退到解密快照，新消息不会及时出现，提示一次
    const fallback = data.sourceFallback ? String(data.sourceFallbackReason || data.sourceFallbackMessage || 'fallback') : null;
    if (fallback !== this._wcdaFallback) {
      this._wcdaFallback = fallback;
      if (fallback) console.warn(`[bridge] WCDA 未处于实时模式（${fallback}），请在 WCDA 里点侧边栏的闪电图标开启实时`);
      else console.log('[bridge] WCDA 实时模式已恢复');
    }
    const prevSnapshotAt = this._prevSnapshotAt;
    this._prevSnapshotAt = t0;
    if (!sessions?.length) return;

    const changed = [];
    const unseen = [];   // 本轮新出现、之前没有指纹的会话
    for (const s of sessions) {
      if (this._ignoreGroups && s.isGroup) continue;
      const sig = { t: String(s.lastMessageTime ?? ''), msg: String(s.lastMessage ?? ''), unread: Number(s.unreadCount) || 0, name: s.name };
      const prev = this._sig.get(s.username);
      this._sig.set(s.username, sig);
      if (prev === undefined) {
        unseen.push(s.username);
        if (prevSnapshotAt === 0) continue;   // 完全没有历史指纹（首次运行）：只建立基线
        changed.push(s);                      // 之后新出现的会话：当作有变化
        continue;
      }
      // 只有未读数减少（用户在微信里看了一眼）不算变化，避免白拉一次很慢的 messages 接口
      if (prev.t !== sig.t || prev.msg !== sig.msg || sig.unread > prev.unread) changed.push(s);
    }
    this._saveSigs();

    if (prevSnapshotAt === 0) {
      console.log(`[bridge] 已建立 ${this._sig.size} 个会话的指纹基线（${Date.now() - t0}ms），等待变化`);
      // 没有历史指纹就无法知道停机期间谁来过消息，把已跟踪的联系人排进后台补漏逐个核对
      this._enqueueCatchup('启动');
      return;
    }
    if (reason === 'startup' && unseen.length) {
      // 有历史指纹但个别会话没记录过（上次运行时不在列表里），也核对一下
      this._enqueueCatchup('启动', unseen);
    }
    if (!changed.length) {
      if (reason !== 'heartbeat') console.log(`[bridge] ${reason}: 会话列表无变化（${Date.now() - t0}ms）`);
      return;
    }
    console.log(`[bridge] ${reason}: ${changed.length} 个会话有变化：${changed.map(s => s.name).join('、')}`);

    // 首次见到的联系人用时间判断哪些是新消息：比上一轮快照早的都算旧消息
    const sinceMs = prevSnapshotAt - FIRST_SIGHT_SLACK_MS;
    for (const s of changed) {
      try {
        await this._doIncrementalSync(s.username, s.name, s.isGroup, sinceMs);
      } catch (err) {
        console.error(`[bridge] ${s.name}(${s.username}) 同步出错:`, err.message);
      }
    }
  }

  _isTriggering(m) {
    return !m.isSent && !NON_TRIGGER_TYPES.has(m.renderType);
  }

  _emit(username, name, isGroup, messages, isFullSync) {
    if (!messages.length) return;
    this.emit('new_message', { wxid: username, name, isGroup, messages, isFullSync });
  }

  // ── 增量同步（某个联系人有变化时） ─────────────────────────────────────

  async _doIncrementalSync(username, name, isGroup, sinceMs) {
    const lastSeen = getLastLocalId(username);
    const t0 = Date.now();
    const res = await this._fetch(
      `${this._baseUrl}/api/chat/messages?username=${encodeURIComponent(username)}` +
      `&source=realtime&limit=${this._contextLimit}&order=asc`
    );
    if (!res.ok) {
      console.warn(`[bridge] ${name}: messages 接口返回 ${res.status}`);
      return;
    }
    const { messages } = await res.json();
    if (!messages?.length) return;
    const maxLocalId = Math.max(...messages.map(m => m.localId));

    let newMessages;
    if (lastSeen === -1) {
      // 首次见到：没有本地已读位置，用时间判断——比上一轮快照早的都是旧消息
      newMessages = messages.filter(m => m.createTime * 1000 > sinceMs);
      if (!newMessages.length) {
        updateLastLocalId(username, maxLocalId);
        console.log(`[bridge] ${name}: 首次见到，记录基线 localId=${maxLocalId}（${Date.now() - t0}ms）`);
        return;
      }
    } else {
      if (maxLocalId <= lastSeen) return;
      // 返回的全是新消息且填满了窗口：可能有更早的缺口（离线期间消息超过 context_limit 条），分页补拉
      if (messages.every(m => m.localId > lastSeen) && messages.length >= this._contextLimit) {
        await this._fillGap(username, name, isGroup, lastSeen);
        return;
      }
      newMessages = messages.filter(m => m.localId > lastSeen);
    }

    const hasIncoming = newMessages.some(m => this._isTriggering(m));
    console.log(`[bridge] ${name}: ${newMessages.length} 条新消息${hasIncoming ? '' : '（无对方消息）'}（${Date.now() - t0}ms）`);

    if (!hasIncoming && !this._debugSelfTrigger) {
      // 只有自己发的（或撤回提示等）：上传入库但不触发 AI
      this._emit(username, name, isGroup, await this._processMessages(newMessages, username), true);
      updateLastLocalId(username, maxLocalId);
      return;
    }
    if (!hasIncoming) console.log(`[bridge] debug: ${name} 新消息全为自发，仍触发（self_trigger）`);

    // 收到对方消息且从未全量同步过 → 先补录历史（图片/语音进缓存，下面不会重复调 Gemini）
    await this._ensureFullSynced(username, name, isGroup);

    this._emit(username, name, isGroup, await this._processMessages(newMessages, username), false);
    // 已读位置在处理和上报之后再推进；全量同步成功时已写入更大的值，取大者
    updateLastLocalId(username, Math.max(maxLocalId, getLastLocalId(username)));
  }

  // ── 缺口补拉（本地端离线期间消息超过 context_limit 条） ──────────────

  async _fillGap(username, name, isGroup, lastSeen) {
    console.log(`[bridge] ${name}: 检测到消息缺口（lastSeen=${lastSeen}），分页补拉`);

    let all = [];
    let offset = 0;
    while (true) {
      const res = await this._fetch(
        `${this._baseUrl}/api/chat/messages?username=${encodeURIComponent(username)}` +
        `&source=realtime&limit=${PAGE_SIZE}&offset=${offset}&order=asc`
      );
      if (!res.ok) break;
      const data = await res.json();
      const page = data.messages ?? [];
      if (!page.length) break;
      all = all.concat(page);
      if (!data.hasMore) break;
      // offset 从最新一条往旧数：这一页里最早的一条已不比 lastSeen 新，说明缺口已覆盖
      if (Math.min(...page.map(m => m.localId)) <= lastSeen) break;
      offset += PAGE_SIZE;
    }

    const newMessages = sortByTime(all.filter(m => m.localId > lastSeen));
    if (!newMessages.length) return;
    const maxLocalId = Math.max(...newMessages.map(m => m.localId));
    const hasIncoming = newMessages.some(m => this._isTriggering(m));

    if (hasIncoming) await this._ensureFullSynced(username, name, isGroup);

    const processed = await this._processMessages(newMessages, username);
    console.log(`[bridge] ${name}: 补拉完成，共 ${newMessages.length} 条缺失消息`);
    this._emit(username, name, isGroup, processed, !hasIncoming);  // 全是自发消息则不触发 AI
    updateLastLocalId(username, Math.max(maxLocalId, getLastLocalId(username)));
  }

  // ── 全量同步（首次收到对方消息时补录全部历史） ─────────────────────────

  async _ensureFullSynced(username, name, isGroup) {
    if (isFullSynced(username) || this._fullSyncingNow.has(username)) return;
    this._fullSyncingNow.add(username);
    try {
      await this._doFullSync(username, name, isGroup);
    } catch (err) {
      console.error(`[bridge] ${name}: 全量同步失败:`, err.message);
    } finally {
      this._fullSyncingNow.delete(username);
    }
  }

  async _doFullSync(username, name, isGroup) {
    console.log(`[bridge] ${name}: 开始全量同步历史`);

    let all = [];
    let offset = 0;
    let complete = false;
    while (true) {
      const res = await this._fetch(
        `${this._baseUrl}/api/chat/messages?username=${encodeURIComponent(username)}` +
        `&source=realtime&limit=${PAGE_SIZE}&offset=${offset}&order=asc`
      );
      if (!res.ok) break;
      const data = await res.json();
      const page = data.messages ?? [];
      if (!page.length) { complete = true; break; }
      all = all.concat(page);
      if (!data.hasMore) { complete = true; break; }
      offset += PAGE_SIZE;
    }

    if (!complete) {
      console.warn(`[bridge] ${name}: 全量同步分页中断（已取 ${all.length} 条），本次不标记，下次收到消息时重试`);
      return;
    }
    if (!all.length) {
      markFullSynced(username, -1);
      return;
    }

    // 分页是从最新往旧取的，各页内部升序、页与页之间降序，整体排一次序再上报
    const sorted = sortByTime(all);
    const maxLocalId = Math.max(...sorted.map(m => m.localId));
    const processed = await this._processMessages(sorted, username);
    console.log(`[bridge] ${name}: 全量同步 ${sorted.length} 条历史消息`);
    this._emit(username, name, isGroup, processed, true);
    markFullSynced(username, maxLocalId);
  }

  // ── 消息转换（文本保留，图片/语音转文字，其余转带信息的占位） ───────────

  async _processMessages(messages, username) {
    // 并发转换（Gemini 调用由 image_analyzer 内部限流），结果保持原顺序
    const out = await Promise.all(messages.map(m => this._convert(m, username)));
    return out.filter(Boolean);
  }

  async _convert(m, username) {
    const base = { localId: m.localId, isSelf: !!m.isSent, createTime: m.createTime, renderType: m.renderType };

    switch (m.renderType) {
      case 'text':
        return text(m.content) ? { ...base, content: m.content } : null;

      case 'image':
        return {
          ...base,
          content: this._analyzeImages ? await analyzeImage({ ...m, username }, this._baseUrl) : '[图片]',
        };

      case 'voice': {
        const sec = voiceSeconds(m);
        const tag = sec ? `语音 ${sec}s` : '语音';
        // 微信自带的转写优先，省一次 Gemini 调用
        if (text(m.voiceTranscript)) return { ...base, content: `[${tag}：${text(m.voiceTranscript)}]` };
        if (this._analyzeImages && m.voiceUrl) return { ...base, content: await transcribeVoice(m) };
        return { ...base, content: `[${tag}]` };
      }

      case 'voip':
        return null;  // 通话记录跳过

      case 'quote': {
        const replyText = text(m.content);
        if (!replyText) return null;
        let content = replyText;
        if (text(m.quoteContent)) {
          const who = m.quoteTitle || '对方';
          const quoted = m.quoteContent.length > 60 ? m.quoteContent.slice(0, 60) + '…' : m.quoteContent;
          content = `「${who}: ${quoted}」\n${replyText}`;
        }
        return { ...base, content };
      }

      case 'system': {
        // "你撤回了一条消息" 这类提示 isSent 也是 false，按文案判断是谁的动作
        const c = text(m.content);
        if (!c) return null;
        return { ...base, isSelf: /^你/.test(c) ? true : base.isSelf, content: `[系统消息] ${c}` };
      }

      case 'link':
        return { ...base, content: `[链接：${text(m.title) || text(m.content) || '无标题'}]` };

      case 'chatHistory': {
        const summary = text(m.content).slice(0, 200);
        return { ...base, content: `[转发的聊天记录：${text(m.title) || '无标题'}]${summary ? '\n' + summary : ''}` };
      }

      case 'emoji':
        return { ...base, content: '[表情]' };

      case 'video':
        return { ...base, content: '[视频]' };

      case 'file':
        return { ...base, content: `[文件：${text(m.title) || text(m.content) || '未知文件'}]` };

      case 'location':
        return { ...base, content: `[位置：${text(m.locationPoiname) || text(m.locationLabel) || text(m.content) || '未知'}]` };

      case 'transfer':
        return { ...base, content: text(m.content) ? `[转账] ${text(m.content)}` : `[转账${m.amount ? ' ' + m.amount : ''}]` };

      default:
        if (!m.renderType) return null;
        return { ...base, content: text(m.content) ? `[${m.renderType}] ${text(m.content)}` : `[${m.renderType}]` };
    }
  }
}

export { WeChatBridge, sortByTime, NON_TRIGGER_TYPES };
export default new WeChatBridge();
