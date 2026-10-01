/**
 * What a failed InnerTube request looked like from the collector page, for
 * diagnostics only (2026-10-01: a replay session died after 73 s of failures
 * and nothing recorded whether YouTube refused or the request timed out).
 */
export interface ProviderRequestFailure {
  /** InnerTube path, e.g. `/youtubei/v1/live_chat/get_live_chat_replay`; `invalid` when unparsable. */
  path: string;
  /** HTTP status when the proxy answered; null when the request threw (network, abort). */
  status: number | null;
  durationMs: number;
  /** Error class name when the request threw. Never the message: it can carry URLs. */
  error?: string;
}

export interface ProviderFetchObserver {
  onRequestStarted?: (at: number) => void;
  onRequestSucceeded?: (at: number) => void;
  onRequestFailed?: (at: number, failure: ProviderRequestFailure) => void;
  /** Bootstrap calls (player, next) that failed. They never decide liveness. */
  onBootstrapRequestFailed?: (at: number, failure: ProviderRequestFailure) => void;
}

/** Connect-phase calls whose failures are worth a diagnostic line; metadata polls are not. */
const BOOTSTRAP_REQUEST_PATHS: ReadonlySet<string> = new Set(['/youtubei/v1/player', '/youtubei/v1/next']);

export function innertubeRequestPath(input: string | Request | RequestInfo | URL): string {
  try {
    const source = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return source.pathname;
  } catch {
    return 'invalid';
  }
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
    const path = innertubeRequestPath(input);
    const bootstrap = !observed && BOOTSTRAP_REQUEST_PATHS.has(path);
    if (observed) observer.onRequestStarted?.(startedAt);
    const report = (at: number, failure: Omit<ProviderRequestFailure, 'path' | 'durationMs'>) => {
      const detail: ProviderRequestFailure = { path, durationMs: Math.max(0, at - startedAt), ...failure };
      if (observed) observer.onRequestFailed?.(at, detail);
      else if (bootstrap) observer.onBootstrapRequestFailed?.(at, detail);
    };

    try {
      const rewritten = rewriteInnertubeUrl(input as string | Request | URL, proxyBaseUrl);
      const request = new Request(rewritten, input instanceof Request ? input : undefined);
      const headers = new Headers(request.headers);
      if (init?.headers != null) {
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      }
      headers.set(COLLECTOR_PROXY_HEADER, COLLECTOR_PROXY_HEADER_VALUE);
      const response = await fetch(new Request(request, { headers }), init == null ? undefined : { ...init, headers });
      if (response.ok) {
        if (observed) observer.onRequestSucceeded?.(Date.now());
      } else {
        report(Date.now(), { status: response.status });
      }
      return response;
    } catch (error) {
      report(Date.now(), { status: null, error: error instanceof Error ? error.name : typeof error });
      throw error;
    }
  };
}
