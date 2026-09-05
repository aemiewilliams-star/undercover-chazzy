import { useEffect, useRef, useState } from 'react';
import { CollectorPlayback, CollectorStatusCode } from '../collector/contracts';
import {
  COLLECTOR_PROXY_HEADER,
  COLLECTOR_PROXY_HEADER_VALUE,
  CollectorProxyConfigurationError,
  resolveCollectorProxyBaseUrl,
} from '../youtube/innertubeFetch';
import { YoutubeLiveChatHealth } from '../youtube/useLiveChat';
import { reconnectDelayMs } from '../youtube/liveChatPolicy';
import { ReplayScheduler } from '../youtube/replayScheduler';
import { ChzzkChatItem } from './chzzkChatProtocol';
import { CHZZK_VIDEO_NO, chzzkVideoChatNextOffset, chzzkVideoChatPage } from './chzzkVideoChat';

/**
 * CHZZK recorded playback for the collector page (owner decision 2026-09-05:
 * CHZZK replay after CHZZK live). Mirrors the YouTube recorded branch of
 * useLiveChat: chat pages are fetched at the scheduler position through our
 * proxy, buffered a couple of minutes ahead, and each chat is released when
 * the session clock reaches its video offset — original spacing, not a drain.
 *
 * Same health vocabulary as the live hooks so the bridge, heartbeats and the
 * app stay identical. The page's own timestamp is not used for `occurredAt`:
 * the normalizer stamps `collector_received` at emission, as for YouTube
 * replays, so ranking windows run on the session clock.
 */

const REPLAY_TICK_MS = 250;
const REPLAY_FETCH_MIN_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 8_000;

export type ChzzkVideoChatHealth = YoutubeLiveChatHealth;

export interface ChzzkVideoChatOptions {
  onHealthUpdate?: (health: ChzzkVideoChatHealth) => void;
  onPlatformStatus?: (status: 'live' | 'ended' | 'unavailable', code?: CollectorStatusCode) => void;
}

const INITIAL_HEALTH: ChzzkVideoChatHealth = {
  liveness: 'connecting',
  lastProviderPollStartedAt: null,
  lastProviderSuccessAt: null,
  lastMessageAt: null,
  reconnectAttempt: 0,
};

function diag(fields: Record<string, string | number | boolean | undefined>): void {
  try {
    const body = JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/collector/diag', new Blob([body], { type: 'application/json' }));
    }
  } catch {
    // diagnostics never affect collection
  }
}

async function proxyContent(proxyBase: URL, path: string, signal: AbortSignal): Promise<unknown> {
  const url = new URL(path, proxyBase);
  const response = await fetch(url, {
    headers: { accept: 'application/json', [COLLECTOR_PROXY_HEADER]: COLLECTOR_PROXY_HEADER_VALUE },
    signal,
  });
  if (!response.ok) throw new Error(`chzzk_proxy_${response.status}`);
  const parsed = (await response.json()) as { code?: unknown; content?: unknown };
  if (parsed?.code !== 200 || parsed.content == null || typeof parsed.content !== 'object') {
    throw new Error('chzzk_api_code');
  }
  return parsed.content;
}

