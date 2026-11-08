/**
 * The three liquidity strategies (market/lpStrategy.ts; Kyle 2026-11-08) and the engine's order mode behind strategy
 * "orders": one coin on one side of the price, never swapped; the pool fills it; filled through, it flips to the
 * opposite order (or pauses). Plus the order replay and the strategy cards.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { LpEngine, type LpState } from '../src/server/bot/lpEngine';
import { correlatedPair, orderState, orderTicks, patientWidth, STRATEGY } from '../src/market/lpStrategy';
import { replayOrders, type PoolMinute, type ReplayPool } from '../src/market/lpReplay';
import { OrderFields, StrategyCards } from '../src/ui/StrategyCards';
import { LpDetail } from '../src/ui/LpDetail';
import { ShowUsdCtx } from '../src/ui/money';
import { S } from './helpers/unitsScreens';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { NET } from './helpers/mockChain';

type Ev = { type: string; msg: string; level?: string; notify?: boolean };
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MARKET = 'pulsechain:PLS/DAI#9mm';

function world(emit?: (e: Ev) => void) {
  const CH = chainFromNetwork(NETWORKS.mainnet);
  const dex = CH.dexes.find((d) => d.id === '9mm-v3')!;
  const m = new MultiDexMock();
  const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
  const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };
  [WPLS, DAI].forEach((t) => m.addToken(t));
  m.addV3('9mm-v3', { factory: dex.factory, quoter: dex.quoter! });
  const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
  const def: MarketDef = {
    key: MARKET, chainId: 369, custom: true,
    base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
    pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
  };
  const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
  let t = 1_800_000_000_000;
  const lp = new LpEngine({ net: NET, store: new MemoryStore<LpState>(), log: new Logger(true), hub, now: () => t, emit: emit as never });
  return { m, pool, lp, at: (ms: number) => { t = 1_800_000_000_000 + ms; } };
}
const buyOrder = { strategy: 'orders' as const, oneSided: { side: 'buy' as const, steps: 2, flip: true }, lossLimitPct: 0.5 };

describe('strategy "orders": a one-sided position the pool fills, never swapped', () => {
  it('a buy order sits below the price, holds only the quote coin, swaps nothing, and waits while the price is above it', async () => {
    const events: Ev[] = [];
    const { lp } = world((e) => events.push(e));
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, ...buyOrder });
    expect(events.some((e) => /placing a buy order 2 pool steps below/.test(e.msg))).toBe(true);
    await lp.tick();
    const s = lp.status();
    expect(s.position).not.toBeNull();
    expect(s.position!.upper).toBeLessThanOrEqual(s.price!);
    expect(s.coins!.base).toBe(0);
    expect(s.coins!.quote).toBeGreaterThan(990);
    expect(s.totals.swapCost).toBe(0);
    expect(s.side).toBe('buy');
    expect(s.config!.strategy).toBe('orders');
    await lp.tick();
    expect(lp.status().hold.wait).toBe('order-waiting');
  });

  it('the price rising away leaves the order where it is; filled through, it flips to a sell order just above the new price', async () => {
    const events: Ev[] = [];
    const { lp, m, pool, at } = world((e) => events.push(e));
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, ...buyOrder });
    await lp.tick();
    const first = lp.status().position!;
    m.movePrice(pool, 1.05); at(60_000);
    await lp.tick();
    expect(lp.status().position!.id).toBe(first.id);
    expect(lp.status().reranges).toBe(0);
    m.movePrice(pool, 0.9); at(120_000); // back down and through the 1% band (2 steps of 0.5%)
    await lp.tick();
    const s = lp.status();
    expect(s.reranges).toBe(1);
    expect(s.side).toBe('sell');
    expect(s.position!.id).not.toBe(first.id);
    expect(s.position!.lower).toBeGreaterThanOrEqual(s.price!); // the sell order sits above the price
    expect(s.coins!.quote).toBe(0); // and holds only the coin the buy order got
    expect(s.coins!.base).toBeGreaterThan(0);
    expect(s.totals.swapCost).toBe(0);
    expect(events.some((e) => /the buy order .* is filled .*; placing a sell order at the price/.test(e.msg) && e.notify)).toBe(true);
  });

  it('a sell order needs the base coin and sits above the price; with flip off a fill pauses the bot, and Resume places the opposite order', async () => {
    const { lp, m, pool, at } = world();
    await expect(lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, strategy: 'orders', oneSided: { side: 'sell', steps: 1, flip: false } })).rejects.toThrow(/A sell order is placed with PLS/);
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 0, baseAmount: 1_000_000, lossLimitPct: 0.5, strategy: 'orders', oneSided: { side: 'sell', steps: 1, flip: false } });
    await lp.tick();
    const s = lp.status();
    expect(s.position!.lower).toBeGreaterThanOrEqual(s.price!);
    expect(s.coins!.quote).toBe(0);
    expect(s.coins!.base).toBeGreaterThan(0);
    m.movePrice(pool, 1.04); at(60_000);
    await lp.tick();
    const f = lp.status();
    expect(f.status).toBe('stopped');
    expect(f.halt).toMatchObject({ what: 'filled' });
    expect(f.halt!.detail).toMatch(/the sell order filled .*Resume to place a buy order at the price, or close\./);
    expect(f.position).toBeNull();
    expect(f.idle.base).toBe(0); // sold: only the quote coin is in the wallet
    expect(f.idle.quote).toBeGreaterThan(0);
    expect(f.side).toBe('buy'); // the order those coins fill
    lp.resume();
    at(120_000);
    await lp.tick();
    const again = lp.status();
    expect(again.status).toBe('running');
    expect(again.position).not.toBeNull();
    expect(again.position!.upper).toBeLessThanOrEqual(again.price!); // a buy order, below the price
    expect(again.coins!.base).toBe(0);
    expect(again.totals.swapCost).toBe(0);
  });

  it('Move now re-places a waiting order at the price, the same side; bad settings are refused in plain words', async () => {
    const { lp, m, pool, at } = world();
    await lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, ...buyOrder });
    await lp.tick();
    const first = lp.status().position!;
    m.movePrice(pool, 1.05); at(60_000);
    await lp.tick();
    await lp.move();
    at(120_000);
    await lp.tick();
    const s = lp.status();
    expect(s.position).not.toBeNull();
    expect(s.position!.id).not.toBe(first.id);
    expect(s.reranges).toBe(1);
    expect(s.position!.upper).toBeGreaterThan(first.upper); // closer to the higher price
    expect(s.position!.upper).toBeLessThanOrEqual(s.price!);
    expect(s.side).toBe('buy');
    const w = world();
    await expect(w.lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 0, baseAmount: 1_000_000, strategy: 'orders', oneSided: { side: 'buy', steps: 2, flip: true } })).rejects.toThrow(/A buy order is placed with DAI/);
    await expect(w.lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, oneSided: { side: 'buy', steps: 0, flip: true } })).rejects.toThrow(/1 to 10 pool steps/);
    await expect(w.lp.start({ mode: 'paper', market: MARKET, bandPct: 0.01, capital: 1000, strategy: 'moon' as never })).rejects.toThrow(/Unknown strategy/);
  });
});

describe('the strategies\' rules (market/lpStrategy.ts)', () => {
  it('the patient width is the week\'s move, clamped, and a fallback until the week is read', () => {
    expect(patientWidth(null)).toEqual({ pct: 0.1, from: 'fallback' });
    expect(patientWidth({ hiPct: 0.08, loPct: 0.12 })).toEqual({ pct: 0.12, from: 'week' });
    expect(patientWidth({ hiPct: 0.4, loPct: 0.1 }).pct).toBe(STRATEGY.patient.width.max);
    expect(patientWidth({ hiPct: 0.01, loPct: 0.02 }).pct).toBe(STRATEGY.patient.width.min);
  });
  it('coins that move together: dollar coins, ETH wrappers, BTC wrappers; a meme coin against ETH is not one', () => {
    expect(correlatedPair('USDC', 'USDT')).toBe('stable');
    expect(correlatedPair('USDG', 'USDC')).toBe('stable');
    expect(correlatedPair('wstETH', 'WETH')).toBe('eth');
    expect(correlatedPair('cbBTC', 'WBTC')).toBe('btc');
    expect(correlatedPair('CASHCAT', 'ETH')).toBeNull();
    expect(correlatedPair('ETH', 'USDG')).toBeNull();
  });
  it('an order\'s ticks sit on the side where its coin is held, skipping the step the price is in; its state is read from the tick', () => {
    expect(orderTicks(125, 60, true, 'buy', 2)).toEqual({ tickLower: 0, tickUpper: 120 }); // the quote coin below, when the base is token0
    expect(orderTicks(125, 60, true, 'sell', 2)).toEqual({ tickLower: 180, tickUpper: 300 });
    expect(orderTicks(125, 60, false, 'buy', 2)).toEqual({ tickLower: 180, tickUpper: 300 }); // the quote coin above, when the base is token1
    expect(orderState(110, 0, 120, true, 'buy')).toBe('filling');
    expect(orderState(-5, 0, 120, true, 'buy')).toBe('filled');
    expect(orderState(130, 0, 120, true, 'buy')).toBe('waiting');
    expect(orderState(305, 180, 300, true, 'sell')).toBe('filled');
    expect(orderState(100, 180, 300, false, 'buy')).toBe('waiting');
  });
});

describe('the order replay', () => {
  const pool: ReplayPool = { baseIs0: true, baseDecimals: 18, quoteDecimals: 18, spacing: 60, swapFee: 0.003 };
  const T0 = 1_700_000_000;
  // 60 minutes flat at tick 0, a fall to −200 over 40 minutes, a rise to +100 over 60 minutes, then flat
  const path: number[] = [...Array(60).fill(0), ...Array.from({ length: 40 }, (_, i) => -Math.round((i + 1) * 5)), ...Array.from({ length: 60 }, (_, i) => -200 + Math.round((i + 1) * 5)), ...Array(40).fill(100)];
  const rows: PoolMinute[] = path.map((c, i) => ({ t: T0 + i * 60, lo: Math.min(c, path[i - 1] ?? c), hi: Math.max(c, path[i - 1] ?? c), c, f0: 1e-12, f1: 1e-12, liq: 1e24, n: 3 }));
  it('a buy order fills when the price falls through it, flips to a sell order, which fills on the way back up; fees come while inside', () => {
    const r = replayOrders(rows, pool, { side: 'buy', steps: 2, flip: true, capital: 1000, gasMove: 0.01 });
    expect(r.fills).toBe(2);
    expect(r.fees).toBeGreaterThan(0);
    expect(r.inOrder).toBeGreaterThan(0);
    expect(r.inOrder).toBeLessThan(1);
    expect(r.gas).toBeCloseTo(0.02, 12);
    expect(Number.isFinite(r.result)).toBe(true);
    expect(r.startCoins).toEqual({ base: 0, quote: 1000 });
    const once = replayOrders(rows, pool, { side: 'buy', steps: 2, flip: false, capital: 1000, gasMove: 0.01 });
    expect(once.fills).toBe(1);
    expect(once.endCoins.base).toBeGreaterThan(0); // bought, and kept
  });
  it('a sell order the price never reaches fills nothing and earns nothing', () => {
    const flat = rows.slice(0, 60);
    const r = replayOrders(flat, pool, { side: 'sell', steps: 1, flip: true, capital: 1000, gasMove: 0.01 });
    expect(r.fills).toBe(0);
    expect(r.fees).toBe(0);
    expect(r.result).toBeCloseTo(0, 9);
  });
});

describe('the strategy cards and the order view', () => {
  const html = renderToStaticMarkup(createElement(StrategyCards, { chosen: 'orders', onChoose: () => undefined, week: { hiPct: 0.08, loPct: 0.12 }, base: 'CASHCAT', quote: 'ETH', stepPct: 0.006 }));
  it('three cards, each with its moving picture, the settings in words and a button; the chosen one says so', () => {
    for (const id of ['patient', 'orders', 'stable']) expect(html).toContain(`data-testid="strategy-${id}"`);
    expect(html).toContain('class="sx sx-p"'); expect(html).toContain('class="sx sx-o"'); expect(html).toContain('class="sx sx-s"');
    expect(html).toContain('±12.0% (how far CASHCAT went in 7 days, from its trades)');
    expect(html).toContain('2 steps wide (1.20%)');
    expect(html).toContain('>Chosen<');
    expect((html.match(/>Use this</g) ?? []).length).toBe(2);
    expect(html).toContain('fees build while the price wanders inside');
    expect(html).toContain('filled trade by trade: CASHCAT + the fee');
    expect(html).toContain('a depeg: one breaks away; paused at −1%');
    expect(html).not.toContain('$');
  });
  it('the order fields: side, width in pool steps, flip, and what it would do at the price', () => {
    const o = renderToStaticMarkup(createElement(OrderFields, { o: { side: 'buy', steps: 2, flip: true }, set: () => undefined, base: 'CASHCAT', quote: 'ETH', stepPct: 0.006, spot: 0.00004 }));
    expect(o).toContain('Buy CASHCAT below the price · places ETH');
    expect(o).toContain('2 steps · 1.20%');
    expect(o).toContain('Flip when filled');
    expect(o).toMatch(/Buys CASHCAT between about .* and .* ETH\/CASHCAT, earning the pool fee on every trade that fills it\. Nothing is swapped\./);
  });
  it('the bot page shows an order bot as an order: its side, where it waits, the flip, and a way to re-place it', () => {
    const lp = (S.lps as Obj[]).find((l) => l.status === 'running' && l.position)!;
    const price = lp.price as number;
    const bot = { ...lp, side: 'buy', hold: { ...lp.hold, wait: 'order-waiting' }, inRange: false, config: { ...lp.config, strategy: 'orders', oneSided: { side: 'buy', steps: 2, flip: true } }, position: { ...lp.position, lower: price * 0.98, upper: price * 0.99 } };
    const page = renderToStaticMarkup(createElement(ShowUsdCtx.Provider, { value: { on: false, set: () => undefined } },
      createElement(LpDetail, { s: { ...S, lps: [bot] }, id: bot.id, events: [], ticks: null, nav: () => undefined, act: () => undefined, busy: false } as never)));
    const text = page.replace(/<[^>]+>/g, ' ');
    expect(text).toContain('Buy order · waiting for the price');
    expect(text).toContain('Strategy: Paid limit orders');
    expect(text).toMatch(/waits from .* to .*: the pool buys .* with it on the way down, paying the fee on every trade\./);
    expect(text).toContain('the bot places a sell order just above the new price');
    expect(page).toContain('>Re-place at the price<');
    expect(text).toContain('The price is away from your order');
  });
});
