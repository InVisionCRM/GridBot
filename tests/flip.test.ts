/**
 * Base/quote flip ("Stack HEX with PLS"): key helpers, inverted price math across decimals, native-leg router
 * methods (ETH-for-tokens / tokens-for-ETH, FoT variants, V3 wrap/unwrap), flipped paper + live grids (fills, PnL
 * in PLS), gas-reserve gate, flipped trend bot, inverted candles, flipped backtest without look-ahead, migration of
 * existing state, and the flipped presets passing the start gate.
 */
import { describe, expect, it } from 'vitest';
import { getAddress } from 'ethers';
import { FLIP, flipKey, flipMarket, isFlipKey, orientation, orientedKey, unflipKey, type MarketDef } from '../src/live/markets';
import { invertCandles, type Candle } from '../src/market/candles';
import { CandleStore } from '../src/server/market/candleStore';
import { checkGasReserve, DEFAULT_GAS_RESERVE, gasReserve, parseGasRes, reserveCfg } from '../src/live/gasReserve';
import { validateLimits, DEFAULT_LIMITS } from '../src/live/limits';
import { amountToUnits } from '../src/live/decimals';
import { NATIVE, fromUnits } from '../src/live/swapMath';
import { NO_TAX } from '../src/live/tax';
import { V2Adapter } from '../src/server/dex/v2';
import { V3Adapter } from '../src/server/dex/v3';
import { V3_ROUTER } from '../src/server/dex/abis';
import { Quoter, PaperExecutor } from '../src/server/bot/chain';
import type { DexConfig } from '../src/live/chains';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ActivityBus } from '../src/server/bot/activity';
import { runTrendBacktest } from '../src/market/backtest';
import { DEFAULT_TREND } from '../src/market/strategy';
import { getPreset, listPresets, legKey } from '../src/live/presets';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { MockChain, NET } from './helpers/mockChain';
import { candlesFromCloses, wavePath } from './helpers/candles';

const FEE = 0.0029;
const ME = getAddress('0x' + 'd'.repeat(40));

describe('flip keys + orientation labels', () => {
  it('K~ is the flipped view; helpers round-trip; original keys never contain ~', () => {
    expect(FLIP).toBe('~');
    expect(flipKey('HEX')).toBe('HEX~');
    expect(flipKey('HEX~')).toBe('HEX');
    expect(isFlipKey('HEX~')).toBe(true);
    expect(isFlipKey('ethereum:ETH/USDC')).toBe(false);
    expect(unflipKey('ethereum:ETH/USDC~')).toBe('ethereum:ETH/USDC');
    expect(unflipKey('DAI')).toBe('DAI');
    expect(orientedKey('HEX', true)).toBe('HEX~');
    expect(orientedKey('HEX~', false)).toBe('HEX');
    expect(orientedKey('HEX~', true)).toBe('HEX~');
  });
});

