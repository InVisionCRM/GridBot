import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSwap, DEFAULT_DAYS as KEEP_DAYS, MAX_DAYS, PoolHistories, type PoolRef } from '../src/server/lp/poolHistory';
import { V3_SWAP_TOPIC, type LogReader } from '../src/server/market/onchain';
import { syncAnswer } from '../src/server/lp/replay';

const POOL = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca';
const T0 = 1_790_000_000;
const DAY = 86_400;
const hex = (x: bigint) => (x < 0n ? (1n << 256n) + x : x).toString(16).padStart(64, '0');
const swapData = (a0: bigint, a1: bigint, liq: bigint, tick: number) => '0x' + [a0, a1, 1n << 96n, liq, BigInt(tick)].map(hex).join('');

/** A chain with one block a second from T0, a swap every `every` blocks, and an RPC that refuses requests matching more than `cap` logs. */
function chain(o: { days: number; every: number; cap: number }) {
  const latest = o.days * DAY;
  const calls = { logs: 0, refused: 0, blocks: 0 };
  let head = latest;
  const swapAt = (n: number) => ({ blockNumber: n, index: 0, topics: [V3_SWAP_TOPIC], data: swapData(10n ** 15n, -2n * 10n ** 6n, 10n ** 18n, -198_000 + (n % 7)) });
  const reader: LogReader = {
    getBlockNumber: async () => head,
    getBlock: async (n: number) => { calls.blocks++; return n <= head ? { timestamp: T0 + n } : null; },
    getLogs: async (f) => {
      calls.logs++;
      const first = Math.ceil(f.fromBlock / o.every) * o.every, n = first <= f.toBlock ? Math.floor((f.toBlock - first) / o.every) + 1 : 0;
      if (n > o.cap) { calls.refused++; throw new Error(`logs matched by query exceeds limit of ${o.cap}`); }
      return Array.from({ length: n }, (_, i) => swapAt(first + i * o.every));
    },
  };
  return { reader, calls, latest, grow: (blocks: number) => { head += blocks; } };
}

const REF: PoolRef = { chainId: 4663, pool: POOL, feeTier: 100, lpShare: 0.75, logChunk: 20_000 };
/** No waiting in tests */
const fast = (now: () => number) => ({ now, gapMs: 0, sleep: async () => {} });

describe('decodeSwap', () => {
  it('reads signed amounts, liquidity and a negative tick from a V3 Swap event', () => {
    expect(decodeSwap(swapData(-5n, 7n, 123n, -198_361), 42)).toEqual({ t: 42, a0: -5, a1: 7, liq: 123, tick: -198_361 });
  });
});

