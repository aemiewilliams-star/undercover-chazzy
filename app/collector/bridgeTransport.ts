import {
  COLLECTOR_BOOTSTRAP_HANDLER,
  COLLECTOR_BRIDGE_HANDLER,
  COLLECTOR_BRIDGE_VERSION,
  CollectorBridgeMessage,
  CollectorRuntimeConfig,
  isCollectorRuntimeConfig,
} from './contracts';

declare global {
  interface Window {
    flutter_inappwebview?: {
      callHandler: (handlerName: string, ...args: unknown[]) => Promise<unknown>;
    };
  }
}

function debugBridgeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_COLLECTOR_BRIDGE_DEBUG === '1';
}

function debugRuntimeConfig(): CollectorRuntimeConfig | null {
  if (!debugBridgeEnabled()) return null;
  const query = new URLSearchParams(window.location.search);
  const config = {
    bridgeToken: query.get('bridgeToken') ?? '',
    collectorRunId: query.get('collectorRunId') ?? '',
  };
  return isCollectorRuntimeConfig(config) ? config : null;
}

export async function requestCollectorRuntimeConfig(): Promise<CollectorRuntimeConfig | null> {
  const debugConfig = debugRuntimeConfig();
  if (debugConfig != null) return debugConfig;

  const nativeBridge = window.flutter_inappwebview;
  if (nativeBridge == null) return null;
  try {
    const result = await nativeBridge.callHandler(COLLECTOR_BOOTSTRAP_HANDLER, {
      bridgeVersion: COLLECTOR_BRIDGE_VERSION,
    });
    if (typeof result !== 'object' || result == null) return null;
    const config = result as CollectorRuntimeConfig;
    return isCollectorRuntimeConfig(config) ? config : null;
  } catch {
    return null;
  }
}

export async function sendCollectorBridgeMessage(message: CollectorBridgeMessage): Promise<boolean> {
  if (debugBridgeEnabled()) {
    window.dispatchEvent(new CustomEvent('undercover-live-chat-bridge', { detail: message }));
  }

  const nativeBridge = window.flutter_inappwebview;
  if (nativeBridge == null) return debugBridgeEnabled();
  try {
    const result = await nativeBridge.callHandler(COLLECTOR_BRIDGE_HANDLER, message);
    return bridgeDeliveryAccepted(result);
  } catch {
    return false;
  }
}

export function bridgeDeliveryAccepted(value: unknown): boolean {
  return value === true;
}