/** PLS (native, 18) vs TOK (any decimals) on one V2 pool + one V3 pool. Mid 0.0075 TOK per PLS (≈ 133.3 PLS per TOK). */
function nativeWorld(o: { tokDec: number; kind: 'v2' | 'v3'; tokIsToken0?: boolean; custom?: boolean; buyTax?: number; sellTax?: number }) {
  const WPLS: Tok = { address: getAddress('0x' + 'a'.repeat(40)), symbol: 'WPLS', decimals: 18 };
  const TOK: Tok = { address: getAddress(o.tokIsToken0 ? '0x' + '0c'.padEnd(40, '0') : '0x' + 'c'.repeat(40)), symbol: 'TOK', decimals: o.tokDec };
  const m = new MultiDexMock();
  [WPLS, TOK].forEach((t) => m.addToken(t));
  const router = getAddress('0x' + '1'.repeat(40)), factory = getAddress('0x' + '2'.repeat(40)), quoter = getAddress('0x' + '3'.repeat(40));
  m.addV2('px', { router, factory, feeBps: 29, wrapped: WPLS.address });
  m.addV3('px3', { factory: getAddress('0x' + '4'.repeat(40)), quoter });
  const pair = m.v2Pair('px', WPLS, 1e9, TOK, 7.5e6);
  const pool3 = m.v3Pool('px3', WPLS, 1e9, TOK, 7.5e6, 2500);
  const tax = { buy: o.buyTax ?? 0, sell: o.sellTax ?? 0, transfer: 0 };
  const orig: MarketDef = {
    key: 'pulse:PLS/TOK', chainId: 369,
    base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true },
    quote: { address: TOK.address, symbol: 'TOK', decimals: o.tokDec },
    pool: o.kind === 'v3' ? { dex: 'px3', kind: 'v3', address: pool3, feeBps: 25, feeTier: 2500 } : { dex: 'px', kind: 'v2', address: pair, feeBps: 29 },
    probe: 1000, quoteKind: 'token', ...(o.custom ? { custom: true } : {}),
  };
  const v2cfg: DexConfig = { id: 'px', name: 'PX', kind: 'v2', router, factory, feeBps: 29, source: 'test' };
  const v3cfg: DexConfig = { id: 'px3', name: 'PX3', kind: 'v3', router: getAddress('0x' + '5'.repeat(40)), factory: getAddress('0x' + '4'.repeat(40)), quoter, feeTiers: [2500], source: 'test' };
  const ad = o.kind === 'v3' ? new V3Adapter(m, v3cfg, WPLS.address) : new V2Adapter(m, v2cfg, WPLS.address);
  const chain = { id: 369, key: 'pulse', name: 'PulseChain', short: 'PLS', color: '#fff', status: 'live', stack: 'l1', nativeSymbol: 'PLS', wrappedNative: { address: WPLS.address, symbol: 'WPLS', decimals: 18 }, stables: [], dexes: [v2cfg, v3cfg], explorer: '', geckoSlug: '', trading: { available: true }, gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 1000, rpcs: [] } as never;
  const taxOf = (a: string) => (a.toLowerCase() === TOK.address.toLowerCase() ? tax : NO_TAX);
  const q = new Quoter(m, orig, { chain, adapter: ad, resolve: () => ad, taxOf });
  let spot: number | null = null;
  const flipped = flipMarket(orig, () => spot);
  const fq = new Quoter(m, flipped, { chain, adapter: ad, resolve: () => ad, taxOf, basePerNative: async () => 0.0075 });
  return { m, orig, flipped, q, fq, setSpot: (s: number | null) => { spot = s; }, WPLS, TOK, fee: o.kind === 'v3' ? 0.0025 : FEE };
}

describe('flipMarket: swapped sides, live pool/safety, native flag follows PLS', () => {
  it('HEX/PLS: base TOK, quote native PLS (wrapped), probe from spot or reverse quote', () => {
    const w = nativeWorld({ tokDec: 8, kind: 'v2' });
    expect(w.flipped.key).toBe('pulse:PLS/TOK~');
    expect(w.flipped.base.symbol).toBe('TOK');
    expect(w.flipped.quote).toMatchObject({ symbol: 'PLS', native: true, decimals: 18 });
    expect(w.flipped.quoteKind).toBe('wrapped');
    expect(w.flipped.flipped).toBe(true);
    expect(w.flipped.flipOf).toBe('pulse:PLS/TOK');
    expect(orientation(w.flipped)).toEqual({ label: 'TOK/PLS', spends: 'PLS', stacks: 'TOK', flipped: true });
    expect(orientation(w.orig)).toEqual({ label: 'PLS/TOK', spends: 'TOK', stacks: 'PLS', flipped: false });
    expect(w.flipped.probe).toBe(0); // no cached spot → Quoter sizes it by a reverse quote
    w.setSpot(0.0075);
    expect(w.flipped.probe).toBeCloseTo(7.5, 6); // 1000 PLS × 0.0075
    // Live getters: a pool switch on the original applies to the flipped view.
    w.orig.pool = { ...w.orig.pool, feeBps: 30 };
    expect(w.flipped.pool.feeBps).toBe(30);
    expect(() => flipMarket(w.flipped)).toThrow(/already flipped/);
  });
});

