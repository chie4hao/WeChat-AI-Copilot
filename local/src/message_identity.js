import { createHash } from 'node:crypto';

// serverIdStr preserves the full 64-bit ID; the JSON number may already be rounded.
export function messageKey(message) {
  if (/^[1-9]\d*$/.test(message.serverIdStr || '')) return `srv:${message.serverIdStr}`;
  if (Number.isSafeInteger(message.serverId) && message.serverId > 0) return `srv:${message.serverId}`;
  if (message.id) return `wcda:${message.id}`; // database:table:localId
  const fields = [message.localId, message.createTime, !!message.isSent, message.renderType, message.content];
  return `legacy:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
}

export function isAfterCursor(message, cursor) {
  return !cursor || message.createTime > cursor.lastCreateTime ||
    (message.createTime === cursor.lastCreateTime && !cursor.keysAtLastTime.includes(messageKey(message)));
}
