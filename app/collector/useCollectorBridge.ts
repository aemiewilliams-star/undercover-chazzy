'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CollectorPlatformStatusMessage, CollectorRuntimeConfig, collectorBridgeEnvelope } from './contracts';
import { NormalizedCollectorEvent } from './normalizer';
import { CollectorEventQueue, COLLECTOR_BATCH_MAX_EVENTS } from './queue';
import { sendCollectorBridgeMessage } from './bridgeTransport';
import type { YoutubeLiveChatHealth } from '../youtube/useLiveChat';

const BATCH_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 2000;

export interface CollectorBridgeStats {
  deliveredEvents: number;
  pendingDepth: number;
  droppedByCap: number;
  droppedByNormalizer: number;
  bridgeConnected: boolean;
}

export default function useCollectorBridge(config: CollectorRuntimeConfig | null, health: YoutubeLiveChatHealth) {
  const queueRef = useRef(new CollectorEventQueue());
  const configRef = useRef(config);
  const healthRef = useRef(health);
  const batchSequenceRef = useRef(0);
  const flushingRef = useRef(false);
  const hiddenStartedAtRef = useRef<number | null>(null);
  const hiddenAccumulatedMsRef = useRef(0);
  const droppedByNormalizerRef = useRef(0);
  const [stats, setStats] = useState<CollectorBridgeStats>({
    deliveredEvents: 0,
    pendingDepth: 0,
    droppedByCap: 0,
    droppedByNormalizer: 0,
    bridgeConnected: false,
  });

  configRef.current = config;
  healthRef.current = health;

  const updateQueueStats = useCallback((bridgeConnected?: boolean, deliveredDelta = 0) => {
    const queue = queueRef.current;
    setStats((previous) => ({
      deliveredEvents: previous.deliveredEvents + deliveredDelta,
      pendingDepth: queue.pendingDepth,
      droppedByCap: queue.droppedByCap,
      droppedByNormalizer: droppedByNormalizerRef.current,
      bridgeConnected: bridgeConnected ?? previous.bridgeConnected,
    }));
  }, []);

  const flush = useCallback(async () => {
    const runtimeConfig = configRef.current;
    if (runtimeConfig == null || flushingRef.current || document.hidden) return;
    const events = queueRef.current.take(COLLECTOR_BATCH_MAX_EVENTS);
    if (events.length === 0) return;

    flushingRef.current = true;
    const delivered = await sendCollectorBridgeMessage({
      type: 'batch',
      ...collectorBridgeEnvelope(runtimeConfig),
      batchSequence: batchSequenceRef.current,
      events,
    });
    flushingRef.current = false;

    if (delivered) {
      batchSequenceRef.current += 1;
      updateQueueStats(true, events.length);
    } else {
      queueRef.current.restoreToFront(events);
      updateQueueStats(false);
    }
  }, [updateQueueStats]);

  const enqueue = useCallback(
    (event: NormalizedCollectorEvent) => {
      queueRef.current.enqueue(event);
      updateQueueStats();
      if (queueRef.current.pendingDepth >= COLLECTOR_BATCH_MAX_EVENTS) void flush();
    },
    [flush, updateQueueStats],
  );

  const recordNormalizationDrop = useCallback(() => {
    droppedByNormalizerRef.current += 1;
    updateQueueStats();
  }, [updateQueueStats]);

  const emitPlatformStatus = useCallback(
    async (status: CollectorPlatformStatusMessage['status'], code?: CollectorPlatformStatusMessage['code']) => {
      const runtimeConfig = configRef.current;
      if (runtimeConfig == null) return false;
      const delivered = await sendCollectorBridgeMessage({
        type: 'platform_status',
        ...collectorBridgeEnvelope(runtimeConfig),
        status,
        ...(code == null ? {} : { code }),
      });
      updateQueueStats(delivered);
      return delivered;
    },
    [updateQueueStats],
  );

  useEffect(() => {
    if (config == null) return;
    void sendCollectorBridgeMessage({
      type: 'ready',
      ...collectorBridgeEnvelope(config),
    }).then((delivered) => updateQueueStats(delivered));
  }, [config, updateQueueStats]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const now = Date.now();
      if (document.hidden) hiddenStartedAtRef.current = now;
      else if (hiddenStartedAtRef.current != null) {
        hiddenAccumulatedMsRef.current += now - hiddenStartedAtRef.current;
        hiddenStartedAtRef.current = null;
        void flush();
      }
    };
    if (document.hidden) hiddenStartedAtRef.current = Date.now();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [flush]);

  useEffect(() => {
    const batchTimer = setInterval(() => void flush(), BATCH_INTERVAL_MS);
    const heartbeatTimer = setInterval(() => {
      const runtimeConfig = configRef.current;
      if (runtimeConfig == null) return;

      const now = Date.now();
      let hiddenMsSincePrevious = hiddenAccumulatedMsRef.current;
      hiddenAccumulatedMsRef.current = 0;
      if (document.hidden && hiddenStartedAtRef.current != null) {
        hiddenMsSincePrevious += now - hiddenStartedAtRef.current;
        hiddenStartedAtRef.current = now;
      }

      const queue = queueRef.current;
      const currentHealth = healthRef.current;
      void sendCollectorBridgeMessage({
        type: 'heartbeat',
        ...collectorBridgeEnvelope(runtimeConfig),
        emittedAt: now,
        liveness: currentHealth.liveness,
        lastProviderPollStartedAt: currentHealth.lastProviderPollStartedAt,
        lastProviderSuccessAt: currentHealth.lastProviderSuccessAt,
        lastMessageAt: currentHealth.lastMessageAt,
        lastEventSequence: queue.lastEventSequence,
        pendingDepth: queue.pendingDepth,
        documentHidden: document.hidden,
        hiddenMsSincePrevious,
        droppedByCap: queue.droppedByCap,
        droppedByNormalizer: droppedByNormalizerRef.current,
      }).then((delivered) => updateQueueStats(delivered));
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      clearInterval(batchTimer);
      clearInterval(heartbeatTimer);
    };
  }, [flush, updateQueueStats]);

  return { enqueue, recordNormalizationDrop, emitPlatformStatus, flush, stats };
}
