/**
 * CHZZK REST proxy rules (2026-09-05, owner decision: webview collection).
 *
 * The collector page runs inside the app's webview, which only talks to this
 * origin; the base project called Naver's APIs through the author's proxy.
 * Three GET endpoints are allowed, each pinned to its upstream host and an
 * exact path shape. Chat itself is a WebSocket the page opens directly
 * (CSP connect-src for /collector/chzzk/ pages).
 */
const MAX_QUERY_LENGTH = 512;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const CHZZK_PROXY_TIMEOUT_MS = 8_000;

const CHANNEL_ID = '[a-f0-9]{32}';

interface ChzzkProxyRule {
  pattern: RegExp;
  upstreamOrigin: string;
  upstreamPath: (match: RegExpExecArray) => string;
  query: (search: URLSearchParams) => URLSearchParams | null;
}

const RULES: readonly ChzzkProxyRule[] = [
  {
    pattern: new RegExp(`^/chzzk-api/service/v1/channels/(${CHANNEL_ID})$`),
    upstreamOrigin: 'https://api.chzzk.naver.com',
    upstreamPath: (match) => `/service/v1/channels/${match[1]}`,
    query: (search) => (search.size === 0 ? new URLSearchParams() : null),
  },
  {
    pattern: new RegExp(`^/chzzk-api/polling/v2/channels/(${CHANNEL_ID})/live-status$`),
    upstreamOrigin: 'https://api.chzzk.naver.com',
    upstreamPath: (match) => `/polling/v2/channels/${match[1]}/live-status`,
    query: (search) => (search.size === 0 ? new URLSearchParams() : null),
  },
  {
    pattern: /^\/chzzk-api\/nng_main\/v1\/chats\/access-token$/,
    upstreamOrigin: 'https://comm-api.game.naver.com',
    upstreamPath: () => '/nng_main/v1/chats/access-token',
    query: (search) => {
      const channelId = search.get('channelId');
      const chatType = search.get('chatType');
      if (search.size !== 2 || channelId == null || chatType !== 'STREAMING') return null;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) return null;
      return new URLSearchParams({ channelId, chatType });
    },
  },
];

export class ChzzkProxyRequestError extends Error {
  constructor(
    public readonly status: 400 | 404,
    public readonly code: 'proxy_request_invalid' | 'proxy_route_not_allowed',
  ) {
    super(code);
    this.name = 'ChzzkProxyRequestError';
  }
}

export function chzzkUpstreamUrl(requestUrl: URL, pathname: string, method: string): URL {
  if (method.toUpperCase() !== 'GET') throw new ChzzkProxyRequestError(404, 'proxy_route_not_allowed');
  if (requestUrl.search.length > MAX_QUERY_LENGTH) throw new ChzzkProxyRequestError(400, 'proxy_request_invalid');
  for (const rule of RULES) {
    const match = rule.pattern.exec(pathname);
    if (!match) continue;
    const query = rule.query(requestUrl.searchParams);
    if (query == null) throw new ChzzkProxyRequestError(400, 'proxy_request_invalid');
    const upstream = new URL(rule.upstreamPath(match), rule.upstreamOrigin);
    upstream.search = query.toString();
    return upstream;
  }
  throw new ChzzkProxyRequestError(404, 'proxy_route_not_allowed');
}

export function chzzkRequestHeaders(): Headers {
  return new Headers({
    accept: 'application/json',
    'accept-language': 'ko-KR,ko;q=0.9',
    origin: 'https://chzzk.naver.com',
    referer: 'https://chzzk.naver.com/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
}

export async function boundedChzzkBody(response: Response): Promise<ArrayBuffer> {
  const rawLength = response.headers.get('content-length');
  if (rawLength != null) {
    const length = Number(rawLength);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('CHZZK_RESPONSE_TOO_LARGE');
    }
  }
  if (response.body == null) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('CHZZK_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function safeChzzkResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers({
    'cache-control': 'private, no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  });
  const contentType = upstream.get('content-type');
  if (contentType != null && /^application\/json(?:\s*;|$)/i.test(contentType))
    headers.set('content-type', contentType);
  return headers;
}
