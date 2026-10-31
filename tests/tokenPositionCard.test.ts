/**
 * What an open token-trader position shows (Kyle, 2026-10-30: "the numbers barely update and the meter is dumb … whats
 * exit plan? whats scan? wheres the logos?"): its value, its prices since the buy, how far each exit rule is, and a
 * Sell now that sells it through the normal exit path.
 */
import { describe, expect, it } from 'vitest';
import { EXIT, exitTargets, fromTopPool, type FreshPool, type GateInput } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { MARKS_KEPT, TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';
import { exitTrack } from '../src/ui/tokenModel';

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

function trader(mark: (n: number) => number | null) {
  let now = NOW, ticks = 0;
  const batches = [[pool]];
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => now,
    sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => batches.shift() ?? [], assess: async () => clean, resolve: async () => null,
    mark: async () => { const price = mark(ticks++); return price == null ? null : { price }; },
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, risk: 'any' });
  t.turnOn();
  return { t, later: (ms: number) => { now += ms; } };
}

describe('exit targets', () => {
  const base = { entryPrice: 1, price: 1, peak: 1, openedAt: NOW - 3600_000, now: NOW, entryVolume: 0, volume: 0, entryLiq: 0, liq: 0, sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1 };
  it('at the entry price: stop 25% below, trailing stop arms 30% up, take profits 50% and 100% up, 5 h of the time stop left', () => {
    const x = Object.fromEntries(exitTargets(base).map((r) => [r.key, r]));
    expect(x.stop.move).toBeCloseTo(-0.25, 12);
    expect(x.trail).toMatchObject({ armed: false, does: 'arms at +30%' });
    expect(x.trail.move).toBeCloseTo(0.3, 12);
    expect(x.tp1.move).toBeCloseTo(0.5, 12);
    expect(x.tp2.move).toBeCloseTo(1, 12);
    expect(x.time.msLeft).toBe(EXIT.timeStopMs - 3600_000);
    expect([x.stop.at, x.trail.at, x.tp1.at, x.tp2.at, x.time.ms]).toEqual([-0.25, 0.3, 0.5, 1, EXIT.timeStopMs]);
  });
  it('fees count like decideExit: with a 1% exit fee the stop is that much nearer', () => {
    const stop = exitTargets({ ...base, exitFee: 0.01 }).find((r) => r.key === 'stop')!;
    expect(stop.move).toBeCloseTo(0.75 / 0.99 - 1, 12);
  });
  it('once up 30% the trailing stop is armed and sits 20% under the peak; a take profit taken has no distance', () => {
    const x = Object.fromEntries(exitTargets({ ...base, price: 1.6, peak: 1.8, tp1Done: true }).map((r) => [r.key, r]));
    expect(x.trail).toMatchObject({ armed: true });
    expect(x.trail.move).toBeCloseTo((1.8 * 0.8) / 1.6 - 1, 12);
    expect(x.tp1).toMatchObject({ done: true, move: null });
    expect(x.time.does).toBe('off: up over +10%');
    expect(x.trail.at).toBeUndefined();
  });
});

describe('the exit track on a position card', () => {
  const base = { entryPrice: 1, price: 1, peak: 1, openedAt: NOW - 3600_000, now: NOW, entryVolume: 0, volume: 0, entryLiq: 0, liq: 0, sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1 };
  it('at the buy price the marker sits at 0%: a fifth of the way from the stop (−25%) to the last take-profit (+100%)', () => {
    const k = exitTrack(exitTargets(base))!;
    expect(k.now).toBeCloseTo(0, 12);
    expect(k.x).toBeCloseTo(20, 9);
    expect(k.marks.map((m) => [m.key, Math.round(m.x)])).toEqual([['stop', 0], ['trail', 44], ['tp1', 60], ['tp2', 100]]);
    expect(k.time).toMatchObject({ msLeft: EXIT.timeStopMs - 3600_000, off: false });
    expect(k.time!.frac).toBeCloseTo(1 / 6, 12);
  });
  it('the result now is the exit math\'s, fee in: price 1.2 with a 1% exit fee is +18.8%', () => {
    expect(exitTrack(exitTargets({ ...base, price: 1.2, peak: 1.2, exitFee: 0.01 }))!.now).toBeCloseTo(1.2 * 0.99 - 1, 9);
  });
  it('an armed trail sits where it would fire: 20% under a 1.8 peak is +44%; a take-profit taken is marked done', () => {
    const k = exitTrack(exitTargets({ ...base, price: 1.6, peak: 1.8, tp1Done: true }))!;
    expect(k.marks.find((m) => m.key === 'trail')!.at).toBeCloseTo(0.44, 9);
    expect(k.marks.find((m) => m.key === 'tp1')).toMatchObject({ done: true, at: 0.5 });
    expect(k.time!.off).toBe(true);
  });
  it('no price read yet: no track', () => {
    expect(exitTrack(exitTargets({ ...base, price: 0 }))).toBeNull();
    expect(exitTrack(null)).toBeNull();
  });
});

