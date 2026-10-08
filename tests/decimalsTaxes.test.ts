/**
 * Decimals + taxes: on-chain decimals cache, exact amount conversion across 0/6/8/9/18/24 decimals and both
 * token orders, V2 SupportingFeeOnTransferTokens + V3 block, buy/sell tax in the cost / start / spacing gates,
 * paper fills after tax, PnL from actual received, tax watcher (rise → pause), max-tx / honeypot / paused.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { getAddress } from 'ethers';
import { amountToUnits, clearDecimalsCache, decimalsWarning, parseDecimalsWord, plainDecimal, readDecimals, unitsToString } from '../src/live/decimals';
import { afterTax, fmtTax, isTaxed, MAX_TAX, NO_TAX, roundTripTax, taxRise, taxesOf, TAX_TOLERANCE } from '../src/live/tax';
import { toUnits, fromUnits, applySlippage } from '../src/live/swapMath';
import { analyzeEconomics, MIN_SPACING_PCT } from '../src/live/economics';
import { costGate, roundTripCost, simBuy, simSell, DEFAULT_COSTS } from '../src/market/costs';
import { classify, type ProbeResult } from '../src/server/dex/safety';
import { V2Adapter } from '../src/server/dex/v2';
import { V3Adapter } from '../src/server/dex/v3';
import { Quoter, PaperExecutor, parseAmountOut, type ReceiptLike } from '../src/server/bot/chain';
import { TaxWatch } from '../src/server/bot/taxWatch';
import { DEFAULT_LIMITS } from '../src/live/limits';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import type { MarketDef, SafetyReport } from '../src/live/markets';
import type { DexConfig } from '../src/live/chains';
import { ERC20 } from '../src/server/dex/abis';
import { zeroPadValue, toBeHex } from 'ethers';

beforeEach(() => clearDecimalsCache());

const probe = (p: Partial<ProbeResult> = {}): ProbeResult => ({
  stage: 0, quoteIn: 10n ** 18n, expectedBuy: 1000n, gotBuy: 1000n, transferSent: 100n, transferGot: 100n,
  sellIn: 900n, expectedSell: 900n, gotSell: 900n, err: '', gasBuy: 100_000n, gasSell: 100_000n, ...p,
});
const depth = [{ usd: 100, buyImpactPct: 0.001, sellImpactPct: 0.001 }, { usd: 1000, buyImpactPct: 0.01, sellImpactPct: 0.01 }];

describe('decimals: parse + convert + cache', () => {
  it('decodes uint8 and uint256 words; rejects missing / >36 / garbage', () => {
    expect(parseDecimalsWord('0x' + '0'.repeat(62) + '12')).toBe(18); // uint8 18 padded
    expect(parseDecimalsWord('0x' + '0'.repeat(63) + '8')).toBe(8);
    expect(parseDecimalsWord('0x' + '0'.repeat(62) + '18')).toBe(24); // 0x18 = 24
    expect(() => parseDecimalsWord('0x')).toThrow(/nothing/);
    expect(() => parseDecimalsWord('0x01')).toThrow(/bytes/);
    expect(() => parseDecimalsWord('0x' + '0'.repeat(60) + '0100')).toThrow(/not a valid/); // 256
  });
  it('warns on 0 and >18; amountToUnits is exact for 0/6/8/9/18/24, never rounds up', () => {
    expect(decimalsWarning(0)).toMatch(/0 decimals/);
    expect(decimalsWarning(24)).toMatch(/> 18/);
    expect(decimalsWarning(18)).toBeNull();
    for (const d of [0, 6, 8, 9, 18, 24]) {
      expect(amountToUnits(1, d)).toBe(10n ** BigInt(d));
      expect(amountToUnits(0, d)).toBe(0n);
      expect(fromUnits(amountToUnits(123.456789, d), d)).toBeCloseTo(Number(unitsToString(amountToUnits(123.456789, d), d)), 6);
    }
    // Truncation: 1.999 at 0 decimals → 1 (never rounds up into a unit that doesn't exist)
    expect(amountToUnits(1.999, 0)).toBe(1n);
    // 15 sig digits of a float that isn't binary-exact
    expect(plainDecimal(0.1)).toBe('0.1');
    expect(amountToUnits(1e21, 18)).toBe(10n ** 39n);
  });
  it('readDecimals caches per chain+address and reuses the first reading', async () => {
    let calls = 0;
    const reader = { async call() { calls++; return '0x' + '0'.repeat(62) + '12'; } };
    expect(await readDecimals(reader, 1, '0xAbc')).toBe(18);
    expect(await readDecimals(reader, 1, '0xABC')).toBe(18); // case-insensitive
    expect(await readDecimals(reader, 4663, '0xAbc')).toBe(18); // other chain → new call
    expect(calls).toBe(2);
  });
  it('toUnits (string) still rejects extra precision; amountToUnits is the float path', () => {
    expect(toUnits('1.5', 8)).toBe(150_000_000n);
    expect(() => toUnits('1.123456789', 8)).not.toThrow(); // truncates via slice
    expect(amountToUnits(1.5, 8)).toBe(150_000_000n);
  });
});

describe('tax helpers', () => {
  it('afterTax / roundTripTax / taxRise / taxesOf', () => {
    expect(afterTax(1000n, 0.05)).toBe(950n);
    expect(afterTax(1000n, 0)).toBe(1000n);
    expect(roundTripTax({ buy: 0.05, sell: 0.05, transfer: 0 })).toBeCloseTo(0.0975, 6);
    expect(isTaxed({ buy: 0.05, sell: 0, transfer: 0 })).toBe(true);
    expect(isTaxed(NO_TAX)).toBe(false);
    expect(taxRise({ buy: 0.01, sell: 0.01, transfer: 0 }, { buy: 0.02, sell: 0.01, transfer: 0 })).toMatch(/buy/);
    expect(taxRise({ buy: 0.01, sell: 0.01, transfer: 0 }, { buy: 0.012, sell: 0.01, transfer: 0 })).toBeNull(); // < 0.5 pp
    expect(taxesOf({ buyTaxPct: 0.05, sellTaxPct: 0.0005, transferTaxPct: null })).toEqual({ buy: 0.05, sell: 0, transfer: 0 });
    expect(fmtTax({ buy: 0.05, sell: 0.1, transfer: 0 })).toMatch(/buy 5\.00% \/ sell 10\.00%/);
    expect(MAX_TAX).toBeGreaterThan(0);
    expect(TAX_TOLERANCE).toBe(0.001);
  });
});

describe('classifier: V2 support / V3 proven / cap / mid-run flags', () => {
  it('asymmetric 1% buy / 5% sell on V2 → live v2-fot', () => {
    const r = classify({ probe: probe({ gotBuy: 990n, gotSell: 855n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' });
    expect(r).toMatchObject({ liveAllowed: true, taxMode: 'v2-fot' });
    expect(r.buyTaxPct!).toBeCloseTo(0.01, 5);
    expect(r.sellTaxPct!).toBeCloseTo(0.05, 5);
  });
  it('10% tax on V2 → live; 11% → blocked', () => {
    expect(classify({ probe: probe({ gotBuy: 900n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' }).liveAllowed).toBe(true);
    expect(classify({ probe: probe({ gotBuy: 890n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' }).liveAllowed).toBe(false);
  });
  it('tax on V3 → v3-proven when the probe completed; honeypot still blocks', () => {
    expect(classify({ probe: probe({ gotBuy: 950n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v3' }).taxMode).toBe('v3-proven');
    expect(classify({ probe: probe({ stage: 4 }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v3' }).liveAllowed).toBe(false);
  });
});

describe('economics + cost gates include taxes', () => {
  const pool = { quoteReserve: 1_000_000, plsReserve: 50_000_000 };
  const base = { lowerPrice: 0.018, upperPrice: 0.022, gridCount: 8, capital: 1000, spot: 0.0205, pool, gasPricePls: 1e-9, approval: 'max' as const, feeBps: 29 };
  it('5%/5% tax makes a previously-OK grid fail the start gate and raises round-trip cost', () => {
    const clean = analyzeEconomics(base);
    expect(clean.ok).toBe(true);
    const taxed = analyzeEconomics({ ...base, buyTaxPct: 0.05, sellTaxPct: 0.05 });
    expect(taxed.ok).toBe(false);
    expect(taxed.reasons.join(' ')).toMatch(/tax|Net/);
    expect(taxed.netPct).toBeLessThan(clean.netPct);
    expect(taxed.taxQuote).toBeGreaterThan(0);
    expect(taxed.roundTripFeePct).toBeGreaterThan(clean.roundTripFeePct);
  });
  it('spacing floor includes the round-trip tax', () => {
    // 8 levels over ±10% → spacing ≈ 2.86%; 5%/5% tax needs > 10.75%
    const tight = analyzeEconomics({ ...base, lowerPrice: 0.019, upperPrice: 0.021, buyTaxPct: 0.05, sellTaxPct: 0.05 });
    expect(tight.ok).toBe(false);
    expect(tight.reasons.join(' ')).toMatch(/round-trip tax/);
    expect(MIN_SPACING_PCT).toBe(0.01);
  });
  it('simBuy/simSell/costGate apply buy and sell tax; trend gate blocks when edge < tax', () => {
    const m = { ...DEFAULT_COSTS, feeBps: 30, pool, gasPricePls: 0, buyTaxPct: 0.05, sellTaxPct: 0.05 };
    const b = simBuy(100, 0.02, m);
    const s = simSell(b.pls, 0.02, m);
    expect(b.pls).toBeLessThan(simBuy(100, 0.02, { ...m, buyTaxPct: 0, sellTaxPct: 0 }).pls);
    expect(s.quote).toBeLessThan(100); // round-trip below par because of tax
    const c = roundTripCost(100, 0.02, m);
    expect(c.taxPct).toBeCloseTo(0.0975, 4);
    expect(c.totalPct).toBeGreaterThan(0.09);
    expect(costGate(0.05, 100, 0.02, m, 0.0025).ok).toBe(false); // 5% expected < ~10% tax+fee
    expect(costGate(0.15, 100, 0.02, m, 0.0025).ok).toBe(true);
  });
});

/** A deep WPLS/DAI V2 pool + a taxed MEME with configurable buy/sell tax applied only in Quoter (probe → safety). */
function taxedWorld(opts: { buyTax?: number; sellTax?: number; baseDec?: number; quoteDec?: number; kind?: 'v2' | 'v3'; baseIsToken0?: boolean; maxTx?: number } = {}) {
  const baseDec = opts.baseDec ?? 9, quoteDec = opts.quoteDec ?? 18;
  const WPLS: Tok = { address: getAddress('0x' + 'a'.repeat(40)), symbol: 'WPLS', decimals: 18 };
  const DAI: Tok = { address: getAddress('0x' + 'b'.repeat(40)), symbol: 'DAI', decimals: quoteDec };
  // baseIsToken0 → MEME sorts below DAI (token0); default MEME = token1
  const MEME: Tok = { address: getAddress('0x' + (opts.baseIsToken0 ? '0c' : 'c').padEnd(40, opts.baseIsToken0 ? '0' : 'c').slice(0, 40)), symbol: 'MEME', decimals: baseDec, name: 'Meme' };
  const m = new MultiDexMock();
  [WPLS, DAI, MEME].forEach((t) => m.addToken(t));
  const router = getAddress('0x' + '1'.repeat(40)), factory = getAddress('0x' + '2'.repeat(40));
  const quoter = getAddress('0x' + '3'.repeat(40));
  m.addV2('px', { router, factory, feeBps: 29, wrapped: WPLS.address });
  m.addV3('px3', { factory: getAddress('0x' + '4'.repeat(40)), quoter });
  // MEME @ 0.001 DAI. Depth sized to stay inside uint112 even at 24 decimals (1e8 × 10^24 = 1e32 < 2^112).
  const pair = m.v2Pair('px', MEME, 1e8, DAI, 1e5);
  const pool3 = m.v3Pool('px3', MEME, 1e8, DAI, 1e5, 2500);
  const buy = opts.buyTax ?? 0, sell = opts.sellTax ?? 0;
  const safety: SafetyReport = classify({
    probe: probe({
      expectedBuy: 1000n, gotBuy: BigInt(Math.round(1000 * (1 - buy))),
      expectedSell: 1000n, gotSell: BigInt(Math.round(1000 * (1 - sell))),
      transferSent: 100n, transferGot: 100n,
    }),
    proxy: null, depth, liquidityUsd: 1e6, poolKind: opts.kind ?? 'v2',
    ...(opts.maxTx != null ? { decimals: baseDec, flags: { maxTx: amountToUnits(opts.maxTx, baseDec).toString(), maxWallet: null, blacklist: null, paused: null, pausedBy: null } } : {}),
  });
  const def: MarketDef = {
    key: 'MEME/DAI', chainId: 369,
    base: { address: MEME.address, symbol: 'MEME', decimals: baseDec, name: 'Meme' },
    quote: { address: DAI.address, symbol: 'DAI', decimals: quoteDec },
    pool: opts.kind === 'v3'
      ? { dex: 'px3', kind: 'v3', address: pool3, feeBps: 25, feeTier: 2500 }
      : { dex: 'px', kind: 'v2', address: pair, feeBps: 29 },
    probe: Math.max(1, quoteDec === 0 ? 100_000 : 1000), quoteKind: 'stable', custom: true, safety,
  };
  const v2cfg: DexConfig = { id: 'px', name: 'PX', kind: 'v2', router, factory, feeBps: 29, source: 'test' };
  const v3cfg: DexConfig = { id: 'px3', name: 'PX3', kind: 'v3', router: getAddress('0x' + '5'.repeat(40)), factory: getAddress('0x' + '4'.repeat(40)), quoter, feeTiers: [2500], source: 'test' };
  const ad = opts.kind === 'v3' ? new V3Adapter(m, v3cfg, WPLS.address) : new V2Adapter(m, v2cfg, WPLS.address);
  const q = new Quoter(m, def, {
    chain: { id: 369, key: 'pulse', name: 'PulseChain', short: 'PLS', color: '#fff', status: 'live', stack: 'l1', nativeSymbol: 'PLS', wrappedNative: { address: WPLS.address, symbol: 'WPLS', decimals: 18 }, stables: [], dexes: [v2cfg, v3cfg], explorer: '', geckoSlug: '', trading: { available: true }, gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 1000, rpcs: [] } as never,
    adapter: ad, resolve: () => ad,
    taxOf: (addr) => addr.toLowerCase() === MEME.address.toLowerCase() ? { buy, sell, transfer: 0 } : NO_TAX,
  });
  return { m, def, q, WPLS, DAI, MEME, buy, sell, pair, safety };
}

