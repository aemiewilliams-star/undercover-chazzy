'use client';

import { useCallback, useState } from 'react';
import { normalizeChzzkTextMessage } from '../../normalizer';
import useCollectorBootstrap from '../../useCollectorBootstrap';
import useCollectorBridge from '../../useCollectorBridge';
import useChzzkVideoChat, { ChzzkVideoChatHealth } from '../../../chzzk/useChzzkVideoChat';
import { ChzzkChatItem } from '../../../chzzk/chzzkChatProtocol';
import { immutableCollectorSourceUrl } from '../../sourceNotice';

const INITIAL_HEALTH: ChzzkVideoChatHealth = {
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

/**
 * CHZZK replay collector page. The app opens it for a recorded CHZZK session
 * and hands `playback.startOffsetMs` over the bootstrap; without playback the
 * replay starts at the beginning of the video.
 */
export default function ChzzkVideoCollector({ videoNo }: { videoNo: string }) {
  const bootstrap = useCollectorBootstrap();
  const [health, setHealth] = useState<ChzzkVideoChatHealth>(INITIAL_HEALTH);
  const runtimeConfig = bootstrap.status === 'ready' ? bootstrap.config : null;
  const { enqueue, recordNormalizationDrop, emitPlatformStatus, stats } = useCollectorBridge(runtimeConfig, health);
  const publishedSourceUrl = sourceCodeUrl();

  const handleChat = useCallback(
    (item: ChzzkChatItem) => {
      // Recorded playback: `occurredAt` is stamped at emission (collector_received),
      // as for YouTube replays, so ranking windows follow the session clock.
      const normalized = normalizeChzzkTextMessage({
        authorOpaqueKey: item.authorOpaqueKey,
        text: item.text,
        timestamp: null,
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
  const handlePlatformStatus = useCallback(
    (status: 'live' | 'ended' | 'unavailable', code?: Parameters<typeof emitPlatformStatus>[1]) => {
      void emitPlatformStatus(status, code);
    },
    [emitPlatformStatus],
  );

  useChzzkVideoChat(runtimeConfig == null ? undefined : videoNo, runtimeConfig?.playback, handleChat, {
    onHealthUpdate: setHealth,
    onPlatformStatus: handlePlatformStatus,
  });

  return (
    <main className="collector-shell">
      <section className="collector-status" aria-live="polite">
        <h1>UNDERCOVER CHZZK Replay Collector</h1>
        <dl>
          <dt>Bootstrap</dt>
          <dd>{bootstrap.status}</dd>
          <dt>Provider</dt>
          <dd>{health.liveness}</dd>
          <dt>시작 지점(ms)</dt>
          <dd>{runtimeConfig?.playback?.startOffsetMs ?? 0}</dd>
          <dt>마지막 page 시작</dt>
          <dd>{formatTimestamp(health.lastProviderPollStartedAt)}</dd>
          <dt>마지막 page 성공</dt>
          <dd>{formatTimestamp(health.lastProviderSuccessAt)}</dd>
          <dt>마지막 채팅</dt>
          <dd>{formatTimestamp(health.lastMessageAt)}</dd>
          <dt>재접속 시도</dt>
          <dd>{health.reconnectAttempt}</dd>
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
