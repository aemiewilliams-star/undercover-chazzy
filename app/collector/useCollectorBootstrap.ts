'use client';

import { useEffect, useState } from 'react';
import { CollectorRuntimeConfig } from './contracts';
import { requestCollectorRuntimeConfig } from './bridgeTransport';

const BOOTSTRAP_RETRY_MS = 250;
const BOOTSTRAP_MAX_ATTEMPTS = 40;

export type CollectorBootstrapState =
  | { status: 'waiting'; config: null }
  | { status: 'ready'; config: CollectorRuntimeConfig }
  | { status: 'unavailable'; config: null };

export default function useCollectorBootstrap(): CollectorBootstrapState {
  const [state, setState] = useState<CollectorBootstrapState>({ status: 'waiting', config: null });

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const attempt = async () => {
      const config = await requestCollectorRuntimeConfig();
      if (disposed) return;
      if (config != null) {
        setState({ status: 'ready', config });
        return;
      }

      attempts += 1;
      if (attempts >= BOOTSTRAP_MAX_ATTEMPTS) {
        setState({ status: 'unavailable', config: null });
        return;
      }
      timer = setTimeout(() => void attempt(), BOOTSTRAP_RETRY_MS);
    };

    void attempt();
    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
    };
  }, []);

  return state;
}