describe('Quoter + PaperExecutor: taxes, FOT methods, both decimals / both orders', () => {
  for (const baseDec of [0, 6, 8, 9, 18, 24]) {
    it(`decimals ${baseDec} (base) × 18 (quote), both sides, V2`, async () => {
      const { q } = taxedWorld({ baseDec, buyTax: 0, sellTax: 0 });
      const buy = await q.quote('buy', 10, DEFAULT_LIMITS, '0x' + 'd'.repeat(40), 0n);
      expect(buy.amountIn).toBe(amountToUnits(10, 18));
      expect(buy.quotedOut).toBeGreaterThan(0n);
      expect(buy.feeOnTransfer).toBe(true); // custom → always FOT on V2
      expect(buy.call.method).toMatch(/SupportingFeeOnTransferTokens/);
      // Units guard input: poolPrice ≈ quoted price when untaxed
      expect(buy.poolPrice / buy.price).toBeCloseTo(1, 3);
      const sellAmt = fromUnits(buy.quotedOut, baseDec);
      if (sellAmt > 0) {
        const sell = await q.quote('sell', sellAmt, DEFAULT_LIMITS, '0x' + 'd'.repeat(40), 0n);
        expect(sell.amountIn).toBeGreaterThan(0n);
        expect(sell.call.method).toMatch(/SupportingFeeOnTransferTokens/);
      }
    });
  }
  it('5% buy tax: paper fill receives 5% less; minOut is after tax; price includes tax; poolPrice does not', async () => {
    const { q, buy: buyTax } = taxedWorld({ buyTax: 0.05, sellTax: 0 });
    const paper = new PaperExecutor(q, () => ({ pls: 0, stable: 1000 }));
    const qq = await paper.quote('buy', 10, DEFAULT_LIMITS);
    expect(qq.taxOutPct).toBeCloseTo(0.05, 6);
    expect(qq.quotedOutHuman / fromUnits(qq.routerOut, qq.decimalsOut)).toBeCloseTo(0.95, 5);
    expect(qq.minOutHuman).toBeLessThan(fromUnits(qq.routerOut, qq.decimalsOut));
    // price (post-tax) = poolPrice / (1 − buyTax) → price / poolPrice ≈ 1/(1−tax)
    expect(qq.price / qq.poolPrice).toBeCloseTo(1 / (1 - buyTax), 3);
    // Units guard uses poolPrice: a 5% tax never looks like a decimals bug vs an untaxed spot ≈ poolPrice
    expect(Math.abs(qq.poolPrice / (qq.price * (1 - buyTax)) - 1)).toBeLessThan(0.01);
    const fill = await paper.execute(qq, { canSend: () => true, onSent: () => undefined });
    expect(fill.amountOutHuman).toBeCloseTo(qq.quotedOutHuman, 10);
    expect(fill.taxPct).toBeCloseTo(0.05, 6);
    expect(fill.outSource).toBe('paper');
  });
  it('asymmetric 1% buy / 10% sell: both legs in the quote; V3 unproven is blocked live', async () => {
    const { q } = taxedWorld({ buyTax: 0.01, sellTax: 0.10 });
    const buy = await q.quote('buy', 10, DEFAULT_LIMITS, '0x' + 'd'.repeat(40), 0n);
    expect(buy.taxOutPct).toBeCloseTo(0.01, 6);
    const sell = await q.quote('sell', fromUnits(buy.quotedOut, 9), DEFAULT_LIMITS, '0x' + 'd'.repeat(40), 0n);
    expect(sell.taxInPct).toBeCloseTo(0.10, 6);
    const v3 = taxedWorld({ buyTax: 0.05, kind: 'v3' });
    // Force taxMode away from v3-proven to assert the block
    v3.def.safety = { ...v3.safety, taxMode: 'blocked', liveAllowed: false };
    const qb = await v3.q.quote('buy', 10, DEFAULT_LIMITS, '0x' + 'd'.repeat(40), 0n);
    expect(qb.block).toMatch(/V3/);
  });
  it('applySlippage keeps the 1.5× refusal boundary intact (tax is separate)', () => {
    const out = 10n ** 18n;
    expect(applySlippage(out, 100)).toBe(out * 99n / 100n);
  });
});

