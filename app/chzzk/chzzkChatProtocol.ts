/**
 * CHZZK chat WebSocket protocol, the parts the collector needs (from the base
 * project's useChatList, kept pure so it can be tested without a socket).
 *
 * Frames are JSON. The client sends CONNECT with a READ access token, answers
 * PING with PONG, and receives CHAT / CHEESE_CHAT frames whose `bdy` is an
 * array of chats. Each chat carries `profile` and `extras` as JSON strings.
 */

export const CHZZK_CHAT_HOSTS: readonly string[] = [
  'wss://kr-ss1.chat.naver.com/chat',
  'wss://kr-ss2.chat.naver.com/chat',
  'wss://kr-ss3.chat.naver.com/chat',
];

export const ChzzkCmd = {
  PING: 0,
  PONG: 10000,
  CONNECT: 100,
  CONNECTED: 10100,
  RECENT_CHAT: 15101,
  CHAT: 93101,
  CHEESE_CHAT: 93102,
  BLIND: 94008,
} as const;

const MSG_TYPE_CHAT = 1;
const MSG_TYPE_CHEESE = 10;
const EMOJI_MARKUP = /\{:[a-zA-Z0-9_]+:\}/g;

export interface ChzzkChatItem {
  /** Opaque viewer id from the chat profile; hashed with the session salt on the app side. */
  authorOpaqueKey: string;
  /** Message text with `{:emoji:}` markup replaced by the placeholder. */
  text: string;
  /** Provider timestamp (ms). */
  timestamp: number | null;
}

export function chzzkConnectFrame(chatChannelId: string, accessToken: string): string {
  return JSON.stringify({
    bdy: { accTkn: accessToken, auth: 'READ', devType: 2001, uid: null },
    cmd: ChzzkCmd.CONNECT,
    tid: 1,
    cid: chatChannelId,
    svcid: 'game',
    ver: '2',
  });
}

export function chzzkPongFrame(): string {
  return JSON.stringify({ ver: '2', cmd: ChzzkCmd.PONG });
}

export function chzzkPingFrame(): string {
  return JSON.stringify({ ver: '2', cmd: ChzzkCmd.PING });
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

export interface ChzzkFrame {
  cmd: number;
  body: unknown;
}

export function parseChzzkFrame(raw: unknown): ChzzkFrame | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const frame = record(parsed);
  if (frame == null || typeof frame.cmd !== 'number') return null;
  return { cmd: frame.cmd, body: frame.bdy };
}

/** Text chats and text-bearing cheese chats from a CHAT / CHEESE_CHAT frame; hidden and system entries dropped. */
export function chzzkChatItemsFromBody(body: unknown): ChzzkChatItem[] {
  if (!Array.isArray(body)) return [];
  const items: ChzzkChatItem[] = [];
  for (const entry of body) {
    const chat = record(entry);
    if (chat == null) continue;
    if (chat.msgStatusType === 'HIDDEN') continue;
    const typeCode = chat.msgTypeCode;
    if (typeCode !== MSG_TYPE_CHAT && typeCode !== MSG_TYPE_CHEESE) continue;
    const extras = parseJsonRecord(chat.extras);
    if (typeCode === MSG_TYPE_CHEESE && extras?.donationType !== 'CHAT') continue;
    const profile = parseJsonRecord(chat.profile);
    const authorOpaqueKey = typeof profile?.userIdHash === 'string' ? profile.userIdHash : null;
    if (authorOpaqueKey == null || !/^[A-Za-z0-9_-]{1,128}$/.test(authorOpaqueKey)) continue;
    const message = typeof chat.msg === 'string' ? chat.msg : '';
    const text = message.replace(EMOJI_MARKUP, '[이모지]');
    const timestamp = typeof chat.msgTime === 'number' && Number.isFinite(chat.msgTime) ? chat.msgTime : null;
    items.push({ authorOpaqueKey, text, timestamp });
  }
  return items;
}
