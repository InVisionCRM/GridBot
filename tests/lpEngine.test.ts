import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { LpEngine, type LpState } from '../src/server/bot/lpEngine';
import { Q128, rangeBaseShare } from '../src/live/v3Liquidity';
import { LpPool } from '../src/server/lp/lpPool';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { ERC20, V3_NPM } from '../src/server/dex/abis';
import type { ReceiptLike } from '../src/server/bot/chain';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { MultiBot, type MultiState } from '../src/server/bot/multi';

const NET = NETWORKS.mainnet;
const CH = chainFromNetwork(NET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };
const PRICE = 0.00003; // DAI per PLS

function world() {
  const m = new MultiDexMock();
  [WPLS, DAI].forEach((t) => m.addToken(t));
  m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
  // deep pool: 1e10 PLS / 3e5 DAI at 0.00003 DAI per PLS
  const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
  const def: MarketDef = {
    key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
    base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
    pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
  };
  const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
  let t = 1_800_000_000_000;
  const store = new MemoryStore<LpState>();
  const lp = new LpEngine({ net: NET, store, log: new Logger(true), hub, now: () => t });
  return { m, pool, def, hub, lp, store, at: (ms: number) => { t = 1_800_000_000_000 + ms; } };
}
const value = (lp: LpEngine) => lp.status().value!;

