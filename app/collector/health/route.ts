import { NextResponse } from 'next/server';
import { collectorDeploymentReadiness } from '../deploymentReadiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  const readiness = collectorDeploymentReadiness();
  return NextResponse.json(
    {
      status: readiness.ready ? 'ready' : 'not_ready',
      checks: readiness.checks,
    },
    {
      status: readiness.ready ? 200 : 503,
      headers: {
        'cache-control': 'private, no-store, max-age=0',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex, nofollow',
      },
    },
  );
}
