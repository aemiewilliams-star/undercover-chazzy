export const COLLECTOR_BRIDGE_VERSION = 1 as const;
export const COLLECTOR_BRIDGE_HANDLER = 'undercoverLiveChatCollector';
export const COLLECTOR_BOOTSTRAP_HANDLER = 'undercoverLiveChatCollectorBootstrap';
export const COLLECTOR_PLATFORM = 'youtube' as const;

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
  platform: typeof COLLECTOR_PLATFORM;
}

interface CollectorBridgeBase {
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

export type CollectorBridgeMessage =
  | CollectorReadyMessage
  | CollectorBatchMessage
  | CollectorHeartbeatMessage
  | CollectorPlatformStatusMessage;

export interface CollectorRuntimeConfig {
  bridgeToken: string;
  collectorRunId: string;
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
    safeId.test(candidate.collectorRunId)
  );
}
