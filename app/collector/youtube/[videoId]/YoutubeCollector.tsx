'use client';

import { useCallback, useState } from 'react';
import { YTNodes } from 'youtubei.js';
import { normalizeYoutubeTextMessage } from '../../normalizer';
import useCollectorBootstrap from '../../useCollectorBootstrap';
import useCollectorBridge from '../../useCollectorBridge';
import useLiveChat, { YoutubeLiveChatHealth } from '../../../youtube/useLiveChat';
import { LiveChatTextMessage } from '../../../youtube/types';
import { immutableCollectorSourceUrl } from '../../sourceNotice';

const INITIAL_HEALTH: YoutubeLiveChatHealth = {
  liveness: 'connecting',
  lastProviderPollStartedAt: null,
  lastProviderSuccessAt: null,
  lastMessageAt: null,
  reconnectAttempt: 0,
};

function sourceCodeUrl(): string | null {
  return (
    immutableCollectorSourceUrl(
      process.env.NEXT_PUBLIC_SOURCE_CODE_URL,
      process.env.NEXT_PUBLIC_SOURCE_REVISION,
    )?.toString() ?? null
  );
}

function formatTimestamp(value: number | null): string {
  return value == null ? '없음' : new Date(value).toISOString();
}

export default function YoutubeCollector({ videoId }: { videoId: string }) {
  const bootstrap = useCollectorBootstrap();
  const [health, setHealth] = useState<YoutubeLiveChatHealth>(INITIAL_HEALTH);
  const runtimeConfig = bootstrap.status === 'ready' ? bootstrap.config : null;
  const { enqueue, recordNormalizationDrop, emitPlatformStatus, stats } = useCollectorBridge(runtimeConfig, health);
  const publishedSourceUrl = sourceCodeUrl();

  const handleChatUpdate = useCallback(
    (action: YTNodes.AddChatItemAction) => {
      if (!(action instanceof YTNodes.AddChatItemAction) || action.item.type !== 'LiveChatTextMessage') return;
      const message = action.item as unknown as LiveChatTextMessage;
      const normalized = normalizeYoutubeTextMessage({
        authorOpaqueKey: message.author?.id,
        timestamp: message.timestamp,
        runs: message.message?.runs,
        collectorReceivedAt: Date.now(),
      });
      if (!normalized.ok) {
        recordNormalizationDrop();
        return;
      }
      enqueue(normalized.event);
    },
    [enqueue, recordNormalizationDrop],
  );

  const handleMetadataUpdate = useCallback(() => {}, []);
  const handlePlatformStatus = useCallback(
    (status: 'live' | 'ended' | 'unavailable', code?: Parameters<typeof emitPlatformStatus>[1]) => {
      void emitPlatformStatus(status, code);
    },
    [emitPlatformStatus],
  );

  useLiveChat(runtimeConfig == null ? undefined : videoId, handleChatUpdate, handleMetadataUpdate, {
    onHealthUpdate: setHealth,
    onPlatformStatus: handlePlatformStatus,
  });

  return (
    <main className="collector-shell">
      <section className="collector-status" aria-live="polite">
        <h1>UNDERCOVER YouTube Collector</h1>
        <dl>
          <dt>Bootstrap</dt>
          <dd>{bootstrap.status}</dd>
          <dt>Provider</dt>
          <dd>{health.liveness}</dd>
          <dt>마지막 poll 시작</dt>
          <dd>{formatTimestamp(health.lastProviderPollStartedAt)}</dd>
          <dt>마지막 poll 성공</dt>
          <dd>{formatTimestamp(health.lastProviderSuccessAt)}</dd>
          <dt>마지막 채팅</dt>
          <dd>{formatTimestamp(health.lastMessageAt)}</dd>
          <dt>Bridge</dt>
          <dd>{stats.bridgeConnected ? 'connected' : 'waiting'}</dd>
          <dt>전달 이벤트</dt>
          <dd>{stats.deliveredEvents}</dd>
          <dt>대기 이벤트</dt>
          <dd>{stats.pendingDepth}</dd>
          <dt>Queue 폐기</dt>
          <dd>{stats.droppedByCap}</dd>
          <dt>정규화 제외</dt>
          <dd>{stats.droppedByNormalizer}</dd>
        </dl>
        <footer className="collector-source-notice">
          {publishedSourceUrl == null ? (
            <span>실행 중인 Collector 소스 링크 미설정</span>
          ) : (
            <a href={publishedSourceUrl} target="_blank" rel="noreferrer">
              실행 중인 Collector 소스 보기
            </a>
          )}
        </footer>
      </section>
    </main>
  );
}
