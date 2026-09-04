/**
 * sync_state.js
 *
 * 持久化每个联系人的同步状态，避免重启后重复全量同步。
 *
 * 文件格式（sync_state.json）：
 * {
 *   "wxid_xxx": { "fullSynced": true, "lastLocalId": 456 }
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dataFile } from './paths.js';

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
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

const _state = load();

export function isFullSynced(wxid) {
  return !!_state[wxid]?.fullSynced;
}

export function getLastLocalId(wxid) {
  return _state[wxid]?.lastLocalId ?? -1;
}

export function markFullSynced(wxid, lastLocalId) {
  _state[wxid] = { fullSynced: true, lastLocalId };
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
