import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSwap, KEEP_DAYS, PoolHistories, type PoolRef } from '../src/server/lp/poolHistory';
import { V3_SWAP_TOPIC, type LogReader } from '../src/server/market/onchain';

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
  });

  it('a later sync reads only the new blocks and continues the last minute', async () => {
    const c = chain({ days: 1, every: 20, cap: 10_000 });
    let t = (T0 + c.latest) * 1000;
    const h = new PoolHistories(null, () => c.reader, fast(() => t)).get(REF);
    await h.sync();
    const n = h.minutes.length, logs = c.calls.logs;
    c.grow(600);
    t += 600_000;
    await h.sync();
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
    await new PoolHistories(dir, () => c.reader, fast(now)).get(REF).sync();
    expect(new PoolHistories(dir, () => c.reader, fast(now)).get(REF).minutes.length).toBeGreaterThan(1000);
    expect(new PoolHistories(dir, () => c.reader, fast(now)).get({ ...REF, lpShare: 0.8 }).minutes).toEqual([]);
  });

  it('a request that keeps failing on a single block is a real error, kept for the page to show', async () => {
    const c = chain({ days: 1, every: 1, cap: 0 });
    const h = new PoolHistories(null, () => c.reader, fast(() => (T0 + c.latest) * 1000)).get(REF);
    await expect(h.sync()).rejects.toThrow(/exceeds limit/);
    expect(h.state.error).toMatch(/exceeds limit/);
    expect(h.state.syncing).toBe(false);
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
});
