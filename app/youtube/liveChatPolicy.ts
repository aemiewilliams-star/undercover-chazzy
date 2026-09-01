export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const PROVIDER_STALL_MS = 60000;

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
