/**
 * sync_state.js
 *
 * 持久化每个联系人的同步状态，避免重启后重复全量同步。
 *
 * 文件格式（sync_state.json）：
 * {
 *   "wxid_xxx": { "fullSynced": true, "lastLocalId": 456,
 *     "lastCreateTime": 1789000000, "keysAtLastTime": ["srv:123456789"] }
 * }
 * lastLocalId 仅作诊断信息；消息库轮换时会重置，同步进度由时间和该秒的完整标识决定。
 * 旧状态缺少时间游标时，首次核对保守重放历史，由服务器去重。
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { dataFile } from './paths.js';
import { messageKey } from './message_identity.js';

const STATE_PATH = dataFile('sync_state.json');

function load() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  const temp = `${STATE_PATH}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temp, STATE_PATH);
}

const _state = load();

export function isFullSynced(wxid) {
  return !!_state[wxid]?.fullSynced;
}

export function getLastLocalId(wxid) {
  return _state[wxid]?.lastLocalId ?? -1;
}

export function markFullSynced(wxid, lastLocalId) {
  _state[wxid] = { ..._state[wxid], fullSynced: true, lastLocalId };
  save(_state);
}

export function updateLastLocalId(wxid, lastLocalId) {
  if (!_state[wxid]) _state[wxid] = { fullSynced: false, lastLocalId };
  else _state[wxid].lastLocalId = lastLocalId;
  save(_state);
}

export function trackedCount() {
  return Object.keys(_state).length;
}

export function getSyncCursor(wxid) {
  const s = _state[wxid];
  if (!Number.isFinite(s?.lastCreateTime)) return null;
  return { lastCreateTime: s.lastCreateTime, keysAtLastTime: s.keysAtLastTime || [] };
}

// Advance only after delivery succeeds (or the uploader durably queues the batch).
// localId remains diagnostic metadata; it can go backwards when WeChat rotates DBs.
export function advanceCursor(wxid, messages, { fullSynced } = {}) {
  const old = _state[wxid] || { fullSynced: false, lastLocalId: -1 };
  const next = { ...old };
  if (fullSynced !== undefined) next.fullSynced = fullSynced;
  if (messages.length) {
    const newest = messages.reduce((a, b) => b.createTime >= a.createTime ? b : a);
    const lastCreateTime = Math.max(old.lastCreateTime ?? 0, newest.createTime);
    const keys = new Set(lastCreateTime === old.lastCreateTime ? old.keysAtLastTime : []);
    for (const m of messages) if (m.createTime === lastCreateTime) keys.add(messageKey(m));
    next.lastCreateTime = lastCreateTime;
    next.keysAtLastTime = [...keys];
    if (newest.createTime === lastCreateTime) next.lastLocalId = newest.localId;
  }
  save({ ..._state, [wxid]: next });
  _state[wxid] = next;
}
