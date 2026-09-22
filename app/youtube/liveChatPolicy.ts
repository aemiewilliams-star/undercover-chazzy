export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const PROVIDER_STALL_MS = 60000;

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

export function providerHasStalled(
  lastProviderSuccessAt: number | null,
  lastProviderPollStartedAt: number | null,
  now: number,
): boolean {
  const referenceAt = lastProviderSuccessAt ?? lastProviderPollStartedAt;
  return referenceAt != null && now - referenceAt > PROVIDER_STALL_MS;
}