describe('LP bot (paper): open, earn, re-range, send, close', () => {
  it('opens a ±10% position around the price with the right mix; value stays close to the amount', async () => {
    const { lp } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick(); // swap to the mix + mint
    const s = lp.status();
    expect(s.step).toBeNull();
    expect(s.position).not.toBeNull();
    expect(s.position!.lower).toBeLessThan(PRICE);
    expect(s.position!.upper).toBeGreaterThan(PRICE);
    expect(s.position!.lower).toBeCloseTo(PRICE * 0.9, 6);
    expect(s.inRange).toBe(true);
    // roughly half in each coin; only the swap's fee + impact and dust stay out
    expect(s.coins!.base * PRICE).toBeGreaterThan(400);
    expect(s.coins!.quote).toBeGreaterThan(400);
    expect(value(lp)).toBeGreaterThan(995);
    expect(value(lp)).toBeLessThan(1000);
  });

  it("fees come from the pool's counters, scaled by the share of the pool the position would be (its pool share)", async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const v0 = value(lp);
    // the pool's in-range liquidity earns 1e-6 DAI per unit of liquidity (DAI is token1 here only if WPLS < DAI)
    m.addFees(pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n);
    await lp.tick();
    const s = lp.status(), L = BigInt(s.position!.liquidity);
    const poolL = BigInt(Math.round(Math.sqrt(1e10 * 1e18 * 3e5 * 1e18)));
    const each = Number((L / 10n ** 6n) * poolL / (poolL + L)) / 1e18; // per token, human (both 18 decimals)
    expect(s.owed!.base).toBeCloseTo(each, 9);
    expect(s.owed!.quote).toBeCloseTo(each, 9);
    expect(value(lp) - v0).toBeCloseTo(each * PRICE + each, 9);
    expect(s.poolShare).toBeCloseTo(Number(L) / Number(poolL + L), 12);
  });

  it('a stale RPC answer with lower fee counters earns nothing, and fees resume from the highest reading (not ~2^128 × L)', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const d = Q128 / 10n ** 6n;
    m.addFees(pool, d, d);
    await lp.tick();
    const owed = lp.status().owed!;
    expect(owed.base).toBeGreaterThan(0);
    // a node a few blocks behind answers: the counters read lower than last time (a real pool's never go down)
    m.addFees(pool, -d / 2n, -d / 2n);
    await lp.tick();
    expect(lp.status().owed).toEqual(owed);
    // a fresh node again, d/2 past the highest reading so far: only that part is new
    m.addFees(pool, d, d);
    await lp.tick();
    expect(lp.status().owed!.base).toBeCloseTo(owed.base * 1.5, 12);
    expect(lp.status().owed!.quote).toBeCloseTo(owed.quote * 1.5, 12);
  });

  // A real pool's fee counters have grown since it was created (the user's ETH/USDG pool: ~3.5e-7 × 2^128 per unit of
  // liquidity). A paper position's range ticks don't exist in the pool: they read 0 and never flip.
  const HISTORY = Q128 / 10n ** 4n;

  it('below its range on a pool with fee history: no fees and a sane value, not the ~2^128 × L wrap (the 10^48 USDG chart)', async () => {
    const { lp, m, pool } = world();
    m.addFees(pool, HISTORY, HISTORY);
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000, rerange: false }); // stays out of range
    await lp.tick();
    const v0 = value(lp);
    m.movePrice(pool, 0.8); // PLS −20%: below the ±10% range
    await lp.tick();
    expect(lp.status().inRange).toBe(false);
    expect(lp.status().owed).toEqual({ base: 0, quote: 0 });
    expect(value(lp)).toBeLessThan(v0);
    expect(value(lp)).toBeGreaterThan(v0 * 0.8);
    expect(Math.max(...lp.status().equity.map(([, v]: [number, number]) => v))).toBeLessThan(v0 * 1.01);
  });

  it("earns the pool's fees only while the price is inside the range", async () => {
    const { lp, m, pool } = world();
    m.addFees(pool, HISTORY, HISTORY);
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000, rerange: false }); // stays out of range
    await lp.tick();
    const L = BigInt(lp.status().position!.liquidity), poolL = BigInt(Math.round(Math.sqrt(1e10 * 1e18 * 3e5 * 1e18)));
    const each = Number((L / 10n ** 6n) * poolL / (poolL + L)) / 1e18;
    const fees = () => lp.status().owed!.quote;
    m.addFees(pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n); await lp.tick();
    expect(fees()).toBeCloseTo(each, 9);
    m.movePrice(pool, 0.8); await lp.tick(); // out
    expect(lp.status().poolShare).toBe(0);
    m.addFees(pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n); await lp.tick(); // earned by others while it was out
    expect(fees()).toBeCloseTo(each, 9);
    m.movePrice(pool, 1 / 0.8); await lp.tick(); // back in
    expect(lp.status().inRange).toBe(true);
    expect(fees()).toBeCloseTo(each, 9);
    m.addFees(pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n); await lp.tick();
    expect(fees()).toBeCloseTo(2 * each, 9);
  });

  // Out of range with Auto-move on: the range moves to the price at the next fresh reading.
  const H = 3600_000;
  const STEP = Q128 / 10n ** 8n; // one burst of trading in the pool: fee growth per unit of liquidity on each token
  /** Trade in the pool and tick until the bot moves its range (or `max` ticks). */
  async function tradeUntilMoved(lp: LpEngine, m: MultiDexMock, pool: string, max = 20) {
    const moves = lp.status().reranges;
    for (let i = 0; i < max && lp.status().reranges === moves; i++) {
      m.addFees(pool, STEP, STEP);
      await lp.tick();
    }
  }

  it('out of range with Auto-move on it moves to the price at once, both ways, whatever moving costs; with it off it waits', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const first = lp.status().position!;
    m.movePrice(pool, 1.2); // PLS up 20% (DAI per PLS ↑ when WPLS is token0)
    await lp.tick(); // out at this reading: the move starts and runs straight through in paper
    let s = lp.status();
    expect(s).toMatchObject({ reranges: 1, inRange: true });
    expect(s.position!.lower).toBeGreaterThan(first.upper * 0.95);
    // down through it again: the same the other way
    m.movePrice(pool, 0.7);
    await lp.tick();
    expect(lp.status()).toMatchObject({ reranges: 2, inRange: true });
    // Auto-move off: out of range it waits
    lp.setRerange(false);
    m.movePrice(pool, 1.3);
    for (let i = 0; i < 5; i++) { m.addFees(pool, STEP, STEP); await lp.tick(); }
    s = lp.status();
    expect(s).toMatchObject({ reranges: 2, inRange: false });
  });

  it('Move now: to the price at the same width, or Change range to a new width; refused while paused, busy, or for a bad width', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000, rerange: false });
    await lp.tick();
    m.movePrice(pool, 1.05); // still inside ±10%, off centre
    await lp.tick();
    const before = lp.status().position!;
    await lp.move();
    await lp.tick();
    let s = lp.status();
    expect(s.reranges).toBe(1);
    expect(s.config!.bandPct).toBe(0.1);
    // re-centred on the price: the range now sits around it
    expect(s.position!.lower).toBeGreaterThan(before.lower);
    expect(Math.sqrt(s.position!.lower * s.position!.upper) / s.price!).toBeCloseTo(1, 1);
    // a new width
    await lp.move(0.03);
    await lp.tick();
    s = lp.status();
    expect(s).toMatchObject({ reranges: 2, config: { bandPct: 0.03 } });
    // ±3% on a pool whose ticks are 0.5% apart (50 × 0.01%): within a tick of 1.03 / 0.97
    expect(Math.abs(s.position!.upper / s.position!.lower - 1.03 / 0.97)).toBeLessThan(0.0101);
    await expect(lp.move(0.001)).rejects.toThrow(/±1% to ±50%/);
    lp.stop();
    await expect(lp.move()).rejects.toThrow(/Resume it first/);
  });

  it('fees per coin; a move locks in what the range did to the coin mix ("lost to moves"); earned after costs adds it up', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const s0 = lp.status(), p0 = s0.pnl!;
    // the position remembers the coins it went in with
    expect(s0.position!.putIn!.base).toBeCloseTo(s0.coins!.base, 9);
    expect(s0.position!.putIn!.quote).toBeCloseTo(s0.coins!.quote, 9);
    expect(p0).toMatchObject({ moveLoss: 0, feeCoins: { base: 0, quote: 0 } });
    expect(p0.swapCost).toBeGreaterThan(0); // the opening swap to the range's mix
    m.addFees(pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n);
    await lp.tick();
    const s1 = lp.status(), p1 = s1.pnl!;
    expect(p1.feeCoins.base).toBeGreaterThan(0);
    expect(p1.feeCoins.quote).toBeGreaterThan(0);
    expect(p1.fees).toBeCloseTo(p1.feeCoins.base * s1.price! + p1.feeCoins.quote, 9); // all still waiting: valued now
    m.movePrice(pool, 1.2);
    await tradeUntilMoved(lp, m, pool);
    const s2 = lp.status(), p2 = s2.pnl!;
    expect(s2.reranges).toBe(1);
    // the range sold PLS on the way up; taken out at that mix, it's worth less than the coins it went in with
    expect(p2.moveLoss).toBeGreaterThan(0);
    expect(p2.net).toBeCloseTo(p2.fees - p2.gas - p2.swapCost - p2.moveLoss, 9);
    // the fees collected at the move are counted per coin
    expect(s2.totals.feeCoins.base).toBeGreaterThan(0);
    expect(s2.totals.feeCoins.quote).toBeGreaterThan(0);
    // the new position remembers what it went in with
    expect(s2.position!.putIn!.base).toBeCloseTo(s2.coins!.base, 6);
  });

  it("doesn't start a move whose swap would go over the price-impact cap (it would stop halfway, out of the position)", async () => {
    const { lp, m, pool, hub, store } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const saved = store.load()!;
    store.save({ ...saved, limits: { ...saved.limits, maxPriceImpact: 1e-9 } });
    const again = new LpEngine({ net: NET, store, log: new Logger(true), hub, now: () => 1_800_000_000_000 });
    m.movePrice(pool, 1.2);
    await again.tick();
    await tradeUntilMoved(again, m, pool);
    const s = again.status();
    expect(s.reranges).toBe(0);
    expect(s.position).not.toBeNull();
    expect(s.move.block).toMatch(/would move the price .*% \(cap 0\.00%\)/);
    // asked by hand: refused with the same reason
    await expect(again.move()).rejects.toThrow(/Not moved: the swap to the new range's mix would move the price/);
  });

  it('a stale reading decides nothing: no move on it, the move comes with the next fresh one', async () => {
    const { lp, m, pool } = world();
    m.addFees(pool, STEP * 10n, STEP * 10n);
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    // the price left the range, read first by a node behind the chain: lower counters than last time
    m.movePrice(pool, 1.2);
    m.addFees(pool, -STEP, -STEP);
    await lp.tick();
    expect(lp.status()).toMatchObject({ reranges: 0, lastError: null });
    m.addFees(pool, STEP * 2n, STEP * 2n); // a fresh node
    await lp.tick();
    expect(lp.status().reranges).toBe(1);
  });

  it('a stopped bot never re-ranges; the position stays open', async () => {
    const { lp, m, pool, at } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    lp.stop();
    m.movePrice(pool, 1.3);
    at(24 * 3600_000);
    for (let i = 0; i < 200; i++) { m.addFees(pool, Q128 / 10n ** 7n, Q128 / 10n ** 7n); await lp.tick(); }
    expect(lp.status()).toMatchObject({ status: 'stopped', reranges: 0 });
    expect(lp.status().position).not.toBeNull();
  });

  it('send mode collects the fees to the address once they are worth 10× the gas', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000, profits: { mode: 'send', to: '0x00000000000000000000000000000000000beef1' } });
    await lp.tick();
    m.addFees(pool, Q128 / 10n ** 5n, Q128 / 10n ** 5n);
    await lp.tick(); // fees large enough → collect step
    await lp.tick();
    const s = lp.status();
    expect(s.totals.sent).toBeGreaterThan(0);
    expect(s.owed!.base + s.owed!.quote).toBeCloseTo(0, 12);
  });

  it('close takes everything out to the wallet and ends the bot', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    m.addFees(pool, Q128 / 10n ** 6n, 0n);
    await lp.tick(); // fees land in the cached reading; close then settles from that, with no further tick
    lp.close();
    const s = lp.status();
    expect(s).toMatchObject({ status: 'closed', position: null, step: null });
    expect(s.totals.fees).toBeGreaterThan(0);
    expect(s.idle.base * PRICE + s.idle.quote).toBeGreaterThan(995);
  });

  it('refuses ranges outside ±1–50%, no amount, and markets that are not V3 pools', async () => {
    const { lp } = world();
    await expect(lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.6, capital: 100 })).rejects.toThrow(/±1% to ±50%/);
    await expect(lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 0 })).rejects.toThrow(/amount/);
    await expect(lp.start({ mode: 'paper', market: 'DAI', bandPct: 0.1, capital: 100 })).rejects.toThrow(/needs a V3 pool/);
  });
});

