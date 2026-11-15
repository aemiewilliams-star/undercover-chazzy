import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import Innertube from 'youtubei.js';
import useLiveChat, { type YoutubeLiveChatOptions } from './useLiveChat';

type VideoInfo = Awaited<ReturnType<Innertube['getInfo']>>;

type InfoSequence = Partial<VideoInfo> | Partial<VideoInfo>[];

/** Mocked replay proxy behaviour: which page requests fail, and whether pages keep a continuation. */
type ReplayPages = { failPage?: (index: number) => boolean; endless?: boolean };

async function harness(
  info: InfoSequence,
  run: (h: Harness) => Promise<void>,
  playback?: YoutubeLiveChatOptions['playback'],
  pages?: ReplayPages,
) {
  const h = new Harness(info, playback, pages);
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
  replayRequests: { action: string; offsetMs: string }[] = [];
  delivered: { id: string; offsetMs?: number }[] = [];
  now = 1_800_000_000_000;
  private timers = new Map<number, { due: number; interval: number; callback: () => void }>();
  private nextId = 1;
  private undo: (() => void)[] = [];
  private cleanup?: () => void;
  constructor(
    private readonly info: InfoSequence,
    private readonly playback?: YoutubeLiveChatOptions['playback'],
    private readonly pages: ReplayPages = {},
  ) {}
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
            ...(Array.isArray(this.info) ? this.info[Math.min(this.lookups - 1, this.info.length - 1)] : this.info),
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
        actions: {
          execute: (action: string, payload: { currentPlayerState: { playerOffsetMs: string } }) => {
            this.replayRequests.push({ action, offsetMs: payload.currentPlayerState.playerOffsetMs });
            const index = this.replayRequests.length - 1;
            if (this.pages.failPage?.(index)) {
              return Promise.reject(new Error('simulated replay page failure'));
            }
            const start = this.playback?.startOffsetMs ?? 0;
            return Promise.resolve({
              continuation_contents: {
                actions: [1_000, 121_000].map((offset) => ({
                  type: 'ReplayChatItemAction',
                  video_offset_time_msec: start + offset,
                  actions: [{ type: 'AddChatItemAction', item: { id: `message-${offset}` } }],
                })),
                // Without a token the page is the last one (the pre-existing single-page shape).
                ...(this.pages.endless ? { continuation: { token: `replay-page-${index + 1}` } } : {}),
              },
            });
          },
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
        (action, offsetMs) => {
          const id = (action.item as unknown as { id?: unknown }).id;
          if (typeof id === 'string') this.delivered.push({ id, offsetMs });
        },
        () => {},
        {
          playback: this.playback,
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

void test('real connect effect retries unknown availability and exhausts by time without reporting ended', async () => {
  // No lookup ever says live: the outage ends after the time budget (180 s),
  // not after five tries. Lookups at 0, 1, 3, 7, 15, 31, then every 30 s.
  await harness(
    {
      basic_info: {} as VideoInfo['basic_info'],
      playability_status: { status: 'LOGIN_REQUIRED' } as VideoInfo['playability_status'],
    },
    async (h) => {
      assert.deepEqual(h.statuses, []);
      await h.advance(31_000);
      assert.equal(h.lookups, 6);
      assert.deepEqual(h.statuses, []);
      await h.advance(150_000);
      assert.equal(h.lookups, 11);
      assert.equal(h.starts, 0);
      assert.deepEqual(h.statuses, [{ status: 'unavailable', code: 'reconnect_exhausted' }]);
      await h.advance(120_000);
      assert.equal(h.lookups, 11);
    },
  );
});

/** 2026-11-14 20:01:25–20:02:01 KST collector-diag (MBC 24-hour live, second source of two). */
const liveWithoutChatRenderer: Partial<VideoInfo> = {
  basic_info: { is_live: true } as VideoInfo['basic_info'],
  playability_status: { status: 'UNPLAYABLE' } as VideoInfo['playability_status'],
};
const liveWithChat: Partial<VideoInfo> = {
  ...liveWithoutChatRenderer,
  livechat: { is_replay: false, continuation: 'public_live_chat' } as VideoInfo['livechat'],
};

void test('a live broadcast whose lookups briefly omit the chat renderer keeps retrying and then collects', async () => {
  // Six lookups in a row said is_live (player UNPLAYABLE) but came back without
  // the live chat renderer; the 1+2+4+8+16 s count budget ended the source at the
  // sixth, 36 s in (`reconnect_exhausted`), while its chat was flowing. The same
  // video through the same proxy returned the renderer again the next day.
  // Here the renderer comes back on the twelfth lookup (211 s): past the 3-minute
  // budget, inside the 10-minute budget a live broadcast gets.
  await harness([...Array<Partial<VideoInfo>>(11).fill(liveWithoutChatRenderer), liveWithChat], async (h) => {
    await h.advance(31_000);
    assert.equal(h.lookups, 6);
    assert.deepEqual(h.statuses, [], 'the sixth missing renderer must not end a live broadcast');
    await h.advance(150_000);
    assert.equal(h.lookups, 11);
    assert.deepEqual(h.statuses, [], 'a live broadcast is not held to the 3-minute budget');
    await h.advance(30_000);
    assert.equal(h.lookups, 12);
    assert.equal(h.starts, 1);
    assert.deepEqual(h.statuses, [{ status: 'live', code: undefined }]);
  });
});

void test('a broadcast that stays live but never gets its chat fails at the 10-minute budget', async () => {
  // Owner decision 2026-11-15 ("10분 뒤 실패로"): live evidence extends the budget
  // to 10 minutes from the first failure, not for the whole session.
  // Lookups at 0, 1, 3, 7, 15, 31 s, then every 30 s; the try at 601 s is over budget.
  await harness(liveWithoutChatRenderer, async (h) => {
    await h.advance(600_000);
    assert.equal(h.lookups, 24);
    assert.deepEqual(h.statuses, []);
    await h.advance(1_000);
    assert.equal(h.lookups, 25);
    assert.equal(h.starts, 0);
    assert.deepEqual(h.statuses, [{ status: 'unavailable', code: 'reconnect_exhausted' }]);
    await h.advance(10 * 60_000);
    assert.equal(h.lookups, 25);
  });
});

void test('a lookup that says the broadcast is no longer live ends the retries within the time budget', async () => {
  // The outage clock runs from the first failure, so the budget is not restarted
  // by the lookup that flips the broadcast to not live.
  const noLongerLive: Partial<VideoInfo> = {
    basic_info: { is_live: false } as VideoInfo['basic_info'],
    playability_status: { status: 'UNPLAYABLE' } as VideoInfo['playability_status'],
  };
  await harness(
    [liveWithoutChatRenderer, liveWithoutChatRenderer, liveWithoutChatRenderer, noLongerLive],
    async (h) => {
      await h.advance(151_000);
      assert.equal(h.lookups, 10);
      assert.deepEqual(h.statuses, []);
      await h.advance(30_000);
      assert.equal(h.lookups, 11);
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

const recorded = { kind: 'recorded', startOffsetMs: 60_000 } as const;
const replayInfo: Partial<VideoInfo> = {
  basic_info: {} as VideoInfo['basic_info'],
  playability_status: { status: 'LOGIN_REQUIRED' } as VideoInfo['playability_status'],
  livechat: { is_replay: true, continuation: 'public_replay_chat' } as VideoInfo['livechat'],
};

void test('recorded startup retries missing chat and preserves the requested offset when it becomes available', async () => {
  await harness(
    [{ basic_info: {} as VideoInfo['basic_info'] }, replayInfo],
    async (h) => {
      assert.deepEqual(h.statuses, []);
      assert.equal(h.replayRequests.length, 0);
      await h.advance(1_000);
      assert.equal(h.lookups, 2);
      assert.deepEqual(h.replayRequests, [{ action: 'live_chat/get_live_chat_replay', offsetMs: '60000' }]);
      assert.deepEqual(h.statuses, [{ status: 'live', code: undefined }]);
      assert.deepEqual(h.delivered, []);
      await h.advance(1_000);
      assert.deepEqual(h.delivered, [{ id: 'message-1000', offsetMs: 61_000 }]);
      assert.equal(h.starts, 0);
    },
    recorded,
  );
});

void test('recorded startup bounds retries when no chat is available instead of failing on the first response', async () => {
  // A replay is never live: it keeps the 180 s time budget.
  await harness(
    {
      basic_info: { is_live: false } as VideoInfo['basic_info'],
      playability_status: { status: 'OK' } as VideoInfo['playability_status'],
    },
    async (h) => {
      assert.deepEqual(h.statuses, []);
      await h.advance(31_000);
      assert.equal(h.lookups, 6);
      assert.deepEqual(h.statuses, []);
      await h.advance(150_000);
      assert.equal(h.lookups, 11);
      assert.equal(h.replayRequests.length, 0);
      assert.deepEqual(h.statuses, [{ status: 'unavailable', code: 'reconnect_exhausted' }]);
      await h.advance(60_000);
      assert.equal(h.lookups, 11);
    },
    recorded,
  );
});

void test('recorded startup still immediately uses available public replay when the player requires login', async () => {
  await harness(
    replayInfo,
    async (h) => {
      assert.equal(h.lookups, 1);
      assert.deepEqual(h.statuses, [{ status: 'live', code: undefined }]);
      await h.advance(1_000);
      assert.deepEqual(h.delivered, [{ id: 'message-1000', offsetMs: 61_000 }]);
      assert.equal(h.starts, 0);
    },
    recorded,
  );
});

void test('recorded reconnects that re-establish the replay do not exhaust the retry budget', async () => {
  // Production shape of 2026-10-01 13:25-13:26 KST (session lc_01139bae…): every
  // page after a successful first page fails, and each reconnect gets its first
  // page again. The five retries ran out in ~40 s while chat was still arriving.
  // A first page with chat past the resume point now restarts the budget.
  await harness(
    replayInfo,
    async (h) => {
      await h.advance(120_000);
      assert.equal(
        h.statuses.some((s) => s.status === 'unavailable'),
        false,
        `exhausted after ${h.lookups} lookups: ${JSON.stringify(h.statuses)}`,
      );
      assert.ok(h.lookups >= 8, `expected repeated reconnects, saw ${h.lookups} lookups`);
      assert.ok(h.replayRequests.length >= 16, `expected repeated pages, saw ${h.replayRequests.length}`);
      assert.deepEqual(h.delivered.slice(0, 1), [{ id: 'message-1000', offsetMs: 61_000 }]);
    },
    recorded,
    { failPage: (index) => index % 2 === 1, endless: true },
  );
});

void test('recorded pages that keep failing without any first page still exhaust the retry budget', async () => {
  // The budget is only restarted by progress; a proxy that never answers a page
  // still ends in `reconnect_exhausted` once the outage passes the 180 s budget.
  await harness(
    replayInfo,
    async (h) => {
      await h.advance(60_000);
      assert.equal(h.lookups, 6);
      assert.deepEqual(h.statuses, []);
      await h.advance(121_000);
      assert.equal(h.lookups, 11);
      assert.deepEqual(h.statuses, [{ status: 'unavailable', code: 'reconnect_exhausted' }]);
      assert.deepEqual(h.delivered, []);
    },
    recorded,
    { failPage: () => true },
  );
});
