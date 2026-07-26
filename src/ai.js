import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import { query as ccQuery } from '@anthropic-ai/claude-agent-sdk';
import config from './config.js';
import * as db from './db.js';

/**
 * 每个联系人维护独立的状态：
 * - provider:        'gemini' | 'claude' | 'claude-code'
 * - chat:            Gemini 多轮 chat 对象（仅 Gemini）
 * - messages:        Claude 消息数组（仅 Claude API，手动维护多轮历史）
 * - ccSessionId:     Claude Code 会话 id（仅 claude-code，多轮 resume 用）
 * - abortController: 用于取消当前正在进行的请求
 */
const sessions = new Map();

/**
 * Gemini 系统提示缓存（全局单例，所有联系人共用）
 * 同一模型 + 同一提示词只创建一次，TTL 1 小时
 */
let _geminiSysCache = null; // { name, hash, expireAt }

// ── Provider detection ────────────────────────────────────────

// 优先级：Claude Code（Max 订阅，免 API 费）> Claude API > Gemini
function getProvider() {
  const cfg = config.get();
  if (cfg.claude_code?.enabled) return 'claude-code';
  return cfg.claude?.api_key ? 'claude' : 'gemini';
}

// ── Gemini helpers ────────────────────────────────────────────

function getGeminiClient() {
  return new GoogleGenAI({ apiKey: config.get().gemini.api_key });
}

function getGeminiModelConfig() {
  const { model, candidate_count, temperature, stream = true } = config.get().gemini;
  const systemInstruction = config.get().prompt;
  return { model, candidate_count, temperature, stream, systemInstruction };
}

const GEMINI_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message:    { type: 'string' },
    candidates: { type: 'array', items: { type: 'string' } },
  },
  required: ['message', 'candidates'],
};

/**
 * 确保 Gemini 系统提示缓存有效，返回缓存名称（失败则返回 null）。
 * 同一 model + 提示词在 58 分钟内复用同一缓存（避免临近过期的边界问题）。
 */
async function ensureGeminiCache(ai, model, systemInstruction) {
  const now = Date.now();
  const hash = `${model}|${systemInstruction}`;

  if (_geminiSysCache?.hash === hash && _geminiSysCache.expireAt > now) {
    return _geminiSysCache.name;
  }

  try {
    const cache = await ai.caches.create({
      model,
      config: { systemInstruction, ttl: '3600s' },
    });
    _geminiSysCache = { name: cache.name, hash, expireAt: now + 58 * 60 * 1000 };
    console.log('[ai] Gemini 系统提示已缓存:', cache.name);
    return cache.name;
  } catch (e) {
    // 常见原因：提示词不足最低 token 数（Gemini 2.0 Flash 要求 ≥ 1024 tokens）
    console.warn('[ai] Gemini 缓存创建失败，将直接传入提示词:', e.message);
    _geminiSysCache = null;
    return null;
  }
}

// ── Claude helpers ────────────────────────────────────────────

// base_url 指向反代（如 clewdr 的 /code 端点）时，走订阅额度而非 API 计费；
// 反代为 Anthropic 原生格式透传，缓存/thinking/output_config 均照常生效
function getClaudeClient() {
  const { api_key, base_url } = config.get().claude ?? {};
  return new Anthropic({
    apiKey: api_key,
    ...(base_url?.trim() && { baseURL: base_url.trim().replace(/\/+$/, '') }),
  });
}

function getClaudeModelConfig() {
  const cfg = config.get();
  const { model = 'claude-opus-5', candidate_count = 3, effort = 'medium', base_url = '' } = cfg.claude ?? {};
  return { model, candidate_count, effort, base_url, systemPrompt: cfg.prompt ?? '' };
}

// ── Claude Code helpers（Max 订阅，经 Agent SDK 调用，不走 API 计费）──

