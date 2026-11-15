/** Count budget still used by the CHZZK collectors (five tries, then stop). */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const PROVIDER_STALL_MS = 60000;

/**
 * YouTube reconnect steps. The last step repeats: retries keep a 30 s cadence
 * instead of stopping after the fifth one.
 */
export const YOUTUBE_RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
/**
 * How long one outage may last before the collector gives up, measured from its
 * first failure. Time, not tries: on 2026-11-14 a live broadcast whose lookups
 * all said `is_live` but briefly came back without the chat renderer used up the
 * five tries (1+2+4+8+16 s) in 36 s and never collected again.
 */
export const YOUTUBE_RECONNECT_BUDGET_MS = 180_000;
/**
 * The same budget while the latest lookup says the broadcast is live. Owner
 * decision 2026-11-15 ("10분 뒤 실패로"): even a live broadcast whose chat cannot
 * be attached for 10 minutes from the first failure is reported failed.
 */
export const YOUTUBE_RECONNECT_LIVE_BUDGET_MS = 600_000;

interface YoutubeChatAvailability {
  basic_info: { is_live?: boolean };
  playability_status?: { status?: string };
  livechat?: { is_replay?: boolean; continuation?: string } | null;
}

/** Video playback may require sign-in while YouTube still serves public chat.
 * A missing player field is not evidence that the broadcast ended. Use the
 * chat response for chat availability; never turn a replay into live input. */
export function youtubeLiveChatStart(info: YoutubeChatAvailability): 'live' | 'ended' | 'retry' {
  if (info.livechat?.is_replay === true) return 'ended';
  if (
    info.livechat?.is_replay === false &&
    typeof info.livechat.continuation === 'string' &&
    info.livechat.continuation.trim() !== ''
  )
    return 'live';
  if (info.livechat == null && info.playability_status?.status === 'OK' && info.basic_info.is_live === false) {
    return 'ended';
  }
  return 'retry';
}

export function reconnectDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= RECONNECT_BACKOFF_MS.length) return null;
  return RECONNECT_BACKOFF_MS[attempt];
}

export interface YoutubeReconnectState {
  /** Reconnects already scheduled in this outage (0 for the first). */
  attempt: number;
  /** When this outage began: the first failure since the collector was last healthy. */
  outageStartedAt: number;
  now: number;
  /**
   * The latest lookup that answered said the broadcast is live (`is_live`, or a
   * live chat continuation): the outage gets the 10-minute live budget instead
   * of 3 minutes. The session's own end (operator stop, time limit) still stops it.
   */
  stillLive: boolean;
}

/** Delay before the next YouTube reconnect, or null when the outage is over budget. */
export function youtubeReconnectDelayMs({
  attempt,
  outageStartedAt,
  now,
  stillLive,
}: YoutubeReconnectState): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  const budgetMs = stillLive ? YOUTUBE_RECONNECT_LIVE_BUDGET_MS : YOUTUBE_RECONNECT_BUDGET_MS;
  if (now - outageStartedAt >= budgetMs) return null;
  return YOUTUBE_RECONNECT_BACKOFF_MS[Math.min(attempt, YOUTUBE_RECONNECT_BACKOFF_MS.length - 1)];
}

export function providerHasStalled(
  lastProviderSuccessAt: number | null,
  lastProviderPollStartedAt: number | null,
  now: number,
): boolean {
  const referenceAt = lastProviderSuccessAt ?? lastProviderPollStartedAt;
  return referenceAt != null && now - referenceAt > PROVIDER_STALL_MS;
}
