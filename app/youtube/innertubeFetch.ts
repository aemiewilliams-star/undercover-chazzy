export interface ProviderFetchObserver {
  onRequestStarted?: (at: number) => void;
  onRequestSucceeded?: (at: number) => void;
  onRequestFailed?: (at: number) => void;
}

export class CollectorProxyConfigurationError extends Error {
  constructor() {
    super('NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL must be an allowed absolute URL');
    this.name = 'CollectorProxyConfigurationError';
  }
}

export function resolveCollectorProxyBaseUrl(raw = process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL): URL {
  if (raw == null || raw === '') throw new CollectorProxyConfigurationError();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CollectorProxyConfigurationError();
  }

  const isLocalDevelopment = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocalDevelopment && parsed.protocol === 'http:')) {
    throw new CollectorProxyConfigurationError();
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new CollectorProxyConfigurationError();
  }
  return parsed;
}

export function rewriteInnertubeUrl(input: string | Request | URL, proxyBaseUrl: URL): URL {
  const source =
    typeof input === 'string' ? new URL(input) : input instanceof URL ? new URL(input) : new URL(input.url);
  const rewritten = new URL(proxyBaseUrl.toString());
  rewritten.pathname = source.pathname;
  rewritten.search = source.search;
  rewritten.hash = '';
  return rewritten;
}

export function createInnertubeFetch(
  observer: ProviderFetchObserver = {},
  proxyBaseUrl = resolveCollectorProxyBaseUrl(),
) {
  return async (input: string | Request | RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = Date.now();
    observer.onRequestStarted?.(startedAt);

    try {
      const rewritten = rewriteInnertubeUrl(input as string | Request | URL, proxyBaseUrl);
      const request = new Request(rewritten, input instanceof Request ? input : undefined);
      const response = await fetch(request, init);
      if (response.ok) observer.onRequestSucceeded?.(Date.now());
      else observer.onRequestFailed?.(Date.now());
      return response;
    } catch (error) {
      observer.onRequestFailed?.(Date.now());
      throw error;
    }
  };
}