function getClaudeCodeConfig() {
  const cfg = config.get();
  const cc = cfg.claude_code ?? {};
  return {
    model: cc.model || 'claude-opus-5',
    oauthToken: cc.oauth_token || '',
    candidate_count: cc.candidate_count ?? cfg.claude?.candidate_count ?? 3,
    systemPrompt: cfg.prompt ?? '',
  };
}

// output_config 强制输出合法 JSON，比 prompt 约束更可靠（多轮追问时 Claude 可能在 JSON 前加前缀导致解析失败）
// effort 在请求时按配置注入（不影响 input 缓存命中）
const CLAUDE_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      message:    { type: 'string' },
      candidates: { type: 'array', items: { type: 'string' } },
    },
    required: ['message', 'candidates'],
    additionalProperties: false,
  },
};

// Opus 4.8 不支持 temperature 等采样参数；系统提示只描述字段含义，格式由 output_config 保证
function buildClaudeSystem(basePrompt) {
  return `${basePrompt}\n\n【输出字段说明】\n- message：对当前对话情况的分析和回复建议（纯文字）\n- candidates：具体的候选回复文本列表`;
}

// 1h TTL（GA，无需 beta header）：聊天稀疏时 5 分钟缓存常过期，1 小时显著提升命中率
const CLAUDE_CACHE = { type: 'ephemeral', ttl: '1h' };

// max_tokens 是 thinking + 输出文本的硬上限；effort 越高思考越多，留足空间防 JSON 被截断
const MAX_TOKENS_BY_EFFORT = { low: 16384, medium: 16384, high: 32768, xhigh: 65536, max: 65536 };

// Claude 首条 user content：prefix（聊天记录，打缓存断点）+ suffix（当前时间/指令，不缓存）。
// 对方每发一条新消息，prefix 仅尾部增长，前面部分跨"获取建议"请求稳定命中。
function buildClaudeUserContent(chatHistory, candidateCount, notes, otherName = '对方') {
  const { prefix, suffix } = buildUserMessageParts(chatHistory, candidateCount, notes, otherName);
  return [
    { type: 'text', text: prefix, cache_control: CLAUDE_CACHE },
    { type: 'text', text: suffix },
  ];
}

// ── Shared message formatting ─────────────────────────────────

function formatMsgTime(ts) {
  // getHours() 受 VPS 时区影响；手动偏移到 UTC+8 再用 UTC getter，结果与时区无关
  const d = new Date(ts + 8 * 3600 * 1000);
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mo}月${day}日 ${hh}:${mm}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 当前时间（UTC+8，含年份和星期），让 AI 判断距上一条消息隔了多久、是否该开新话题
function formatNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const yr = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yr}年${mo}月${day}日 ${WEEKDAYS[d.getUTCDay()]} ${hh}:${mm}`;
}

// 拆成 prefix（稳定可缓存：notes + 聊天记录）和 suffix（易变不缓存：当前时间 + 指令）。
// 当前时间放末尾，让前面的聊天记录前缀保持稳定，便于跨请求命中前缀缓存。
function buildUserMessageParts(chatHistory, candidateCount, notes, otherName = '对方') {
  const lines = chatHistory.map(m =>
    `[${formatMsgTime(m.timestamp)}] ${m.is_self ? '我' : otherName}: ${m.content}`);
  const head = [];
  if (notes) head.push(`【关于这个人】\n${notes}\n`);
  head.push('以下是我们最近的聊天记录：', '', ...lines);
  const prefix = head.join('\n');
  const suffix = `\n【当前时间】${formatNow()}\n请分析当前对话情况并给出 ${candidateCount} 条候选回复。`;
  return { prefix, suffix };
}

// 完整 user message（Gemini、预览、restore 用），内容与 Claude 的 prefix+suffix 一致
function buildUserMessage(chatHistory, candidateCount, notes, otherName = '对方') {
  const { prefix, suffix } = buildUserMessageParts(chatHistory, candidateCount, notes, otherName);
  return `${prefix}\n${suffix}`;
}

// ── JSON 解析容错 ─────────────────────────────────────────────

/**
 * 解析 AI 返回的 JSON，逐级降级：
 *   1. 直接 parse（output_config 生效时走这条）
 *   2. 剥离 markdown 代码块（反代忽略 output_config 时模型常包 ```json）
 *   3. 截取首个 { 到末个 }（模型在 JSON 前后加了说明文字）
 */
