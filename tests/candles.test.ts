import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, zeroPadValue } from 'ethers';
import { describe, expect, it } from 'vitest';
import { aggregate, applyTick, bucketStart, closedOnly, fillGaps, mergeCandles, type Candle } from '../src/market/candles';
import { CandleStore } from '../src/server/market/candleStore';
import { GeckoSource, RateLimited } from '../src/server/market/gecko';
import { SWAP_TOPIC, SYNC_TOPIC, rebuildFromChain } from '../src/server/market/onchain';
import { NET } from './helpers/mockChain';

const T0 = 1_791_446_400; // 2026-10-08 08:00 UTC, aligned to 1d? (aligned to 1h)

describe('candle building & aggregation', () => {
  it('applyTick buckets ticks into OHLC', () => {
    const s: Candle[] = [];
    applyTick(s, 10, T0 + 5, '1m'); applyTick(s, 12, T0 + 20, '1m'); applyTick(s, 9, T0 + 50, '1m'); applyTick(s, 11, T0 + 59, '1m');
    applyTick(s, 11.5, T0 + 61, '1m');
    applyTick(s, 99, T0 + 30, '1m'); // late tick for a closed bucket: ignored
    expect(s).toEqual([
      { t: T0, o: 10, h: 12, l: 9, c: 11, v: 0 },
      { t: T0 + 60, o: 11, h: 11.5, l: 11, c: 11.5, v: 0 },
    ]);
    expect(bucketStart(T0 + 3599, '1h')).toBe(T0);
    expect(bucketStart(T0 + 7 * 3600, '4h')).toBe(T0 + 4 * 3600);
  });

  it('aggregate 1m → 5m / 1h keeps O, H, L, C, ΣV', () => {
    const m: Candle[] = Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * 60, o: 100 + i, h: 101 + i + (i === 7 ? 50 : 0), l: 99 + i - (i === 3 ? 40 : 0), c: 100.5 + i, v: 1 }));
    const five = aggregate(m, '5m');
    expect(five).toHaveLength(24);
    expect(five[0]).toEqual({ t: T0, o: 100, h: 105, l: 62, c: 104.5, v: 5 });
    expect(five[1]).toMatchObject({ t: T0 + 300, o: 105, h: 158, c: 109.5 });
    const hr = aggregate(m, '1h');
    expect(hr.map((x) => x.v)).toEqual([60, 60]);
    expect(hr[1]).toMatchObject({ o: 160, c: 219.5 });
    expect(aggregate(five, '1h')).toEqual(hr); // 1m→5m→1h == 1m→1h
  });

  it('fillGaps forward-fills flat candles and marks them', () => {
    const k: Candle[] = [{ t: T0, o: 1, h: 2, l: 1, c: 2, v: 3 }, { t: T0 + 180, o: 2, h: 3, l: 2, c: 3, v: 1 }];
    const f = fillGaps(k, '1m', T0 + 300);
    expect(f.map((x) => x.t)).toEqual([T0, T0 + 60, T0 + 120, T0 + 180, T0 + 240, T0 + 300]);
    expect(f[1]).toEqual({ t: T0 + 60, o: 2, h: 2, l: 2, c: 2, v: 0, f: 1 });
    expect(f[5]).toMatchObject({ c: 3, f: 1 });
  });

  it('merge: incoming wins; the live open bucket keeps the wider range and live close', () => {
    const a: Candle[] = [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: 60, o: 1, h: 5, l: 0.5, c: 4, v: 0 }];
    const b: Candle[] = [{ t: 0, o: 1.1, h: 1.2, l: 1, c: 1.1, v: 9 }, { t: 60, o: 1, h: 3, l: 0.8, c: 2, v: 7 }];
    const m = mergeCandles(a, b, Infinity, 60);
    expect(m[0]).toEqual(b[0]);
    expect(m[1]).toEqual({ t: 60, o: 1, h: 5, l: 0.5, c: 4, v: 7 });
    expect(mergeCandles(a, b, 1)).toHaveLength(1);
  });

  it('closedOnly drops the still-open bucket', () => {
    const k: Candle[] = [0, 3600, 7200].map((t) => ({ t: T0 + t, o: 1, h: 1, l: 1, c: 1, v: 0 }));
    expect(closedOnly(k, '1h', T0 + 7200 + 10)).toHaveLength(2);
    expect(closedOnly(k, '1h', T0 + 3 * 3600)).toHaveLength(3);
  });

  it('CandleStore: ticks update every timeframe; persists and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candles-'));
    const s = new CandleStore(dir, 0);
    s.tick('DAI', 1e-5, T0 + 10); s.tick('DAI', 1.1e-5, T0 + 70); s.tick('DAI', 0.9e-5, T0 + 4000);
    expect(s.get('DAI', '1m')).toHaveLength(3);
    expect(s.get('DAI', '1h')).toHaveLength(2);
    expect(s.get('DAI', '1d')[0]).toMatchObject({ o: 1e-5, h: 1.1e-5, l: 0.9e-5, c: 0.9e-5 });
    s.mergeFrom1m('HEX', [{ t: T0, o: 4e-3, h: 4.1e-3, l: 3.9e-3, c: 4e-3, v: 10 }, { t: T0 + 60, o: 4e-3, h: 4e-3, l: 4e-3, c: 4.05e-3, v: 5 }], 'onchain', T0 + 3600 * 5);
    expect(s.get('HEX', '1h')).toEqual([{ t: T0, o: 4e-3, h: 4.1e-3, l: 3.9e-3, c: 4.05e-3, v: 15 }]);
    s.flush();
    const r = new CandleStore(dir, 0);
    expect(r.get('DAI', '1m')).toEqual(s.get('DAI', '1m'));
    expect(r.get('HEX', '4h')).toEqual(s.get('HEX', '4h'));
    expect(r.getMeta('HEX', '1h')?.source).toBe('onchain');
  });
});

