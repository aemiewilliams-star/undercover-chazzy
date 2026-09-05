import { NextRequest, NextResponse } from 'next/server';

function collectorProxyOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL;
  if (raw == null || raw === '') {
    return "'self'";
  }

  try {
    return new URL(raw).origin;
  } catch {
    return "'self'";
  }
}

export function middleware(request: NextRequest) {
  const isCollectorPath = request.nextUrl.pathname.startsWith('/collector/');
  const isEnabledProxyPath =
    process.env.COLLECTOR_PROXY_ENABLED === '1' &&
    (request.nextUrl.pathname === '/sw.js_data' ||
      request.nextUrl.pathname.startsWith('/youtubei/') ||
      request.nextUrl.pathname.startsWith('/chzzk-api/'));
  if (process.env.COLLECTOR_ONLY_MODE === '1' && !isCollectorPath && !isEnabledProxyPath) {
    const notFound = new NextResponse('Not Found', { status: 404 });
    notFound.headers.set('Cache-Control', 'private, no-store, max-age=0');
    notFound.headers.set('X-Content-Type-Options', 'nosniff');
    notFound.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return notFound;
  }
  if (!isCollectorPath) return NextResponse.next();

  const nonce = btoa(crypto.randomUUID());
  const devEval = process.env.NODE_ENV === 'development' ? "'unsafe-eval'" : '';
  // CHZZK chat is a WebSocket the page opens directly (owner decision
  // 2026-09-05: webview collection); only the CHZZK collector pages get it.
  const chzzkChatOrigins = request.nextUrl.pathname.startsWith('/collector/chzzk/')
    ? ' wss://kr-ss1.chat.naver.com wss://kr-ss2.chat.naver.com wss://kr-ss3.chat.naver.com'
    : '';
  const csp = `
    default-src 'none';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${devEval};
    style-src 'self';
    connect-src 'self' ${collectorProxyOrigin()}${chzzkChatOrigins};
    img-src 'self' data:;
    font-src 'self';
    worker-src 'none';
    object-src 'none';
    base-uri 'none';
    form-action 'none';
    frame-ancestors 'none';
    block-all-mixed-content;
    upgrade-insecure-requests;
  `
    .replace(/\s{2,}/g, ' ')
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

export const config = {
  matcher: '/((?!_next/|favicon.ico).*)',
};
