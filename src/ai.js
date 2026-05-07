import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import * as db from './db.js';

/**
 * 每个联系人维护独立的状态：
 * - provider:        'gemini' | 'claude'
 * - chat:            Gemini 多轮 chat 对象（仅 Gemini）
 * - messages:        Claude 消息数组（仅 Claude，手动维护多轮历史）
 * - abortController: 用于取消当前正在进行的请求
 */
const sessions = new Map();

/**
 * Gemini 系统提示缓存（全局单例，所有联系人共用）
 * 同一模型 + 同一提示词只创建一次，TTL 1 小时
 */
let _geminiSysCache = null; // { name, hash, expireAt }

// ── Provider detection ────────────────────────────────────────

function getProvider() {
  return config.get().claude?.api_key ? 'claude' : 'gemini';
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

function getClaudeClient() {
  return new Anthropic({ apiKey: config.get().claude.api_key });
}

function getClaudeModelConfig() {
  const cfg = config.get();
  const { model = 'claude-opus-4-7', candidate_count = 3 } = cfg.claude ?? {};
  return { model, candidate_count, systemPrompt: cfg.prompt ?? '' };
}

// Opus 4.7 不支持 temperature 等采样参数，JSON 格式通过系统提示强制输出
function buildClaudeSystem(basePrompt) {
  return `${basePrompt}\n\n请以如下 JSON 格式输出，不要输出任何其他内容：\n{"message": "分析内容（纯文字）", "candidates": ["候选回复1", "候选回复2"]}`;
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

function buildUserMessage(chatHistory, candidateCount, notes) {
  const lines = chatHistory.map(m =>
    `[${formatMsgTime(m.timestamp)}] ${m.is_self ? '我' : '她'}: ${m.content}`);
  const parts = [];
  if (notes) parts.push(`【关于这个人】\n${notes}\n`);
  parts.push('以下是我们最近的聊天记录：', '', ...lines, '');
  parts.push(`请分析当前对话情况并给出 ${candidateCount} 条候选回复。`);
  return parts.join('\n');
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

  if (provider === 'claude') {
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

async function generateSuggestions(contactId, chatHistory, { onChunk, onComplete, onError } = {}, notes = '') {
  const session = await resetSession(contactId);
  const provider = getProvider();
  const candidateCount = provider === 'claude'
    ? getClaudeModelConfig().candidate_count
    : getGeminiModelConfig().candidate_count;
  const userMessage = buildUserMessage(chatHistory, candidateCount, notes);
  await _sendMessage(session, userMessage, { onChunk, onComplete, onError });
}

// ── Restore session（服务重启后追问时从数据库重建内存状态） ──────

async function restoreSession(contactId) {
  return getProvider() === 'claude'
    ? _restoreClaudeSession(contactId)
    : await _restoreGeminiSession(contactId);
}

async function _restoreGeminiSession(contactId) {
  const fullSession = db.getFullAiSession(contactId);
  if (!fullSession?.messages?.length) return null;

  const { model, temperature, systemInstruction, candidate_count } = getGeminiModelConfig();
  const chatHistory = db.getRecentMessages(contactId);
  const firstUserMsg = buildUserMessage(chatHistory, candidate_count, '');

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
  const firstUserMsg = buildUserMessage(chatHistory, candidate_count, '');

  const messages = [{ role: 'user', content: firstUserMsg }];

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
    if (session.provider === 'claude') {
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

// ── Claude streaming ──────────────────────────────────────────

async function _claudeStreamingRequest(session, message, { onChunk, onComplete }) {
  const { model, systemPrompt } = getClaudeModelConfig();

  session.messages.push({ role: 'user', content: message });

  // 构造带缓存标记的消息列表：
  // - 系统提示永远缓存（所有请求共用）
  // - 除当前最新 user 消息外，历史 user 消息均加 cache_control
  //   → 多轮追问时，随轮次增加，命中越来越多的历史前缀
  const apiMessages = session.messages.map((msg, i) => {
    const isLast = i === session.messages.length - 1;
    if (msg.role === 'user' && !isLast) {
      return {
        role: 'user',
        content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
      };
    }
    return msg;
  });

  const stream = getClaudeClient().messages.stream({
    model,
    max_tokens: 8192,
    system: [{ type: 'text', text: buildClaudeSystem(systemPrompt), cache_control: { type: 'ephemeral' } }],
    messages: apiMessages,
  }, { signal: session.abortController.signal });

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

  // 记录缓存使用情况（方便调试成本）
  try {
    const { usage } = await stream.finalMessage();
    const created = usage?.cache_creation_input_tokens ?? 0;
    const hit    = usage?.cache_read_input_tokens ?? 0;
    if (created || hit) {
      console.log(`[ai] Claude 缓存：写入=${created} 命中=${hit} tokens`);
    }
  } catch (_) {}

  session.messages.push({ role: 'assistant', content: buffer });

  try {
    onComplete?.(JSON.parse(buffer));
  } catch (e) {
    throw new Error(`AI 返回了无效的 JSON：${e.message}`);
  }
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

  try {
    onComplete?.(JSON.parse(buffer));
  } catch (e) {
    throw new Error(`AI 返回了无效的 JSON：${e.message}`);
  }
}

async function _geminiBlockingRequest(session, message, { onComplete }) {
  const response = await session.chat.sendMessage(
    { message },
    { signal: session.abortController.signal },
  );
  onComplete?.(JSON.parse(response.text));
}

export { generateSuggestions, followUp, cancelRequest, resetSession };
