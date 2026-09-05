import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Collector self-diagnostics (2026-09-05). The collector page runs inside the
 * app's webview where nothing is visible; when a session fails the server
 * only sees "liveness failed". The page posts small enum-like markers here
 * (branch taken, failure code, first page seen) and they land in the Fly
 * logs. No chat text, no identifiers beyond the collector run id.
 */
const MAX_BODY = 1024;
const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 413 });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const entries = Object.entries(parsed ?? {})
    .filter(
      ([key, value]) =>
        SAFE.test(key) &&
        (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && SAFE.test(value))),
    )
    .slice(0, 12);
  console.info(`[collector-diag] ${JSON.stringify(Object.fromEntries(entries))}`);
  return NextResponse.json({ ok: true });
}
