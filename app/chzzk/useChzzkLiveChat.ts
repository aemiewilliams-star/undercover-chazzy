import { useEffect, useRef, useState } from 'react';
import { CollectorLiveness, CollectorStatusCode } from '../collector/contracts';
import { CollectorProxyConfigurationError, resolveCollectorProxyBaseUrl } from '../youtube/innertubeFetch';
import { YoutubeLiveChatHealth } from '../youtube/useLiveChat';
import { providerHasStalled, reconnectDelayMs } from '../youtube/liveChatPolicy';
import { COLLECTOR_PROXY_HEADER, COLLECTOR_PROXY_HEADER_VALUE } from '../youtube/innertubeFetch';
import {
  CHZZK_CHAT_HOSTS,
  ChzzkChatItem,
  ChzzkCmd,
  chzzkChatItemsFromBody,
  chzzkConnectFrame,
  chzzkPingFrame,
  chzzkPongFrame,
  parseChzzkFrame,
} from './chzzkChatProtocol';

/**
 * CHZZK live chat for the collector page (owner decision 2026-09-05: webview
 * collection, CHZZK next). Same health/liveness vocabulary as the YouTube
 * hook so the bridge, heartbeats and the app stay identical:
 *
 *   connect → live-status via our proxy (CLOSE → not_live) → access token via
 *   our proxy → WebSocket to Naver's chat server (CSP-allowed) → CONNECT →
 *   CHAT frames → chat items. PING/PONG every 20 s; a closed socket
 *   reconnects with the shared backoff; live-status is re-polled every 30 s
 *   and CLOSE ends the session (provider_stream_ended).
 */

const WATCHDOG_INTERVAL_MS = 2000;
const LIVE_STATUS_POLL_MS = 30_000;
const KEEPALIVE_PING_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;

export type ChzzkLiveChatHealth = YoutubeLiveChatHealth;

export interface ChzzkLiveChatOptions {
  onHealthUpdate?: (health: ChzzkLiveChatHealth) => void;
  onPlatformStatus?: (status: 'live' | 'ended' | 'unavailable', code?: CollectorStatusCode) => void;
}