function parseAiJson(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('返回内容为空');

  try { return JSON.parse(text); } catch (_) { /* 继续降级 */ }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (_) { /* 继续降级 */ }
  }

  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch (_) { /* 落到下面报错 */ }
  }

  throw new Error(`AI 返回了无效的 JSON（前 80 字符：${text.slice(0, 80)}）`);
}

// ── Streaming JSON parser（共享，提取 message 字段值实时输出）────

function makeStreamParser(onChunk) {
  let msgStarted = false;
  let msgDone = false;
  let pending = '';

  return function parse(text) {
    if (!text || msgDone || !onChunk) return;
    pending += text;

    if (!msgStarted) {
      const match = pending.match(/"message"\s*:\s*"/);
      if (!match) return;
      msgStarted = true;
      pending = pending.slice(match.index + match[0].length);
    }

    let out = '';
    let i = 0;
    while (i < pending.length) {
      if (pending[i] === '\\' && i + 1 < pending.length) {
        const esc = pending[i + 1];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
        i += 2;
      } else if (pending[i] === '"') {
        msgDone = true;
        i++;
        break;
      } else {
        out += pending[i++];
      }
    }
    pending = pending.slice(i);
    if (out) onChunk(out);
  };
}

// ── Session management ────────────────────────────────────────

function cancelRequest(contactId) {
  const session = sessions.get(contactId);
  if (session?.abortController) {
    session.abortController.abort();
    session.abortController = new AbortController();
  }
}

async function resetSession(contactId) {
  cancelRequest(contactId);
  const provider = getProvider();

  if (provider === 'claude-code') {
    // ccSessionId 首轮请求完成后由结果回填；contactId 用于持久化 session id 到 db
    sessions.set(contactId, { provider: 'claude-code', contactId, ccSessionId: null, abortController: new AbortController() });
  } else if (provider === 'claude') {
    sessions.set(contactId, { provider: 'claude', messages: [], abortController: new AbortController() });
  } else {
    const { model, temperature, systemInstruction } = getGeminiModelConfig();
    const ai = getGeminiClient();
    const cacheName = await ensureGeminiCache(ai, model, systemInstruction);

    const chat = ai.chats.create({
      model,
      config: {
        temperature,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_JSON_SCHEMA,
        // 有缓存时注入缓存名（系统提示已在缓存中，不再重复传）
        ...(cacheName ? { cachedContent: cacheName } : { systemInstruction }),
      },
    });
    sessions.set(contactId, { provider: 'gemini', chat, abortController: new AbortController() });
  }

  return sessions.get(contactId);
}

// ── Generate suggestions ──────────────────────────────────────

async function generateSuggestions(contactId, chatHistory, { onChunk, onComplete, onError } = {}, notes = '', otherName = '对方') {
  const session = await resetSession(contactId);
  const provider = getProvider();
  const candidateCount =
    provider === 'claude-code' ? getClaudeCodeConfig().candidate_count :
    provider === 'claude'      ? getClaudeModelConfig().candidate_count :
    getGeminiModelConfig().candidate_count;
  // Claude API：拆 prefix（聊天记录，缓存）/ suffix（指令，不缓存）做前缀缓存；
  // Claude Code / Gemini：整串纯文本（Claude Code 内部自己管缓存）
  const userMessage = provider === 'claude'
    ? buildClaudeUserContent(chatHistory, candidateCount, notes, otherName)
    : buildUserMessage(chatHistory, candidateCount, notes, otherName);
  await _sendMessage(session, userMessage, { onChunk, onComplete, onError });
}

// ── Preview（调试用：构造即将发给 AI 的完整内容，不实际请求）──────

function buildAiPreview(chatHistory, notes = '', otherName = '对方') {
  const provider = getProvider();
  if (provider === 'claude-code') {
    const { model, candidate_count, systemPrompt } = getClaudeCodeConfig();
    return {
      provider: 'claude-code（Max 订阅）', model,
      system: buildClaudeSystem(systemPrompt),
      user: buildUserMessage(chatHistory, candidate_count, notes, otherName),
    };
  }
  if (provider === 'claude') {
    const { model, candidate_count, systemPrompt, base_url } = getClaudeModelConfig();
    return {
      provider: base_url ? `claude（反代：${base_url}）` : 'claude（官方 API）',
      model,
      system: buildClaudeSystem(systemPrompt),
      user: buildUserMessage(chatHistory, candidate_count, notes, otherName),
    };
  }
  const { model, candidate_count, systemInstruction } = getGeminiModelConfig();
  return {
    provider, model,
    system: systemInstruction,
    user: buildUserMessage(chatHistory, candidate_count, notes, otherName),
  };
}

// ── Restore session（服务重启后追问时从数据库重建内存状态） ──────

async function restoreSession(contactId) {
  const provider = getProvider();
  if (provider === 'claude-code') return _restoreClaudeCodeSession(contactId);
  return provider === 'claude'
    ? _restoreClaudeSession(contactId)
    : await _restoreGeminiSession(contactId);
}

// Claude Code 的多轮状态存在 VPS 磁盘（~/.claude），重启后凭 db 里的 session id 直接 resume
function _restoreClaudeCodeSession(contactId) {
  const row = db.getAiSession(contactId);
  if (!row?.cc_session_id) return null;
  sessions.set(contactId, {
    provider: 'claude-code', contactId,
    ccSessionId: row.cc_session_id,
    abortController: new AbortController(),
  });
  return sessions.get(contactId);
}

async function _restoreGeminiSession(contactId) {
  const fullSession = db.getFullAiSession(contactId);
  if (!fullSession?.messages?.length) return null;

  const { model, temperature, systemInstruction, candidate_count } = getGeminiModelConfig();
  const chatHistory = db.getRecentMessages(contactId);
  const otherName = db.getContactById(contactId)?.name || '对方';
  const firstUserMsg = buildUserMessage(chatHistory, candidate_count, '', otherName);

  const history = [{ role: 'user', parts: [{ text: firstUserMsg }] }];

  for (const msg of fullSession.messages) {
    if (msg.type === 'ai_round') {
      const raw = JSON.stringify({ message: msg.content.analysis || '', candidates: msg.content.candidates || [] });
      history.push({ role: 'model', parts: [{ text: raw }] });
    } else if (msg.type === 'user') {
      history.push({ role: 'user', parts: [{ text: msg.content }] });
    }
  }

  if (history[history.length - 1].role !== 'model') return null;

  const ai = getGeminiClient();
  const cacheName = await ensureGeminiCache(ai, model, systemInstruction);

  const chat = ai.chats.create({
    model,
    config: {
      temperature, responseMimeType: 'application/json', responseSchema: GEMINI_JSON_SCHEMA,
      ...(cacheName ? { cachedContent: cacheName } : { systemInstruction }),
    },
    history,
  });

  sessions.set(contactId, { provider: 'gemini', chat, abortController: new AbortController() });
  return sessions.get(contactId);
}

function _restoreClaudeSession(contactId) {
  const fullSession = db.getFullAiSession(contactId);
  if (!fullSession?.messages?.length) return null;

  const { candidate_count } = getClaudeModelConfig();
  const chatHistory = db.getRecentMessages(contactId);
  const contact = db.getContactById(contactId);
  const otherName = contact?.name || '对方';
  // 用真实 notes 重建首条（与原始首轮一致），保证 restore 后追问能命中聊天记录前缀缓存
  const firstContent = buildClaudeUserContent(chatHistory, candidate_count, contact?.notes || '', otherName);

  const messages = [{ role: 'user', content: firstContent }];

  for (const msg of fullSession.messages) {
    if (msg.type === 'ai_round') {
      const raw = JSON.stringify({ message: msg.content.analysis || '', candidates: msg.content.candidates || [] });
      messages.push({ role: 'assistant', content: raw });
    } else if (msg.type === 'user') {
      messages.push({ role: 'user', content: msg.content });
    }
  }

  // 最后一条必须是 assistant，才能继续追问
  if (messages[messages.length - 1].role !== 'assistant') return null;

  sessions.set(contactId, { provider: 'claude', messages, abortController: new AbortController() });
  return sessions.get(contactId);
}

// ── Follow up ─────────────────────────────────────────────────

async function followUp(contactId, userText, { onChunk, onComplete, onError } = {}) {
  let session = sessions.get(contactId);
  if (!session) session = await restoreSession(contactId);
  if (!session) {
    onError?.(new Error('没有活跃的 AI session，请先触发一次生成'));
    return;
  }
  cancelRequest(contactId);
  await _sendMessage(session, userText, { onChunk, onComplete, onError });
}

// ── Internal: dispatch to provider ───────────────────────────

async function _sendMessage(session, message, { onChunk, onComplete, onError } = {}) {
  try {
    if (session.provider === 'claude-code') {
      await _claudeCodeStreamingRequest(session, message, { onChunk, onComplete });
    } else if (session.provider === 'claude') {
      await _claudeStreamingRequest(session, message, { onChunk, onComplete });
    } else {
      const { stream } = getGeminiModelConfig();
      if (stream) {
        await _geminiStreamingRequest(session, message, { onChunk, onComplete });
      } else {
        await _geminiBlockingRequest(session, message, { onComplete });
      }
    }
  } catch (err) {
    // 主动取消不报错：Claude 抛 APIUserAbortError，fetch 层抛 AbortError
    if (err instanceof Anthropic.APIUserAbortError || err.name === 'AbortError') return;
    onError?.(err);
  }
}

// ── Claude Code streaming（Agent SDK，走 Max 订阅额度）─────────

async function _claudeCodeStreamingRequest(session, message, { onChunk, onComplete }) {
  const { model, oauthToken, systemPrompt } = getClaudeCodeConfig();

  const q = ccQuery({
    prompt: message,
    options: {
      model,
      systemPrompt: buildClaudeSystem(systemPrompt),  // 整体替换 Claude Code 默认的 agent 系统提示
      ...(session.ccSessionId && { resume: session.ccSessionId }),
      maxTurns: 1,
      tools: [],                                      // 纯文本生成，禁用全部内置工具
      includePartialMessages: true,                   // 开启 stream_event，拿到逐字增量
      outputFormat: { type: 'json_schema', schema: CLAUDE_OUTPUT_FORMAT.schema },
      abortController: session.abortController,
      // 订阅 OAuth token 通过环境变量注入（env 会整体替换子进程环境，必须铺开 process.env）
      ...(oauthToken && { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken } }),
    },
  });

  let buffer = '';
  let structured = null;
  let resultText = null;
  const parse = makeStreamParser(onChunk);

  for await (const m of q) {
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        buffer += e.delta.text;
        parse(e.delta.text);
      }
    } else if (m.type === 'result') {
      session.ccSessionId = m.session_id;
      if (m.subtype === 'success') {
        structured = m.structured_output ?? null;
        resultText = m.result;
      } else {
        const detail = m.errors?.length ? `：${m.errors[0]}` : '';
        throw new Error(`Claude Code 执行失败（${m.subtype}）${detail}`);
      }
    }
  }

  // 持久化 session id：服务重启后可从 db 恢复并 resume 追问
  if (session.ccSessionId && session.contactId != null) {
    try { db.setCcSessionId(session.contactId, session.ccSessionId); } catch (_) {}
  }

  // 优先用 SDK 校验过的结构化输出，退回手动解析
  const result = structured ?? parseAiJson(resultText ?? buffer);
  onComplete?.(result);
}

