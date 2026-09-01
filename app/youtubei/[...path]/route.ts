import { NextRequest, NextResponse } from 'next/server';
import {
  assertCollectorProxyRequest,
  boundedRequestBody,
  boundedUpstreamBody,
  collectorProxyEnabled,
  COLLECTOR_PROXY_TIMEOUT_MS,
  InnertubeProxyRequestError,
  safeYoutubeResponseHeaders,
  youtubeRequestHeaders,
  youtubeUpstreamUrl,
} from '../../collector/innertubeProxy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  if (!collectorProxyEnabled()) return new NextResponse('Not Found', { status: 404 });

  try {
    assertCollectorProxyRequest(request.headers);
    const { path } = await context.params;
    const pathname = `/youtubei/${path.join('/')}`;
    const upstreamUrl = youtubeUpstreamUrl(request.nextUrl, pathname, request.method);
    const body = await boundedRequestBody(request);
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers: youtubeRequestHeaders(request.headers),
      body,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(COLLECTOR_PROXY_TIMEOUT_MS),
    });
    const responseBody = await boundedUpstreamBody(upstream);
    return new NextResponse(responseBody, {
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

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}
