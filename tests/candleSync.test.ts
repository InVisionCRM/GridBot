import { describe, expect, it, vi } from 'vitest';
import { CandleSync, IDLE_TFS, REFRESH_LIMIT, VIEW_MS, type CandleSource } from '../src/server/market/backfill';
import { CandleStore } from '../src/server/market/candleStore';
import { TFS, TF_SEC, type TF } from '../src/market/candles';

const src = (key: string): CandleSource => ({ key, label: key, network: 'eth', pool: `0xpool${key}`, kind: 'v3', base: { address: '0xb', decimals: 18 }, quote: { address: '0xq', decimals: 18 }, feeBps: 30 });

function world(o: { active?: string[]; store?: CandleStore } = {}) {
  let now = 1_800_000_000_000;
  const calls: { pool: string; tf: TF; limit: number }[] = [];
  const gecko = {
    calls: 0, blockedUntil: 0, pace: 2500, limitedWithin: () => 0,
    ohlcv: async (pool: string, _t: string, tf: TF, _b?: number, limit = 1000) => { calls.push({ pool, tf, limit }); return [{ t: Math.floor(now / 1000) - TF_SEC[tf], o: 1, h: 1, l: 1, c: 1, v: 1 }]; },
  };
  const store = o.store ?? new CandleStore(null);
  const active = new Set(o.active ?? []);
  const sync = new CandleSync(gecko as never, () => [src('A'), src('B')], store, { now: () => now, active: () => active });
  return { sync, calls, store, active, at: (ms: number) => { now = 1_800_000_000_000 + ms; }, now: () => now };
}

async function drain(sync: CandleSync, max = 200) { for (let i = 0; i < max && sync.nextTask()?.kind === 'backfill'; i++) await sync.step(); }

describe('CandleSync: every timeframe only for markets in use', () => {
  it(`markets nothing uses get ${IDLE_TFS.join('/')} only; a market with a bot or alert gets all ${TFS.length}`, async () => {
    const { sync, calls } = world({ active: ['A'] });
    await drain(sync);
    const tfsOf = (p: string) => [...new Set(calls.filter((c) => c.pool === `0xpool${p}`).map((c) => c.tf))].sort();
    expect(tfsOf('A')).toEqual([...TFS].sort());
    expect(tfsOf('B')).toEqual([...IDLE_TFS].sort());
    expect(sync.status()).toMatchObject({ markets: 2, total: TFS.length + IDLE_TFS.length, backfilled: TFS.length + IDLE_TFS.length });
  });

  it(`opening a chart syncs every timeframe of that market for ${VIEW_MS / 60_000} minutes (flipped key counts as the original)`, () => {
    const { sync, at } = world();
    expect(sync.tfsFor('B')).toEqual(IDLE_TFS);
    sync.view('B~');
    expect(sync.tfsFor('B')).toEqual(TFS);
    at(VIEW_MS + 1);
    expect(sync.tfsFor('B')).toEqual(IDLE_TFS);
  });

  it('refreshes fetch the newest REFRESH_LIMIT candles, only for the timeframes the market is synced on', async () => {
    const { sync, calls, at } = world();
    await drain(sync);
    calls.length = 0;
    at(13 * 3600_000); // every 1h/4h/1d series is due again
    for (let i = 0; i < 10; i++) await sync.step();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.limit === REFRESH_LIMIT && IDLE_TFS.includes(c.tf))).toBe(true);
  });
});

describe('CandleSync: no full re-download after a restart', () => {
  it('a saved series recent enough for one refresh is not backfilled again; an old one is', () => {
    const store = new CandleStore(null);
    const nowSec = 1_800_000_000;
    store.merge('A', '1h', [{ t: nowSec - 3 * 3600, o: 1, h: 1, l: 1, c: 1, v: 1 }], 'gecko', nowSec);
    store.merge('B', '1h', [{ t: nowSec - (REFRESH_LIMIT + 5) * 3600, o: 1, h: 1, l: 1, c: 1, v: 1 }], 'gecko', nowSec);
    const { sync } = world({ store });
    const first = sync.nextTask();
    expect(first).toEqual({ pair: 'B', tf: '1h', kind: 'backfill' }); // A|1h is skipped, B|1h is too old
  });
});

describe('CandleSync: pauses while the daily scan runs', () => {
  it('no GeckoTerminal requests while paused; resumes after', async () => {
    vi.useFakeTimers();
    try {
      let scanning = true, calls = 0;
      const gecko = { calls: 0, blockedUntil: 0, ohlcv: async () => { calls++; return []; } };
      const sync = new CandleSync(gecko as never, () => [src('A')], new CandleStore(null), { paused: () => scanning });
      sync.start(1000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toBe(0);
      scanning = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBeGreaterThan(0);
      sync.stop();
    } finally { vi.useRealTimers(); }
  });
});
