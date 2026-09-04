/**
 * image_analyzer.js
 *
 * 从 WeChatDataAnalysis 拉取图片/语音，调用 Gemini 提取描述或转写，
 * 返回 "[图片：{description}]" / "[语音 Ns：{transcript}]" 格式的文本，可直接替换消息 content。
 *
 * 成功结果按消息 id 持久化缓存（image_cache.json）；失败不缓存，下次遇到会重试。
 */

import { GoogleGenAI } from '@google/genai';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dataFile } from './paths.js';

const CACHE_PATH = dataFile('image_cache.json');
const FETCH_TIMEOUT_MS = 60_000;   // 拉媒体文件的超时

let _client = null;
let _cfg = null;

// 并发限制：最多同时 2 个 Gemini 请求，避免 429
const MAX_CONCURRENT = 2;
let _running = 0;
const _queue = [];

function _acquireSlot() {
  return new Promise((resolve) => {
    if (_running < MAX_CONCURRENT) {
      _running++;
      resolve();
    } else {
      _queue.push(resolve);
    }
  });
}

function _releaseSlot() {
  const next = _queue.shift();
  if (next) {
    next();  // 唤醒队列中下一个等待者（_running 不变，直接转让）
  } else {
    _running--;
  }
}

// 持久化缓存：启动时从文件读取，新增时写回
const _cache = new Map(
  existsSync(CACHE_PATH)
    ? Object.entries(JSON.parse(readFileSync(CACHE_PATH, 'utf8')))
    : []
);

function _saveCache() {
  writeFileSync(CACHE_PATH, JSON.stringify(Object.fromEntries(_cache)), 'utf8');
}

function _imageKey(msg) {
  if (msg.serverId)    return `srv:${msg.serverId}`;
  if (msg.imageMd5)    return `md5:${msg.imageMd5}`;
  if (msg.imageFileId) return `fid:${msg.imageFileId}`;
  if (msg.imageUrl)    return `url:${msg.imageUrl}`;
  return null;
}

export function initImageAnalyzer(geminiConfig) {
  _cfg = geminiConfig;
  _client = new GoogleGenAI({ apiKey: geminiConfig.api_key });
  console.log(`[image_analyzer] 已加载缓存 ${_cache.size} 条`);
}

async function _fetchBytes(url, defaultMime) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mimeType = (res.headers.get('content-type') || defaultMime).split(';')[0];
  const buffer = await res.arrayBuffer();
  return { data: Buffer.from(buffer).toString('base64'), mimeType, size: buffer.byteLength };
}

/**
 * 分析一条图片消息，返回文字描述。
 *
 * @param {object} msg  - 原始消息对象（含 imageUrl / imageMd5 / serverId 等字段）
 * @param {string} wcdaBaseUrl - WeChatDataAnalysis 后端地址（如 http://127.0.0.1:10393）
 * @returns {Promise<string>} 如 "[图片：一只猫趴在沙发上]"
 */
export async function analyzeImage(msg, wcdaBaseUrl) {
  if (!_client || !_cfg) throw new Error('image_analyzer 未初始化，请先调用 initImageAnalyzer()');

  // 命中缓存直接返回，避免重复调用 Gemini
  const cacheKey = _imageKey(msg);
  if (cacheKey && _cache.has(cacheKey)) return _cache.get(cacheKey);

  // 1. 拿到图片 URL
  const imageUrl = resolveImageUrl(msg, wcdaBaseUrl);
  if (!imageUrl) return '[图片：无法获取图片地址]';

  // 2. 拉取图片 bytes（失败不缓存）
  let imageBytes;
  try {
    imageBytes = await _fetchBytes(imageUrl, 'image/jpeg');
  } catch (err) {
    console.warn('[image_analyzer] 拉取图片失败:', err.message);
    return `[图片：获取失败 ${err.message}]`;
  }

  // 3. 调 Gemini Vision（并发限制，最多 MAX_CONCURRENT 个同时进行）
  const prompt = _cfg.image_desc_prompt || '详细描述这张图片的全部内容。如果图片中有文字，请完整转录所有文字。如果是截图，描述界面内容和关键信息。如果是照片，描述场景、人物、物体等细节。';
  await _acquireSlot();
  try {
    const response = await _client.models.generateContent({
      model: _cfg.model || 'gemini-2.0-flash',
      contents: [{
        parts: [
          { inlineData: { data: imageBytes.data, mimeType: imageBytes.mimeType } },
          { text: prompt },
        ],
      }],
    });
    const desc = response.text?.trim();
    if (!desc) return '[图片：AI 未返回描述]';
    const result = `[图片：${desc}]`;
    if (cacheKey) { _cache.set(cacheKey, result); _saveCache(); }
    return result;
  } catch (err) {
    // 失败不进缓存，下次遇到这张图会重试
    console.error('[image_analyzer] Gemini 调用失败:', err.message);
    return '[图片：AI 分析失败]';
  } finally {
    _releaseSlot();
  }
}

