/**
 * Generated (coins, no USD) for the token trader and the smart trader: closed sells less what they cost, less gas;
 * fees and taxes are inside the actual amounts; open positions add nothing until sold (no mark to market).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { JsonStore, MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type LiveFill, type LiveSell, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { Autopilot, DEFAULT_OPTIONS, type AutopilotState, type ScanView } from '../src/server/bot/autopilot';
import { HOLD_MS } from '../src/market/autopilot';
import type { Opportunity } from '../src/market/scan';
import { MockChain, NET } from './helpers/mockChain';

const WETH = '0x' + '22'.repeat(20), USDC = '0x' + '33'.repeat(20), TOKEN = '0x' + '11'.repeat(20);
const NOW = 1_700_000_000_000;
const gate = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true, ...o,
});
let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 1, pool: '0x' + (n++).toString(16).padStart(40, 'b'), dex: 'uni-v3', kind: 'v3',
  token: TOKEN, spend: WETH, tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000, ...o,
});
const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper;
const coinInfo = (_chainId: number, spend: string) => ({ native: spend.toLowerCase() === WETH, nativeSymbol: 'ETH' });

/** Live trader with a scripted broker: buys and sells fill exactly as told (taxes and fees are inside the amounts). */
function live(o: {
  pools: FreshPool[]; buy: (p: FreshPool, spend: number) => LiveFill; sell: (tokens: number) => LiveSell;
  g?: Partial<GateInput>; store?: MemoryStore<TraderState> | JsonStore<TraderState>; native?: boolean;
}) {
  let queue = [...o.pools];
  const t = new TokenTrader({
    store: o.store ?? new MemoryStore<TraderState>(), now: () => NOW, sniper,
    discover: async () => { const q = queue; queue = []; return q; },
    assess: async () => gate({ mode: 'live', ...o.g }),
    live: { buy: async (p, spend) => o.buy(p, spend), sell: async (_p, tokens) => o.sell(tokens) },
    ...(o.native === false ? {} : { coinInfo }),
  });
  t.configure({ mode: 'live', perTradeUsd: 2000, totalUsd: 10_000, minPoolAgeSec: 0, risk: 'medium' });
  t.turnOn();
  return t;
}
const byCoin = (t: TokenTrader, coin: string) => t.status().generated.find((g) => g.coin.address === coin.toLowerCase())!;

