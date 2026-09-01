import { immutableCollectorSourceUrl } from './sourceNotice';

function exactHttpsOrigin(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export interface CollectorDeploymentReadiness {
  ready: boolean;
  checks: {
    collectorOnly: boolean;
    bridgeDebugDisabled: boolean;
    selfHostedProxy: boolean;
    immutableSourceNotice: boolean;
  };
  sourceUrl: string | null;
}

export function collectorDeploymentReadiness(): CollectorDeploymentReadiness {
  const configuredProxy = exactHttpsOrigin(process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL);
  const publicOrigin = exactHttpsOrigin(process.env.COLLECTOR_PUBLIC_ORIGIN);
  const source = immutableCollectorSourceUrl(
    process.env.NEXT_PUBLIC_SOURCE_CODE_URL,
    process.env.NEXT_PUBLIC_SOURCE_REVISION,
  );
  const checks = {
    collectorOnly: process.env.COLLECTOR_ONLY_MODE === '1',
    bridgeDebugDisabled: process.env.NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG !== '1',
    selfHostedProxy:
      process.env.COLLECTOR_PROXY_ENABLED === '1' &&
      publicOrigin !== null &&
      configuredProxy?.origin === publicOrigin.origin,
    immutableSourceNotice: source !== null,
  };
  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    sourceUrl: source?.toString() ?? null,
  };
}