export default function useChzzkVideoChat(
  videoNo: string | undefined,
  playback: CollectorPlayback | undefined,
  handleChat: (item: ChzzkChatItem) => void,
  options: ChzzkVideoChatOptions = {},
) {
  const [health, setHealth] = useState<ChzzkVideoChatHealth>(INITIAL_HEALTH);
  const chatRef = useRef(handleChat);
  const optionsRef = useRef(options);
  chatRef.current = handleChat;
  optionsRef.current = options;
  const startOffsetMs = playback?.startOffsetMs ?? 0;

  useEffect(() => {
    if (videoNo == null || videoNo === '' || !CHZZK_VIDEO_NO.test(videoNo)) return;

    let disposed = false;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let replayTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let lastProviderPollStartedAt: number | null = null;
    let lastProviderSuccessAt: number | null = null;
    let lastMessageAt: number | null = null;
    // A reconnect resumes from the offset playback had reached, not from the start.
    let resumeOffsetMs: number | null = null;
    let liveness: ChzzkVideoChatHealth['liveness'] = 'connecting';

    const emitHealth = (nextLiveness: ChzzkVideoChatHealth['liveness'], statusCode?: CollectorStatusCode) => {
      liveness = nextLiveness;
      const snapshot: ChzzkVideoChatHealth = {
        liveness: nextLiveness,
        lastProviderPollStartedAt,
        lastProviderSuccessAt,
        lastMessageAt,
        reconnectAttempt,
        code: statusCode,
      };
      setHealth(snapshot);
      optionsRef.current.onHealthUpdate?.(snapshot);
    };

    const stop = () => {
      controller?.abort();
      controller = undefined;
      if (replayTimer != null) clearTimeout(replayTimer);
      replayTimer = undefined;
    };

    const fail = (code: CollectorStatusCode, status: 'ended' | 'unavailable') => {
      stop();
      emitHealth('failed', code);
      optionsRef.current.onPlatformStatus?.(status, code);
    };

    const scheduleReconnect = (code: CollectorStatusCode) => {
      stop();
      const delay = reconnectDelayMs(reconnectAttempt);
      if (delay == null) {
        fail('reconnect_exhausted', 'unavailable');
        return;
      }
      reconnectAttempt += 1;
      emitHealth('degraded', code);
      diag({ at: 'chzzk_video_reconnect', attempt: reconnectAttempt, code });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      const currentGeneration = ++generation;
      let proxyBase: URL;
      try {
        proxyBase = resolveCollectorProxyBaseUrl();
      } catch (error) {
        fail(
          error instanceof CollectorProxyConfigurationError ? 'invalid_config' : 'provider_poll_failed',
          'unavailable',
        );
        return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      const scheduler = new ReplayScheduler<ChzzkChatItem>(resumeOffsetMs ?? startOffsetMs);
      let nextOffsetMs: number | null = scheduler.startOffsetMs;
      let fetchInFlight = false;
      let lastFetchAt = 0;
      diag({ at: 'chzzk_video_connect', attempt: reconnectAttempt, startOffsetMs: scheduler.startOffsetMs });

      const fetchMore = async () => {
        if (disposed || generation !== currentGeneration || fetchInFlight || nextOffsetMs == null) return;
        if (Date.now() - lastFetchAt < REPLAY_FETCH_MIN_GAP_MS) return;
        fetchInFlight = true;
        lastFetchAt = Date.now();
        lastProviderPollStartedAt = lastFetchAt;
        const requested = nextOffsetMs;
        const timeout = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);
        try {
          const content = await proxyContent(
            proxyBase,
            `/chzzk-api/service/v1/videos/${videoNo}/chats?playerMessageTime=${requested}`,
            signal,
          );
          if (disposed || generation !== currentGeneration) return;
          const page = chzzkVideoChatPage(content);
          if (page == null) throw new Error('chzzk_video_page_shape');
          scheduler.push(page.items);
          nextOffsetMs = chzzkVideoChatNextOffset(page, requested);
          if (nextOffsetMs == null) scheduler.markExhausted();
          lastProviderSuccessAt = Date.now();
          if (!scheduler.started) {
            scheduler.start(Date.now());
            reconnectAttempt = 0;
            diag({ at: 'chzzk_video_first_page', items: scheduler.bufferedCount, exhausted: scheduler.exhausted });
            emitHealth('healthy');
            optionsRef.current.onPlatformStatus?.('live');
          } else if (liveness !== 'healthy') {
            emitHealth('healthy');
          }
        } catch (error) {
          if (disposed || generation !== currentGeneration) return;
          resumeOffsetMs = scheduler.positionMs(Date.now());
          const message = error instanceof Error ? error.message : '';
          // 404 means the video (or its chat) is gone: no point retrying.
          if (message === 'chzzk_proxy_404') {
            fail('provider_stream_ended', 'ended');
            return;
          }
          scheduleReconnect('provider_poll_failed');
        } finally {
          clearTimeout(timeout);
          fetchInFlight = false;
        }
      };

      const tick = () => {
        if (disposed || generation !== currentGeneration) return;
        const now = Date.now();
        if (scheduler.needsMore(now)) void fetchMore();
        if (scheduler.started) {
          for (const item of scheduler.due(now)) {
            lastMessageAt = now;
            chatRef.current(item.action);
          }
          // Pages are fetched minutes ahead; buffered playback counts as the provider being alive.
          if (scheduler.bufferedCount > 0) lastProviderSuccessAt = now;
          if (scheduler.finished()) {
            diag({ at: 'chzzk_video_finished', positionMs: scheduler.positionMs(now) });
            fail('provider_stream_ended', 'ended');
            return;
          }
        }
        replayTimer = setTimeout(tick, REPLAY_TICK_MS);
      };

      emitHealth(reconnectAttempt === 0 ? 'connecting' : 'degraded');
      tick();
    };

    connect();

    return () => {
      disposed = true;
      generation += 1;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      stop();
    };
  }, [videoNo, startOffsetMs]);

  return health;
}
