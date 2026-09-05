import { CollectorEvent } from './contracts';
import { MessageRun } from '../youtube/types';

export const COLLECTOR_TEXT_MAX_CODEPOINTS = 500;
export const AUTHOR_OPAQUE_KEY_MAX_CODEPOINTS = 128;

export type NormalizationFailureReason = 'text_empty' | 'text_too_long' | 'author_missing' | 'author_invalid';

export type NormalizedCollectorEvent = Omit<CollectorEvent, 'eventSequence'>;

export type NormalizeCollectorEventResult =
  | { ok: true; event: NormalizedCollectorEvent }
  | { ok: false; reason: NormalizationFailureReason };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const URL = /https?:\/\/[^\s]+/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?82[-.\s]?)?(?:0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}/g;
const MENTION = /(^|\s)@[A-Za-z0-9_.-]{2,64}/g;

/** The text cleanup every platform shares: control characters, URLs, emails, phones, mentions, whitespace. */
export function normalizeChatText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(CONTROL_CHARACTERS, '')
    .replace(URL, '[URL]')
    .replace(EMAIL, '[이메일]')
    .replace(PHONE, '[전화번호]')
    .replace(MENTION, '$1[멘션]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeMessageRuns(runs: MessageRun[] | undefined): string {
  const raw = (runs ?? [])
    .map((run) => {
      // Emoji first: replay pages put the custom emoji's resource id into
      // `text` next to `emoji`, which leaked ids like "UC…/2sIf…" into the
      // chat text (first recorded-broadcast device test, 2026-09-05).
      if (run.emoji != null) return '[이모지]';
      if (typeof run.text === 'string') return run.text;
      return '';
    })
    .join('');
  return normalizeChatText(raw);
}

export function normalizeProviderTimestamp(
  rawTimestamp: unknown,
  collectorReceivedAt: number,
): Pick<CollectorEvent, 'occurredAt' | 'timingSource'> {
  const numeric = rawTimestamp instanceof Date ? rawTimestamp.getTime() : Number(rawTimestamp);
  let occurredAt = numeric;

  if (Number.isFinite(numeric)) {
    if (numeric >= 1e15) occurredAt = numeric / 1000;
    else if (numeric < 1e11) occurredAt = numeric * 1000;
  }

  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(occurredAt) || Math.abs(occurredAt - collectorReceivedAt) > oneYearMs) {
    return { occurredAt: collectorReceivedAt, timingSource: 'collector_received' };
  }

  return { occurredAt: Math.round(occurredAt), timingSource: 'provider' };
}

export function normalizeYoutubeTextMessage(input: {
  authorOpaqueKey: unknown;
  timestamp: unknown;
  runs: MessageRun[] | undefined;
  collectorReceivedAt: number;
}): NormalizeCollectorEventResult {
  const authorOpaqueKey = typeof input.authorOpaqueKey === 'string' ? input.authorOpaqueKey.trim() : '';
  if (authorOpaqueKey === '') return { ok: false, reason: 'author_missing' };
  if (
    !/^[A-Za-z0-9_-]+$/.test(authorOpaqueKey) ||
    Array.from(authorOpaqueKey).length > AUTHOR_OPAQUE_KEY_MAX_CODEPOINTS
  ) {
    return { ok: false, reason: 'author_invalid' };
  }

  const normalizedText = normalizeMessageRuns(input.runs);
  if (normalizedText === '') return { ok: false, reason: 'text_empty' };
  if (Array.from(normalizedText).length > COLLECTOR_TEXT_MAX_CODEPOINTS) {
    return { ok: false, reason: 'text_too_long' };
  }

  return {
    ok: true,
    event: {
      ...normalizeProviderTimestamp(input.timestamp, input.collectorReceivedAt),
      authorOpaqueKey,
      normalizedText,
      platform: 'youtube',
    },
  };
}

/**
 * CHZZK chat → collector event. `text` already has `{:emoji:}` markup replaced
 * by the protocol module; `authorOpaqueKey` is the profile's userIdHash (the
 * app hashes it again with the session salt and the platform prefix).
 */
export function normalizeChzzkTextMessage(input: {
  authorOpaqueKey: unknown;
  text: unknown;
  timestamp: unknown;
  collectorReceivedAt: number;
}): NormalizeCollectorEventResult {
  const authorOpaqueKey = typeof input.authorOpaqueKey === 'string' ? input.authorOpaqueKey.trim() : '';
  if (authorOpaqueKey === '') return { ok: false, reason: 'author_missing' };
  if (
    !/^[A-Za-z0-9_-]+$/.test(authorOpaqueKey) ||
    Array.from(authorOpaqueKey).length > AUTHOR_OPAQUE_KEY_MAX_CODEPOINTS
  ) {
    return { ok: false, reason: 'author_invalid' };
  }
  const normalizedText = normalizeChatText(typeof input.text === 'string' ? input.text : '');
  if (normalizedText === '') return { ok: false, reason: 'text_empty' };
  if (Array.from(normalizedText).length > COLLECTOR_TEXT_MAX_CODEPOINTS) {
    return { ok: false, reason: 'text_too_long' };
  }
  return {
    ok: true,
    event: {
      ...normalizeProviderTimestamp(input.timestamp, input.collectorReceivedAt),
      authorOpaqueKey,
      normalizedText,
      platform: 'chzzk',
    },
  };
}