describe('token trader Generated (coins)', () => {
  it('buy with tax and gas, a partial take-profit, then the rest: proceeds − cost − gas, in the funding coin (WETH)', async () => {
    let rate = 0.0015;
    const t = live({
      pools: [pool({ price: 1 / 900 })], g: { buyTax: 0.05, sellTax: 0.05 },
      // 1 WETH in, 900 tokens arrive (fee, impact and the 5% buy tax already off); gas 0.002 ETH
      buy: () => ({ tokens: 900, spent: 1, spentUsd: 2000, price: 1 / 900, impact: 0.01, gasNative: 0.002 }),
      // each sell: what arrives after fee and sell tax; 0.001 ETH gas per send
      sell: (tokens) => ({ quoteOut: tokens * rate, tokensIn: tokens, price: rate, impact: 0.01, gasNative: 0.001 }),
    });
    await t.tick();
    const [p] = t.status().positions;
    expect(p.tokens).toBe(900);
    // Open, nothing sold: only the buy's pool fee (1 × 0.30%) and its gas
    let g = byCoin(t, WETH);
    expect(g.coin).toEqual({ chainId: 1, address: WETH, symbol: 'WETH', native: true });
    expect(g.amount).toBeCloseTo(-0.003 - 0.002, 12);
    expect(p.generated.amount).toBeCloseTo(-0.005, 12);
    // Marking the price up adds nothing (no mark to market)
    t.mark(p.id, { price: (1 / 900) * 1.4 });
    await t.tick();
    expect(t.status().positions[0].tokens).toBe(900);
    expect(byCoin(t, WETH).amount).toBeCloseTo(-0.005, 12);
    // Take profit: a third (300 tokens) → 0.45 WETH
    t.mark(p.id, { price: (1 / 900) * 1.7 });
    await t.tick();
    expect(t.status().positions[0].tokens).toBeCloseTo(600, 9);
    g = byCoin(t, WETH);
    const cost1 = 0.003 + 0.997 * (300 / 900);
    expect(g.proceeds).toBeCloseTo(0.45, 12);
    expect(g.cost).toBeCloseTo(cost1, 12);
    expect(g.gasNative).toBeCloseTo(0.003, 12);
    expect(g.amount).toBeCloseTo(0.45 - cost1 - 0.003, 12);
    expect(t.status().positions[0].generated.amount).toBeCloseTo(0.45 - cost1 - 0.003, 12);
    // Hard stop sells the other 600 at a worse rate → 0.3 WETH
    rate = 0.0005;
    t.mark(p.id, { price: (1 / 900) * 0.5 });
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    g = byCoin(t, WETH);
    expect(g.proceeds).toBeCloseTo(0.75, 12);
    expect(g.cost).toBeCloseTo(1, 12); // a whole round trip costs exactly what was spent
    expect(g.gasNative).toBeCloseTo(0.004, 12);
    expect(g.amount).toBeCloseTo(0.75 - 1 - 0.004, 12);
    expect(g.closed).toBe(2);
    expect(g.gasInAmount).toBe(true);
    // fees and taxes for reference only: the buy fee plus each sell's fee, and each sell's tax (5%)
    const gross = (q: number) => q / (0.997 * 0.95);
    expect(g.fees).toBeCloseTo(0.003 + (gross(0.45) + gross(0.3)) * 0.95 * 0.003, 12);
    expect(g.taxes).toBeCloseTo((gross(0.45) + gross(0.3)) * 0.05, 12);
    // the existing USD figures are unchanged
    expect(t.status().trades.filter((x) => x.side === 'sell').map((x) => x.pnlUsd)).toEqual([
      expect.closeTo(0.3 * 2000 - 2000 * (600 / 900), 6), expect.closeTo(0.45 * 2000 - 2000 * (300 / 900), 6),
    ]);
  });

  it('a non-native funding coin (USDC): gas stays apart in ETH, never price-converted', async () => {
    const t = live({
      pools: [pool({ spend: USDC, spendSymbol: 'USDC', usdPerSpend: 1, quoteReserve: 80_000, price: 0.08 })],
      buy: () => ({ tokens: 10_000, spent: 1000, spentUsd: 1000, price: 0.1, impact: 0.01, gasNative: 0.002 }),
      sell: (tokens) => ({ quoteOut: tokens * 0.05, tokensIn: tokens, price: 0.05, impact: 0.01, gasNative: 0.001 }),
    });
    await t.tick();
    const id = t.status().positions[0].id;
    t.mark(id, { price: 0.05 });
    await t.tick();
    const g = byCoin(t, USDC);
    expect(g.coin).toMatchObject({ symbol: 'USDC', native: false });
    expect(g.amount).toBeCloseTo(500 - 1000, 9); // fee inside the cost; no gas taken out
    expect(g.gasNative).toBeCloseTo(0.003, 12);
    expect(g.gasSymbol).toBe('ETH');
    expect(g.gasInAmount).toBe(false);
  });

  it('several positions on two coins: one entry per funding coin; gas of a failed sell still counts', async () => {
    let fail = false;
    const t = live({
      pools: [pool({ price: 0.001 }), pool({ price: 0.001 }), pool({ spend: USDC, spendSymbol: 'USDC', usdPerSpend: 1, quoteReserve: 80_000, price: 0.1 })],
      buy: (p) => (p.spend === USDC
        ? { tokens: 10_000, spent: 1000, spentUsd: 1000, price: 0.1, impact: 0, gasNative: 0.001 }
        : { tokens: 1000, spent: 1, spentUsd: 2000, price: 0.001, impact: 0, gasNative: 0.001 }),
      sell: (tokens) => {
        if (fail) throw Object.assign(new Error('swap reverted'), { opts: { gasNative: 0.0007 } });
        return { quoteOut: tokens * 0.002, tokensIn: tokens, price: 0.002, impact: 0, gasNative: 0.001 };
      },
    });
    await t.tick();
    const ps = t.status().positions;
    expect(ps).toHaveLength(3);
    const [a, b] = ps.filter((p) => p.spend === WETH);
    t.mark(a.id, { price: 0.0005 }); // hard stop: sells 1000 → 2 WETH (scripted)
    await t.tick();
    let g = byCoin(t, WETH);
    // two buys (fee 0.003 each, gas 0.001 each) and one closed sell
    expect(g.amount).toBeCloseTo(2 - (0.003 + 0.997) - 0.003 - 0.001 * 3, 12);
    fail = true;
    t.mark(b.id, { price: 0.0005 });
    await t.tick();
    expect(t.status().lastError).toMatch(/reverted/);
    g = byCoin(t, WETH);
    expect(g.gasNative).toBeCloseTo(0.0037, 12);
    expect(g.closed).toBe(1);
    expect(byCoin(t, USDC).amount).toBeCloseTo(-1000 * 0.003, 9); // open: only its buy fee
    expect(t.status().generated).toHaveLength(2);
  });

  it('live buy with the spend reserved (#59 pendingBuy): gas booked into Generated exactly once; the hold is released on fill and on failure', async () => {
    let t!: TokenTrader;
    let fail = false;
    const during: unknown[] = [];
    t = live({
      pools: [pool({ price: 1 / 900 }), pool({ price: 1 / 900 })],
      buy: (p, spend) => {
        // while the send is in flight the spend coin is held for this buy, and nothing is booked yet
        during.push({ held: t.reservations().filter((r) => r.address === p.spend && r.amount === spend).length, gas: t.status().generated.reduce((a, g) => a + g.gasNative, 0) });
        if (fail) throw Object.assign(new Error('swap reverted'), { opts: { gasNative: 0.0009 } });
        fail = true; // the second buy reverts after paying gas
        return { tokens: 900, spent: 1, spentUsd: 2000, price: 1 / 900, impact: 0, gasNative: 0.002 };
      },
      sell: (tokens) => ({ quoteOut: tokens * 0.001, tokensIn: tokens, price: 0.001, impact: 0, gasNative: 0 }),
    });
    await t.tick();
    expect(during).toEqual([{ held: 1, gas: 0 }, { held: 1, gas: 0.002 }]);
    const ps = t.status().positions;
    expect(ps).toHaveLength(1); // the failed buy books no position
    expect(t.status().lastError).toMatch(/reverted/);
    // hold released: only the open position's coins remain reserved, no pending spend
    expect(t.reservations().filter((r) => r.address === WETH)).toEqual([expect.objectContaining({ amount: ps[0].spent })]);
    const g = byCoin(t, WETH);
    expect(g.gasNative).toBeCloseTo(0.002 + 0.0009, 12); // filled buy once + failed send once, never twice
    expect(ps[0].generated.gasNative).toBeCloseTo(0.002, 12); // the failed send is not charged to the open position
    expect(g.amount).toBeCloseTo(-0.003 - 0.0029, 12);
  });

  it('paper: fee and both taxes come out of what it generated, on a deep pool at a flat price', async () => {
    const f = 0.003, tb = 0.04, ts = 0.04;
    let queue = [pool({ quoteReserve: 1e9, tokenReserve: 2.5e13 })];
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => NOW, sniper, coinInfo,
      discover: async () => { const q = queue; queue = []; return q; }, assess: async () => gate({ buyTax: tb, sellTax: ts }),
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'medium' });
    t.turnOn();
    await t.tick();
    const [p] = t.status().positions;
    t.mark(p.id, { liq: 1 }); // liquidity pulled: sells everything at the same price
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    const g = byCoin(t, WETH);
    // a round trip at a flat price keeps (1 − f)² (1 − tb)(1 − ts) of what was spent
    expect(g.amount / p.spent).toBeCloseTo((1 - f) ** 2 * (1 - tb) * (1 - ts) - 1, 4);
    expect(g.cost).toBeCloseTo(p.spent, 12);
  });
});