describe('PoolHistories: a pool\'s swaps kept as minutes', () => {
  it(`first sync reaches back ${KEEP_DAYS} days, splitting requests the RPC refuses; saved and read back`, async () => {
    const c = chain({ days: KEEP_DAYS + 2, every: 30, cap: 400 });
    const dir = mkdtempSync(join(tmpdir(), 'ph-'));
    const now = () => (T0 + c.latest) * 1000;
    const h = new PoolHistories(dir, () => c.reader, fast(now)).get(REF);
    await h.sync();
    expect(h.state).toMatchObject({ syncing: false, error: null, done: h.state.total });
    // one swap every 30 s → 2 per minute, for 14 days (± a minute at the start)
    const m = h.minutes;
    expect(Math.abs(m[0].t - (T0 + c.latest - KEEP_DAYS * DAY))).toBeLessThanOrEqual(120);
    expect(m.length).toBeGreaterThan(KEEP_DAYS * 1440 - 3);
    expect(m.every((x) => x.n >= 1 && x.n <= 2)).toBe(true);
    // fees: 1e15 token0 in × 0.01 % × 75 % ÷ 1e18 liquidity, per swap
    expect(m[5].f0).toBeCloseTo((m[5].n * 1e15 * 1e-4 * 0.75) / 1e18, 18);
    expect(c.calls.refused).toBeGreaterThan(0);
    // requests settle near 5,000 logs (≤ 400 here: the cap) instead of failing every time
    expect(c.calls.refused).toBeLessThan(c.calls.logs / 4);
    const saved = JSON.parse(readFileSync(join(dir, `4663-${POOL}.json`), 'utf8'));
    expect(saved.rows).toHaveLength(m.length);
    const again = new PoolHistories(dir, () => c.reader, fast(now)).get(REF);
    expect(again.minutes).toEqual(m);
    // read to the head once: after a restart its week is used while the next top-up runs
    expect(again.state.ready).toBe(true);
  });

  it('a first read stopped half way is saved, but not trusted after a restart: the rest of the week is read first', async () => {
    const c = chain({ days: KEEP_DAYS + 1, every: 600, cap: 10_000 });
    const dir = mkdtempSync(join(tmpdir(), 'ph-'));
    let t = (T0 + c.latest) * 1000, calls = 0;
    // each request takes 40 s (so the sync saves as it goes); the RPC dies after 3 of them
    const reader: LogReader = { ...c.reader, getLogs: async (f) => { if (++calls > 3) throw new Error('connect ECONNREFUSED'); t += 40_000; return c.reader.getLogs(f); } };
    const h = new PoolHistories(dir, () => reader, { now: () => t, gapMs: 0, sleep: async () => {} }).get({ ...REF, logChunk: 20_000 });
    await expect(h.sync()).rejects.toThrow(/ECONNREFUSED/);
    expect(h.minutes.length).toBeGreaterThan(0);
    const again = new PoolHistories(dir, () => c.reader, fast(() => t)).get(REF);
    expect(again.minutes.length).toBeGreaterThan(0); // part of the week was saved
    expect(again.state.ready).toBe(false);
    expect(again.covers(KEEP_DAYS)).toBe(false);
    expect(syncAnswer({ ...again.state, syncing: true }, again.covers(KEEP_DAYS), 7)).toMatchObject({ state: 'syncing' });
  });

  it('a later sync reads only the new blocks and continues the last minute', async () => {
    const c = chain({ days: 1, every: 20, cap: 10_000 });
    let t = (T0 + c.latest) * 1000;
    const h = new PoolHistories(null, () => c.reader, fast(() => t)).get(REF);
    expect(h.state.ready).toBe(false);
    await h.sync(1);
    expect(h.state.ready).toBe(true);
    const n = h.minutes.length, logs = c.calls.logs;
    c.grow(600);
    t += 600_000;
    const topUp = h.sync(1);
    // the day already read stays usable while the new blocks are read
    expect(h.state).toMatchObject({ syncing: true, ready: true });
    expect(syncAnswer(h.state, h.covers(1), 1)).toBeNull();
    await topUp;
    expect(h.minutes.length).toBeGreaterThanOrEqual(n + 9);
    expect(h.minutes.length).toBeLessThanOrEqual(n + 10);
    expect(h.state.total).toBe(600);
    expect(c.calls.logs - logs).toBe(1);
    // minutes stay in order with no repeats
    expect(h.minutes.every((x, i) => i === 0 || x.t > h.minutes[i - 1].t)).toBe(true);
  });

  it('a different LP share makes the saved fees wrong, so the history starts over', async () => {
    const c = chain({ days: 1, every: 60, cap: 10_000 });
    const dir = mkdtempSync(join(tmpdir(), 'ph-'));
    const now = () => (T0 + c.latest) * 1000;
    await new PoolHistories(dir, () => c.reader, fast(now)).get(REF).sync(1);
    expect(new PoolHistories(dir, () => c.reader, fast(now)).get(REF).minutes.length).toBeGreaterThan(1000);
    expect(new PoolHistories(dir, () => c.reader, fast(now)).get({ ...REF, lpShare: 0.8 }).minutes).toEqual([]);
  });

  it('a request that keeps failing on a single block is a real error, kept for the page to show', async () => {
    const c = chain({ days: 1, every: 1, cap: 0 });
    const h = new PoolHistories(null, () => c.reader, fast(() => (T0 + c.latest) * 1000)).get(REF);
    const first = h.sync();
    expect(syncAnswer(h.state, h.covers(7), 7)).toEqual({ state: 'syncing', days: 7, done: 0, total: 0 }); // a first read shows its progress
    await expect(first).rejects.toThrow(/exceeds limit/);
    expect(h.state.error).toMatch(/exceeds limit/);
    expect(h.state).toMatchObject({ syncing: false, ready: false });
    expect(syncAnswer(h.state, h.covers(7), 7)).toEqual({ state: 'error', error: h.state.error });
  });

  it('a rate-limited RPC (429) is waited out, 1 s then 2 s, without shrinking the requests', async () => {
    const c = chain({ days: 1, every: 60, cap: 10_000 });
    const real = c.reader.getLogs;
    let fails = 2;
    c.reader.getLogs = async (f) => {
      if (fails-- > 0) throw new Error('exceeded maximum retry limit (response={"error":{"code":429,"message":"Too Many Requests"}})');
      return real(f);
    };
    const waits: number[] = [];
    const h = new PoolHistories(null, () => c.reader, { now: () => (T0 + c.latest) * 1000, gapMs: 0, sleep: async (ms) => { waits.push(ms); } }).get(REF);
    await h.sync();
    expect(waits).toEqual([1000, 2000]);
    expect(h.state.error).toBeNull();
    expect(h.minutes.length).toBeGreaterThan(1000);
  });

  it('an RPC that stays rate-limited fails the sync after 5 retries, and says why', async () => {
    const c = chain({ days: 1, every: 60, cap: 10_000 });
    c.reader.getLogs = async () => { throw new Error('HTTP 429 Too Many Requests'); };
    const waits: number[] = [];
    const h = new PoolHistories(null, () => c.reader, { now: () => (T0 + c.latest) * 1000, gapMs: 0, sleep: async (ms) => { waits.push(ms); } }).get(REF);
    await expect(h.sync()).rejects.toThrow(/429/);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(h.state.error).toMatch(/429/);
  });

  it('a longer window reads the days before the history, newest first, and equals reading that window from scratch', async () => {
    const c = chain({ days: 40, every: 45, cap: 10_000 });
    const now = () => (T0 + c.latest) * 1000;
    const h = new PoolHistories(null, () => c.reader, fast(now)).get(REF);
    await h.sync(7);
    expect(h.covers(7)).toBe(true);
    expect(h.covers(30)).toBe(false);
    const week = h.minutes.length;
    await h.sync(30);
    expect(h.covers(30)).toBe(true);
    expect(h.minutes.length).toBeGreaterThan(week * 4);
    expect(h.minutes.every((x, i) => i === 0 || x.t > h.minutes[i - 1].t)).toBe(true);
    const fresh = new PoolHistories(null, () => c.reader, fast(now)).get(REF);
    await fresh.sync(30);
    // the boundary minutes join exactly: the same minutes, swaps and fees as one read of the 30 days
    expect(h.minutes.length).toBe(fresh.minutes.length);
    expect(h.minutes.reduce((a, m) => a + m.n, 0)).toBe(fresh.minutes.reduce((a, m) => a + m.n, 0));
    for (let i = 0; i < h.minutes.length; i++) {
      const a = h.minutes[i], b = fresh.minutes[i];
      expect([a.t, a.n, a.c]).toEqual([b.t, b.n, b.c]);
      expect(a.f0).toBeCloseTo(b.f0, 20);
    }
  });

  it('a long read stopped half way keeps the days it read; the next sync carries on from there', async () => {
    const c = chain({ days: 40, every: 600, cap: 10_000 });
    const dir = mkdtempSync(join(tmpdir(), 'ph-'));
    let t = (T0 + c.latest) * 1000;
    const h = new PoolHistories(dir, () => c.reader, { now: () => t, gapMs: 0, sleep: async () => {} }).get(REF);
    await h.sync(7);
    const start = h.state.from!;
    // each request takes 40 s, so the read saves as it goes; the RPC dies part way back
    let calls = 0;
    const real = c.reader.getLogs;
    c.reader.getLogs = async (f) => { if (++calls > 6) throw new Error('connect ECONNREFUSED'); t += 40_000; return real(f); };
    await expect(h.sync(30)).rejects.toThrow(/ECONNREFUSED/);
    const again = new PoolHistories(dir, () => c.reader, fast(() => t)).get(REF);
    expect(again.state.from!).toBeLessThan(start); // the days read before it stopped were kept
    expect(again.covers(7)).toBe(true);
    expect(again.covers(30)).toBe(false);
    c.reader.getLogs = real;
    await again.sync(30);
    expect(again.covers(30)).toBe(true);
    expect(again.minutes.every((x, i) => i === 0 || x.t > again.minutes[i - 1].t)).toBe(true);
  });

  it(`keeps at most ${MAX_DAYS} days`, async () => {
    const c = chain({ days: MAX_DAYS + 3, every: 3600, cap: 10_000 });
    const h = new PoolHistories(null, () => c.reader, fast(() => (T0 + c.latest) * 1000)).get({ ...REF, logChunk: 1_000_000 });
    await h.sync(MAX_DAYS);
    const first = h.minutes[0].t, last = h.minutes[h.minutes.length - 1].t;
    expect(last - first).toBeLessThanOrEqual(MAX_DAYS * DAY);
    expect(h.covers(MAX_DAYS)).toBe(true);
    expect(() => h.sync(MAX_DAYS + 1)).toThrow(/1 to 365 days/);
  });

  it('a file from before the history said where it starts (version 1) is read again from scratch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ph-'));
    writeFileSync(join(dir, `4663-${POOL}.json`), JSON.stringify({ version: 1, chainId: 4663, pool: POOL, feeTier: 100, lpShare: 0.75, toBlock: 5, lastTick: 1, rows: [[T0, 1, 1, 1, 0, 0, 1, 1]], ready: true }));
    const h = new PoolHistories(dir, () => chain({ days: 1, every: 60, cap: 10_000 }).reader, fast(() => T0 * 1000)).get(REF);
    expect(h.minutes).toEqual([]);
    expect(h.state).toMatchObject({ ready: false, from: null });
  });
});

describe('replay window', () => {
  it('7 days unless one of 1, 7, 30 or 365 is asked for; anything else is refused', async () => {
    const { replayDays } = await import('../src/server/lp/replay');
    expect(replayDays(undefined)).toBe(7);
    expect(replayDays('')).toBe(7);
    expect(replayDays('1')).toBe(1);
    expect(replayDays('30')).toBe(30);
    expect(replayDays(365)).toBe(365);
    expect(() => replayDays('14')).toThrow(/1, 7, 30, 365/);
    expect(() => replayDays('abc')).toThrow(/1, 7, 30, 365/);
  });
  it('a window the history does not cover yet answers with the read\'s progress; a covered one answers from the history', () => {
    const s = { syncing: true, done: 10, total: 100, error: null, at: null, ready: true, from: 0 };
    expect(syncAnswer(s, false, 30)).toEqual({ state: 'syncing', days: 30, done: 10, total: 100 });
    expect(syncAnswer(s, true, 7)).toBeNull();
    expect(syncAnswer({ ...s, syncing: false, error: 'boom' }, true, 7)).toEqual({ state: 'error', error: 'boom' });
  });
});
