export const COLLECTOR_BRIDGE_VERSION = 1 as const;
export const COLLECTOR_BRIDGE_HANDLER = 'undercoverLiveChatCollector';
export const COLLECTOR_BOOTSTRAP_HANDLER = 'undercoverLiveChatCollectorBootstrap';
export const COLLECTOR_PLATFORM = 'youtube' as const;
/** Platforms a collector page can read chat from (owner decision 2026-09-05: CHZZK next). */
export type CollectorPlatform = 'youtube' | 'chzzk';

export type CollectorLiveness = 'connecting' | 'healthy' | 'degraded' | 'failed';

export type CollectorStatusCode =
  | 'not_live'
  | 'innertube_init_failed'
  | 'get_info_failed'
  | 'live_chat_start_failed'
  | 'provider_poll_failed'
  | 'provider_stream_ended'
  | 'provider_stalled'
  | 'reconnect_exhausted'
  | 'invalid_config';

export interface CollectorEvent {
  eventSequence: number;
  occurredAt: number;
  timingSource: 'provider' | 'collector_received';
  authorOpaqueKey: string;
  normalizedText: string;
  platform: CollectorPlatform;
}

export interface CollectorBridgeBase {
  bridgeVersion: typeof COLLECTOR_BRIDGE_VERSION;
  collectorRunId: string;
  bridgeToken: string;
}

export interface CollectorReadyMessage extends CollectorBridgeBase {
  type: 'ready';
}

export interface CollectorBatchMessage extends CollectorBridgeBase {
  type: 'batch';
  batchSequence: number;
  events: CollectorEvent[];
}

export interface CollectorHeartbeatMessage extends CollectorBridgeBase {
  type: 'heartbeat';
  emittedAt: number;
  liveness: CollectorLiveness;
  lastProviderPollStartedAt: number | null;
  lastProviderSuccessAt: number | null;
  lastMessageAt: number | null;
  lastEventSequence: number;
  pendingDepth: number;
  documentHidden: boolean;
  hiddenMsSincePrevious: number;
  droppedByCap: number;
  droppedByNormalizer: number;
}

export interface CollectorPlatformStatusMessage extends CollectorBridgeBase {
  type: 'platform_status';
  status: 'live' | 'ended' | 'unavailable';
  code?: CollectorStatusCode;
}

/**
 * Recorded playback state (work list W7, design v4 §4-3). Sent only when the
 * app advertised `replay-status-v1` in its bootstrap answer; the app checks
 * message keys exactly, so every field below is required except `code`,
 * which exists only with `failed` and is omitted (never null) otherwise.
 */
export type CollectorReplayState = 'prefilling' | 'playing' | 'catching_up' | 'ended' | 'failed';

export interface CollectorReplayStatusMessage extends CollectorBridgeBase {
  type: 'replay_status';
  replayState: CollectorReplayState;
  positionMs: number;
  coveredOffsetMs: number;
  bufferedAheadMs: number;
  bufferedCount: number;
  replayWaitMs: number;
  replayWaitCount: number;
  code?: CollectorStatusCode;
}

export type CollectorBridgeMessage =
  | CollectorReadyMessage
  | CollectorBatchMessage
  | CollectorHeartbeatMessage
  | CollectorPlatformStatusMessage
  | CollectorReplayStatusMessage;

/** Bootstrap feature the app advertises to receive `replay_status` (design v4 §4-2). */
export const COLLECTOR_REPLAY_STATUS_FEATURE = 'replay-status-v1';

/**
 * Recorded playback: the broadcast has ended and the channel kept its chat
 * replay. The collector re-emits that chat at the original pace on the
 * session clock, starting `startOffsetMs` into the video (owner decision
 * 2026-09-05). Absent → live collection, unchanged.
 */
export interface CollectorPlayback {
  kind: 'recorded';
  startOffsetMs: number;
}

export const COLLECTOR_PLAYBACK_MAX_START_OFFSET_MS = 24 * 60 * 60 * 1000;

export interface CollectorRuntimeConfig {
  bridgeToken: string;
  collectorRunId: string;
  playback?: CollectorPlayback;
  /** Optional bridge features the app supports (unknown names are ignored, never an error). */
  features?: string[];
}

/** True when the app asked for `replay_status` messages; older apps (no features) get none. */
export function replayStatusEnabled(config: CollectorRuntimeConfig | null): boolean {
  return config?.features?.includes(COLLECTOR_REPLAY_STATUS_FEATURE) === true;
}

/**
 * The envelope every bridge message carries. Only these three keys: the app
 * checks message keys exactly, so spreading the whole runtime config (which
 * may carry `playback`) makes it refuse ready, heartbeat and batch alike
 * (first recorded-broadcast device test, 2026-09-05).
 */
export function collectorBridgeEnvelope(config: CollectorRuntimeConfig): CollectorBridgeBase {
  return {
    bridgeVersion: COLLECTOR_BRIDGE_VERSION,
    bridgeToken: config.bridgeToken,
    collectorRunId: config.collectorRunId,
  };
}

export function isCollectorPlayback(value: unknown): value is CollectorPlayback {
  if (typeof value !== 'object' || value == null) return false;
  const candidate = value as Partial<CollectorPlayback>;
  return (
    candidate.kind === 'recorded' &&
    typeof candidate.startOffsetMs === 'number' &&
    Number.isInteger(candidate.startOffsetMs) &&
    candidate.startOffsetMs >= 0 &&
    candidate.startOffsetMs <= COLLECTOR_PLAYBACK_MAX_START_OFFSET_MS
  );
}

export function isCollectorRuntimeConfig(value: unknown): value is CollectorRuntimeConfig {
  if (typeof value !== 'object' || value == null) return false;
  const candidate = value as Partial<CollectorRuntimeConfig>;
  const safeId = /^[A-Za-z0-9_-]+$/;
  return (
    typeof candidate.bridgeToken === 'string' &&
    typeof candidate.collectorRunId === 'string' &&
    candidate.bridgeToken.length >= 16 &&
    candidate.bridgeToken.length <= 256 &&
    candidate.collectorRunId.length >= 8 &&
    candidate.collectorRunId.length <= 128 &&
    safeId.test(candidate.bridgeToken) &&
    safeId.test(candidate.collectorRunId) &&
    (candidate.playback === undefined || isCollectorPlayback(candidate.playback)) &&
    (candidate.features === undefined || isFeatureList(candidate.features))
  );
}

function isFeatureList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((entry) => typeof entry === 'string' && /^[a-z0-9-]{1,64}$/.test(entry))
  );
}
