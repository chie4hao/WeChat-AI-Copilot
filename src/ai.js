import { GoogleGenAI } from '@google/genai';
import config from './config.js';

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
 */
function buildUserMessage(chatHistory, candidateCount) {
  const lines = chatHistory.map(m => `${m.is_self ? '我' : '她'}: ${m.content}`);
  return [
    '以下是我们最近的聊天记录：',
    '',
    ...lines,
    '',
    `请根据以上对话，给出 ${candidateCount} 条候选回复建议。`,
  ].join('\n');
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
          analysis:   { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
        },
        required: ['analysis', 'candidates'],
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
 * @param {Function} callbacks.onChunk     每收到一个文本 chunk 时回调
 * @param {Function} callbacks.onComplete  生成完成时回调，参数为解析后的 { analysis, candidates }
 * @param {Function} callbacks.onError     出错时回调
 */
async function generateSuggestions(contactId, chatHistory, { onChunk, onComplete, onError } = {}) {
  const session = resetSession(contactId);
  const { candidate_count } = getGeminiConfig();
  const userMessage = buildUserMessage(chatHistory, candidate_count);

  await streamMessage(session, userMessage, { onChunk, onComplete, onError });
}

/**
 * 流式追问（用户输入追问文本时调用）
 *
 * @param {number}   contactId
 * @param {string}   userText    用户追问内容
 * @param {object}   callbacks
 */
async function followUp(contactId, userText, { onChunk, onComplete, onError } = {}) {
  const session = sessions.get(contactId);
  if (!session) {
    onError?.(new Error('没有活跃的 AI session，请先触发一次生成'));
    return;
  }

  // 取消当前请求，但保留 chat（保持追问上下文）
  cancelRequest(contactId);

  await streamMessage(session, userText, { onChunk, onComplete, onError });
}

/**
 * 内部：发送消息，根据配置走流式或非流式
 */
async function streamMessage(session, message, { onChunk, onComplete, onError } = {}) {
  const { stream } = getGeminiConfig();

  try {
    if (stream) {
      await _streamingRequest(session, message, { onChunk, onComplete });
    } else {
      await _blockingRequest(session, message, { onComplete });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      // 主动取消，不作为错误处理
      return;
    }
    onError?.(err);
  }
}

async function _streamingRequest(session, message, { onChunk, onComplete }) {
  let buffer = '';

  const stream = await session.chat.sendMessageStream(
    { message },
    { signal: session.abortController.signal },
  );

  for await (const chunk of stream) {
    const text = chunk.text ?? '';
    if (text) {
      buffer += text;
      onChunk?.(text);
    }
  }

  onComplete?.(JSON.parse(buffer));
}

async function _blockingRequest(session, message, { onComplete }) {
  const response = await session.chat.sendMessage(
    { message },
    { signal: session.abortController.signal },
  );

  onComplete?.(JSON.parse(response.text));
}

export { generateSuggestions, followUp, cancelRequest, resetSession };