const INITIAL_HEALTH: ChzzkLiveChatHealth = {
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

async function proxyJson(proxyBase: URL, path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
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
  return parsed.content as Record<string, unknown>;
}

export default function useChzzkLiveChat(
  channelId: string | undefined,
  handleChat: (item: ChzzkChatItem) => void,
  options: ChzzkLiveChatOptions = {},
) {
  const [health, setHealth] = useState<ChzzkLiveChatHealth>(INITIAL_HEALTH);
  const chatRef = useRef(handleChat);
  const optionsRef = useRef(options);
  chatRef.current = handleChat;
  optionsRef.current = options;

  useEffect(() => {
    if (channelId == null || channelId === '') return;

    let disposed = false;
    let generation = 0;
    let reconnectAttempt = 0;
    let reconnectScheduled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    let hostIndex = 0;
    let lastProviderPollStartedAt: number | null = null;
    let lastProviderSuccessAt: number | null = null;
    let socketStartedAt: number | null = null;
    let lastMessageAt: number | null = null;
    let currentLiveness: CollectorLiveness = 'connecting';
    let currentCode: CollectorStatusCode | undefined;
    let connected = false;

    const emitHealth = (liveness: CollectorLiveness, code?: CollectorStatusCode) => {
      if (disposed) return;
      currentLiveness = liveness;
      currentCode = code;
      const next: ChzzkLiveChatHealth = {
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

    const stopSocket = () => {
      connected = false;
      if (pingTimer != null) clearInterval(pingTimer);
      if (statusTimer != null) clearInterval(statusTimer);
      pingTimer = undefined;
      statusTimer = undefined;
      const current = socket;
      socket = undefined;
      if (current == null) return;
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      try {
        current.close();
      } catch {
        // already closed
      }
    };

    const failPermanently = (code: CollectorStatusCode) => {
      diag({ at: 'chzzk_fail_permanently', code, attempt: reconnectAttempt });
      generation += 1;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      reconnectScheduled = false;
      stopSocket();
      emitHealth('failed', code);
      optionsRef.current.onPlatformStatus?.('unavailable', code);
    };

    const endStream = () => {
      diag({ at: 'chzzk_stream_ended' });
      generation += 1;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      reconnectScheduled = false;
      stopSocket();
      emitHealth('failed', 'provider_stream_ended');
      optionsRef.current.onPlatformStatus?.('ended', 'provider_stream_ended');
    };

    const scheduleReconnect = (code: CollectorStatusCode) => {
      if (disposed || reconnectScheduled) return;
      diag({ at: 'chzzk_schedule_reconnect', code, attempt: reconnectAttempt });
      stopSocket();
      const delay = reconnectDelayMs(reconnectAttempt);
      if (delay == null) {
        failPermanently('reconnect_exhausted');
        return;
      }
      reconnectAttempt += 1;
      reconnectScheduled = true;
      hostIndex = (hostIndex + 1) % CHZZK_CHAT_HOSTS.length;
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
      socketStartedAt = null;
      emitHealth(reconnectAttempt === 0 ? 'connecting' : 'degraded');
      diag({ at: 'chzzk_connect', attempt: reconnectAttempt });
      let proxyBase: URL;
      try {
        proxyBase = resolveCollectorProxyBaseUrl();
      } catch (error) {
        if (error instanceof CollectorProxyConfigurationError) failPermanently('invalid_config');
        return;
      }
      let phase: 'live_status' | 'token' | 'socket' = 'live_status';
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let live: Record<string, unknown>;
        let token: Record<string, unknown>;
        try {
          lastProviderPollStartedAt = Date.now();
          live = await proxyJson(
            proxyBase,
            `/chzzk-api/polling/v2/channels/${channelId}/live-status`,
            controller.signal,
          );
          if (disposed || generation !== currentGeneration) return;
          if (live.status !== 'OPEN') {
            stopSocket();
            emitHealth('failed', 'not_live');
            optionsRef.current.onPlatformStatus?.('ended', 'not_live');
            return;
          }
          const chatChannelId = typeof live.chatChannelId === 'string' ? live.chatChannelId : '';
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatChannelId)) throw new Error('chzzk_chat_channel_missing');
          phase = 'token';
          token = await proxyJson(
            proxyBase,
            `/chzzk-api/nng_main/v1/chats/access-token?channelId=${encodeURIComponent(chatChannelId)}&chatType=STREAMING`,
            controller.signal,
          );
          if (disposed || generation !== currentGeneration) return;
          const accessToken = typeof token.accessToken === 'string' ? token.accessToken : '';
          if (accessToken === '') throw new Error('chzzk_token_missing');
          phase = 'socket';
          openSocket(chatChannelId, accessToken, currentGeneration, proxyBase);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        if (disposed || generation !== currentGeneration) return;
        scheduleReconnect(
          phase === 'live_status'
            ? 'get_info_failed'
            : phase === 'token'
              ? 'live_chat_start_failed'
              : 'provider_poll_failed',
        );
      }
    };

    const openSocket = (chatChannelId: string, accessToken: string, currentGeneration: number, proxyBase: URL) => {
      socketStartedAt = Date.now();
      lastProviderPollStartedAt = socketStartedAt;
      const ws = new WebSocket(CHZZK_CHAT_HOSTS[hostIndex]);
      socket = ws;
      ws.onopen = () => {
        if (disposed || generation !== currentGeneration || socket !== ws) return;
        lastProviderPollStartedAt = Date.now();
        ws.send(chzzkConnectFrame(chatChannelId, accessToken));
        emitHealth(currentLiveness, currentCode);
      };
      ws.onmessage = (event: MessageEvent) => {
        if (disposed || generation !== currentGeneration || socket !== ws) return;
        const frame = parseChzzkFrame(event.data);
        if (frame == null) return;
        const now = Date.now();
        lastProviderSuccessAt = now;
        switch (frame.cmd) {
          case ChzzkCmd.PING:
            ws.send(chzzkPongFrame());
            break;
          case ChzzkCmd.CONNECTED:
            if (!connected) {
              connected = true;
              reconnectAttempt = 0;
              diag({ at: 'chzzk_connected', host: hostIndex });
              optionsRef.current.onPlatformStatus?.('live');
            }
            break;
          case ChzzkCmd.CHAT:
          case ChzzkCmd.CHEESE_CHAT: {
            for (const item of chzzkChatItemsFromBody(frame.body)) {
              lastMessageAt = now;
              chatRef.current(item);
            }
            break;
          }
          default:
            break;
        }
        // Quiet channels still receive keepalives. Publish their freshness to
        // the bridge, and clear a transient socket error after a good frame.
        emitHealth(connected ? 'healthy' : currentLiveness, connected ? undefined : currentCode);
      };
      ws.onerror = () => {
        if (disposed || generation !== currentGeneration || socket !== ws) return;
        emitHealth('degraded', 'provider_poll_failed');
      };
      ws.onclose = () => {
        if (disposed || generation !== currentGeneration || socket !== ws) return;
        scheduleReconnect('provider_poll_failed');
      };
      pingTimer = setInterval(() => {
        if (disposed || generation !== currentGeneration || socket !== ws) return;
        if (ws.readyState === WebSocket.OPEN) {
          lastProviderPollStartedAt = Date.now();
          ws.send(chzzkPingFrame());
          emitHealth(currentLiveness, currentCode);
        }
      }, KEEPALIVE_PING_MS);
      statusTimer = setInterval(() => {
        if (disposed || generation !== currentGeneration || socket !== ws) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        proxyJson(proxyBase, `/chzzk-api/polling/v2/channels/${channelId}/live-status`, controller.signal)
          .then((live) => {
            if (disposed || generation !== currentGeneration || socket !== ws) return;
            // Metadata can establish that the stream ended, but cannot prove
            // that its chat socket is making progress.
            if (live.status !== 'OPEN') endStream();
          })
          .catch(() => {
            // a failed status poll is not a chat failure; the socket watchdog decides
          })
          .finally(() => clearTimeout(timer));
      }, LIVE_STATUS_POLL_MS);
    };

    const watchdogTimer = setInterval(() => {
      if (disposed || socket == null || reconnectScheduled) return;
      if (providerHasStalled(lastProviderSuccessAt, socketStartedAt, Date.now())) {
        scheduleReconnect('provider_stalled');
      }
    }, WATCHDOG_INTERVAL_MS);

    void connect();

    return () => {
      disposed = true;
      generation += 1;
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      clearInterval(watchdogTimer);
      stopSocket();
    };
  }, [channelId]);

  return { health };
}