// ── Claude streaming ──────────────────────────────────────────

async function _claudeStreamingRequest(session, message, { onChunk, onComplete }) {
  const { model, systemPrompt, effort } = getClaudeModelConfig();

  // message：首轮是 [prefix(缓存), suffix] 的 content 数组；追问是纯文本字符串
  session.messages.push({ role: 'user', content: message });

  // Haiku 4.5 不支持 effort / adaptive thinking；其余模型必须显式开 adaptive thinking
  // （否则 Opus 4.8/4.7 不思考 → 回复又快又浅）。Fable 5 始终思考，传 adaptive 也安全。
  const useThinking = !/haiku/i.test(model);

  // 共 2 个缓存断点（≤4 上限）：system + 首条 user 的聊天记录前缀，二者覆盖绝大部分 token。
  // 首条 content 已自带 cache_control，messages 直接用 session.messages 即可。
  const params = {
    model,
    max_tokens: useThinking ? (MAX_TOKENS_BY_EFFORT[effort] ?? 32768) : 8192,
    system: [{ type: 'text', text: buildClaudeSystem(systemPrompt), cache_control: CLAUDE_CACHE }],
    messages: session.messages,
    output_config: { format: CLAUDE_OUTPUT_FORMAT },
  };
  if (useThinking) {
    params.thinking = { type: 'adaptive' };
    params.output_config.effort = effort;
  }
  const stream = getClaudeClient().messages.stream(params, { signal: session.abortController.signal });

  let buffer = '';
  const parse = makeStreamParser(onChunk);

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text;
        if (!text) continue;
        buffer += text;
        parse(text);
      }
    }
  } catch (err) {
    // 回滚：把刚才 push 的 user 消息移除，防止连续 user 消息导致下次请求报错
    session.messages.pop();
    throw err;
  }

  // 记录缓存使用情况（方便调试成本），同时取 stop_reason
  let stopReason = null;
  try {
    const finalMsg = await stream.finalMessage();
    stopReason = finalMsg.stop_reason;
    const created = finalMsg.usage?.cache_creation_input_tokens ?? 0;
    const hit    = finalMsg.usage?.cache_read_input_tokens ?? 0;
    if (created || hit) {
      console.log(`[ai] Claude 缓存：写入=${created} 命中=${hit} tokens`);
    }
  } catch (_) {}

  // Fable 5 安全分类器拒绝时返回 stop_reason: 'refusal'（HTTP 200 而非报错），
  // 此时 buffer 不是合法 JSON，回滚 user 消息并给出明确提示
  if (stopReason === 'refusal') {
    session.messages.pop();
    throw new Error('模型拒绝了本次请求（安全分类器），可在设置中换用 Opus 模型重试');
  }
  // 思考 + 输出耗尽 max_tokens 时 JSON 被截断，给明确提示而非笼统的"无效 JSON"
  if (stopReason === 'max_tokens') {
    session.messages.pop();
    throw new Error('回复被截断（思考占用过多 token），请在设置中降低思考深度');
  }

  session.messages.push({ role: 'assistant', content: buffer });

  onComplete?.(parseAiJson(buffer));
}

// ── Gemini streaming ──────────────────────────────────────────

async function _geminiStreamingRequest(session, message, { onChunk, onComplete }) {
  let buffer = '';
  const parse = makeStreamParser(onChunk);

  const stream = await session.chat.sendMessageStream(
    { message },
    { signal: session.abortController.signal },
  );

  for await (const chunk of stream) {
    const text = chunk.text ?? '';
    if (!text) continue;
    buffer += text;
    parse(text);
  }

  onComplete?.(parseAiJson(buffer));
}

async function _geminiBlockingRequest(session, message, { onComplete }) {
  const response = await session.chat.sendMessage(
    { message },
    { signal: session.abortController.signal },
  );
  onComplete?.(parseAiJson(response.text));
}

export { generateSuggestions, followUp, cancelRequest, resetSession, buildAiPreview };