describe('inverted price math + native-leg router methods (decimals matrix, both orders, V2 + V3)', () => {
  const unwrapSel = V3_ROUTER.getFunction('unwrapWETH9')!.selector;
  for (const kind of ['v2', 'v3'] as const) {
    for (const tokIsToken0 of [false, true]) {
      for (const tokDec of [8, 6, 18, 0, 24, 9]) {
        it(`${kind} TOK ${tokDec} / PLS 18 · TOK ${tokIsToken0 ? 'token0' : 'token1'}`, async () => {
          const w = nativeWorld({ tokDec, kind, tokIsToken0 });
          const f1 = 1 - w.fee;
          const origPx = await w.q.getPrice(); // TOK per PLS
          const flipPx = await w.fq.getPrice(); // PLS per TOK
          if (tokDec > 0) expect(origPx / (0.0075 * f1)).toBeCloseTo(1, 3);
          else expect(origPx).toBe(Math.floor(1000 * 0.0075 * f1) / 1000); // whole TOK units out of a 1000 PLS probe
          if (tokDec > 0) expect(flipPx / ((1 / 0.0075) * f1)).toBeCloseTo(1, 3);
          else expect(flipPx / ((1 / 0.0075) * f1)).toBeGreaterThan(0.999); // whole-unit probe, still exact for the units quoted
          // Inverse relation: flipped ≈ 1/original up to one fee each way.
          if (tokDec > 0) {
            expect(flipPx * origPx).toBeGreaterThan(f1 * f1 * 0.999);
            expect(flipPx * origPx).toBeLessThan(1.0001);
          }
          // Flipped BUY: spend 1000 PLS (native, msg.value) for TOK
          const buy = await w.fq.quote('buy', 1000, DEFAULT_LIMITS, ME, null);
          expect(buy.tokenIn).toBe(NATIVE);
          expect(buy.tokenOut).toBe(w.TOK.address);
          expect(buy.decimalsIn).toBe(18);
          expect(buy.decimalsOut).toBe(tokDec);
          expect(buy.amountIn).toBe(amountToUnits(1000, 18));
          expect(buy.call.value).toBe(buy.amountIn);
          expect(buy.approveAmount).toBeNull();
          if (kind === 'v2') expect(buy.call.method).toBe('swapExactETHForTokens');
          else { expect(buy.call.method).toBe('multicall'); expect((buy.call.args[1] as string[]).some((d) => d.startsWith(unwrapSel))).toBe(false); }
          const expOut = 1000 * 0.0075 * f1;
          expect(buy.quotedOutHuman).toBeLessThanOrEqual(expOut * 1.0001);
          expect(buy.quotedOutHuman).toBeGreaterThan(tokDec === 0 ? 6.99 : expOut * 0.999);
          if (tokDec >= 6) expect(buy.price / (flipPx / f1 / f1)).toBeCloseTo(1, 2); // ask ≈ bid / (1−f)²
          // Flipped SELL: the exact TOK units that arrived → PLS (unwrapped)
          const sell = await w.fq.quote('sell', buy.quotedOutHuman, DEFAULT_LIMITS, ME, 0n, { amountInUnits: buy.quotedOut });
          expect(sell.tokenIn).toBe(w.TOK.address);
          expect(sell.tokenOut).toBe(NATIVE);
          expect(sell.amountIn).toBe(buy.quotedOut);
          expect(sell.call.value).toBe(0n);
          expect(sell.approveAmount).not.toBeNull(); // TOK must be approved; PLS never is
          if (kind === 'v2') expect(sell.call.method).toBe('swapExactTokensForETH');
          else { expect(sell.call.method).toBe('multicall'); expect((sell.call.args[1] as string[]).some((d) => d.startsWith(unwrapSel))).toBe(true); }
          const rt = sell.quotedOutHuman / 1000;
          expect(rt).toBeLessThan(f1 * f1 * 1.0001);
          expect(rt).toBeGreaterThan(tokDec === 0 ? 0.9 : f1 * f1 * 0.999);
          // The classic orientation still sells PLS (native in) and buys PLS (native out).
          const cb = await w.q.quote('buy', 10, DEFAULT_LIMITS, ME, null);
          expect(cb.tokenOut).toBe(NATIVE);
          const cs = await w.q.quote('sell', 1000, DEFAULT_LIMITS, ME, null);
          expect(cs.tokenIn).toBe(NATIVE);
        });
      }
    }
  }

  it('reverse-quote probe and spot probe give the same flipped price', async () => {
    const w = nativeWorld({ tokDec: 8, kind: 'v2' });
    const a = await w.fq.getPrice();
    w.setSpot(0.0075 * (1 - FEE));
    const w2 = nativeWorld({ tokDec: 8, kind: 'v2' });
    w2.setSpot(0.0075 * (1 - FEE));
    const b = await w2.fq.getPrice();
    expect(a / b).toBeCloseTo(1, 5);
  });

  it('taxed / custom native markets use the FoT ETH variants on V2', async () => {
    const w = nativeWorld({ tokDec: 9, kind: 'v2', custom: true, buyTax: 0.02, sellTax: 0.03 });
    const buy = await w.fq.quote('buy', 1000, DEFAULT_LIMITS, ME, null);
    expect(buy.call.method).toBe('swapExactETHForTokensSupportingFeeOnTransferTokens');
    expect(buy.feeOnTransfer).toBe(true);
    expect(buy.taxOutPct).toBeCloseTo(0.02, 9); // TOK leaves the pool → its buy tax
    const sell = await w.fq.quote('sell', buy.quotedOutHuman, DEFAULT_LIMITS, ME, 0n, { amountInUnits: buy.quotedOut });
    expect(sell.call.method).toBe('swapExactTokensForETHSupportingFeeOnTransferTokens');
    expect(sell.taxInPct).toBeCloseTo(0.03, 9); // TOK sent to the pool → its sell tax
    // Leg taxes are oriented: flipped buy = base(TOK).buy, flipped sell = base(TOK).sell
    expect(w.fq.legTaxes().buy).toBeCloseTo(0.02, 9);
    expect(w.fq.legTaxes().sell).toBeCloseTo(0.03, 9);
    expect(w.fq.tokenSide).toBe('quote');
  });

  it('paper round trip on the flipped market books PLS in, PLS out', async () => {
    const w = nativeWorld({ tokDec: 8, kind: 'v2' });
    const pe = new PaperExecutor(w.fq, () => ({ pls: 0, stable: 1e6 }));
    const b = await pe.execute(await pe.quote('buy', 1000, DEFAULT_LIMITS), { canSend: () => true, onSent: () => undefined });
    const s = await pe.execute(await pe.quote('sell', b.amountOutHuman, DEFAULT_LIMITS), { canSend: () => true, onSent: () => undefined });
    expect(b.amountInHuman).toBe(1000);
    expect(s.amountOutHuman / 1000).toBeCloseTo((1 - FEE) ** 2, 3);
    expect(fromUnits(amountToUnits(b.amountOutHuman, 8), 8)).toBeCloseTo(b.amountOutHuman, 8);
  });
});

