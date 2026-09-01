import { useEffect, useState } from 'react';
import Innertube from 'youtubei.js';
import { CollectorProxyConfigurationError, createInnertubeFetch } from './innertubeFetch';

function useInnertube() {
  const [innertube, setInnertube] = useState<Innertube | undefined>();
  const [error, setError] = useState<'proxy_configuration' | 'initialization_failed' | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const created = await Innertube.create({ fetch: createInnertubeFetch() });
        if (!disposed) setInnertube(created);
      } catch (caught) {
        if (!disposed) {
          setError(
            caught instanceof CollectorProxyConfigurationError ? 'proxy_configuration' : 'initialization_failed',
          );
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  return { innertube, error };
}

export default useInnertube;
