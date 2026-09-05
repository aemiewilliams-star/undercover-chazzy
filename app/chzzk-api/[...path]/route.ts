import { NextRequest, NextResponse } from 'next/server';
import {
  assertCollectorProxyRequest,
  collectorProxyEnabled,
  InnertubeProxyRequestError,
} from '../../collector/innertubeProxy';
import {
  boundedChzzkBody,
  CHZZK_PROXY_TIMEOUT_MS,
  chzzkRequestHeaders,
  ChzzkProxyRequestError,
  chzzkUpstreamUrl,
  safeChzzkResponseHeaders,
} from '../../collector/chzzkProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ path: string[] }> };

/** GET-only allowlisted proxy for the three CHZZK REST calls the collector page needs. */
export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!collectorProxyEnabled()) return new NextResponse('Not Found', { status: 404 });
  try {
    assertCollectorProxyRequest(request.headers);
    const { path } = await context.params;
    const pathname = `/chzzk-api/${path.join('/')}`;
    const upstreamUrl = chzzkUpstreamUrl(request.nextUrl, pathname, request.method);
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: chzzkRequestHeaders(),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(CHZZK_PROXY_TIMEOUT_MS),
    });
    const body = await boundedChzzkBody(upstream);
    return new NextResponse(body, { status: upstream.status, headers: safeChzzkResponseHeaders(upstream.headers) });
  } catch (error) {
    if (error instanceof ChzzkProxyRequestError || error instanceof InnertubeProxyRequestError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: { 'cache-control': 'private, no-store, max-age=0' } },
      );
    }
    return NextResponse.json(
      { error: 'proxy_upstream_unavailable' },
      { status: 502, headers: { 'cache-control': 'private, no-store, max-age=0' } },
    );
  }
}