describe('inverted candles', () => {
  it('o=1/o, h=1/l, l=1/h, c=1/c; volume in the new base; double inversion restores prices', () => {
    const k: Candle[] = [{ t: 0, o: 0.008, h: 0.01, l: 0.005, c: 0.0075, v: 1000 }, { t: 3600, o: 0.0075, h: 0.0075, l: 0.0075, c: 0.0075, v: 0, f: 1 }];
    const inv = invertCandles(k);
    expect(inv[0].o).toBeCloseTo(125, 9);
    expect(inv[0].h).toBeCloseTo(200, 9); // 1 / low
    expect(inv[0].l).toBeCloseTo(100, 9); // 1 / high
    expect(inv[0].c).toBeCloseTo(1 / 0.0075, 9);
    expect(inv[0].h).toBeGreaterThanOrEqual(Math.max(inv[0].o, inv[0].c));
    expect(inv[0].l).toBeLessThanOrEqual(Math.min(inv[0].o, inv[0].c));
    expect(inv[0].v).toBeCloseTo(1000 / ((0.01 + 0.005 + 0.0075) / 3), 6);
    expect(inv[1].f).toBe(1);
    const back = invertCandles(inv);
    for (const f of ['o', 'h', 'l', 'c'] as const) expect(back[0][f]).toBeCloseTo(k[0][f], 12);
  });
  it('CandleStore: flipped key reads the inverted original series; merging on a flipped key writes the original', () => {
    const cs = new CandleStore(null);
    const k = candlesFromCloses([0.0075, 0.008, 0.007, 0.0072]);
    cs.merge('HEX', '1h', k, 'gecko', k[k.length - 1].t + 7200);
    const a = cs.get('HEX', '1h'), b = cs.get('HEX~', '1h');
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].t).toBe(a[i].t);
      expect(b[i].c).toBeCloseTo(1 / a[i].c, 9);
      expect(b[i].h).toBeCloseTo(1 / a[i].l, 9);
      expect(b[i].l).toBeCloseTo(1 / a[i].h, 9);
    }
    // Writing flipped data lands (inverted back) in the original series.
    const t = k[k.length - 1].t + 3600;
    cs.merge('HEX~', '1h', [{ t, o: 125, h: 130, l: 120, c: 128, v: 0 }], 'gecko', t + 7200);
    const last = cs.get('HEX', '1h').find((x) => x.t === t)!;
    expect(last.c).toBeCloseTo(1 / 128, 12);
    expect(last.h).toBeCloseTo(1 / 120, 12);
    expect(last.l).toBeCloseTo(1 / 130, 12);
  });
});

