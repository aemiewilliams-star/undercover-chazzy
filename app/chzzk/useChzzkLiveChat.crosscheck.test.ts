import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import useChzzkLiveChat, { ChzzkLiveChatHealth } from './useChzzkLiveChat';
import { ChzzkChatItem } from './chzzkChatProtocol';

// Exercise the real effect with controlled provider I/O and time, without a DOM.
async function harness(run: (h: Harness) => Promise<void>, prepare?: (h: Harness) => void) {
  const h = new Harness();
  try {
    prepare?.(h);
    h.mount();
    await h.flush();
    await run(h);
  } finally {
    h.restore();
  }
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: { cmd: number }[] = [];
  constructor(readonly url: string) {}
  send(value: string) {
    this.sent.push(JSON.parse(value) as { cmd: number });
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(cmd: number, bdy?: unknown) {
    this.onmessage?.({ data: JSON.stringify({ cmd, bdy }) });
  }
  disconnect() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class Harness {
  now = 1_788_600_000_000;
  sockets: FakeSocket[] = [];
  health: ChzzkLiveChatHealth[] = [];
  statuses: { status: string; code?: string }[] = [];
  chats: ChzzkChatItem[] = [];
  liveResponse = () =>
    Promise.resolve(Response.json({ code: 200, content: { status: 'OPEN', chatChannelId: 'room_1' } }));
  tokenResponse = () => Promise.resolve(Response.json({ code: 200, content: { accessToken: 'fixture_token' } }));
  private timers = new Map<number, { due: number; interval: number; callback: () => void }>();
  private nextId = 1;
  private undo: (() => void)[] = [];
  private cleanup?: () => void;
  private setGlobal(name: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    this.undo.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  mount() {
    const originalNow = Date.now;
    Date.now = () => this.now;
    this.undo.push(() => {
      Date.now = originalNow;
    });
    const env = process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL;
    process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL = 'https://collector.example';
    this.undo.push(() => {
      if (env === undefined) delete process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL;
      else process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL = env;
    });
    const timer = (callback: () => void, delay: number, interval: boolean) => {
      const id = this.nextId++;
      this.timers.set(id, { callback, due: this.now + delay, interval: interval ? delay : 0 });
      return id;
    };
    this.setGlobal('setTimeout', (cb: () => void, ms: number) => timer(cb, ms, false));
    this.setGlobal('setInterval', (cb: () => void, ms: number) => timer(cb, ms, true));
    this.setGlobal('clearTimeout', (id: number) => {
      this.timers.delete(id);
    });
    this.setGlobal('clearInterval', (id: number) => {
      this.timers.delete(id);
    });
    this.setGlobal('fetch', (url: URL) =>
      url.pathname.endsWith('/access-token') ? this.tokenResponse() : this.liveResponse(),
    );
    const sockets = this.sockets;
    this.setGlobal(
      'WebSocket',
      class extends FakeSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );
    type Dispatcher = { current: unknown };
    const dispatcher = (
      React as unknown as {
        __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: Dispatcher };
      }
    ).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const old = dispatcher.current;
    let effect: (() => (() => void) | undefined) | undefined;
    dispatcher.current = {
      useState: (initial: unknown) => [initial, () => {}],
      useRef: (current: unknown) => ({ current }),
      useEffect: (callback: typeof effect) => {
        effect = callback;
      },
    };
    try {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- A controlled React dispatcher is installed above.
      useChzzkLiveChat('0123456789abcdef0123456789abcdef', (item) => this.chats.push(item), {
        onHealthUpdate: (health) => this.health.push(health),
        onPlatformStatus: (status, code) => this.statuses.push({ status, code }),
      });
    } finally {
      dispatcher.current = old;
    }
    this.cleanup = effect?.();
  }
  async flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = Array.from(this.timers)
        .filter(([, t]) => t.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else this.timers.delete(id);
      timer.callback();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }
  restore() {
    this.cleanup?.();
    this.undo.reverse().forEach((fn) => fn());
  }
}

void test('quiet channel PING and PONG publish fresh provider health without fabricating chat', async () => {
  await harness(async (h) => {
    const ws = h.sockets[0];
    ws.open();
    ws.frame(10100);
    await h.advance(20_000);
    ws.frame(0);
    assert.equal(ws.sent.at(-1)?.cmd, 10000);
    assert.equal(h.health.at(-1)?.lastProviderSuccessAt, h.now);
    await h.advance(20_000);
    ws.frame(10000);
    assert.equal(h.health.at(-1)?.lastProviderSuccessAt, h.now);
    assert.equal(h.health.at(-1)?.lastMessageAt, null);
    assert.equal(h.chats.length, 0);
  });
});

void test('successful REST metadata polls cannot hide a stalled chat socket', async () => {
  await harness(async (h) => {
    h.sockets[0].open();
    h.sockets[0].frame(10100);
    await h.advance(64_000);
    assert.ok(h.health.some((health) => health.code === 'provider_stalled'));
    assert.equal(h.sockets.length, 2);
    assert.equal(h.sockets[1].url, 'wss://kr-ss2.chat.naver.com/chat');
  });
});

void test('a socket that never completes CONNECT also times out while REST remains live', async () => {
  await harness(async (h) => {
    await h.advance(64_000);
    assert.equal(h.sockets.length, 2);
    assert.ok(h.health.some((health) => health.code === 'provider_stalled'));
  });
});

void test('late CLOSE from a stopped socket cannot terminate a reconnecting session', async () => {
  await harness(async (h) => {
    const ws = h.sockets[0];
    ws.open();
    ws.frame(10100);
    let finish: ((response: Response) => void) | undefined;
    h.liveResponse = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await h.advance(30_000);
    ws.disconnect();
    finish?.(Response.json({ code: 200, content: { status: 'CLOSE' } }));
    await h.flush();
    assert.ok(!h.statuses.some((status) => status.status === 'ended'));
    h.liveResponse = () =>
      Promise.resolve(Response.json({ code: 200, content: { status: 'OPEN', chatChannelId: 'room_1' } }));
    await h.advance(1_000);
    assert.equal(h.sockets.length, 2);
  });
});

void test('current stream CLOSE is terminal and cancels the live socket', async () => {
  await harness(async (h) => {
    h.sockets[0].open();
    h.sockets[0].frame(10100);
    h.liveResponse = () => Promise.resolve(Response.json({ code: 200, content: { status: 'CLOSE' } }));
    await h.advance(30_000);
    assert.deepEqual(h.statuses.at(-1), { status: 'ended', code: 'provider_stream_ended' });
    await h.advance(90_000);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].readyState, 3);
  });
});

