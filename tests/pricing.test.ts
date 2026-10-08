/**
 * Pricing / units invariants. Written to FAIL on inverted pricing (PLS per quote instead of quote per PLS),
 * wrong decimals (HEX/eHEX are 8, USDC/USDT 6, DAI/PLSX 18) or wrong pair reserve ordering.
 */
import { describe, expect, it } from 'vitest';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import { Quoter } from '../src/server/bot/chain';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { toUnits } from '../src/live/swapMath';
import { NET, MockChain, HEX } from './helpers/mockChain';

const P0 = 0.00001;
const HEXP = 0.004; // HEX per PLS (mid)
const F = 0.0029;
const USDC = NET.quotes.find((q) => q.symbol === 'USDC')!;
const PLSX = NET.quotes.find((q) => q.symbol === 'PLSX')!;

function hexChain() {
  const chain = new MockChain(P0);
  chain.setPrice(HEXP, 'HEX');
  chain.setBal('HEX', 100_000);
  return chain;
}
function make(chain: MockChain, signer: MockChain | null = chain, opts: Record<string, unknown> = {}) {
  const log = new Logger(true);
  const engine = new GridEngine({ net: NET, reader: chain, signer, store: new MemoryStore<BotState>(), log, maxRetries: 0, retryDelayMs: 0, ...opts });
  return { engine, log };
}
async function hexGrid(engine: GridEngine, chain: MockChain, mode: 'live' | 'paper' = 'live', extra = {}) {
  const spot = await new Quoter(chain, NET, HEX).getPrice();
  await engine.start({ mode, stable: 'HEX', lowerPrice: spot * 0.88, upperPrice: spot * 1.12, gridCount: 12, totalCapitalUsd: 6000, ...extra });
  return spot;
}
/** Move the HEX pool so getPrice() lands just past `level` (below for buys, above for sells). */
function crossHex(chain: MockChain, level: number, dir: 'down' | 'up') {
  chain.setPrice((level / (1 - F)) * (dir === 'down' ? 0.999 : 1.001), 'HEX');
}
const topWaiting = (e: GridEngine) => e.state.intervals.filter((i) => i.status === 'waitingBuy').at(-1)!;

describe('Quoter units: quote per PLS, token decimals, reserve order', () => {
  it('HEX (8 dec, pool token0 = WPLS): price ≈ 0.004 HEX/PLS — not inverted (250) and not 1e10-scaled', async () => {
    const chain = hexChain();
    const q = new Quoter(chain, NET, HEX);
    const p = await q.getPrice();
    expect(p / (HEXP * (1 - F))).toBeCloseTo(1, 3);
    expect(p).toBeLessThan(1); // inverted would be ~250
    const m = await q.market();
    expect(m.quoteReserve).toBeCloseTo(1_000_000, 0); // 1M HEX, read with 8 decimals
    expect(m.plsReserve).toBeCloseTo(1_000_000 / HEXP, -3);
    expect(m.quoteReserve / m.plsReserve).toBeCloseTo(HEXP, 8); // reserve order resolved via token0
  });

  it('reserve order: flipping token0 on the pair does not change market mid', async () => {
    const chain = hexChain();
    const q = new Quoter(chain, NET, HEX);
    const a = await q.market();
    chain.pool('HEX').token0IsQuote = !chain.pool('HEX').token0IsQuote;
    const b = await q.market();
    expect(b.quoteReserve).toBeCloseTo(a.quoteReserve, 6);
    expect(b.plsReserve).toBeCloseTo(a.plsReserve, 0);
  });

  it('buy 10 HEX: amountIn is 10e8 raw; ≈2492.7 PLS out; effective price above spot by one fee', async () => {
    const chain = hexChain();
    const q = new Quoter(chain, NET, HEX);
    const lim = { maxPriceImpact: 0.03, slippageBps: 50, deadlineMinutes: 10 };
    const buy = await q.quote('buy', 10, lim, '0x' + '1'.repeat(40), null);
    expect(buy.decimalsIn).toBe(8);
    expect(buy.amountIn).toBe(10n * 10n ** 8n);
    expect(buy.quotedOutHuman).toBeCloseTo((10 * (1 - F)) / HEXP, 0);
    expect(buy.price).toBeCloseTo(HEXP / (1 - F), 6);

    const sell = await q.quote('sell', 1000, lim, '0x' + '1'.repeat(40), null);
    expect(sell.decimalsOut).toBe(8);
    expect(sell.quotedOut).toBeGreaterThan(3n * 10n ** 8n);
    expect(sell.quotedOut).toBeLessThan(4n * 10n ** 8n);
    expect(sell.price).toBeCloseTo(HEXP * (1 - F), 6);
    // Same units both sides: buy pays more per PLS than sell receives, by exactly the round-trip fee
    expect(buy.price).toBeGreaterThan(sell.price);
    expect(sell.price / buy.price).toBeCloseTo((1 - F) ** 2, 4);
  });

  it('every quote token prices consistently from its own pool (6/8/18 decimals)', async () => {
    const chain = new MockChain(P0);
    chain.setPrice(HEXP, 'HEX'); chain.setPrice(0.0107, 'eHEX'); chain.setPrice(1.3, 'PLSX'); chain.setPrice(0.0000089, 'USDC');
    const expectMid: Record<string, number> = { DAI: P0, USDC: 0.0000089, USDT: P0, HEX: HEXP, eHEX: 0.0107, PLSX: 1.3 };
    for (const tok of NET.quotes) {
      const q = new Quoter(chain, NET, tok);
      // 1000-PLS probe has small real impact on the 1M-unit mock pools; 1e10 or inversion errors are many orders off
      expect((await q.getPrice()) / (expectMid[tok.symbol] * (1 - F)), tok.symbol).toBeCloseTo(1, 2);
      const m = await q.market();
      expect(m.quoteReserve / m.plsReserve / expectMid[tok.symbol], tok.symbol).toBeCloseTo(1, 4);
    }
    expect(USDC.decimals).toBe(6); expect(HEX.decimals).toBe(8); expect(PLSX.decimals).toBe(18);
  });
});