describe('GeckoTerminal source', () => {
  const row = (t: number, c: number) => [t, c, c * 1.01, c * 0.99, c, 123];
  it('builds the verified URL, converts to sell-side units, sorts ascending', async () => {
    const urls: string[] = [];
    const g = new GeckoSource(async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [row(T0 + 3600, 2e-5), row(T0, 1e-5)] } } }) }; }, { minIntervalMs: 0 });
    const k = await g.ohlcv('0xPool', NET.pulsex.wpls, '4h', T0 + 7200, 500);
    expect(urls[0]).toBe(`https://api.geckoterminal.com/api/v2/networks/pulsechain/pools/0xPool/ohlcv/hour?aggregate=4&limit=500&currency=token&token=${NET.pulsex.wpls}&before_timestamp=${T0 + 7200}`);
    expect(k.map((x) => x.t)).toEqual([T0, T0 + 3600]);
    expect(k[0].c).toBeCloseTo(1e-5 * 0.9971, 18);
    expect(k[0].v).toBe(123);
  });

  it('throttles calls and backs off 65 s on 429', async () => {
    let now = 0;
    const sleeps: number[] = [];
    let n = 0;
    const g = new GeckoSource(async () => (++n === 2 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [] } } }) }), {
      minIntervalMs: 2500, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await g.ohlcv('p', 'w', '1h');
    await expect(g.ohlcv('p', 'w', '1h')).rejects.toBeInstanceOf(RateLimited);
    expect(g.blockedUntil).toBe(2500 + 65_000);
    await g.ohlcv('p', 'w', '1h');
    expect(sleeps).toEqual([2500, 65_000]);
  });
});

describe('on-chain candle rebuild', () => {
  it('Sync → price (both token orders, decimals), Swap → quote volume', async () => {
    const hex = NET.quotes.find((q) => q.symbol === 'HEX')!;
    const enc = AbiCoder.defaultAbiCoder();
    const sync = (bn: number, r0: bigint, r1: bigint) => ({ blockNumber: bn, index: 0, topics: [SYNC_TOPIC], data: enc.encode(['uint112', 'uint112'], [r0, r1]) });
    const swap = (bn: number, a: bigint[]) => ({ blockNumber: bn, index: 1, topics: [SWAP_TOPIC, zeroPadValue('0x01', 32), zeroPadValue('0x02', 32)], data: enc.encode(['uint', 'uint', 'uint', 'uint'], a) });
    // token0 = HEX (8 dec): 1,000,000 HEX vs 250,000,000 WPLS → mid 0.004 HEX/PLS
    const logs = [
      sync(100, 1_000_000n * 10n ** 8n, 250_000_000n * 10n ** 18n), swap(100, [500n * 10n ** 8n, 0n, 0n, 1n]),
      sync(106, 1_010_000n * 10n ** 8n, 250_000_000n * 10n ** 18n), swap(106, [0n, 1n, 200n * 10n ** 8n, 0n]),
    ];
    const reader = {
      getBlockNumber: async () => 200,
      getBlock: async (n: number) => ({ timestamp: T0 + (n - 100) * 10 }),
      getLogs: async () => logs,
    };
    const k = await rebuildFromChain(reader, hex, { token0IsQuote: true, fromBlock: 100, toBlock: 112, chunk: 100 });
    expect(k).toHaveLength(2); // blocks 100 (t0) and 106 (t0+60)
    expect(k[0].c).toBeCloseTo(0.004 * 0.9971, 12);
    expect(k[0].v).toBe(500);
    expect(k[1].c).toBeCloseTo(0.00404 * 0.9971, 12);
    expect(k[1].v).toBe(200);
    const flipped = await rebuildFromChain({ ...reader, getLogs: async () => [sync(100, 250_000_000n * 10n ** 18n, 1_000_000n * 10n ** 8n)] }, hex, { token0IsQuote: false, fromBlock: 100, toBlock: 100 });
    expect(flipped[0].c).toBeCloseTo(0.004 * 0.9971, 12);
  });
  it('holds back a poll price >20% off the last candle until 3 polls confirm it', () => {
    const st = new CandleStore(null);
    const t0 = 1_791_000_000 - (1_791_000_000 % 60);
    expect(st.tick('DAI', 1e-5, t0)).toBe(true);
    expect(st.tick('DAI', 0.7e-5, t0 + 10)).toBe(false); // glitch
    expect(st.tick('DAI', 1.01e-5, t0 + 20)).toBe(true); // back to normal: glitch never reached any candle
    for (const tf of ['1m', '1h', '1d'] as const) expect(st.get('DAI', tf).at(-1)!.l).toBe(1e-5);
    // a real move: three polls in a row on the same side are accepted
    expect(st.tick('DAI', 1.3e-5, t0 + 30)).toBe(false);
    expect(st.tick('DAI', 1.31e-5, t0 + 40)).toBe(false);
    expect(st.tick('DAI', 1.32e-5, t0 + 50)).toBe(true);
    expect(st.get('DAI', '1h').at(-1)!.h).toBe(1.32e-5);
    expect(st.tick('DAI', NaN, t0 + 60)).toBe(false);
  });
});
