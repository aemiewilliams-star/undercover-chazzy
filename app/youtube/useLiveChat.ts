import { useEffect, useRef, useState } from 'react';
import Innertube, { YT, YTNodes } from 'youtubei.js';
import { CollectorLiveness, CollectorPlayback, CollectorStatusCode } from '../collector/contracts';
import { CollectorProxyConfigurationError, createInnertubeFetch, ProviderFetchObserver } from './innertubeFetch';
import { providerHasStalled, reconnectDelayMs } from './liveChatPolicy';
import { ReplayScheduler, ReplaySeenIds, replayItemsFromPage, replayPage } from './replayScheduler';

const WATCHDOG_INTERVAL_MS = 2000;
const REPLAY_TICK_MS = 250;
const REPLAY_SEEN_LIMIT = 5000;
/** Never fetch replay pages faster than this; a page covers ~15 s of a busy chat. */
const REPLAY_FETCH_MIN_GAP_MS = 1000;

/** Enum-like markers to the collector's own /collector/diag (see that route). */
function diag(fields: Record<string, string | number | boolean | undefined>): void {
  try {
    const body = JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/collector/diag', new Blob([body], { type: 'application/json' }));
    } else {
      void fetch('/collector/diag', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
        keepalive: true,
      });
    }
  } catch {
    // diagnostics never affect collection
  }
}

export interface YoutubeLiveChatHealth {
  liveness: CollectorLiveness;
  lastProviderPollStartedAt: number | null;
  lastProviderSuccessAt: number | null;
  lastMessageAt: number | null;
  reconnectAttempt: number;
  code?: CollectorStatusCode;
}

export interface YoutubeLiveChatOptions {
  onHealthUpdate?: (health: YoutubeLiveChatHealth) => void;
  onPlatformStatus?: (status: 'live' | 'ended' | 'unavailable', code?: CollectorStatusCode) => void;
  /** Recorded playback of an ended broadcast; absent means live collection. */
  playback?: CollectorPlayback;
}

const INITIAL_HEALTH: YoutubeLiveChatHealth = {
  liveness: 'connecting',
  lastProviderPollStartedAt: null,
  lastProviderSuccessAt: null,
  lastMessageAt: null,
  reconnectAttempt: 0,
};