describe('gas reserve', () => {
  it('reserve = max(pct × capital, fixed); defaults 2 %; parse + validate', () => {
    expect(DEFAULT_GAS_RESERVE).toEqual({ pct: 0.02, fixed: 0 });
    expect(gasReserve(1_000_000)).toBeCloseTo(20_000, 9);
    expect(gasReserve(1_000_000, { pct: 0.02, fixed: 50_000 })).toBe(50_000);
    expect(reserveCfg({ gasReservePct: 0.05 })).toEqual({ pct: 0.05, fixed: 0 });
    expect(reserveCfg(null)).toEqual(DEFAULT_GAS_RESERVE);
    expect(parseGasRes('2%')).toEqual({ pct: 0.02, fixed: 0 });
    expect(parseGasRes('50000')).toEqual({ pct: 0, fixed: 50_000 });
    expect(parseGasRes('3% 1000')).toEqual({ pct: 0.03, fixed: 1000 });
    expect(parseGasRes('')).toEqual(DEFAULT_GAS_RESERVE);
    expect(parseGasRes('60%')).toBeNull();
    expect(parseGasRes('abc')).toBeNull();
    expect(validateLimits({ ...DEFAULT_LIMITS, gasReservePct: 0.6 })).toEqual(['Gas reserve must be 0–50% of capital.']);
    expect(validateLimits({ ...DEFAULT_LIMITS, gasReservePct: 0.02, gasReserveNative: 100 })).toEqual([]);
  });
  it('checkGasReserve blocks when capital + reserve (+ allocated) exceeds the balance', () => {
    expect(checkGasReserve({ capital: 980, balance: 1000, symbol: 'PLS' }).ok).toBe(true); // 980 + 19.6
    const bad = checkGasReserve({ capital: 990, balance: 1000, symbol: 'PLS' });
    expect(bad.ok).toBe(false);
    expect(bad.need).toBeCloseTo(990 * 1.02, 9);
    expect(bad.reason).toMatch(/PLS balance .* gas reserve/);
    const alloc = checkGasReserve({ capital: 500, balance: 1000, allocated: 600, symbol: 'PLS' });
    expect(alloc.ok).toBe(false);
    expect(alloc.reason).toMatch(/other live bots/);
  });
});

// ── MultiBot on the legacy PulseX V2 mock: HEX has 8 decimals, WPLS is token0 of the HEX pair ─────────────────
const P0 = 0.00001; // DAI per PLS
const QH = 0.0075; // HEX per PLS → HEX/PLS ≈ 133.3
function make(o: { chain?: MockChain; store?: MemoryStore<MultiState>; live?: boolean; candles?: CandleStore; clock?: { ms: number } } = {}) {
  const chain = o.chain ?? (() => { const c = new MockChain(P0, { quoteDepth: 100_000_000 }); c.setPrice(QH, 'HEX'); return c; })();
  const store = o.store ?? new MemoryStore<MultiState>();
  const clock = o.clock;
  const bot = new MultiBot({
    net: NET, reader: chain, signer: o.live ? chain : null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0,
    ...(o.candles ? { candles: o.candles } : {}), ...(clock ? { now: () => clock.ms, activity: new ActivityBus(400, () => clock.ms) } : {}),
  });
  return { chain, store, bot };
}
const flipMid = () => 1 / QH;

describe('flipped grid (HEX/PLS): paper fills and PnL in PLS', () => {
  it('buys spend PLS for HEX on dips, sells only that level\'s HEX lot for PLS; realized PnL > 0 in PLS', async () => {
    const { chain, bot } = make();
    const mid = flipMid();
    const id = await bot.add({ mode: 'paper', stable: 'HEX~', lowerPrice: mid * 0.9, upperPrice: mid * 1.1, gridCount: 10, totalCapitalUsd: 1_000_000 });
    let g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.flipped).toBe(true);
    expect(g.label).toBe('HEX/PLS');
    expect(g.spends).toBe('PLS');
    expect(g.stacks).toBe('HEX');
    expect(g.pairKey).toBe('HEX');
    expect(g.price! / (mid * (1 - FEE))).toBeCloseTo(1, 3); // PLS per HEX, not HEX per PLS
    expect(g.gasReserve).toBeCloseTo(20_000, 6); // 2 % of 1M PLS, shown for native-quote grids (enforced on live start)
    // HEX/PLS falls 3 % (= HEX per PLS rises 3 %) → buys
    chain.setPrice(QH / 0.97, 'HEX');
    await bot.tickAll();
    g = bot.status().grids.find((x) => x.id === id)!;
    const buys = g.trades.filter((t: { side: string; failed?: boolean }) => t.side === 'buy' && !t.failed);
    expect(buys.length).toBeGreaterThanOrEqual(1);
    for (const b of buys) {
      expect(b.stable).toBe('HEX~');
      expect(b.stableAmount).toBeGreaterThan(50_000); // PLS spent (~100k PLS per level)
      expect(b.plsAmount).toBeGreaterThan(300); // HEX received (~750 HEX per level)
      expect(b.price).toBeGreaterThan(100); // PLS per HEX
      expect(b.price).toBeLessThan(200);
      expect(b.stableAmount / b.plsAmount).toBeCloseTo(b.price, 6);
    }
    const heldAfterBuys = g.pnl.plsHeld; // HEX held by the grid
    expect(heldAfterBuys).toBeCloseTo(buys.reduce((a: number, t: { plsAmount: number }) => a + t.plsAmount, 0), 6);
    // Back up 4 % → sells of those exact lots for PLS
    chain.setPrice(QH * 0.99, 'HEX');
    await bot.tickAll();
    g = bot.status().grids.find((x) => x.id === id)!;
    const sells = g.trades.filter((t: { side: string; failed?: boolean }) => t.side === 'sell' && !t.failed);
    expect(sells.length).toBeGreaterThanOrEqual(1);
    for (const s of sells) {
      const lot = buys.find((b: { intervalIndex: number }) => b.intervalIndex === s.intervalIndex)!;
      expect(lot).toBeTruthy();
      expect(s.plsAmount).toBeCloseTo(lot.plsAmount, 6); // only the HEX that level bought
      expect(s.stableAmount).toBeGreaterThan(lot.stableAmount); // more PLS back
      expect(s.realizedPnlUsd).toBeGreaterThan(0); // in PLS (the field is quote units)
    }
    expect(g.pnl.realized).toBeGreaterThan(0);
    expect(g.quoteSym).toBe('PLS');
  });
});

