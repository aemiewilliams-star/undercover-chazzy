import { ReplayScheduledItem } from '../youtube/replayScheduler';
import { ChzzkChatItem, chzzkChatItemFromFields, chzzkRecord } from './chzzkChatProtocol';

/**
 * CHZZK VOD chat pages (owner decision 2026-09-05: CHZZK replay after CHZZK
 * live, before multi-source). `GET /service/v1/videos/{no}/chats?playerMessageTime=<ms>`
 * answers up to 200 chats at or after that video offset plus
 * `nextPlayerMessageTime`, the offset to ask for next; `null` once the last
 * chat of the video is in the page (measured 2026-09-05 on a public replay).
 * Each chat carries the same profile/extras/type fields as a live frame, with
 * `playerMessageTime` as its video offset — so it feeds the recorded playback
 * scheduler the YouTube replay path already uses.
 */

export const CHZZK_VIDEO_NO = /^[0-9]{1,12}$/;

export interface ChzzkVideoChatPage {
  items: ReplayScheduledItem<ChzzkChatItem>[];
  /** Offset to request next; null when the video's chat is exhausted. */
  nextPlayerMessageTime: number | null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Parses the `content` object of a VOD chat response. Returns null when the shape is not a chat page. */
export function chzzkVideoChatPage(content: unknown): ChzzkVideoChatPage | null {
  const page = chzzkRecord(content);
  if (page == null || !Array.isArray(page.videoChats)) return null;
  const items: ReplayScheduledItem<ChzzkChatItem>[] = [];
  for (const entry of page.videoChats) {
    const chat = chzzkRecord(entry);
    if (chat == null) continue;
    const offsetMs = finiteNonNegativeInteger(chat.playerMessageTime);
    if (offsetMs == null) continue;
    const item = chzzkChatItemFromFields({
      statusType: chat.messageStatusType,
      typeCode: chat.messageTypeCode,
      extras: chat.extras,
      profile: chat.profile,
      message: chat.content,
      time: chat.messageTime,
    });
    if (item != null) items.push({ offsetMs, action: item });
  }
  const next = finiteNonNegativeInteger(page.nextPlayerMessageTime);
  return { items, nextPlayerMessageTime: next };
}

/**
 * The offset to fetch after a page. Exhausted when the API says so (null),
 * when the page brought nothing, or when the cursor does not move forward —
 * the last guard keeps a stuck cursor from spinning on the same page.
 */
export function chzzkVideoChatNextOffset(page: ChzzkVideoChatPage, requestedOffsetMs: number): number | null {
  if (page.nextPlayerMessageTime == null) return null;
  if (page.items.length === 0) return null;
  if (page.nextPlayerMessageTime <= requestedOffsetMs) return null;
  return page.nextPlayerMessageTime;
}