describe('a position keeps its prices and when they were read', () => {
  it('each mark adds [time, price]; at most MARKS_KEPT are kept', async () => {
    const { t, later } = trader((n) => 0.00004 * (1 + n / 1000));
    await t.tick();
    for (let i = 0; i < 3; i++) { later(10_000); await t.tick(); }
    const p = t.status().positions[0];
    expect(p.marks!.length).toBe(3);
    expect(p.markedAt).toBe(NOW + 30_000);
    expect(p.marks!.at(-1)).toEqual([NOW + 30_000, p.price]);
    expect(MARKS_KEPT).toBeGreaterThan(100);
  });
  it('status gives the value now in the spend coin and the exit targets', async () => {
    const { t } = trader(() => null);
    await t.tick();
    const p = t.status().positions[0];
    expect(p.value).toBeCloseTo(p.spent + p.pnl!, 12);
    // the pool watch's drain line shows once a depth is known; its dead-pool line once a price has been read (none here)
    expect(p.exits.map((r) => r.key)).toEqual(['stop', 'trail', 'tp1', 'tp2', 'time', 'drain']);
  });
});

describe('Sell now', () => {
  it('sells the whole position on the next pass, by the normal sell path, with its reason in the trades', async () => {
    const { t } = trader(() => null);
    await t.tick();
    const id = t.status().positions[0].id;
    t.sellNow(id);
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().trades[0]).toMatchObject({ side: 'sell', why: expect.stringMatching(/sold by hand/) });
  });
  it('refuses an unknown position, and refuses while off completely', async () => {
    const { t } = trader(() => null);
    await t.tick();
    expect(() => t.sellNow('nope')).toThrow(/No open position/);
    t.turnOff('full');
    expect(() => t.sellNow(t.status().positions[0].id)).toThrow(/off completely/);
  });
});

describe("a pool's fee tier is not part of its coin's name", () => {
  it('"PEPE / WETH 0.3%" gives PEPE and WETH', () => {
    const p = fromTopPool({ address: '0xp', name: 'PEPE / WETH 0.3%', dex: 'uniswap_v3', base: '0xaaa', quote: '0xweth', liquidityUsd: 1e6, volume24Usd: 1e5, createdAt: null, basePriceUsd: 0.00001, quotePriceUsd: 2500 }, { id: 1, spend: ['0xweth'] });
    expect([p!.tokenSymbol, p!.spendSymbol]).toEqual(['PEPE', 'WETH']);
  });
});

describe('positions saved with the fee tier in their label', () => {
  it('"PEPE/WETH 0.3%" shows PEPE paid in WETH', async () => {
    const store = new MemoryStore<TraderState>();
    const first = new TokenTrader({
      store, now: () => NOW, sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => [{ ...pool, spendSymbol: 'WETH 0.3%' }], assess: async () => clean, resolve: async () => null,
    });
    first.configure({ perTradeUsd: 100, totalUsd: 500, risk: 'any' });
    first.turnOn();
    await first.tick();
    const p = first.status().positions[0];
    expect(p.label).toBe('PEPE/WETH 0.3%');
    expect([p.tokenSym, p.spendSym]).toEqual(['PEPE', 'WETH']);
  });
});
