import { GoogleGenAI } from '@google/genai';
import config from './config.js';
import * as db from './db.js';

/**
 * 每个联系人维护独立的状态：
 * - chat:            Gemini 多轮 chat 对象（追问时保持上下文）
 * - abortController: 用于取消当前正在进行的请求
 */
const sessions = new Map(); // contactId(number) -> { chat, abortController }

function getClient() {
  const { api_key } = config.get().gemini;
  return new GoogleGenAI({ apiKey: api_key });
}

function getGeminiConfig() {
  const { model, candidate_count, temperature, stream = true } = config.get().gemini;
  const systemInstruction = config.get().prompt;
  return { model, candidate_count, temperature, stream, systemInstruction };
}

/**
 * 构造发给 Gemini 的用户消息：把微信聊天记录格式化为文本
 *
 * @param {Array}  chatHistory      来自 db.getRecentMessages() 的消息数组
 * @param {number} candidateCount   候选数量
 * @param {string} notes            联系人备注（可选）
 */
function buildUserMessage(chatHistory, candidateCount, notes) {
  const lines = chatHistory.map(m => `${m.is_self ? '我' : '她'}: ${m.content}`);
  const parts = [];

  if (notes) {
    parts.push(`【关于这个人】\n${notes}\n`);
  }

  parts.push('以下是我们最近的聊天记录：', '', ...lines, '');
  parts.push(`请分析当前对话情况并给出 ${candidateCount} 条候选回复。`);

  return parts.join('\n');
}

/**
 * 重置某个联系人的 Gemini chat session（对方发新消息时调用）。
 * 同时取消正在进行的请求。
 */
function resetSession(contactId) {
  cancelRequest(contactId);

  const { model, temperature, systemInstruction } = getGeminiConfig();
  const chat = getClient().chats.create({
    model,
    config: {
      temperature,
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          message:    { type: 'string' }, // AI 自由发挥的分析和建议
          candidates: { type: 'array', items: { type: 'string' } }, // 候选回复
        },
        required: ['message', 'candidates'],
      },
    },
  });

  sessions.set(contactId, { chat, abortController: new AbortController() });
  return sessions.get(contactId);
}

/**
 * 取消当前请求（不销毁 chat session，追问时只取消请求、保留上下文）
 */
function cancelRequest(contactId) {
  const session = sessions.get(contactId);
  if (session?.abortController) {
    session.abortController.abort();
    session.abortController = new AbortController();
  }
}

/**
 * 流式生成建议（对方发新消息时调用）
 *
 * @param {number}   contactId
 * @param {Array}    chatHistory   db.getRecentMessages() 的结果
 * @param {object}   callbacks
 * @param {Function} callbacks.onChunk     每收到一个文本 chunk 时回调（流式模式）
 * @param {Function} callbacks.onComplete  生成完成时回调，参数为解析后的 { message, candidates }
 * @param {Function} callbacks.onError     出错时回调
 */
async function generateSuggestions(contactId, chatHistory, { onChunk, onComplete, onError } = {}, notes = '') {
  const session = resetSession(contactId);
  const { candidate_count } = getGeminiConfig();
  const userMessage = buildUserMessage(chatHistory, candidate_count, notes);

  await _sendMessage(session, userMessage, { onChunk, onComplete, onError });
}

/**
 * 从数据库恢复 chat session（服务重启后追问时调用）
 */
function restoreSession(contactId) {
  const fullSession = db.getFullAiSession(contactId);
  if (!fullSession?.messages?.length) return null;

  const { model, temperature, systemInstruction } = getGeminiConfig();

  // 重建 Gemini chat history：ai_round → model turn，user → user turn
  // 第一轮 user 消息用当前聊天记录重建
  const { candidate_count } = getGeminiConfig();
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

  // 最后一条必须是 model，才能继续追问；否则 history 不完整不恢复
  if (history[history.length - 1].role !== 'model') return null;

  const chat = getClient().chats.create({
    model,
    config: { temperature, systemInstruction, responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: {
        message: { type: 'string' }, candidates: { type: 'array', items: { type: 'string' } },
      }, required: ['message', 'candidates'] },
    },
    history,
  });

  sessions.set(contactId, { chat, abortController: new AbortController() });
  return sessions.get(contactId);
}

/**
 * 流式追问（用户输入追问文本时调用）
 */
async function followUp(contactId, userText, { onChunk, onComplete, onError } = {}) {
  let session = sessions.get(contactId);

  // 服务重启后内存里没有 session，尝试从 db 恢复
  if (!session) {
    session = restoreSession(contactId);
  }

  if (!session) {
    onError?.(new Error('没有活跃的 AI session，请先触发一次生成'));
    return;
  }

  cancelRequest(contactId);
  await _sendMessage(session, userText, { onChunk, onComplete, onError });
}

/**
 * 内部：发送消息，根据配置走流式或非流式
 */
async function _sendMessage(session, message, { onChunk, onComplete, onError } = {}) {
  const { stream } = getGeminiConfig();

  try {
    if (stream) {
      await _streamingRequest(session, message, { onChunk, onComplete });
    } else {
      await _blockingRequest(session, message, { onComplete });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return; // 主动取消，不作为错误处理
    }
    onError?.(err);
  }
}

async function _streamingRequest(session, message, { onChunk, onComplete }) {
  let buffer = '';
  // 流式 JSON 解析状态：只提取 message 字段的值发给前端
  let msgStarted = false;
  let msgDone = false;
  let pending = '';

  const stream = await session.chat.sendMessageStream(
    { message },
    { signal: session.abortController.signal },
  );

  for await (const chunk of stream) {
    const text = chunk.text ?? '';
    if (!text) continue;
    buffer += text;

    if (msgDone || !onChunk) continue;

    pending += text;

    if (!msgStarted) {
      const match = pending.match(/"message"\s*:\s*"/);
      if (!match) continue;
      msgStarted = true;
      pending = pending.slice(match.index + match[0].length);
    }

    // 扫描 pending，输出直到遇到未转义的结束引号
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
  }

  try {
    onComplete?.(JSON.parse(buffer));
  } catch (e) {
    throw new Error(`AI 返回了无效的 JSON：${e.message}`);
  }
}

async function _blockingRequest(session, message, { onComplete }) {
  const response = await session.chat.sendMessage(
    { message },
    { signal: session.abortController.signal },
  );

  onComplete?.(JSON.parse(response.text));
}

export { generateSuggestions, followUp, cancelRequest, resetSession };
