import { useEffect, useRef, useState } from 'react';
import Innertube, { YT, YTNodes } from 'youtubei.js';
import { CollectorLiveness, CollectorStatusCode } from '../collector/contracts';
import { CollectorProxyConfigurationError, createInnertubeFetch, ProviderFetchObserver } from './innertubeFetch';
import { providerHasStalled, reconnectDelayMs } from './liveChatPolicy';

const WATCHDOG_INTERVAL_MS = 2000;

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

    const stopActiveLiveChat = () => {
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
      reconnectScheduled = false;
      stopActiveLiveChat();
      emitHealth('failed', code);
      optionsRef.current.onPlatformStatus?.('unavailable', code);
    };

    const scheduleReconnect = (code: CollectorStatusCode) => {
      if (disposed || reconnectScheduled) return;
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

    const connect = async () => {
      const currentGeneration = ++generation;
      lastProviderPollStartedAt = null;
      lastProviderSuccessAt = null;
      emitHealth(reconnectAttempt === 0 ? 'connecting' : 'degraded');
      let phase: 'init' | 'get_info' | 'start' = 'init';

      const observer: ProviderFetchObserver = {
        onRequestStarted: (at) => {
          if (disposed || generation !== currentGeneration) return;
          lastProviderPollStartedAt = at;
          emitHealth(activeLiveChat == null ? 'connecting' : currentLiveness, currentCode);
        },
        onRequestSucceeded: (at) => {
          if (disposed || generation !== currentGeneration) return;
          lastProviderSuccessAt = at;
          if (activeLiveChat != null) reconnectAttempt = 0;
          emitHealth(activeLiveChat == null ? 'connecting' : 'healthy');
        },
        onRequestFailed: () => {
          if (disposed || generation !== currentGeneration) return;
          emitHealth('degraded', 'provider_poll_failed');
        },
      };

      try {
        const innertube = await Innertube.create({ fetch: createInnertubeFetch(observer) });
        if (disposed || generation !== currentGeneration) return;
        phase = 'get_info';
        const info = await innertube.getInfo(videoId);
        if (disposed || generation !== currentGeneration) return;

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
      if (disposed || activeLiveChat == null || reconnectScheduled) return;
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
