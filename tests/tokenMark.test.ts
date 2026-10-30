/**
 * Open token-trader positions follow their pool (2026-10-30: production passed no mark, so a position's price stayed at
 * its entry; the stop, take profits and trailing stop never fired and every position waited for the 6 h time stop).
 */
import { describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import type { MarketDef } from '../src/live/markets';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import { createTokenTrader, MARK_DRAFT_EVERY_MS, positionMarker } from '../src/server/market/tokenFeed';
import type { PoolSniper } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';

setEthUsdSource(() => 2500);

const NOW = 1_700_000_000_000;
const clean: GateInput = {
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
};
const POOL: FreshPool = {
  chainId: 1, pool: '0x' + 'ab'.repeat(20), dex: 'uni-v3', kind: 'v3',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
};

type Safety = { simulated: boolean; sellTaxPct: number | null; honeypot: boolean };
/** A hub with one pool: its depth and its safety answer are set by the test. */
function fakeHub(o: { quote: number; token: number; safety?: Safety }) {
  const calls = { inspect: 0 };
  const hub = {
    pool: o,
    calls,
    inspect: async () => {
      calls.inspect++;
      return { draft: { key: 'x', safety: hub.pool.safety ?? { simulated: true, sellTaxPct: 0, honeypot: false } } as unknown as MarketDef };
    },
    draftQuoter: () => ({ market: async () => ({ spot: 0, quoteReserve: hub.pool.quote, plsReserve: hub.pool.token, gasPricePls: 0 }) }),
  };
  return hub;
}

const position = (o: Partial<Position> = {}) => ({
  id: 'p1', chainId: 1, pool: POOL.pool, dex: 'uni-v3', label: 'NEW/WETH', token: POOL.token, spend: POOL.spend, usdPerSpend: 2_000,
  liq: 80_000, entryLiq: 80_000, quoteReserve: 40, tokenReserve: 1_000_000, ...o,
}) as Position;

describe('position marks from the pool', () => {
  it('price is quote depth ÷ token depth; liquidity is 2 × quote depth in dollars, and the first mark sets entryLiq to it', async () => {
    const hub = fakeHub({ quote: 28, token: 1_000_000 });
    const m = await positionMarker(hub as never, () => NOW)(position());
    expect(m).toMatchObject({ price: 0.000028, quoteReserve: 28, tokenReserve: 1_000_000, liq: 112_000, entryLiq: 112_000, liqBase: 'chain', sellTax: 0 });
    // later marks keep the chain entryLiq
    const m2 = await positionMarker(hub as never, () => NOW)(position({ liqBase: 'chain', entryLiq: 112_000 }));
    expect(m2).not.toHaveProperty('entryLiq');
  });

  it("a safety check that couldn't simulate changes neither the sell tax nor the sell simulation; a proven honeypot does", async () => {
    const off = await positionMarker(fakeHub({ quote: 40, token: 1e6, safety: { simulated: false, sellTaxPct: null, honeypot: false } }) as never, () => NOW)(position());
    expect(off).not.toHaveProperty('sellSimOk');
    expect(off).not.toHaveProperty('sellTax');
    const trap = await positionMarker(fakeHub({ quote: 40, token: 1e6, safety: { simulated: true, sellTaxPct: 1, honeypot: true } }) as never, () => NOW)(position());
    expect(trap).toMatchObject({ sellSimOk: false, sellTax: 1 });
  });

  it('the pool and its safety are looked up once per 10 minutes; depth is read every mark', async () => {
    let t = NOW;
    const hub = fakeHub({ quote: 40, token: 1e6 });
    const mark = positionMarker(hub as never, () => t);
    await mark(position());
    hub.pool.quote = 30;
    expect((await mark(position()))?.price).toBe(0.00003);
    expect(hub.calls.inspect).toBe(1);
    t += MARK_DRAFT_EVERY_MS;
    await mark(position());
    expect(hub.calls.inspect).toBe(2);
  });

  it('with the marker, a position that falls 30% is sold on the hard stop instead of waiting for the time stop', async () => {
    const hub = fakeHub({ quote: 40, token: 1e6 });
    let fresh = true;
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => NOW,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => (fresh ? (fresh = false, [POOL]) : []), assess: async () => clean, resolve: async () => null,
      mark: positionMarker(hub as never, () => NOW),
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600, risk: 'safe' });
    t.turnOn();
    await t.tick();
    expect(t.status().positions).toHaveLength(1);
    hub.pool.quote = 28; // 30% lower
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().trades[0]).toMatchObject({ side: 'sell' });
    expect(String(t.status().trades[0].why)).toMatch(/hard stop/);
  });

  it('the app wires the marker into the token trader', () => {
    const hub = { runtimes: () => [] };
    const tt = createTokenTrader({ hub: hub as never, gecko: {} as never, store: new MemoryStore<TraderState>(), approval: 'exact', receiptTimeoutMs: 1000 });
    expect(typeof (tt as unknown as { d: { mark?: unknown } }).d.mark).toBe('function');
  });
});