describe('Engine pricing on PLS/HEX (8 decimals)', () => {
  it('live round-trip: buy fills below sell, sell beats the lot cost, diagnostics come from the receipt', async () => {
    const chain = hexChain();
    const { engine } = make(chain);
    await hexGrid(engine, chain);
    expect(engine.state.econ?.ok).toBe(true);
    const iv = topWaiting(engine);
    expect(iv.buyPrice).toBeLessThan(iv.sellPrice);
    const hex0 = chain.bal('HEX');

    crossHex(chain, iv.buyPrice, 'down');
    await engine.tick();
    expect(chain.sent.map((s) => s.method)).toEqual(['approve', 'swapExactTokensForETH']);
    // exact approval in HEX raw units (8 decimals), not 18
    expect(chain.sent[0].args[1]).toBe(toUnits(engine.state.usdPerBuy.toFixed(8), 8));
    const buy = engine.state.trades[0];
    expect(buy).toMatchObject({ side: 'buy', stable: 'HEX', fromReceipt: true, levelPrice: iv.buyPrice });
    expect(buy.triggerPrice!).toBeLessThanOrEqual(iv.buyPrice);
    expect(buy.execPrice!).toBeCloseTo(buy.stableAmount / buy.plsAmount, 12);
    expect(Math.abs(buy.slippagePct!)).toBeLessThan(1e-6);
    expect(buy.execPrice! / (buy.triggerPrice! / (1 - F) ** 2)).toBeCloseTo(1, 2); // ≈ trigger + 2 fees
    expect(buy.execPrice!).toBeLessThan(iv.sellPrice);
    expect(buy.plsAmount).toBeCloseTo(engine.state.usdPerBuy / buy.execPrice!, 6);
    expect(buy.gasUsd).toBeCloseTo(buy.gasPls * buy.execPrice!, 12); // gas in HEX
    expect(buy.lotCost!).toBeCloseTo(buy.stableAmount + buy.gasUsd, 12);
    expect(engine.state.intervals[iv.index].lotCost).toBeCloseTo(buy.lotCost!, 12);

    crossHex(chain, iv.sellPrice, 'up');
    await engine.tick();
    expect(chain.sent.at(-1)!.method).toBe('swapExactETHForTokens');
    const sell = engine.state.trades[1];
    expect(sell).toMatchObject({ side: 'sell', fromReceipt: true, intervalIndex: iv.index, levelPrice: iv.sellPrice });
    expect(sell.plsAmount / buy.plsAmount).toBeCloseTo(1, 12); // sells exactly the lot that interval bought
    expect(sell.execPrice!).toBeGreaterThan(buy.execPrice!);
    expect(sell.lotCost!).toBeCloseTo(buy.lotCost!, 12);
    expect(sell.roundTripNet!).toBeCloseTo(sell.stableAmount - sell.gasUsd - buy.lotCost!, 10);
    expect(sell.roundTripNet!).toBeGreaterThan(0);
    expect(sell.realizedPnlUsd).toBeCloseTo(sell.roundTripNet!, 12);
    // on-chain HEX balance moved by exactly the recorded amounts
    const dHex = Number(chain.bal('HEX') - hex0) / 1e8;
    expect(dHex).toBeCloseTo(sell.stableAmount - buy.stableAmount, 6);

    const st = engine.status();
    expect(st.stats.roundTrips).toBe(1);
    expect(st.stats.avgNet).toBeCloseTo(sell.roundTripNet!, 12);
    expect(st.stats.totalFees).toBeCloseTo(buy.feeQuote! + sell.feeQuote!, 12);
    expect(st.stats.totalGas).toBeCloseTo(buy.gasUsd + sell.gasUsd, 12);
    expect(st.pnl.plsHeld).toBeCloseTo(0, 6);
  });

  it('decimals bug in the quote (18 vs 8 dec) is refused before signing', async () => {
    const chain = hexChain();
    const { engine, log } = make(chain);
    await hexGrid(engine, chain);
    const iv = topWaiting(engine);
    // Router returns PLS out as if the HEX input had 18 decimals (1e10× too much)
    chain.corrupt = (amountIn, out, path) => (path[0].toLowerCase() === HEX.address.toLowerCase() ? out * 10n ** 10n : out);
    crossHex(chain, iv.buyPrice, 'down');
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
    expect(log.entries.some((e) => /units\/decimals mismatch/.test(e.msg))).toBe(true);
  });

  it('inverted pricing (PLS per HEX) in the quote is refused before signing', async () => {
    const chain = hexChain();
    const { engine, log } = make(chain);
    await hexGrid(engine, chain);
    const iv = topWaiting(engine);
    chain.corrupt = (amountIn, out, path) => {
      if (path[0].toLowerCase() !== HEX.address.toLowerCase()) return out;
      const inH = Number(amountIn) / 1e8, outH = Number(out) / 1e18;
      return BigInt(Math.round((inH * inH) / outH)) * 10n ** 18n; // effective price becomes 1/price
    };
    crossHex(chain, iv.buyPrice, 'down');
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
    expect(log.entries.some((e) => /units\/decimals mismatch/.test(e.msg))).toBe(true);
  });

  it('a sell that would not beat its lot buy cost is held, not sent', async () => {
    const chain = hexChain();
    const { engine, log } = make(chain);
    await hexGrid(engine, chain);
    const iv = topWaiting(engine);
    crossHex(chain, iv.buyPrice, 'down'); await engine.tick();
    const sent = chain.sent.length;
    engine.state.intervals[iv.index].lotCost = engine.state.trades[0].stableAmount * 1.05; // lot bought 5% higher
    crossHex(chain, iv.sellPrice, 'up'); await engine.tick();
    expect(chain.sent.length).toBe(sent);
    expect(log.entries.some((e) => /lose vs lot cost/.test(e.msg))).toBe(true);
    expect(engine.state.intervals[iv.index]).toMatchObject({ status: 'holding', needsRearm: true });
  });

  it('oscillating walk (paper, HEX): every completed round-trip sells above its own buy and nets > 0', async () => {
    const chain = hexChain();
    const { engine } = make(chain, null);
    const spot = await hexGrid(engine, chain, 'paper');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const base = spot / (1 - F);
    for (let i = 0; i < 400; i++) {
      // oscillating path with noise: sweeps the whole band repeatedly
      const mid = base * (1 + 0.1 * Math.sin(i / 12) + (rnd() - 0.5) * 0.02);
      chain.setPrice(mid, 'HEX');
      await engine.tick();
    }
    const trades = engine.state.trades.filter((t) => t.paper && !t.failed);
    const lastBuy = new Map<number, typeof trades[number]>();
    let rts = 0;
    for (const t of trades) {
      if (t.side === 'buy') { lastBuy.set(t.intervalIndex, t); continue; }
      const b = lastBuy.get(t.intervalIndex)!;
      expect(b, 'sell without a prior buy on that interval').toBeDefined();
      expect(t.execPrice!).toBeGreaterThan(b.execPrice!);
      expect(t.levelPrice!).toBeGreaterThan(b.levelPrice!);
      expect(t.plsAmount / b.plsAmount).toBeCloseTo(1, 12);
      expect(t.roundTripNet!).toBeGreaterThan(0);
      lastBuy.delete(t.intervalIndex);
      rts++;
    }
    expect(rts).toBeGreaterThan(5);
  });
});

