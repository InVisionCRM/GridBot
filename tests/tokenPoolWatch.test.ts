/**
 * The token trader watches each held coin's pool while it holds it (Kyle, 2026-10-31: "each ticker card liquidity pair
 * should be check while the ticker is being traded … a well oiled machine that i never have to intervein"). Found on
 * Base: an ANTHROPIC pool drained to $0.09 with no swap for 7 h; the position sat at +83.57% forever, because a price
 * that never moves fires no take-profit or trailing stop, the time stop is off when up, and the liquidity exit compared
 * against a depth read after the drain.
 */
import { describe, expect, it } from 'vitest';
import { EXIT, decideExit, exitTargets, type FreshPool, type GateInput } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, lastMove, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';

setEthUsdSource(() => 2500);
const NOW = 1_800_000_000_000;
const pool: FreshPool = {
  chainId: 1, pool: '0x' + 'ab'.repeat(20), dex: 'uni-v3', kind: 'v3', token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20),
  tokenSymbol: 'PEPE', spendSymbol: 'WETH', liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'trending',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
};
const clean: GateInput = {
  mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
  liquidityUsd: 80_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
};

/** One position on `pool`; each tick reads the depths the test sets (or throws `fail`). */
function trader() {
  let now = NOW;
  const depth = { quote: 40, token: 1_000_000, fail: null as string | null };
  const batches = [[pool]];
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => now,
    sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => batches.shift() ?? [], assess: async () => clean, resolve: async () => null,
    mark: async (p: Position) => {
      if (depth.fail) throw new Error(depth.fail);
      return { price: depth.quote / depth.token, quoteReserve: depth.quote, tokenReserve: depth.token, liq: 2 * depth.quote * p.usdPerSpend, ...(p.liqBase !== 'chain' ? { entryLiq: 2 * depth.quote * p.usdPerSpend, liqBase: 'chain' as const } : {}) };
    },
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, risk: 'any' });
  t.turnOn();
  return { t, depth, later: (ms: number) => { now += ms; }, pos: () => t.status().positions[0] };
}

describe('pool watch: a pool that stops trading', () => {
  it('watching starts at the first read; any change in depth is a trade and resets the clock', async () => {
    const { t, depth, later, pos } = trader();
    await t.tick(); // buys
    later(10_000); await t.tick();
    expect(pos().movedAt).toBe(NOW + 10_000);
    later(30 * 60_000); await t.tick();
    expect(pos().movedAt).toBe(NOW + 10_000); // same depths: no trade
    depth.quote = 40.5; depth.token = 987_700; // a buy in the pool
    later(10_000); await t.tick();
    expect(pos().movedAt).toBe(NOW + 10_000 + 30 * 60_000 + 10_000);
  });

  it(`no trade for ${EXIT.deadMs / 3600_000} h sells it all, even while it shows a gain`, async () => {
    const { t, depth, later, pos } = trader();
    await t.tick();
    depth.quote = 64; // +60% (over +50% after fees), then the pool goes quiet: take profit 1 sells a third, the rest waits for +100%
    later(10_000); await t.tick();
    expect(pos().tp1Done).toBe(true);
    later(EXIT.deadMs - 10_000); await t.tick();
    expect(t.status().positions).toHaveLength(1);
    later(10_000); await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(String(t.status().trades[0].why)).toMatch(/no trades in the pool for 2\.0 h/);
  });
});

describe('pool watch: a position from before the watch', () => {
  it('lastMove: the first read at the newest price; all reads equal: the oldest read', () => {
    expect(lastMove([[1, 5], [2, 6], [3, 6], [4, 6]])).toBe(2);
    expect(lastMove([[1, 5], [2, 5], [3, 5]])).toBe(1);
    expect(lastMove([[1, 5], [2, 6], [3, 5]])).toBe(3);
    expect(lastMove([])).toBeUndefined();
  });

  it('starts from its saved prices: 3 h at one price sells on the first read (ANTHROPIC sat at +83.57% for hours)', async () => {
    const { t, later, pos } = trader();
    await t.tick(); // buys
    const p = pos() as unknown as Position;
    // the position as saved before the watch existed: hours of reads at one price, no movedAt
    p.marks = Array.from({ length: 200 }, (_, i) => [NOW - 3 * 3600_000 + i * 50_000, 40 / 1_000_000] as [number, number]);
    const st = (t as unknown as { state: TraderState }).state;
    Object.assign(st.positions[0], { marks: p.marks, movedAt: undefined });
    later(10_000); await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(String(t.status().trades[0].why)).toMatch(/no trades in the pool for 3\.0 h/);
  });
});

describe('pool watch: liquidity drained after the buy', () => {
  it('the drop is measured from the deepest liquidity seen since the buy, not only from the entry', async () => {
    const { t, depth, later, pos } = trader();
    await t.tick();
    later(10_000); await t.tick();
    // depth doubles with the price flat (liquidity added), then most of it is pulled
    depth.quote = 80; depth.token = 2_000_000;
    later(10_000); await t.tick();
    expect(pos().liqPeak).toBe(2 * 80 * 2_000);
    depth.quote = 45; depth.token = 1_125_000; // 44% under the peak, still above the entry depth
    later(10_000); await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(String(t.status().trades[0].why)).toMatch(/liquidity down 44% from its peak/);
  });

  it('decideExit: a drain from the peak sells; the same depth with no peak known does not', () => {
    const base = { entryPrice: 1, price: 1, peak: 1, openedAt: NOW, now: NOW, entryVolume: 0, volume: 0, entryLiq: 100, liq: 70, sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1 };
    expect(decideExit(base)).toEqual({ action: 'hold' });
    expect(decideExit({ ...base, liqPeak: 200 })).toMatchObject({ action: 'sell', why: 'liquidity down 65% from its peak' });
  });
});

describe('the exits a card lists include the pool watch', () => {
  it('drain: how much depth is gone from the peak; dead pool: time left with no trade', () => {
    const base = { entryPrice: 1, price: 1, peak: 1, openedAt: NOW, now: NOW + 30 * 60_000, entryVolume: 0, volume: 0, entryLiq: 100, liq: 90, liqPeak: 120, movedAt: NOW, sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1 };
    const x = Object.fromEntries(exitTargets(base).map((r) => [r.key, r]));
    expect(x.drain).toMatchObject({ at: EXIT.liqPull, does: "sells all if the pool's depth falls 40% from its peak" });
    expect(x.drain.drop).toBeCloseTo(0.25, 12);
    expect(x.dead).toMatchObject({ msLeft: EXIT.deadMs - 30 * 60_000, ms: EXIT.deadMs, does: 'sells all after 2 h with no trades in the pool' });
    // not watched yet: no dead-pool line
    expect(exitTargets({ ...base, movedAt: null }).some((r) => r.key === 'dead')).toBe(false);
  });
});

describe("a read that fails shows on that position's card", () => {
  it('readError is set (last price kept) and cleared by the next read that works', async () => {
    const { t, depth, later, pos } = trader();
    await t.tick();
    later(10_000); await t.tick();
    const price = pos().price;
    depth.fail = 'execution reverted';
    later(10_000); await t.tick();
    expect(pos()).toMatchObject({ readError: 'execution reverted', price });
    depth.fail = null;
    later(10_000); await t.tick();
    expect(pos().readError).toBeNull();
  });

  it('the pool route stays on the server: the page gets `routed`, not the route', async () => {
    const { t, later } = trader();
    await t.tick();
    later(10_000); await t.tick();
    const p = t.status().positions[0] as Record<string, unknown>;
    expect(p).not.toHaveProperty('market');
    expect(p.routed).toBe(false);
  });
});