export default function useLiveChat(
  videoId: string | undefined,
  handleChatUpdate: (action: YTNodes.AddChatItemAction) => void,
  handleMetadataUpdate: (metadata: InstanceType<typeof YT.LiveChat>['metadata']) => void,
  options: YoutubeLiveChatOptions = {},
) {
  const [liveChat, setLiveChat] = useState<YT.LiveChat>();
  const [health, setHealth] = useState<YoutubeLiveChatHealth>(INITIAL_HEALTH);
  const chatUpdateRef = useRef(handleChatUpdate);
  const metadataUpdateRef = useRef(handleMetadataUpdate);
  const optionsRef = useRef(options);

  chatUpdateRef.current = handleChatUpdate;
  metadataUpdateRef.current = handleMetadataUpdate;
  optionsRef.current = options;

  useEffect(() => {
    if (videoId == null || videoId === '') return;

    let disposed = false;
    let activeLiveChat: YT.LiveChat | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectScheduled = false;
    let lastProviderPollStartedAt: number | null = null;
    let lastProviderSuccessAt: number | null = null;
    let lastMessageAt: number | null = null;
    let currentLiveness: CollectorLiveness = 'connecting';
    let currentCode: CollectorStatusCode | undefined;
    // Recorded playback state. The scheduler paces replay pages on the session
    // clock; a reconnect resumes from the position the clock had reached.
    let replayScheduler: ReplayScheduler<YTNodes.AddChatItemAction> | undefined;
    let replayTimer: ReturnType<typeof setTimeout> | undefined;
    let replayFetchInFlight = false;
    let replayResumeOffsetMs: number | null = null;
    // Survives reconnects; evicts only ids before the resume boundary (W6 F1).
    const replaySeen = new ReplaySeenIds(REPLAY_SEEN_LIMIT);
    const collecting = () => activeLiveChat != null || (replayScheduler?.started ?? false);

    const emitHealth = (liveness: CollectorLiveness, code?: CollectorStatusCode) => {
      if (disposed) return;
      currentLiveness = liveness;
      currentCode = code;
      const next: YoutubeLiveChatHealth = {
        liveness,
        lastProviderPollStartedAt,
        lastProviderSuccessAt,
        lastMessageAt,
        reconnectAttempt,
        ...(code == null ? {} : { code }),
      };
      setHealth(next);
      optionsRef.current.onHealthUpdate?.(next);
    };

    const onChatUpdate = (action: YTNodes.AddChatItemAction) => {
      lastMessageAt = Date.now();
      emitHealth(currentLiveness, currentCode);
      chatUpdateRef.current(action);
    };

    const onMetadataUpdate = (metadata: InstanceType<typeof YT.LiveChat>['metadata']) => {
      metadataUpdateRef.current(metadata);
    };

    const onLiveChatError = () => {
      emitHealth('degraded', 'provider_poll_failed');
    };

    const onLiveChatEnd = () => {
      scheduleReconnect('provider_stream_ended');
    };

    const stopReplay = () => {
      if (replayTimer != null) clearTimeout(replayTimer);
      replayTimer = undefined;
      replayScheduler = undefined;
      replayFetchInFlight = false;
    };

    const stopActiveLiveChat = () => {
      stopReplay();
      const current = activeLiveChat;
      activeLiveChat = undefined;
      if (current == null) return;
      current.off('chat-update', onChatUpdate);
      current.off('metadata-update', onMetadataUpdate);
      current.off('error', onLiveChatError);
      current.off('end', onLiveChatEnd);
      current.stop();
      if (!disposed) setLiveChat(undefined);
    };

    const failPermanently = (code: CollectorStatusCode) => {
      diag({ at: 'fail_permanently', code, attempt: reconnectAttempt });
      reconnectScheduled = false;
      stopActiveLiveChat();
      emitHealth('failed', code);
      optionsRef.current.onPlatformStatus?.('unavailable', code);
    };

    const scheduleReconnect = (code: CollectorStatusCode) => {
      if (disposed || reconnectScheduled) return;
      diag({ at: 'schedule_reconnect', code, attempt: reconnectAttempt });
      // Every reconnect path (fetch failure, stall watchdog, stream end) resumes
      // a recorded playback from the drained position; before W6 the stall path
      // restarted from the URL's start offset.
      if (replayScheduler != null) replayResumeOffsetMs = replayScheduler.resumePositionMs();
      stopActiveLiveChat();

      const delay = reconnectDelayMs(reconnectAttempt);
      if (delay == null) {
        failPermanently('reconnect_exhausted');
        return;
      }

      reconnectAttempt += 1;
      reconnectScheduled = true;
      emitHealth('degraded', code);
      reconnectTimer = setTimeout(() => {
        reconnectScheduled = false;
        void connect();
      }, delay);
    };

    /**
     * Recorded playback (owner decision 2026-09-05): walk the chat replay pages
     * a couple of minutes ahead of the session clock and release each chat
     * action when the clock reaches its video offset. youtubei.js' LiveChat
     * would drain the replay at its smoothing rate instead of the real pace.
     */
    const startRecordedPlayback = (
      innertube: Innertube,
      initialContinuation: string,
      playback: CollectorPlayback,
      currentGeneration: number,
    ) => {
      const scheduler = new ReplayScheduler<YTNodes.AddChatItemAction>(replayResumeOffsetMs ?? playback.startOffsetMs);
      replayScheduler = scheduler;
      let nextContinuation: string | null = initialContinuation;
      let lastFetchAt = 0;

      const fetchMore = async () => {
        if (disposed || generation !== currentGeneration || replayFetchInFlight || nextContinuation == null) return;
        if (Date.now() - lastFetchAt < REPLAY_FETCH_MIN_GAP_MS) return;
        replayFetchInFlight = true;
        lastFetchAt = Date.now();
        try {
          // currentPlayerState seeks: with the initial continuation YouTube
          // answers from the requested offset instead of the start of the
          // video (walking from zero to a one-hour mark took hundreds of
          // requests and got the session throttled on 2026-09-05). Later
          // pages follow the continuation; the offset keeps them in step.
          const response = await innertube.actions.execute('live_chat/get_live_chat_replay', {
            continuation: nextContinuation,
            currentPlayerState: { playerOffsetMs: String(scheduler.positionMs(Date.now())) },
            parse: true,
          } as never);
          if (disposed || generation !== currentGeneration || replayScheduler !== scheduler) return;
          const page = replayPage(response);
          if (page == null) {
            nextContinuation = null;
            scheduler.markExhausted();
          } else {
            scheduler.push(replayItemsFromPage<YTNodes.AddChatItemAction>(page.actions));
            if (!page.continuation || page.continuation === nextContinuation) {
              nextContinuation = null;
              scheduler.markExhausted();
            } else {
              nextContinuation = page.continuation;
            }
          }
          if (!scheduler.started) {
            scheduler.start(Date.now());
            diag({ at: 'replay_first_page', items: scheduler.bufferedCount, exhausted: scheduler.exhausted });
            emitHealth('healthy');
            optionsRef.current.onPlatformStatus?.('live');
          }
        } catch {
          if (disposed || generation !== currentGeneration || replayScheduler !== scheduler) return;
          // Resume from what was actually drained, never past an unreceived page (W6).
          replayResumeOffsetMs = scheduler.resumePositionMs();
          scheduleReconnect('provider_poll_failed');
        } finally {
          replayFetchInFlight = false;
        }
      };

      const tick = () => {
        if (disposed || generation !== currentGeneration || replayScheduler !== scheduler) return;
        const now = Date.now();
        if (scheduler.needsMore(now)) void fetchMore();
        if (scheduler.started) {
          for (const item of scheduler.due(now)) {
            const messageId = (item.action as { item?: { id?: unknown } }).item?.id;
            if (typeof messageId === 'string') {
              if (replaySeen.has(messageId)) continue;
              replaySeen.add(messageId, item.offsetMs, scheduler.resumePositionMs());
            }
            onChatUpdate(item.action);
          }
          // Pages are fetched minutes ahead, so the last real poll can be old
          // while chat is still flowing: buffered playback counts as the
          // provider being alive. An empty buffer with pages still pending
          // is left to the stall watchdog.
          if (scheduler.bufferedCount > 0) lastProviderSuccessAt = now;
          if (scheduler.finished()) {
            stopReplay();
            emitHealth('failed', 'provider_stream_ended');
            optionsRef.current.onPlatformStatus?.('ended', 'provider_stream_ended');
            return;
          }
        }
        replayTimer = setTimeout(tick, REPLAY_TICK_MS);
      };

      tick();
    };

    const connect = async () => {
      const currentGeneration = ++generation;
      diag({ at: 'connect', attempt: reconnectAttempt, playback: optionsRef.current.playback?.kind ?? 'live' });
      lastProviderPollStartedAt = null;
      lastProviderSuccessAt = null;
      emitHealth(reconnectAttempt === 0 ? 'connecting' : 'degraded');
      let phase: 'init' | 'get_info' | 'start' = 'init';

      const observer: ProviderFetchObserver = {
        onRequestStarted: (at) => {
          if (disposed || generation !== currentGeneration) return;
          lastProviderPollStartedAt = at;
          emitHealth(collecting() ? currentLiveness : 'connecting', currentCode);
        },
        onRequestSucceeded: (at) => {
          if (disposed || generation !== currentGeneration) return;
          lastProviderSuccessAt = at;
          if (collecting()) reconnectAttempt = 0;
          emitHealth(collecting() ? 'healthy' : 'connecting');
        },
        onRequestFailed: () => {
          if (disposed || generation !== currentGeneration) return;
          emitHealth('degraded', 'provider_poll_failed');
        },
      };

      try {
        // Live chat only needs the Innertube session and API actions. Player
        // signature extraction and cold config retrieval add /iframe_api,
        // player-JS and /youtubei/v1/config requests that are unrelated to
        // chat collection and intentionally outside our narrow proxy allowlist.
        const innertube = await Innertube.create({
          fetch: createInnertubeFetch(observer),
          retrieve_player: false,
          retrieve_innertube_config: false,
        });
        if (disposed || generation !== currentGeneration) return;
        phase = 'get_info';
        const info = await innertube.getInfo(videoId);
        if (disposed || generation !== currentGeneration) return;

        const playback = optionsRef.current.playback;
        diag({
          at: 'got_info',
          playback: playback?.kind ?? 'live',
          startOffsetMs: playback?.startOffsetMs,
          isLive: info.basic_info.is_live === true,
          livechat: info.livechat != null,
          replay: info.livechat?.is_replay === true,
          continuation: typeof info.livechat?.continuation === 'string',
          attempt: reconnectAttempt,
        });
        if (playback?.kind === 'recorded') {
          phase = 'start';
          const continuation = info.livechat?.continuation;
          if (typeof continuation !== 'string' || continuation === '') {
            // The channel did not keep this broadcast's chat replay.
            failPermanently('live_chat_start_failed');
            return;
          }
          startRecordedPlayback(innertube, continuation, playback, currentGeneration);
          return;
        }

        if (!info.basic_info.is_live) {
          stopActiveLiveChat();
          emitHealth('failed', 'not_live');
          optionsRef.current.onPlatformStatus?.('ended', 'not_live');
          return;
        }

        phase = 'start';
        const createdLiveChat = info.getLiveChat();
        createdLiveChat.on('metadata-update', onMetadataUpdate);
        createdLiveChat.on('chat-update', onChatUpdate);
        createdLiveChat.on('error', onLiveChatError);
        createdLiveChat.on('end', onLiveChatEnd);
        activeLiveChat = createdLiveChat;
        setLiveChat(createdLiveChat);
        createdLiveChat.start();
        emitHealth('healthy');
        optionsRef.current.onPlatformStatus?.('live');
      } catch (error) {
        if (disposed || generation !== currentGeneration) return;
        if (error instanceof CollectorProxyConfigurationError) {
          failPermanently('invalid_config');
          return;
        }
        scheduleReconnect(
          phase === 'init'
            ? 'innertube_init_failed'
            : phase === 'get_info'
              ? 'get_info_failed'
              : 'live_chat_start_failed',
        );
      }
    };

    const watchdogTimer = setInterval(() => {
      if (disposed || !collecting() || reconnectScheduled) return;
      if (providerHasStalled(lastProviderSuccessAt, lastProviderPollStartedAt, Date.now())) {
        scheduleReconnect('provider_stalled');
      }
    }, WATCHDOG_INTERVAL_MS);

    void connect();

    return () => {
      disposed = true;
      generation += 1;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      clearInterval(watchdogTimer);
      stopActiveLiveChat();
    };
  }, [videoId]);

  return { liveChat, health };
}