describe('LP bot (live): every step sent once, settled by hash, safe across restarts', () => {
  const ME = '0x1234567890123456789012345678901234567890';
  const NPM = dex('9mm-v3').positionManager!;
  /** `price` = DAI per PLS in the pool; `balances` = the wallet as the executor reads it (base, quote). */
  function live(o: { price?: number; balances?: { pls: number; stable: number } } = {}) {
    const price = o.price ?? PRICE, balances = o.balances ?? { pls: 1e12, stable: 1e9 };
    const m = new MultiDexMock();
    [WPLS, DAI].forEach((t) => m.addToken(t));
    m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
    const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 1e10 * price, 2500);
    const def: MarketDef = {
      key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
      base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
      pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
    };
    const receipts = new Map<string, ReceiptLike>();
    let approved = false;
    const call = m.call.bind(m);
    m.call = async (tx) => (approved && tx.data.startsWith(ERC20.getFunction('allowance')!.selector) ? ERC20.encodeFunctionResult('allowance', [2n ** 255n]) : call(tx));
    m.getTransactionReceipt = async (h: string) => receipts.get(h) ?? null;
    const signer = { getAddress: async () => ME, sendTransaction: async () => { throw new Error('use the scripted executor'); } };
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, signer as never)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
    const store = new MemoryStore<LpState>();
    const sent: { to: string; data: string; value: bigint; hash: string }[] = [];
    // Scripted executor: swaps fill at the pool price; every other tx is recorded and mined only when the test says so.
    const exec = {
      mode: 'live' as const, address: async () => ME, getPrice: async () => price,
      balances: async () => balances,
      quote: async (side: 'buy' | 'sell', amount: number) => ({ side, amountInHuman: amount, quotedOutHuman: side === 'buy' ? amount / price : amount * price, balanceOk: true, priceImpact: 0, tokenOut: side === 'buy' ? WPLS.address : DAI.address, decimalsOut: 18, price }),
      execute: async (q: { side: string; amountInHuman: number; quotedOutHuman: number }) => ({ txHash: '0xswap', amountInHuman: q.amountInHuman, amountOutHuman: q.quotedOutHuman, gasPls: 0.1 }),
      recover: async () => null,
      sendTx: async (req: { to: string; data: string; value: bigint }) => { const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`; sent.push({ ...req, hash }); return hash; },
    };
    const make = () => { const e = new LpEngine({ net: NET, store, log: new Logger(true), hub, now: () => 1_800_000_000_000 }); (e as unknown as { executor: unknown }).executor = exec; return e; };
    const ok = (hash: string, logs: ReceiptLike['logs'] = []) => receipts.set(hash, { status: 1, gasUsed: 100_000n, gasPrice: 10n ** 9n, logs });
    const ev = (name: 'IncreaseLiquidity' | 'DecreaseLiquidity' | 'Collect', args: unknown[]) => ({ address: NPM, ...V3_NPM.encodeEventLog(name, args) });
    return { m, hub, signer, make, sent, receipts, ok, ev, approve: () => { approved = true; } };
  }

  it('approve → mint: each sent once, nothing resent while unmined, position from the receipt; a restart resumes by hash', async () => {
    const w = live();
    const a = w.make();
    await a.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (a as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor; // start() rebuilt it
    await a.tick();
    expect(w.sent).toHaveLength(1);
    expect(ERC20.parseTransaction({ data: w.sent[0].data })!.name).toBe('approve'); // DAI to the position manager
    expect(w.sent[0].to.toLowerCase()).toBe(DAI.address.toLowerCase());
    await a.tick(); await a.tick();
    expect(w.sent).toHaveLength(1); // not mined → never resent
    w.approve(); w.ok(w.sent[0].hash);
    await a.tick();
    expect(w.sent).toHaveLength(2);
    const mint = w.sent[1];
    expect(mint.to).toBe(NPM);
    const [calls] = V3_NPM.decodeFunctionData('multicall', mint.data) as unknown as [string[]];
    expect(calls.map((c) => V3_NPM.parseTransaction({ data: c })!.name)).toEqual(['mint', 'refundETH']); // PLS paid with the tx value
    expect(mint.value).toBeGreaterThan(0n);
    // restart before the mint is mined: the new engine waits on the same hash
    const b = w.make();
    await b.tick();
    expect(w.sent).toHaveLength(2);
    w.ok(mint.hash, [w.ev('IncreaseLiquidity', [777n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n])]);
    await b.tick();
    expect(b.status().position).toMatchObject({ id: '777', liquidity: (10n ** 20n).toString() });
    expect(b.status().step).toBeNull();
  });

  it("live fees are the position manager's own collect quote, asked once as the position's owner (not rebuilt from several reads)", async () => {
    const w = live();
    const a = w.make();
    await a.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (a as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor;
    await a.tick();
    w.approve(); w.ok(w.sent[0].hash);
    await a.tick();
    w.ok(w.sent[1].hash, [w.ev('IncreaseLiquidity', [777n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n])]);
    await a.tick();
    expect(a.status().position).toMatchObject({ id: '777' });
    const asked: (string | undefined)[] = [];
    const reads: string[] = [];
    const prev = w.m.call.bind(w.m);
    w.m.call = async (tx: { to: string; data: string; from?: string }) => {
      if (tx.to.toLowerCase() !== NPM.toLowerCase()) return prev(tx);
      const f = V3_NPM.parseTransaction({ data: tx.data })!;
      reads.push(f.name);
      if (f.name === 'ownerOf') return V3_NPM.encodeFunctionResult('ownerOf', [ME]);
      if (f.name !== 'collect') throw new Error(`mock: ${f.name} not expected`);
      asked.push(tx.from);
      if (tx.from?.toLowerCase() !== ME.toLowerCase()) throw Object.assign(new Error('execution reverted: Not approved'), { code: 'CALL_EXCEPTION' });
      // token0 = WPLS (base), token1 = DAI: 5 PLS + 0.02 DAI owed
      return V3_NPM.encodeFunctionResult('collect', [5n * 10n ** 18n, 2n * 10n ** 16n]);
    };
    await a.tick();
    await a.tick();
    expect(a.status().lastError).toBeNull();
    expect(a.status().owed!.base).toBeCloseTo(5, 12);
    expect(a.status().owed!.quote).toBeCloseTo(0.02, 12);
    expect(asked).toEqual([ME, ME]); // one quote per tick, from the owner
    expect(reads.filter((x) => x === 'ownerOf')).toHaveLength(1); // the owner is looked up once
    // live, the position is part of the pool's active liquidity (this mock's pool doesn't add it): share = L ÷ active
    expect(a.status().inRange).toBe(true);
    expect(a.status().poolShare).toBeCloseTo(1e20 / Math.sqrt(1e10 * 1e18 * (1e10 * PRICE) * 1e18), 15);
  });

  it('close: one multicall (remove all, collect via the manager, unwrap PLS, sweep DAI, burn); fees = collected − principal', async () => {
    const w = live();
    const e = w.make();
    await e.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (e as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor;
    w.approve();
    await e.tick();
    w.ok(w.sent[0].hash, [w.ev('IncreaseLiquidity', [5n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n])]);
    await e.tick();
    e.close();
    await e.tick();
    const exit = w.sent[1];
    const [calls] = V3_NPM.decodeFunctionData('multicall', exit.data) as unknown as [string[]];
    expect(calls.map((c) => V3_NPM.parseTransaction({ data: c })!.name)).toEqual(['decreaseLiquidity', 'collect', 'unwrapWETH9', 'sweepToken', 'burn']);
    const col = V3_NPM.decodeFunctionData('collect', calls[1])[0] as { recipient: string };
    expect(col.recipient).toBe('0x0000000000000000000000000000000000000000');
    expect((V3_NPM.decodeFunctionData('sweepToken', calls[3]) as unknown as [string])[0].toLowerCase()).toBe(DAI.address.toLowerCase());
    // principal 1000 PLS + 0.03 DAI, collected 1010 PLS + 0.04 DAI → fees 10 PLS + 0.01 DAI (WPLS < DAI: token0 = WPLS)
    w.ok(exit.hash, [w.ev('DecreaseLiquidity', [5n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n]), w.ev('Collect', [5n, '0x0000000000000000000000000000000000000000', 1010n * 10n ** 18n, 4n * 10n ** 16n])]);
    await e.tick();
    const s = e.status();
    expect(s).toMatchObject({ status: 'closed', position: null });
    expect(s.totals.fees).toBeCloseTo(10 * PRICE + 0.01, 9);
    expect(s.totals.feeCoins.base).toBeCloseTo(10, 9);
    expect(s.totals.feeCoins.quote).toBeCloseTo(0.01, 9);
  });

  it('a pricey native base (like ETH/USDG): the native side goes in, keeping only gas for the open (bug: 2% of the USDG amount was kept back as ETH)', async () => {
    // 1000 DAI at 2400 DAI per PLS: about half (≈0.21 PLS) is bought for the position; the wallet already had 0.46 PLS for gas.
    const w = live({ price: 2400, balances: { pls: 0.46 + 0.2083, stable: 500 } });
    const e = w.make();
    await e.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.05, capital: 1000 });
    (e as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor;
    w.approve();
    await e.tick();
    expect(e.lastError).toBeNull();
    expect(w.sent).toHaveLength(1);
    const mint = w.sent[0];
    const value = Number(mint.value) / 1e18;
    expect(value).toBeGreaterThan(0.2); // the PLS bought for the position goes in (paid as the tx value)
    expect(value).toBeLessThanOrEqual(0.2084);
  });

  it('a live start with coins from the wallet checks the wallet holds them (after other live bots)', async () => {
    const w = live();
    w.m.native = 10n ** 18n * 1000n; // 1000 PLS in the wallet
    const bot = new MultiBot({ net: NET, reader: w.m, signer: w.signer as never, store: new MemoryStore<MultiState>(), log: new Logger(true), hub: w.hub });
    w.m.addToken({ ...DAI });
    await expect(bot.addLp({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 0, baseAmount: 1500 }))
      .rejects.toThrow('Not enough PLS in your wallet. This needs 1500 PLS (1500 for this bot), and the wallet has 1000 PLS.');
    expect(bot.status().lps).toHaveLength(0);
  });

  it('a step that keeps reverting stops the bot after 3 tries (nothing lost)', async () => {
    const w = live();
    const e = w.make();
    await e.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (e as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor;
    w.approve();
    for (let i = 0; i < 3; i++) {
      await e.tick();
      w.receipts.set(w.sent.at(-1)!.hash, { status: 0, gasUsed: 100_000n, gasPrice: 10n ** 9n, logs: [] });
    }
    await e.tick();
    expect(e.status().status).toBe('stopped');
    expect(e.lastError).toMatch(/reverted 3 times/);
    expect(w.sent).toHaveLength(3);
  });
});


describe('LP bot funded with coins already in the wallet', () => {
  it('puts in both coins and swaps only the difference to the range\'s mix; profit counts from what it was given', async () => {
    const { lp, pool, m } = world();
    const v = await new LpPool(m, (lp as unknown as { hub: Hub }).hub.def('pulsechain:PLS/DAI#9mm'), CH.dexes.find((d) => d.id === '9mm-v3')!, NET.pulsex.wpls).view();
    // the formula the form uses agrees with the engine's own (the pool widens the range to its tick spacing)
    expect(rangeBaseShare(PRICE, PRICE * 0.9, PRICE * 1.1)).toBeCloseTo(0.5, 1);
    const p = new LpPool(m, (lp as unknown as { hub: Hub }).hub.def('pulsechain:PLS/DAI#9mm'), CH.dexes.find((d) => d.id === '9mm-v3')!, NET.pulsex.wpls);
    const t = p.ticksFor(PRICE * 0.9, PRICE * 1.1, v), r = p.rangePrices(t.tickLower, t.tickUpper, v);
    expect(rangeBaseShare(v.price, r.lower, r.upper)).toBeCloseTo(p.baseShare(t.tickLower, t.tickUpper, v), 9);
    void pool;
    const share = p.baseShare(t.tickLower, t.tickUpper, v);
    // 600 DAI + 400 DAI worth of PLS: only ~76 DAI (share × 1000 − 400) is swapped to PLS, not ~476
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 600, baseAmount: 400 / PRICE });
    expect(lp.status().equity[0][1]).toBeCloseTo(1000, 6);
    await lp.tick();
    const s = lp.status();
    expect(s.position).not.toBeNull();
    expect((s.coins!.base * PRICE) / s.value!).toBeCloseTo(share, 2);
    expect(s.pnl!.net + s.pnl!.price).toBeCloseTo(s.pnl!.equity - 1000, 9); // counted from what it was given
    // the same 1000 given only as DAI swaps ~6× more, so it starts with less (fee + price impact)
    const only = world().lp;
    await only.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await only.tick();
    expect(s.value!).toBeGreaterThan(only.status().value!);
    expect(only.status().pnl!.swapCost).toBeGreaterThan(4 * s.pnl!.swapCost);
  });
  it('only coins, no amount of the spend coin, works too; nothing at all is refused', async () => {
    const { lp } = world();
    await expect(lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 0 })).rejects.toThrow('Enter an amount.');
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 0, baseAmount: 1000 / PRICE });
    await lp.tick();
    expect(lp.status().position).not.toBeNull();
    expect(lp.status().coins!.quote).toBeGreaterThan(490);
  });
});

describe('LP bot in the app: API, status, restart, money split', () => {
  async function serve(store = new MemoryStore<MultiState>()) {
    const w = world();
    const bot = new MultiBot({ net: NET, reader: w.m, signer: null, store, log: new Logger(true), hub: w.hub, now: () => 1_800_000_000_000 });
    const server = createApp({ bot, net: NET }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const data = JSON.stringify(body ?? {}); // like the UI: always a JSON body (with its length, as browsers send it)
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(b) }));
      });
      req.on('error', reject);
      req.end(data);
    });
    return { ...w, bot, store, call, close: () => new Promise((r) => server.close(r)) };
  }

  it('a paper bot saved before the fee fix drops its old fee checkpoint and value history (the 10^48 spike); a live bot keeps its history', async () => {
    const first = await serve();
    let saved: MultiState;
    try {
      await first.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
      await first.bot.tickAll();
      saved = JSON.parse(JSON.stringify(first.store.load()));
    } finally { await first.close(); }
    // as version 1 saved them
    const paper = saved.lps[0] as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    Object.assign(paper, { version: 1, equity: [[1, 1000], [2, 1.5e48], [3, 999]] });
    paper.position.paper = { in0: '123', in1: '456', owed0: '0', owed1: '0' };
    const live = JSON.parse(JSON.stringify(paper));
    Object.assign(live, { id: 'lp-live', mode: 'live', equity: [[1, 2000], [2, 2001]] });
    live.position = { ...live.position, id: '1472740' };
    delete live.position.paper;
    saved.lps.push(live);
    const store = new MemoryStore<MultiState>();
    store.save(saved);
    const again = await serve(store);
    try {
      const st = (id: string) => again.bot.status().lps.find((x: { id: string }) => x.id === id)!;
      expect(st(paper.id).position!.paper).toEqual({ g0: '0', g1: '0', inRange: false, owed0: '0', owed1: '0' });
      expect(st(paper.id).equity).toEqual([]);
      expect(st('lp-live').equity).toEqual([[1, 2000], [2, 2001]]);
      await again.bot.tickAll(); // first reading: starts earning from here
      expect(st(paper.id).owed).toEqual({ base: 0, quote: 0 });
      expect(st(paper.id).equity).toHaveLength(1);
      expect(st(paper.id).equity[0][1]).toBeGreaterThan(990);
      expect(st(paper.id).equity[0][1]).toBeLessThan(1000);
    } finally { await again.close(); }
  });

  it('a paper bot that saved a wrapped fee (~2^128 × L from a stale reading) earns again from scratch; normal paper and live bots keep theirs', async () => {
    const first = await serve();
    let saved: MultiState;
    try {
      await first.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
      await first.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
      await first.bot.tickAll();
      saved = JSON.parse(JSON.stringify(first.store.load()));
    } finally { await first.close(); }
    // as version 2 saved them: one took a lower counter reading as a wrap (the 1.6e40 USDC bot), one earned normally
    const [bad, good] = saved.lps as unknown as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const L = BigInt(bad.position.liquidity);
    Object.assign(bad, { version: 2, equity: [[1, 1000], [2, 6.6e39]] });
    bad.position.paper = { ...bad.position.paper, owed0: '17', owed1: ((L << 128n) - 12345n).toString() };
    Object.assign(good, { version: 2, equity: [[1, 1000], [2, 1001]] });
    good.position.paper = { ...good.position.paper, owed0: (L * 6000n).toString(), owed1: '99' };
    const live = JSON.parse(JSON.stringify(bad));
    Object.assign(live, { id: 'lp-live', mode: 'live', equity: [[1, 2000], [2, 2001]] });
    live.position = { ...live.position, id: '1472740' };
    delete live.position.paper;
    saved.lps.push(live);
    const store = new MemoryStore<MultiState>();
    store.save(saved);
    const again = await serve(store);
    try {
      const st = (id: string) => again.bot.status().lps.find((x: { id: string }) => x.id === id)!;
      expect(st(bad.id).position!.paper).toEqual({ g0: '0', g1: '0', inRange: false, owed0: '0', owed1: '0' });
      expect(st(bad.id).equity).toEqual([]);
      expect(st(good.id).position!.paper).toEqual(good.position.paper);
      expect(st(good.id).equity).toEqual([[1, 1000], [2, 1001]]);
      expect(st('lp-live').equity).toEqual([[1, 2000], [2, 2001]]);
    } finally { await again.close(); }
  });

  it('a bot saved before version 5: earlier fees count in the quote coin, an open position\'s coins are taken at its next reading', async () => {
    const first = await serve();
    let saved: MultiState;
    try {
      await first.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
      await first.bot.tickAll();
      saved = JSON.parse(JSON.stringify(first.store.load()));
    } finally { await first.close(); }
    const [old] = saved.lps as unknown as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    // as version 4 saved it: fees as one amount in the quote coin, the coins it opened with, no per-position coins
    Object.assign(old, { version: 4, totals: { fees: 12.5, gas: 1, sent: 0 }, opening: { base: 1, quote: 2, gas: 0 }, missed: 3, moves: [1], seen: { ...old.seen, out: false } });
    delete old.position.putIn;
    const store = new MemoryStore<MultiState>();
    store.save(saved);
    const again = await serve(store);
    try {
      await again.bot.tickAll();
      const st = again.bot.status().lps.find((x: { id: string }) => x.id === old.id)!;
      expect(st.totals).toEqual({ fees: 12.5, gas: expect.any(Number), sent: 0, feeCoins: { base: 0, quote: 12.5 }, swapCost: 0, moveLoss: 0 });
      expect(st.position!.putIn!.base).toBeCloseTo(st.coins!.base, 9);
      expect('opening' in st).toBe(false);
      // the earlier move rule's tally and moves-per-day list are dropped
      const kept = again.store.load()!.lps.find((x) => x.id === old.id) as unknown as Record<string, unknown>;
      expect('missed' in kept || 'moves' in kept).toBe(false);
      expect(Object.keys(kept.seen as object)).toEqual(['g0', 'g1']);
    } finally { await again.close(); }
  });

  it('starts from the API, opens on the next poll, and every control works; a position blocks Remove until closed', async () => {
    const a = await serve();
    try {
      const ml = a.bot.marketList();
      expect(ml.find((m) => m.key === 'pulsechain:PLS/DAI#9mm')!.lpOk).toBe(true);
      expect(ml.find((m) => m.key === 'DAI')!.lpOk).toBe(false); // PulseX V2: no position manager
      const bad = await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'DAI', bandPct: 0.1, capital: 100 });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/needs a V3 pool/);
      expect(a.bot.status().lps).toHaveLength(0); // a failed start leaves nothing behind

      const r = await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.08, capital: 500, profits: { mode: 'reinvest' } });
      expect(r.status).toBe(200);
      const id = r.body.id as string;
      await a.bot.tickAll();
      let st = a.bot.status().lps[0];
      expect(st).toMatchObject({ id, status: 'running', inRange: true, config: { bandPct: 0.08, capital: 500, rerange: true } });
      expect(st.position).not.toBeNull();
      expect(st.pnl!.equity).toBeLessThan(500);
      expect(st.pnl!.equity).toBeGreaterThan(495);

      expect((await a.call('PUT', `/api/bot/lps/${id}/rerange`, { enabled: false })).status).toBe(200);
      expect(a.bot.status().lps[0].config!.rerange).toBe(false);
      expect((await a.call('PUT', `/api/bot/lps/${id}/profits`, { mode: 'send', to: 'nope' })).status).toBe(400);
      expect((await a.call('POST', `/api/bot/lps/${id}/stop`)).status).toBe(200);
      expect(a.bot.status().lps[0].status).toBe('stopped');
      const del = await a.call('DELETE', `/api/bot/lps/${id}`);
      expect(del.status).toBe(400);
      expect(del.body.error).toMatch(/Close the position first/);
      expect((await a.call('POST', `/api/bot/lps/${id}/resume`)).status).toBe(200);
      expect((await a.call('POST', `/api/bot/lps/${id}/close`)).status).toBe(200);
      await a.bot.tickAll();
      st = a.bot.status().lps[0];
      expect(st).toMatchObject({ status: 'closed', position: null, step: null });
      expect((await a.call('DELETE', `/api/bot/lps/${id}`)).status).toBe(200);
      expect(a.bot.status().lps).toHaveLength(0);
    } finally { await a.close(); }
  });

  it('a restart picks the position up from the saved state; KILL ALL pauses it but it keeps being measured', async () => {
    const store = new MemoryStore<MultiState>();
    const a = await serve(store);
    let id: string;
    try {
      id = (await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 })).body.id;
      await a.bot.tickAll();
    } finally { await a.close(); }
    const before = a.bot.status().lps[0].position!;
    const b = await serve(store);
    try {
      expect(b.bot.status().lps[0]).toMatchObject({ id, status: 'running', position: before });
      b.bot.stopAll();
      await b.bot.tickAll();
      const st = b.bot.status().lps[0];
      expect(st.status).toBe('stopped');
      expect(st.value).toBeGreaterThan(990); // still read while paused
    } finally { await b.close(); }
  });

  it('earned after costs = fees − gas − swaps − lost to moves; the price part is the rest; the overview counts the bot', async () => {
    const a = await serve();
    try {
      await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
      await a.bot.tickAll();
      a.m.addFees(a.pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n);
      a.m.movePrice(a.pool, 1.03); // stays inside the ±10% range
      await a.bot.tickAll();
      const st = a.bot.status().lps[0], p = st.pnl!;
      expect(p.fees).toBeGreaterThan(0);
      expect(p.gas).toBeGreaterThan(0);
      expect(p.net).toBeCloseTo(p.fees - p.gas - p.swapCost - p.moveLoss, 9);
      expect(p.equity).toBeCloseTo(st.value! + st.totals.sent - st.totals.gas, 9);
      expect(p.price).toBeCloseTo(p.equity - st.startValue! - p.net, 9);
      const row = a.bot.overview('paper').bots.find((x) => x.kind === 'lp')!;
      expect(a.bot.overview('live').bots).toEqual([]); // a paper bot never shows up in live analytics
      expect((await a.call('GET', '/api/analytics/overview')).status).toBe(400); // a mode is required
      expect((await a.call('GET', '/api/analytics/overview?mode=paper')).body.bots).toHaveLength(1);
      expect(row.capital).toBe(1000);
      expect(row.equity).toBeCloseTo(p.equity, 9);
      expect(row.realized).toBeCloseTo(p.net, 9);
      expect(row.unrealized).toBeCloseTo(p.price, 9);
    } finally { await a.close(); }
  });
});
