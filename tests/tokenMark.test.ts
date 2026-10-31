/**
 * Open token-trader positions follow their pool (2026-10-30: production passed no mark, so a position's price stayed at
 * its entry; the stop, take profits and trailing stop never fired and every position waited for the 6 h time stop).
 */
import { describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import type { MarketDef } from '../src/live/markets';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import { createTokenTrader, MARK_CHECKS_PER_CHAIN, MARK_DRAFT_EVERY_MS, MARK_RETRY_MS, positionMarker } from '../src/server/market/tokenFeed';
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
/** A hub with one pool: its depth and its safety answer are set by the test; `hold` makes safety checks hang. */
function fakeHub(o: { quote: number; token: number; safety?: Safety }) {
  const calls = { inspect: 0, market: 0 };
  let hold = false;
  const hub = {
    pool: o,
    calls,
    hold: (on: boolean) => { hold = on; },
    inspect: async () => {
      calls.inspect++;
      if (hold) await new Promise(() => undefined);
      return { draft: { key: 'x', chainId: 1, safety: hub.pool.safety ?? { simulated: true, sellTaxPct: 0, honeypot: false } } as unknown as MarketDef };
    },
    draftQuoter: () => ({ market: async () => { calls.market++; return { spot: 0, quoteReserve: hub.pool.quote, plsReserve: hub.pool.token, gasPricePls: 0 }; } }),
  };
  return hub;
}
/** Lets background checks finish */
const settle = () => new Promise((r) => setTimeout(r, 0));
const ROUTE = { key: 'x', chainId: 1 } as unknown as MarketDef;

const position = (o: Partial<Position> = {}) => ({
  id: 'p1', chainId: 1, pool: POOL.pool, dex: 'uni-v3', label: 'NEW/WETH', token: POOL.token, spend: POOL.spend, usdPerSpend: 2_000,
  liq: 80_000, entryLiq: 80_000, quoteReserve: 40, tokenReserve: 1_000_000, ...o,
}) as Position;

describe('position marks from the pool', () => {
  it('a position with no route starts its safety check in the background; the next read has the route and the price', async () => {
    const hub = fakeHub({ quote: 28, token: 1_000_000 });
    const mark = positionMarker(hub as never, () => NOW);
    expect(await mark(position())).toBeNull();
    await settle();
    const m = await mark(position());
    expect(m).toMatchObject({ market: { key: 'x' }, checkedAt: NOW, checkNote: null, price: 0.000028, quoteReserve: 28, tokenReserve: 1_000_000, liq: 112_000, entryLiq: 112_000, liqBase: 'chain', sellTax: 0 });
    // the route is kept without the safety report; later reads keep the chain entryLiq
    expect(m!.market).not.toHaveProperty('safety');
    const m2 = await mark(position({ market: ROUTE, checkedAt: NOW, liqBase: 'chain', entryLiq: 112_000 }));
    expect(m2).not.toHaveProperty('entryLiq');
  });

  it('a new position prices at once from the route its buy checked (no second safety check)', async () => {
    const hub = fakeHub({ quote: 28, token: 1_000_000 });
    const m = await positionMarker(hub as never, () => NOW, () => ({ ...ROUTE, safety: { simulated: true } } as unknown as MarketDef))(position());
    expect(m).toMatchObject({ price: 0.000028, checkedAt: NOW, market: { key: 'x' } });
    expect(m!.market).not.toHaveProperty('safety');
    expect(hub.calls.inspect).toBe(0);
  });

  it("a safety check that couldn't simulate changes neither the sell tax nor the sell simulation, and says so; a proven honeypot does", async () => {
    const offHub = fakeHub({ quote: 40, token: 1e6, safety: { simulated: false, sellTaxPct: null, honeypot: false } });
    const off = positionMarker(offHub as never, () => NOW);
    await off(position()); await settle();
    const o = await off(position());
    expect(o).not.toHaveProperty('sellSimOk');
    expect(o).not.toHaveProperty('sellTax');
    expect(o!.checkNote).toMatch(/did not run/);
    const trapHub = fakeHub({ quote: 40, token: 1e6, safety: { simulated: true, sellTaxPct: 1, honeypot: true } });
    const trap = positionMarker(trapHub as never, () => NOW);
    await trap(position()); await settle();
    expect(await trap(position())).toMatchObject({ sellSimOk: false, sellTax: 1 });
  });

  it('the safety check runs again every 10 minutes in the background; depth is read every time, even while the check hangs', async () => {
    let t = NOW;
    const hub = fakeHub({ quote: 40, token: 1e6 });
    const mark = positionMarker(hub as never, () => t);
    const p = position({ market: ROUTE, checkedAt: NOW });
    await mark(p);
    hub.pool.quote = 30;
    expect((await mark(p))?.price).toBe(0.00003);
    expect(hub.calls.inspect).toBe(0);
    t += MARK_DRAFT_EVERY_MS;
    hub.hold(true);
    hub.pool.quote = 20;
    // the check is due and hangs: the read still comes back with today's price, and the check is not started twice
    expect((await mark(p))?.price).toBe(0.00002);
    expect((await mark(p))?.price).toBe(0.00002);
    expect(hub.calls.inspect).toBe(1);
  });

  it('a failed first check is reported and tried again after a minute', async () => {
    let t = NOW;
    const hub = fakeHub({ quote: 40, token: 1e6 });
    hub.inspect = async () => { hub.calls.inspect++; throw new Error('no pool to trade'); };
    const mark = positionMarker(hub as never, () => t);
    await mark(position()); await settle();
    expect(await mark(position())).toEqual({ checkedAt: NOW, checkNote: 'safety check failed: no pool to trade' });
    await mark(position());
    expect(hub.calls.inspect).toBe(1);
    t += MARK_RETRY_MS;
    await mark(position());
    expect(hub.calls.inspect).toBe(2);
  });

  it('a check that finished is kept when the read after it fails, and is not run again (TGLN re-checked every pass)', async () => {
    const hub = fakeHub({ quote: 40, token: 1e6 });
    let fail = true;
    const q = hub.draftQuoter;
    hub.draftQuoter = () => ({ market: async () => { if (fail) throw new Error('execution reverted'); return q().market(); } });
    const mark = positionMarker(hub as never, () => NOW);
    await mark(position()); await settle(); // check done, route built
    await expect(mark(position())).rejects.toThrow('execution reverted');
    await expect(mark(position())).rejects.toThrow('execution reverted');
    expect(hub.calls.inspect).toBe(1);
    fail = false;
    expect(await mark(position())).toMatchObject({ market: { key: 'x' }, checkedAt: NOW, price: 0.00004 });
    expect(hub.calls.inspect).toBe(1);
  });

  it('at most 2 safety checks run at once per chain', async () => {
    const hub = fakeHub({ quote: 40, token: 1e6 });
    hub.hold(true);
    const mark = positionMarker(hub as never, () => NOW);
    for (let i = 0; i < 5; i++) await mark(position({ id: `p${i}` }));
    await settle();
    expect(hub.calls.inspect).toBe(MARK_CHECKS_PER_CHAIN);
  });

  it('a pool that reads empty is an error (the card shows it), not a silent old price', async () => {
    const hub = fakeHub({ quote: 0, token: 1e6 });
    await expect(positionMarker(hub as never, () => NOW)(position({ market: ROUTE, checkedAt: NOW }))).rejects.toThrow('the pool reads empty');
  });

  it('with the marker, a position that falls 30% is sold on the hard stop instead of waiting for the time stop', async () => {
    const hub = fakeHub({ quote: 40, token: 1e6 });
    let fresh = true;
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => NOW,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => (fresh ? (fresh = false, [POOL]) : []), assess: async () => clean, resolve: async () => null,
      mark: positionMarker(hub as never, () => NOW, () => ROUTE),
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
