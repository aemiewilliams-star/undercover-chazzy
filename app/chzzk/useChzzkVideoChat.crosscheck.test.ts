import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import useChzzkVideoChat, { ChzzkVideoChatHealth as ChzzkLiveChatHealth } from './useChzzkVideoChat';
import { ChzzkChatItem } from './chzzkChatProtocol';
import { chzzkVideoChatPage, chzzkVideoChatNextOffset } from './chzzkVideoChat';
const findings: Record<string, unknown> = {};
const output = path.join(os.tmpdir(), 'chzzk-replay-hook-results.json');
const save = () => fs.writeFileSync(output, JSON.stringify(findings, null, 2));
function entry(offset: number, hidden = false) {
  return {
    playerMessageTime: offset,
    messageTime: 1800000000000 + offset,
    messageTypeCode: 1,
    messageStatusType: hidden ? 'HIDDEN' : 'NORMAL',
    content: 'synthetic',
    profile: JSON.stringify({ userIdHash: 's' + offset }),
  };
}
const page = (entries: unknown[], next: number | null) =>
  Response.json({ code: 200, content: { videoChats: entries, nextPlayerMessageTime: next } });
class Harness {
  now = 1_788_600_000_000;
  requests: { at: number; offset: number }[] = [];
  health: ChzzkLiveChatHealth[] = [];
  healthTimes: number[] = [];
  statuses: { status: string; code?: string }[] = [];
  chats: { at: number; item: ChzzkChatItem }[] = [];
  response: (offset: number, call: number) => Promise<Response> = () =>
    Promise.resolve(Response.json({ code: 200, content: { videoChats: [], nextPlayerMessageTime: null } }));
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
    this.setGlobal('fetch', (url: URL) => {
      const offset = Number(url.searchParams.get('playerMessageTime'));
      this.requests.push({ at: this.now, offset });
      return this.response(offset, this.requests.length);
    });
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
      useChzzkVideoChat(
        '15031050',
        { kind: 'recorded', startOffsetMs: 0 },
        (item) => this.chats.push({ at: this.now, item }),
        {
          onHealthUpdate: (health) => {
            this.health.push(health);
            this.healthTimes.push(this.now);
          },
          onPlatformStatus: (status, code) => this.statuses.push({ status, code }),
        },
      );
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

void test('filtered page must retain a forward cursor', () => {
  const parsed = chzzkVideoChatPage({ videoChats: [entry(100, true)], nextPlayerMessageTime: 100 });
  const actual = chzzkVideoChatNextOffset(parsed, 0);
  findings.filteredPage = { rawCount: 1, acceptedCount: parsed.items.length, next: 100, actual };
  save();
  assert.equal(actual, 100);
});
void test('actual replay hook must reach a later valid page after hidden-only page', async () => {
  const h = new Harness();
  h.response = (_, call) => Promise.resolve(call === 1 ? page([entry(100, true)], 100) : page([entry(200)], null));
  try {
    h.mount();
    await h.flush();
    await h.advance(3000);
    findings.filteredHook = { requests: h.requests.length, emitted: h.chats.length, terminal: h.statuses.at(-1) };
    save();
    assert.equal(h.chats.length, 1);
  } finally {
    h.restore();
  }
});
void test('reconnect does not skip buffered items between last tick and failure', async () => {
  const h = new Harness();
  const data = Array.from({ length: 200 }, (_, i) => entry((i + 1) * 100));
  h.response = async (offset, call) => {
    if (call === 2) return new Promise((_, reject) => setTimeout(() => reject(Error('synthetic failure')), 125));
    if (call === 1) return page(data, 20000);
    return page(
      data.filter((e) => e.playerMessageTime > offset),
      null,
    );
  };
  try {
    h.mount();
    await h.flush();
    await h.advance(25000);
    const ids = h.chats.map((c) => c.item.timestamp);
    const missing = data.filter((e) => !ids.includes(e.messageTime)).map((e) => e.playerMessageTime);
    findings.reconnect = {
      requests: h.requests.map((r) => r.offset),
      emitted: h.chats.length,
      unique: new Set(ids).size,
      missingOffsets: missing,
    };
    save();
    assert.deepEqual(missing, []);
  } finally {
    h.restore();
  }
});
void test('measure throughput at several rates and provider latencies', async () => {
  const rows = [];
  for (const [rate, latency] of [
    [20, 0],
    [50, 0],
    [100, 0],
    [200, 0],
    [250, 0],
    [50, 3000],
    [80, 3000],
  ]) {
    const h = new Harness();
    const interval = 1000 / rate;
    let firstResponseAt = 0;
    h.response = (offset) =>
      new Promise((resolve) => {
        const deliver = () => {
          if (!firstResponseAt) firstResponseAt = h.now;
          const begin = Math.floor(offset / interval) + 1;
          resolve(
            page(
              Array.from({ length: 200 }, (_, i) => entry(Math.round((begin + i) * interval))),
              Math.round((begin + 199) * interval),
            ),
          );
        };
        if (latency) setTimeout(deliver, latency);
        else deliver();
      });
    try {
      h.mount();
      await h.flush();
      await h.advance(30000);
      const lags = h.chats.map((c) => c.at - firstResponseAt - (c.item.timestamp - 1800000000000));
      rows.push({
        rate,
        latency,
        requests: h.requests.length,
        emitted: h.chats.length,
        maxLagMs: Math.max(...lags, 0),
        lateBeyondTick: h.chats.filter((_, i) => lags[i] > 250).length,
        elapsedSincePlaybackMs: h.now - firstResponseAt,
        minRequestGapMs: Math.min(...h.requests.slice(1).map((r, i) => r.at - h.requests[i].at)),
      });
    } finally {
      h.restore();
    }
  }
  findings.throughput = rows;
  save();
  assert.equal(rows.length, 7);
});
void test('healthy buffered replay republishes timestamps without new requests', async () => {
  const h = new Harness();
  h.response = () => Promise.resolve(page([entry(300000)], 300000));
  try {
    h.mount();
    await h.flush();
    await h.advance(90000);
    findings.health = {
      requests: h.requests.length,
      snapshots: h.health.length,
      maxSuccessAgeMs: Math.max(
        ...h.health.map((x, i) => (x.lastProviderSuccessAt == null ? 0 : h.healthTimes[i] - x.lastProviderSuccessAt)),
      ),
      finalSuccessAgeMs: h.now - h.health.at(-1).lastProviderSuccessAt,
      finalLiveness: h.health.at(-1).liveness,
    };
    save();
    assert.ok(h.now - h.health.at(-1).lastProviderSuccessAt < 2500);
    assert.equal(h.requests.length, 1);
  } finally {
    h.restore();
  }
});

void test('reconnect after buffer starvation resumes within the fetched prefix', async () => {
  const h = new Harness();
  const data = Array.from({ length: 400 }, (_, i) => entry((i + 1) * 10));
  h.response = async (offset, call) => {
    if (call === 1) return page(data.slice(0, 200), 2000);
    if (call === 2) return new Promise((_, reject) => setTimeout(() => reject(Error('synthetic slow failure')), 3125));
    return page(
      data.filter((e) => e.playerMessageTime > offset),
      null,
    );
  };
  try {
    h.mount();
    await h.flush();
    await h.advance(15000);
    const ids = h.chats.map((c) => c.item.timestamp);
    const missing = data.filter((e) => !ids.includes(e.messageTime));
    findings.starvedReconnect = {
      requests: h.requests.map((r) => r.offset),
      emitted: h.chats.length,
      unique: new Set(ids).size,
      missingCount: missing.length,
    };
    save();
    assert.equal(missing.length, 0);
    assert.equal(new Set(ids).size, data.length);
  } finally {
    h.restore();
  }
});