describe('flipped live grid on the mock: native router methods + gas reserve gate', () => {
  it('live start blocked when capital + 2 % reserve > PLS balance; allowed below it', async () => {
    const { chain, bot } = make({ live: true });
    const mid = flipMid();
    const bal = Number(chain.pls / 10n ** 18n);
    const cfg = { mode: 'live' as const, stable: 'HEX~', lowerPrice: mid * 0.9, upperPrice: mid * 1.1, gridCount: 10 };
    await expect(bot.add({ ...cfg, totalCapitalUsd: bal * 0.99 })).rejects.toThrow(/gas reserve/);
    // A fixed reserve can also block: 60 % of the balance + a fixed reserve of 50 % of it
    await expect(bot.add({ ...cfg, totalCapitalUsd: bal * 0.6, limits: { ...DEFAULT_LIMITS, gasReserveNative: bal * 0.5 } })).rejects.toThrow(/gas reserve/);
    const id = await bot.add({ ...cfg, totalCapitalUsd: 1_000_000 });
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('running');
    expect(g.gasReserve).toBeCloseTo(20_000, 6);
    // Second live bot: the first one's capital counts as allocated
    await expect(bot.add({ ...cfg, totalCapitalUsd: bal - 1_000_000 })).rejects.toThrow(/gas reserve|cover/i);
  });

  it('buy = swapExactETHForTokens with msg.value (no approve); sell = approve + swapExactTokensForETH', async () => {
    const { chain, bot } = make({ live: true });
    const mid = flipMid();
    await bot.add({ mode: 'live', stable: 'HEX~', lowerPrice: mid * 0.9, upperPrice: mid * 1.1, gridCount: 10, totalCapitalUsd: 1_000_000 });
    const pls0 = chain.pls, hex0 = chain.bal('HEX');
    chain.setPrice(QH / 0.97, 'HEX');
    await bot.tickAll();
    const buys = chain.sent.filter((s) => s.method === 'swapExactETHForTokens');
    expect(buys.length).toBeGreaterThanOrEqual(1);
    expect(chain.sent.some((s) => s.method === 'approve')).toBe(false); // spending native needs no approval
    for (const b of buys) expect(b.value).toBeGreaterThan(0n);
    expect(chain.bal('HEX')).toBeGreaterThan(hex0);
    expect(chain.pls).toBeLessThan(pls0);
    const n = chain.sent.length;
    chain.setPrice(QH * 0.99, 'HEX');
    await bot.tickAll();
    const after = chain.sent.slice(n).map((s) => s.method);
    expect(after).toContain('approve');
    expect(after).toContain('swapExactTokensForETH');
    expect(after.some((m) => m.startsWith('swapExactTokensForTokens'))).toBe(false);
    const g = bot.status().grids[0];
    expect(g.pnl.realized).toBeGreaterThan(0);
  });
});