/**
 * 转写一条语音消息，返回 "[语音 Ns：{transcript}]" 格式的文本。
 *
 * @param {object} msg  - 原始消息对象（含 voiceUrl、voiceLength 字段）
 * @returns {Promise<string>}
 */
export async function transcribeVoice(msg) {
  if (!_client || !_cfg) throw new Error('image_analyzer 未初始化，请先调用 initImageAnalyzer()');

  const sec = msg.voiceLength ? Math.round(Number(msg.voiceLength) / 1000) : 0;
  const tag = sec ? `语音 ${sec}s` : '语音';
  if (!msg.voiceUrl) return `[${tag}]`;

  const cacheKey = `voice:${msg.voiceUrl}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // 下载音频（失败不缓存）
  let audio;
  try {
    audio = await _fetchBytes(msg.voiceUrl, 'audio/wav');
  } catch (err) {
    console.warn('[voice] 拉取语音失败:', err.message);
    return `[${tag}：获取失败 ${err.message}]`;
  }

  // 调 Gemini 转写（并发限制）
  await _acquireSlot();
  try {
    const response = await _client.models.generateContent({
      model: _cfg.model || 'gemini-2.0-flash',
      contents: [{
        parts: [
          { inlineData: { data: audio.data, mimeType: audio.mimeType } },
          { text: '请将这段语音原文完整转写为文字，只输出转写内容，不要加任何解释或标点说明。' },
        ],
      }],
    });
    const transcript = response.text?.trim();
    if (!transcript) return `[${tag}]`;
    const result = `[${tag}：${transcript}]`;
    _cache.set(cacheKey, result);
    _saveCache();
    return result;
  } catch (err) {
    console.error('[voice] Gemini 转写失败:', err.message);
    return `[${tag}]`;
  } finally {
    _releaseSlot();
  }
}

/**
 * 从消息字段拼出可访问的图片 URL。
 * 优先用 md5 / file_id 构造高清原图（消息里预拼好的 imageUrl 是缩略图）；
 * 降级用 imageUrl，最后用 serverId。
 */
function resolveImageUrl(msg, wcdaBaseUrl) {
  const base = wcdaBaseUrl.replace(/\/$/, '');
  const account = msg.account || '';
  const username = msg.username || '';

  if (msg.imageMd5 || msg.imageFileId) {
    const params = new URLSearchParams();
    if (account)         params.set('account',  account);
    if (msg.imageMd5)    params.set('md5',      msg.imageMd5);
    if (msg.imageFileId) params.set('file_id',  msg.imageFileId);
    if (username)        params.set('username', username);
    params.set('v', '9');  // 请求高清版本
    return `${base}/api/chat/media/image?${params}`;
  }

  if (msg.imageUrl && msg.imageUrl.startsWith('http')) return msg.imageUrl;

  if (msg.serverId) {
    const params = new URLSearchParams({ server_id: String(msg.serverId) });
    if (account)  params.set('account',  account);
    if (username) params.set('username', username);
    return `${base}/api/chat/media/image?${params}`;
  }

  return null;
}