describe('token trader Generated: resume', () => {
  it('an old token-trader.json without the field loads, books from there on, and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gen-')), file = join(dir, 'token-trader.json');
    const old = {
      version: 1, on: true, options: { mode: 'live', perTradeUsd: 2000, totalUsd: 10000, minPoolAgeSec: 0, chains: [], risk: 'any', maxImpact: 0.03, maxPoolShare: 0.02, sniper: { on: false } },
      positions: [{
        id: 'tt-old', chainId: 1, pool: '0x' + 'cc'.repeat(20), dex: 'uni-v3', label: 'OLD/WETH', token: TOKEN, spend: WETH, mode: 'live',
        entryPrice: 0.001, entryMid: null, entryBasis: 'effective', price: 0.001, peak: 0.001, tokens: 1000, entryTokens: 1000, spent: 1, spentUsd: 2000,
        openedAt: NOW, entryVolume: 10000, volume: 10000, entryLiq: 80000, liq: 80000, entrySellTax: 0, sellTax: 0, sellSimOk: true, feeBps: 30,
        quoteReserve: 40, tokenReserve: 1e6, usdPerSpend: 2000, buyTax: 0, tp1Done: false, tp2Done: false, source: 'scan', exitPlan: 'hold',
      }],
      trades: [{ t: NOW, side: 'buy', chainId: 1, pool: '0x' + 'cc'.repeat(20), label: 'OLD/WETH', usd: 2000, price: 0.001, why: 'buy', pnlUsd: null }],
      feed: [], cursors: {}, snipesAt: [],
    };
    writeFileSync(file, JSON.stringify(old));
    const store = new JsonStore<TraderState>(file);
    const t = live({ pools: [], store, buy: () => { throw new Error('no buys'); }, sell: (k) => ({ quoteOut: k * 0.0012, tokensIn: k, price: 0.0012, impact: 0, gasNative: 0.001 }) });
    // loads: nothing booked yet, the old position and its USD P&L as before
    expect(t.status().generated).toEqual([]);
    expect(t.status().positions[0]).toMatchObject({ id: 'tt-old', spent: 1, tokens: 1000, entryPrice: 0.001 });
    expect(t.status().positions[0].generated.amount).toBe(0);
    t.mark('tt-old', { price: 0.0005 });
    await t.tick();
    // its buy fee was never booked, so its whole `spent` is the cost of what it sold
    const g = byCoin(t, WETH);
    expect(g.amount).toBeCloseTo(1.2 - 1 - 0.001, 12);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as TraderState;
    expect(Object.values(saved.generated!)[0]).toMatchObject({ proceeds: 1.2, cost: 1, closed: 1 });
    expect(saved.trades).toHaveLength(2); // old rows kept
    const again = new TokenTrader({ store: new JsonStore<TraderState>(file), now: () => NOW, coinInfo });
    expect(byCoin(again, WETH).amount).toBeCloseTo(1.2 - 1 - 0.001, 12);
  });

  it('an open position restarts with its booked buy fee, so the round trip still costs exactly what was spent', async () => {
    const store = new MemoryStore<TraderState>();
    const t = live({ pools: [pool({ price: 1 / 900 })], store, buy: () => ({ tokens: 900, spent: 1, spentUsd: 2000, price: 1 / 900, impact: 0, gasNative: 0.002 }), sell: (k) => ({ quoteOut: k * 0.001, tokensIn: k, price: 0.001, impact: 0, gasNative: 0 }) });
    await t.tick();
    const id = t.status().positions[0].id;
    expect(store.load()!.positions[0].gen).toMatchObject({ feeBooked: 0.003, gasNative: 0.002 });
    const t2 = new TokenTrader({ store, now: () => NOW, coinInfo, live: { buy: async () => { throw new Error('x'); }, sell: async (_p, k) => ({ quoteOut: k * 0.001, tokensIn: k, price: 0.001, impact: 0, gasNative: 0 }) } });
    t2.mark(id, { price: 0.0001 });
    await t2.tick();
    const g = byCoin(t2, WETH);
    expect(g.cost).toBeCloseTo(1, 12);
    expect(g.amount).toBeCloseTo(0.9 - 1 - 0.002, 12);
  });
});

