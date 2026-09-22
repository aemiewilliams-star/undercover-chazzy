import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import Innertube from 'youtubei.js';
import useLiveChat from './useLiveChat';

type VideoInfo = Awaited<ReturnType<Innertube['getInfo']>>;

async function harness(info: Partial<VideoInfo>, run: (h: Harness) => Promise<void>) {
  const h = new Harness(info);
  try {
    h.mount();
    await h.flush();
    await run(h);
  } finally {
    h.restore();
  }
}

class Harness {
  statuses: { status: string; code?: string }[] = [];
  starts = 0;
  lookups = 0;
  now = 1_800_000_000_000;
  private timers = new Map<number, { due: number; interval: number; callback: () => void }>();
  private nextId = 1;
  private undo: (() => void)[] = [];
  private cleanup?: () => void;
  constructor(private readonly info: Partial<VideoInfo>) {}
  private setGlobal(name: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    this.undo.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  mount() {
    const oldCreate = Object.getOwnPropertyDescriptor(Innertube, 'create');
    Innertube.create = (() =>
      Promise.resolve({
        getInfo: () => {
          this.lookups++;
          return Promise.resolve({
            ...this.info,
            getLiveChat: () => ({
              on: () => {},
              off: () => {},
              stop: () => {},
              start: () => {
                this.starts++;
              },
            }),
          });
        },
      })) as unknown as typeof Innertube.create;
    this.undo.push(() => {
      Object.defineProperty(Innertube, 'create', oldCreate);
    });
    const oldOrigin = process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL;
    process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL = 'https://collector.example';
    this.undo.push(() => {
      if (oldOrigin === undefined) delete process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL;
      else process.env.NEXT_PUBLIC_COLLECTOR_PROXY_BASE_URL = oldOrigin;
    });
    this.setGlobal('fetch', () => Promise.resolve(Response.json({ ok: true })));
    const oldNow = Date.now;
    Date.now = () => this.now;
    this.undo.push(() => {
      Date.now = oldNow;
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
    const dispatcher = (
      React as unknown as {
        __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } };
      }
    ).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const oldDispatcher = dispatcher.current;
    let effect: (() => (() => void) | undefined) | undefined;
    dispatcher.current = {
      useState: (initial: unknown) => [initial, () => {}],
      useRef: (current: unknown) => ({ current }),
      useEffect: (callback: typeof effect) => {
        effect = callback;
      },
    };
    try {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled effect harness, as in CHZZK tests.
      useLiveChat(
        'testVideo01',
        () => {},
        () => {},
        {
          onPlatformStatus: (status, code) => this.statuses.push({ status, code }),
        },
      );
    } finally {
      dispatcher.current = oldDispatcher;
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

void test('real connect effect starts public chat when player response omits live metadata', async () => {
  // Observed production shape: player LOGIN_REQUIRED, next has live chat.
  await harness(
    {
      basic_info: {} as VideoInfo['basic_info'],
      playability_status: { status: 'LOGIN_REQUIRED' } as VideoInfo['playability_status'],
      livechat: { is_replay: false, continuation: 'public_live_chat' } as VideoInfo['livechat'],
    },
    async (h) => {
      assert.equal(h.starts, 1);
      assert.deepEqual(h.statuses, [{ status: 'live', code: undefined }]);
      await h.advance(10_000);
      assert.equal(h.lookups, 1);
    },
  );
});

void test('real connect effect retries unknown availability and exhausts without reporting ended', async () => {
  await harness(
    {
      basic_info: {} as VideoInfo['basic_info'],
      playability_status: { status: 'LOGIN_REQUIRED' } as VideoInfo['playability_status'],
    },
    async (h) => {
      assert.deepEqual(h.statuses, []);
      await h.advance(31_000);
      assert.equal(h.lookups, 6);
      assert.equal(h.starts, 0);
      assert.deepEqual(h.statuses, [{ status: 'unavailable', code: 'reconnect_exhausted' }]);
    },
  );
});

void test('real connect effect still closes a confirmed ended broadcast', async () => {
  await harness(
    {
      basic_info: { is_live: false } as VideoInfo['basic_info'],
      playability_status: { status: 'OK' } as VideoInfo['playability_status'],
    },
    async (h) => {
      await h.advance(31_000);
      assert.equal(h.lookups, 1);
      assert.equal(h.starts, 0);
      assert.deepEqual(h.statuses, [{ status: 'ended', code: 'not_live' }]);
    },
  );
});

void test('real connect effect never drains replay chat as a live stream', async () => {
  await harness(
    {
      basic_info: {} as VideoInfo['basic_info'],
      livechat: { is_replay: true, continuation: 'replay_chat' } as VideoInfo['livechat'],
    },
    async (h) => {
      await h.flush();
      assert.equal(h.starts, 0);
      assert.deepEqual(h.statuses, [{ status: 'ended', code: 'not_live' }]);
    },
  );
});