void test('socket close rotates hosts and retries at the shared backoff', async () => {
  await harness(async (h) => {
    h.sockets[0].disconnect();
    await h.advance(999);
    assert.equal(h.sockets.length, 1);
    await h.advance(1);
    assert.equal(h.sockets[1].url, 'wss://kr-ss2.chat.naver.com/chat');
    h.sockets[1].disconnect();
    await h.advance(2_000);
    assert.equal(h.sockets[2].url, 'wss://kr-ss3.chat.naver.com/chat');
  });
});

void test('initial CLOSE reports not_live without opening a socket or retrying', async () => {
  await harness(
    async (h) => {
      assert.deepEqual(h.statuses, [{ status: 'ended', code: 'not_live' }]);
      await h.advance(120_000);
      assert.equal(h.sockets.length, 0);
    },
    (h) => {
      h.liveResponse = () => Promise.resolve(Response.json({ code: 200, content: { status: 'CLOSE' } }));
    },
  );
});

void test('token failures retain the start-failed diagnostic and eventually exhaust backoff', async () => {
  await harness(
    async (h) => {
      assert.equal(h.health.at(-1)?.code, 'live_chat_start_failed');
      await h.advance(31_000);
      assert.deepEqual(h.statuses.at(-1), { status: 'unavailable', code: 'reconnect_exhausted' });
      assert.equal(h.sockets.length, 0);
    },
    (h) => {
      h.tokenResponse = () => Promise.resolve(new Response('', { status: 503 }));
    },
  );
});

void test('a good keepalive clears a transient socket error in a connected session', async () => {
  await harness(async (h) => {
    const ws = h.sockets[0];
    ws.open();
    ws.frame(10100);
    ws.onerror?.();
    assert.equal(h.health.at(-1)?.liveness, 'degraded');
    await h.advance(1_000);
    ws.frame(10000);
    assert.equal(h.health.at(-1)?.liveness, 'healthy');
    assert.equal(h.health.at(-1)?.code, undefined);
  });
});