describe('flipped trend bot: long the token, flat in PLS', () => {
  it('enters HEX with PLS on an up-cross of HEX/PLS (inverted candles) and exits back to PLS', async () => {
    const H = 3600, T0 = Math.floor(1_791_000_000 / H) * H;
    const clock = { ms: (T0 + 10) * 1000 };
    const candles = new CandleStore(null);
    const { chain, bot } = make({ candles, clock });
    candles.merge('HEX', '1h', Array.from({ length: 10 }, (_, i) => ({ t: T0 - (10 - i) * H, o: QH, h: QH, l: QH, c: QH, v: 0 })), 'gecko', T0 + 10);
    const CFG = { strategy: 'ema' as const, fast: 2, slow: 3, atrPeriod: 2, stopAtr: 1, tpR: 2, trailAtr: 0, cooldownBars: 0, sizePct: 100 };
    const id = await bot.addTrend({ mode: 'paper', quote: 'HEX~', tf: '1h', cfg: CFG, capital: 100_000 });
    await bot.tickAll();
    let t = bot.status().trends.find((x) => x.id === id)!;
    expect(t.flipped).toBe(true);
    expect(t.spends).toBe('PLS');
    expect(t.stacks).toBe('HEX');
    expect(t.position).toBeNull();
    // Original HEX-per-PLS drops 10 % → HEX/PLS rises ≈ 11 % → EMA cross up on the flipped series
    const q1 = QH / 1.1;
    clock.ms = (T0 + H + 10) * 1000;
    candles.merge('HEX', '1h', [{ t: T0, o: QH, h: QH, l: q1, c: q1, v: 0 }], 'gecko', T0 + H + 10);
    chain.setPrice(q1, 'HEX');
    await bot.tickAll();
    t = bot.status().trends.find((x) => x.id === id)!;
    expect(t.position).not.toBeNull();
    expect(t.cash).toBeCloseTo(0, 6); // all PLS spent
    expect(t.trades[0]).toMatchObject({ side: 'buy', reason: 'entry' });
    expect(t.position!.risk.entry).toBeGreaterThan(100); // PLS per HEX
    const hexHeld = t.position!.qty ?? t.position!.pls ?? t.position!.amount;
    expect(hexHeld).toBeGreaterThan(650); // ≈ 100k PLS / 146.7 PLS per HEX ≈ 680 HEX
    expect(hexHeld).toBeLessThan(700);
    // Crash HEX/PLS below the stop → exit back to PLS
    const q2 = QH * 1.3;
    chain.setPrice(q2, 'HEX');
    await bot.tickAll();
    t = bot.status().trends.find((x) => x.id === id)!;
    expect(t.position).toBeNull();
    expect(t.cash).toBeGreaterThan(50_000);
    expect(t.cash).toBeLessThan(100_000);
  });
});

describe('flipped backtest: inverted candles, no look-ahead', () => {
  const orig = candlesFromCloses(wavePath(500, QH));
  const c = { ...DEFAULT_TREND, fast: 5, slow: 20, cooldownBars: 0, tpR: 0, stopAtr: 3, minEdgePct: 0, expectedMoveAtr: 5 };
  const FEE_ONLY = { feeBps: 29, pool: null, gasPricePls: 0, approval: 'exact' as const, slippageBps: 0 };
  it('trend backtest on the flipped series trades; changing the future never changes the past', () => {
    const k = invertCandles(orig);
    const base = runTrendBacktest(k, c, '1h', { capital: 100_000, costs: FEE_ONLY });
    expect(base.trades.length).toBeGreaterThan(2);
    for (const t of base.trades) expect(t.entryPrice).toBeGreaterThan(50); // PLS per HEX
    for (const m of [150, 260, 400]) {
      const futureOrig = orig.slice(m).map((x, j) => ({ ...x, o: x.o * (j % 2 ? 3 : 0.3), h: x.h * 3, l: x.l * 0.3, c: x.c * (j % 3 ? 0.5 : 2) }));
      const alt = runTrendBacktest(invertCandles([...orig.slice(0, m), ...futureOrig]), c, '1h', { capital: 100_000, costs: FEE_ONLY });
      const cut = orig[m].t;
      expect(alt.trades.filter((t) => t.exitT < cut)).toEqual(base.trades.filter((t) => t.exitT < cut));
      expect(alt.equity.filter((e) => e.t < cut)).toEqual(base.equity.filter((e) => e.t < cut));
    }
  });
  it('MultiBot backtests HEX~ on the inverted HEX candles (capital in PLS)', async () => {
    const H = 3600;
    const last = orig[orig.length - 1].t;
    const clock = { ms: (last + 2 * H) * 1000 };
    const candles = new CandleStore(null);
    candles.merge('HEX', '1h', orig, 'gecko', last + 2 * H);
    const { bot } = make({ candles, clock });
    const flipSeries = bot.candleSeries('HEX~', '1h');
    const origSeries = bot.candleSeries('HEX', '1h');
    expect(flipSeries).toHaveLength(origSeries.length);
    expect(flipSeries[10].c).toBeCloseTo(1 / origSeries[10].c, 9);
    const r = await bot.backtest({ pair: 'HEX~', tf: '1h', capital: 100_000, cfg: c, costs: { useImpact: false, useGas: false, slippageBps: 0 } });
    expect(r.candles).toBeGreaterThan(400);
    expect(r.capital).toBe(100_000);
    for (const t of r.trades) expect(t.entryPrice).toBeGreaterThan(50);
    const g = await bot.backtestGrid({ pair: 'HEX~', tf: '1h', lowerPrice: 100, upperPrice: 170, gridCount: 10, capital: 100_000, costs: { useImpact: false, useGas: false, slippageBps: 0 } });
    expect(g.candles).toBe(r.candles);
  });
});

