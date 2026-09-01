import { NextRequest, NextResponse } from 'next/server';
import {
  assertCollectorProxyRequest,
  boundedUpstreamBody,
  collectorProxyEnabled,
  COLLECTOR_PROXY_TIMEOUT_MS,
  InnertubeProxyRequestError,
  safeYoutubeResponseHeaders,
  youtubeRequestHeaders,
  youtubeUpstreamUrl,
} from '../collector/innertubeProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  if (!collectorProxyEnabled()) return new NextResponse('Not Found', { status: 404 });
  try {
    assertCollectorProxyRequest(request.headers);
    const upstreamUrl = youtubeUpstreamUrl(request.nextUrl, '/sw.js_data', 'GET');
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: youtubeRequestHeaders(request.headers),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(COLLECTOR_PROXY_TIMEOUT_MS),
    });
    return new NextResponse(await boundedUpstreamBody(upstream), {
      status: upstream.status,
      headers: safeYoutubeResponseHeaders(upstream.headers),
    });
  } catch (error) {
    if (error instanceof InnertubeProxyRequestError) {
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