// ── Smart trader ──────────────────────────────────────────────────────
const P0 = 0.00001;
function opp(swing: number): Opportunity {
  const q = NET.quotes.find((x) => x.symbol === 'DAI')!;
  return {
    chainId: NET.chainId, key: 'DAI', ref: { address: NET.pulsex.wpls, quote: q.address, pool: '' }, label: 'PLS/DAI', spend: 'DAI', stack: 'PLS', dex: 'pulsex-v2', kind: 'v2', feeBps: 29,
    risk: null, riskWhy: null, liveAllowed: true, price: P0, movePct: 0, swingPct: swing, activity: null, capital: 1e6, usd: 1e6,
    grid: { bandPct: 0.12, gridCount: 10, earnedPct: 0.02, roundTrips: 8, returnPct: 0, maxDrawdownPct: 0 }, gridWhy: null, lp: null, lpWhy: 'v2',
  };
}
const view = (at: number, items: Opportunity[]): ScanView => ({ at, chains: [{ chainId: NET.chainId, items, error: null }] });

describe('smart trader Generated (budget coin)', () => {
  it('open: counts at cost (no mark to market); closed to cash: what came back less the budget; gas apart', async () => {
    let now = 1_800_000_000_000;
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => now });
    let scan = view(1, [opp(0.3)]);
    const store = new MemoryStore<AutopilotState>();
    const ap = new Autopilot({ bot, store, emit: () => undefined, scan: async () => scan, now: () => now });
    ap.configure({ mode: 'paper', options: { ...DEFAULT_OPTIONS, slots: 1 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] });
    await ap.turnOn();
    await bot.tickAll();
    let [a] = ap.status().accounts;
    expect(a.generated).toMatchObject({ coin: { symbol: 'DAI', native: false }, cost: 300, gasSymbol: 'PLS', gasInAmount: false, basis: 'closed' });
    expect(a.generated.amount).toBeCloseTo(0, 9);
    chain.setPrice(P0 * 1.1); // a price move on an open bot is not Generated
    await bot.tickAll();
    await ap.tick();
    expect(ap.status().accounts[0].generated.amount).toBeCloseTo(0, 9);
    // closed to cash: the PLS it holds comes back and is swapped to DAI
    now += HOLD_MS + 1;
    scan = view(2, [{ ...opp(0.3), grid: null, gridWhy: 'no grid earned from its trades this week' }]);
    await ap.tick();
    await ap.tick();
    [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(0);
    expect(a.generated.amount).toBeCloseTo(a.coins.DAI - 300, 9);
    expect(a.generated.gasNative).toBeCloseTo(ap.state.accounts[0].gasNative, 12);
    expect(a.generated.gasNative).toBeGreaterThan(0);
    expect(a.inTransit).toEqual([]);
    // derived from the saved account only: a restart reads the same
    const again = new Autopilot({ bot, store, emit: () => undefined, scan: async () => scan, now: () => now });
    expect(again.status().accounts[0].generated).toEqual(a.generated);
  });
});
