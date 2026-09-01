const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QUERY_LENGTH = 4096;

export const COLLECTOR_PROXY_HEADER = 'x-undercover-collector';
export const COLLECTOR_PROXY_HEADER_VALUE = 'live-chat-v1';
export const COLLECTOR_PROXY_TIMEOUT_MS = 12_000;

const ALLOWED_REQUESTS = new Map<string, ReadonlySet<string>>([
  ['/sw.js_data', new Set(['GET'])],
  ['/youtubei/v1/player', new Set(['POST'])],
  ['/youtubei/v1/next', new Set(['POST'])],
  ['/youtubei/v1/live_chat/get_live_chat', new Set(['POST'])],
  ['/youtubei/v1/live_chat/get_live_chat_replay', new Set(['POST'])],
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'x-goog-visitor-id',
  'x-youtube-client-name',
  'x-youtube-client-version',
]);

export class InnertubeProxyRequestError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413,
    public readonly code: 'proxy_request_invalid' | 'proxy_route_not_allowed' | 'proxy_payload_too_large',
  ) {
    super(code);
    this.name = 'InnertubeProxyRequestError';
  }
}

export function collectorProxyEnabled(): boolean {
  return process.env.COLLECTOR_PROXY_ENABLED === '1';
}

export function youtubeUpstreamUrl(requestUrl: URL, pathname: string, method: string): URL {
  if (requestUrl.search.length > MAX_QUERY_LENGTH) {
    throw new InnertubeProxyRequestError(400, 'proxy_request_invalid');
  }
  const allowedMethods = ALLOWED_REQUESTS.get(pathname);
  if (allowedMethods == null || !allowedMethods.has(method.toUpperCase())) {
    throw new InnertubeProxyRequestError(404, 'proxy_route_not_allowed');
  }
  const upstream = new URL(pathname, 'https://www.youtube.com');
  upstream.search = requestUrl.search;
  return upstream;
}

export function assertCollectorProxyRequest(headers: Headers): void {
  if (headers.get(COLLECTOR_PROXY_HEADER) !== COLLECTOR_PROXY_HEADER_VALUE) {
    throw new InnertubeProxyRequestError(404, 'proxy_route_not_allowed');
  }
  const rawLength = headers.get('content-length');
  if (rawLength != null) {
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new InnertubeProxyRequestError(400, 'proxy_request_invalid');
    }
    if (length > MAX_REQUEST_BYTES) {
      throw new InnertubeProxyRequestError(413, 'proxy_payload_too_large');
    }
  }
}

export async function boundedRequestBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new InnertubeProxyRequestError(413, 'proxy_payload_too_large');
  }
  return body;
}

export function youtubeRequestHeaders(incoming: Headers): Headers {
  const result = new Headers();
  incoming.forEach((value, name) => {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) result.set(name, value);
  });
  result.set('origin', 'https://www.youtube.com');
  result.set('referer', 'https://www.youtube.com/');
  result.set('user-agent', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36');
  return result;
}

export async function boundedUpstreamBody(response: Response): Promise<ArrayBuffer> {
  const rawLength = response.headers.get('content-length');
  if (rawLength != null) {
    const length = Number(rawLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new Error('INNERTUBE_RESPONSE_TOO_LARGE');
    }
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new Error('INNERTUBE_RESPONSE_TOO_LARGE');
  return body;
}

export function safeYoutubeResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  });
  const contentType = upstream.get('content-type');
  if (contentType != null) headers.set('content-type', contentType);
  return headers;
}
