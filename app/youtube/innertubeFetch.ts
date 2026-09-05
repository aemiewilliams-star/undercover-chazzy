export interface ProviderFetchObserver {
  onRequestStarted?: (at: number) => void;
  onRequestSucceeded?: (at: number) => void;
  onRequestFailed?: (at: number) => void;
}

/**
 * Only the live chat polls decide provider liveness. youtubei.js also polls
 * `/youtubei/v1/updated_metadata` (title, viewer count) in a tight loop that
 * the collector proxy does not allow; those 404s must not flip the session to
 * degraded while chat keeps flowing. Bootstrap calls (player, next) report
 * their own failure codes from the connect phase.
 */
const LIVENESS_REQUEST_PATHS: ReadonlySet<string> = new Set([
  '/youtubei/v1/live_chat/get_live_chat',
  '/youtubei/v1/live_chat/get_live_chat_replay',
]);

export function isProviderLivenessRequest(input: string | Request | RequestInfo | URL): boolean {
  try {
    const source = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return LIVENESS_REQUEST_PATHS.has(source.pathname);
  } catch {
    return true;
  }
}

export const COLLECTOR_PROXY_HEADER = 'x-undercover-collector';
export const COLLECTOR_PROXY_HEADER_VALUE = 'live-chat-v1';

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
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (!isLocalDevelopment && parsed.port !== '')
  ) {
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
    const observed = isProviderLivenessRequest(input);
    if (observed) observer.onRequestStarted?.(startedAt);

    try {
      const rewritten = rewriteInnertubeUrl(input as string | Request | URL, proxyBaseUrl);
      const request = new Request(rewritten, input instanceof Request ? input : undefined);
      const headers = new Headers(request.headers);
      if (init?.headers != null) {
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      }
      headers.set(COLLECTOR_PROXY_HEADER, COLLECTOR_PROXY_HEADER_VALUE);
      const response = await fetch(new Request(request, { headers }), init == null ? undefined : { ...init, headers });
      if (observed) {
        if (response.ok) observer.onRequestSucceeded?.(Date.now());
        else observer.onRequestFailed?.(Date.now());
      }
      return response;
    } catch (error) {
      if (observed) observer.onRequestFailed?.(Date.now());
      throw error;
    }
  };
}