describe('state migration: existing grids keep their orientation', () => {
  it('a persisted "HEX" grid reloads as PLS/HEX (spends HEX); a "HEX~" grid reloads as HEX/PLS', async () => {
    const store = new MemoryStore<MultiState>();
    const a = make({ store });
    const mid = flipMid();
    const classic = await a.bot.add({ mode: 'paper', stable: 'HEX', lowerPrice: QH * 0.9, upperPrice: QH * 1.1, gridCount: 10, totalCapitalUsd: 5_000 });
    const flipped = await a.bot.add({ mode: 'paper', stable: 'HEX~', lowerPrice: mid * 0.9, upperPrice: mid * 1.1, gridCount: 10, totalCapitalUsd: 500_000 });
    // Simulate a pre-flip state file: no orientation fields anywhere, just the quote key.
    const saved = JSON.parse(JSON.stringify(store.load()));
    for (const g of saved.grids) for (const k of Object.keys(g)) if (/flip|orient/i.test(k)) delete g[k];
    const store2 = new MemoryStore<MultiState>();
    store2.save(saved);
    const b = make({ store: store2, chain: a.chain });
    const st = b.bot.status().grids;
    const c = st.find((g) => g.id === classic)!, f = st.find((g) => g.id === flipped)!;
    expect(c).toMatchObject({ flipped: false, label: 'PLS/HEX', spends: 'HEX', stacks: 'PLS', stable: 'HEX' });
    expect(f).toMatchObject({ flipped: true, label: 'HEX/PLS', spends: 'PLS', stacks: 'HEX', stable: 'HEX~' });
    expect(c.config.lowerPrice).toBeCloseTo(QH * 0.9, 12);
    expect(f.config.lowerPrice).toBeCloseTo(mid * 0.9, 9);
  });
});

describe('flipped presets: "Stack … with PLS" pass the start gate', () => {
  it('lists the three stack presets as flipped with ±12 % × 12', () => {
    const ps = listPresets();
    for (const id of ['stack-hex', 'stack-plsx', 'stack-ehex']) {
      const p = ps.find((x) => x.id === id)!;
      expect(p.flipped).toBe(true);
      expect(getPreset(id).legs[0]).toMatchObject({ flip: true, bandPct: 0.12, gridCount: 12 });
      expect(legKey(getPreset(id).legs[0], 'DAI')).toMatch(/~$/);
    }
  });
  for (const id of ['stack-hex', 'stack-plsx', 'stack-ehex']) {
    it(`${id}: preview ok (USD → PLS capital, range in PLS per token) and paper start runs flipped`, async () => {
      const chain = new MockChain(P0, { quoteDepth: 10_000_000_000 }); // deep pools like the real HEX/PLSX/eHEX ones
      chain.setPrice(QH, 'HEX');
      chain.setPrice(0.0075, 'eHEX');
      chain.setPrice(1.5, 'PLSX');
      const { bot } = make({ chain });
      const pv = await bot.previewPreset(id);
      expect(pv.ok, JSON.stringify(pv.legs.map((l) => l.econ.reasons))).toBe(true);
      const leg = pv.legs[0];
      expect(isFlipKey(leg.quote)).toBe(true);
      expect(leg.label).toMatch(/\/PLS$/);
      // $100 at the DAI/PLS quote (0.00001 × (1 − fee)) ≈ 10.03M PLS of capital
      expect(leg.totalCapitalUsd / (100 / (P0 * (1 - FEE)))).toBeCloseTo(1, 4);
      const spot = pv.spots[leg.quote];
      expect(leg.lowerPrice).toBeCloseTo(spot * 0.88, 6);
      expect(leg.upperPrice).toBeCloseTo(spot * 1.12, 6);
      const { ids } = await bot.startPreset(id, { mode: 'paper' });
      const g = bot.status().grids.find((x) => x.id === ids[0])!;
      expect(g).toMatchObject({ flipped: true, spends: 'PLS', status: 'running' });
    });
  }
});