describe('Start gate + paper/live parity', () => {
  const tight = (spot: number) => ({ lowerPrice: spot * 0.98, upperPrice: spot * 1.02, gridCount: 40, totalCapitalUsd: 50 });

  it('live is hard-blocked when not net-positive, even with allowTightSpacing', async () => {
    const chain = new MockChain(P0);
    const { engine } = make(chain);
    await expect(engine.start({ mode: 'live', ...tight(P0), allowTightSpacing: true })).rejects.toThrow(/LIVE start blocked.*round-trip/);
    expect(engine.state.status).toBe('idle');
  });

  it('a saved LIVE grid from before the gate (±2.5%×36) is stopped on load and cannot be resumed', async () => {
    const chain = new MockChain(P0);
    const store = new MemoryStore<BotState>();
    const { engine } = make(chain);
    await engine.start({ mode: 'live', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 50 });
    // simulate legacy saved state: old tight-scalp config, running, no econ
    store.save({ ...engine.state, config: { lowerPrice: P0 * 0.975, upperPrice: P0 * 1.025, gridCount: 36, totalCapitalUsd: 100 }, econ: undefined, status: 'running' });
    const log = new Logger(true);
    const reloaded = new GridEngine({ net: NET, reader: chain, signer: chain, store, log, maxRetries: 0, retryDelayMs: 0 });
    expect(reloaded.state.status).toBe('stopped');
    expect(log.entries.some((e) => /not resuming/.test(e.msg))).toBe(true);
    expect(() => reloaded.resume()).toThrow(/spacing .* floor/);
  });

  it('paper needs the explicit override and records a warning', async () => {
    const chain = new MockChain(P0);
    const { engine } = make(chain, null);
    await expect(engine.start({ mode: 'paper', ...tight(P0) })).rejects.toThrow(/paper only/);
    await engine.start({ mode: 'paper', ...tight(P0), allowTightSpacing: true });
    expect(engine.state.spacingWarn).toMatch(/PAPER ONLY/);
    expect(engine.state.econ?.ok).toBe(false);
    expect(engine.state.econ!.netPerRoundTrip).toBeLessThan(0);
  });

  it('gas-dominated level sizes are blocked (net ≤ 0 even with wide spacing)', async () => {
    const chain = new MockChain(P0);
    chain.gasPrice = 10n ** 15n; // 280–500 PLS per round-trip
    const { engine } = make(chain);
    await expect(engine.start({ mode: 'live', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 0.01 })).rejects.toThrow(/Net per round-trip ≤ 0/);
  });

  it('paper charges approve gas like live (exact: every buy; max: first buy only)', async () => {
    for (const approval of ['exact', 'max'] as const) {
      const chain = new MockChain(P0);
      const { engine } = make(chain, null, { approval });
      await engine.start({ mode: 'paper', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 50 });
      chain.setPrice(P0 * 0.955); await engine.tick(); // two buys
      const buys = engine.state.trades.filter((t) => t.side === 'buy');
      expect(buys).toHaveLength(2);
      // estimate = (approve 60k? + swap 220k) × 1e12 wei
      expect(buys[0].gasPls).toBeCloseTo(0.28, 9);
      expect(buys[1].gasPls).toBeCloseTo(approval === 'exact' ? 0.28 : 0.22, 9);
    }
  });
});