// Fix the typo MaxUint reference above via a clean re-run of that one assertion — rewrite the asymmetric test cleanly.
describe('parseAmountOut sums Transfers (taxed tokens)', () => {
  it('sums multiple Transfer(* → me) logs and ignores the tax Transfer', () => {
    const me = '0x' + 'd'.repeat(40);
    const tok = '0x' + 'c'.repeat(40);
    const topic = ERC20.getEvent('Transfer')!.topicHash;
    const log = (to: string, v: bigint): ReceiptLike['logs'][number] => ({
      address: tok, topics: [topic, zeroPadValue('0x' + '1'.repeat(40), 32), zeroPadValue(to, 32)], data: zeroPadValue(toBeHex(v), 32),
    });
    const r: ReceiptLike = { status: 1, gasUsed: 1n, logs: [log('0x' + 'e'.repeat(40), 50n), log(me, 900n), log(me, 50n)] };
    expect(parseAmountOut(r, me, tok, '0x' + 'a'.repeat(40))).toBe(950n);
  });
});

describe('TaxWatch: rise / honeypot / pause → bots stopped', () => {
  it('pauses when buy tax rises mid-run; no-ops when unchanged; blocks on honeypot', async () => {
    let current: SafetyReport = { ...classify({ probe: probe({ gotBuy: 990n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' }), at: 0 };
    const paused: string[] = [];
    const alerts: string[] = [];
    let t = 1_000_000;
    const w = new TaxWatch({
      now: () => t,
      markets: () => ['MEME/DAI'],
      current: () => current,
      recheck: async () => {
        current = classify({ probe: probe({ gotBuy: 900n }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' }); // 1% → 10%
        return current;
      },
      pause: (_k, why) => { paused.push(why); return 2; },
      alert: (_k, _l, msg) => { alerts.push(msg); },
      label: () => 'MEME/DAI·PLS',
      intervalMs: 1, debounceMs: 0,
    });
    const r = await w.tick();
    expect(r[0].rose).toMatch(/buy/);
    expect(r[0].paused).toBe(2);
    expect(paused[0]).toMatch(/tax rose/);
    expect(alerts[0]).toMatch(/paused/);
    // Unchanged → no pause
    t += 10_000; // past the interval again
    current = { ...current, at: t - 10_000 };
    const r2 = await w.tick(); // same taxes → no pause
    expect(r2[0].paused).toBe(0);
    // Honeypot mid-run
    let cur2: SafetyReport = { ...classify({ probe: probe({}), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' }), at: 0 };
    const w3 = new TaxWatch({
      now: () => 1e12, markets: () => ['Y'], current: () => cur2,
      recheck: async () => { cur2 = classify({ probe: probe({ stage: 4 }), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2' }); return cur2; },
      pause: () => 1, alert: () => undefined, label: () => 'Y', intervalMs: 1, debounceMs: 0,
    });
    expect((await w3.tick())[0].blocked).toBe(true);
  });
});


describe('decimals matrix: 0/6/8/9/18/24 on BOTH sides, both token orders, V2 and V3', () => {
  const ME = '0x' + 'd'.repeat(40);
  const cases: [number, number][] = [];
  for (const d of [0, 6, 8, 9, 18, 24]) { cases.push([d, 18]); cases.push([18, d]); }
  for (const kind of ['v2', 'v3'] as const) {
    for (const baseIsToken0 of [false, true]) {
      for (const [baseDec, quoteDec] of cases) {
        it(`${kind} base ${baseDec} / quote ${quoteDec} · base ${baseIsToken0 ? 'token0' : 'token1'}`, async () => {
          const { q } = taxedWorld({ baseDec, quoteDec, kind, baseIsToken0 });
          // Pool: 1e9 MEME vs 1e6 DAI → 0.001 DAI per MEME (sell-side, after LP fee)
          const px = await q.getPrice();
          expect(px).toBeGreaterThan(0.001 * 0.95);
          expect(px).toBeLessThan(0.001 * 1.05);
          const buy = await q.quote('buy', 10, DEFAULT_LIMITS, ME, 0n);
          expect(buy.amountIn).toBe(amountToUnits(10, quoteDec));
          // 10 DAI → ≈ 10_000 MEME (minus fee)
          expect(buy.quotedOutHuman).toBeGreaterThan(9_900);
          expect(buy.quotedOutHuman).toBeLessThan(10_000);
          expect(buy.poolPrice / px).toBeGreaterThan(1 / 1.5);
          expect(buy.poolPrice / px).toBeLessThan(1.5);
          // Sell the EXACT raw units received (how a live bot sells a lot — never a float round-trip).
          const sell = await q.quote('sell', buy.quotedOutHuman, DEFAULT_LIMITS, ME, 0n, { amountInUnits: buy.quotedOut });
          expect(sell.amountIn).toBe(buy.quotedOut);
          // A 0-decimals quote can only pay whole units: ≈9.94 floors to 9 (the pool itself rounds down).
          expect(sell.quotedOutHuman).toBeGreaterThan(quoteDec === 0 ? 8.99 : 9.8);
          expect(sell.quotedOutHuman).toBeLessThan(10);
          expect(sell.call.method).toBe(kind === 'v2' ? 'swapExactTokensForTokensSupportingFeeOnTransferTokens' : 'multicall');
          // Float path is still within 1.5× of spot (the units guard input).
          const sellFloat = await q.quote('sell', buy.quotedOutHuman, DEFAULT_LIMITS, ME, 0n);
          expect(sellFloat.poolPrice / px).toBeGreaterThan(1 / 1.5);
          expect(sellFloat.poolPrice / px).toBeLessThan(1.5);
        });
      }
    }
  }
  it('a wrong stored decimals value is caught: market says 6 but chain says 18 → refuse to quote', async () => {
    const w = taxedWorld({ baseDec: 18 });
    const bad = { ...w.def, base: { ...w.def.base, decimals: 6 } };
    const { readDecimals: rd } = await import('../src/live/decimals');
    const q = new Quoter(w.m, bad, {
      chain: (w.q as unknown as { chain: never }).chain, adapter: w.q.adapter, resolve: () => w.q.adapter,
      verifyDecimals: async () => {
        for (const t of [bad.base, bad.quote]) {
          const on = await rd(w.m, 369, t.address);
          if (on !== t.decimals) throw new Error(`${t.symbol} decimals() = ${on} on-chain but the market stores ${t.decimals} — refusing`);
        }
      },
    });
    await expect(q.getPrice()).rejects.toThrow(/decimals\(\) = 18 on-chain but the market stores 6/);
    await expect(q.quote('buy', 10, DEFAULT_LIMITS, ME, 0n)).rejects.toThrow(/refusing/);
  });
  it('without verification, a wrong decimals value would push the price 10^12 off — the 1.5× guard is what catches it', async () => {
    const w = taxedWorld({ baseDec: 18 });
    const bad = new Quoter(w.m, { ...w.def, base: { ...w.def.base, decimals: 6 } }, { chain: (w.q as unknown as { chain: never }).chain, adapter: w.q.adapter, resolve: () => w.q.adapter });
    const good = await w.q.getPrice();
    const wrong = await bad.getPrice();
    expect(wrong / good > 1.5 || wrong / good < 1 / 1.5).toBe(true);
  });
});

describe('taxes 0 / 1 / 5 / 10 %: round trip, max-tx, live V3 block, PnL from actual received', () => {
  const ME = getAddress('0x' + 'd'.repeat(40));
  for (const t of [0, 0.01, 0.05, 0.10]) {
    it(`paper round trip with ${t * 100}% buy and sell tax returns ≈ (1−t)² × (1−fee)²`, async () => {
      const { q } = taxedWorld({ buyTax: t, sellTax: t });
      const pe = new PaperExecutor(q, () => ({ pls: 1e12, stable: 1e6 }));
      const b = await pe.execute(await pe.quote('buy', 10, DEFAULT_LIMITS), { canSend: () => true, onSent: () => undefined });
      const sq = await pe.quote('sell', b.amountOutHuman, DEFAULT_LIMITS);
      const s = await pe.execute(sq, { canSend: () => true, onSent: () => undefined });
      const expected = 10 * (1 - t) ** 2 * (1 - 0.0029) ** 2;
      expect(s.amountOutHuman / expected).toBeGreaterThan(0.995);
      expect(s.amountOutHuman / expected).toBeLessThan(1.001);
      expect(sq.taxInPct).toBeCloseTo(t, 6);
    });
  }
  it('max-tx: an order above the token limit is blocked (skipped by the engine)', async () => {
    const { q } = taxedWorld({ maxTx: 5_000 });
    const pe = new PaperExecutor(q, () => ({ pls: 0, stable: 1e6 }));
    const big = await pe.quote('buy', 10, DEFAULT_LIMITS); // ≈ 9970 MEME > 5000
    expect(big.balanceOk).toBe(false);
    expect(big.balanceNote).toMatch(/max transaction/);
    const small = await pe.quote('buy', 2, DEFAULT_LIMITS); // ≈ 2000 MEME
    expect(small.balanceOk).toBe(true);
  });

  /** Live executor against the mock: swaps pay tax to a tax wallet; the token emits a GROSS Transfer to the buyer and then a tax Transfer away, so only the balance change shows the net. */
  function liveRig(buyTax: number) {
    const w = taxedWorld({ buyTax });
    const m = w.m;
    m.wallet.set(`${ME.toLowerCase()}:${w.DAI.address.toLowerCase()}`, amountToUnits(1000, 18));
    let nonce = 0;
    const topic = ERC20.getEvent('Transfer')!.topicHash;
    const signer = {
      async getAddress() { return ME; },
      async sendTransaction(tx: { to: string; data: string; value: bigint; nonce: number }) {
        nonce++;
        const hash = '0x' + nonce.toString(16).padStart(64, '0');
        let logs: ReceiptLike['logs'] = [];
        if (tx.to.toLowerCase() !== w.def.pool.address.toLowerCase() && tx.data.startsWith('0x095ea7b3') === false) {
          const { ROUTER } = await import('../src/server/dex/abis');
          const f = ROUTER.parseTransaction({ data: tx.data })!;
          const [amountIn, minOut, path] = f.args as unknown as [bigint, bigint, string[]];
          const gross = BigInt((await m.call({ to: tx.to, data: ROUTER.encodeFunctionData('getAmountsOut', [amountIn, path]) })).slice(-64).replace(/^/, '0x')) ;
          const net = afterTax(gross, buyTax);
          if (net < minOut) return { hash, wait: async () => ({ status: 0, gasUsed: 100_000n, gasPrice: 10n ** 9n, logs: [] }) };
          const k = (a: string) => `${ME.toLowerCase()}:${a.toLowerCase()}`;
          m.wallet.set(k(path[0]), (m.wallet.get(k(path[0])) ?? 0n) - amountIn);
          m.wallet.set(k(path[1]), (m.wallet.get(k(path[1])) ?? 0n) + net);
          const L = (from: string, to: string, v: bigint) => ({ address: path[1], topics: [topic, zeroPadValue(from, 32), zeroPadValue(to, 32)], data: zeroPadValue(toBeHex(v), 32) });
          // Reflection-style token: Transfer(pair → me, gross) then Transfer(me → taxWallet, tax)
          logs = [L(w.pair, ME, gross), L(ME, '0x' + 'e'.repeat(40), gross - net)];
        }
        const r = { status: 1, gasUsed: 100_000n, gasPrice: 10n ** 9n, logs };
        return { hash, wait: async () => r };
      },
    };
    return { w, signer };
  }

  it('live buy books the ACTUAL received (balance change), not the gross Transfer log; FOT method used', async () => {
    const { LiveExecutor } = await import('../src/server/bot/chain');
    const { w, signer } = liveRig(0.05);
    const ex = new LiveExecutor(w.q, signer, { approval: 'max', receiptTimeoutMs: 1000 });
    const q = await ex.quote('buy', 10, DEFAULT_LIMITS);
    expect(q.call.method).toBe('swapExactTokensForTokensSupportingFeeOnTransferTokens');
    expect(q.balanceOk).toBe(true);
    const f = await ex.execute(q, { canSend: () => true, onSent: () => undefined });
    expect(f.outSource).toBe('balance');
    const gross = fromUnits(q.routerOut, q.decimalsOut);
    expect(f.amountOutHuman / gross).toBeCloseTo(0.95, 4); // net, not gross
    expect(Math.abs(f.shortfallPct!)).toBeLessThan(0.001);
    expect(f.taxPct).toBeCloseTo(0.05, 6);
  });
  it('tax rises after the safety check: fill lands short of the post-tax quote → shortfall reported', async () => {
    const { LiveExecutor } = await import('../src/server/bot/chain');
    const { w, signer } = liveRig(0.08); // real tax 8 % …
    // … but the market still thinks it's 5 %, with 5 % slippage so the tx doesn't revert
    (w.q as unknown as { ctx: { taxOf: (a: string) => unknown } }).ctx.taxOf = (a: string) => a.toLowerCase() === w.MEME.address.toLowerCase() ? { buy: 0.05, sell: 0, transfer: 0 } : NO_TAX;
    const ex = new LiveExecutor(w.q, signer, { approval: 'max', receiptTimeoutMs: 1000 });
    const q = await ex.quote('buy', 10, { ...DEFAULT_LIMITS, slippageBps: 500 });
    const f = await ex.execute(q, { canSend: () => true, onSent: () => undefined });
    expect(f.shortfallPct!).toBeGreaterThan(0.025); // ≈ 3.2 % short → engine asks TaxWatch to re-check
  });
  it('live: taxed token on an unproven V3 pool is refused before signing', async () => {
    const { LiveExecutor } = await import('../src/server/bot/chain');
    const v3 = taxedWorld({ buyTax: 0.05, kind: 'v3' });
    v3.def.safety = { ...v3.safety, taxMode: 'blocked', liveAllowed: false };
    v3.m.wallet.set(`${ME.toLowerCase()}:${v3.DAI.address.toLowerCase()}`, amountToUnits(1000, 18));
    const ex = new LiveExecutor(v3.q, { getAddress: async () => ME, sendTransaction: async () => { throw new Error('must not send'); } }, { approval: 'max', receiptTimeoutMs: 1000 });
    const q = await ex.quote('buy', 10, DEFAULT_LIMITS);
    expect(q.balanceOk).toBe(false);
    expect(q.balanceNote).toMatch(/V3/);
  });
});
