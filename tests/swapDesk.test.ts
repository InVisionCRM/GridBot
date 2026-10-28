/** Taxes, gas, holds and reservations on the swap service. Nothing is broadcast. */
import { describe, expect, it } from 'vitest';
import { chainByKey } from '../src/live/chains';
import { clearDecimalsCache } from '../src/live/decimals';
import { amountToUnits } from '../src/live/decimals';
import type { MarketDef, SafetyReport } from '../src/live/markets';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { NETWORKS } from '../src/live/networks';
import { NATIVE, applySlippage, getAmountOut } from '../src/live/swapMath';
import { afterTax } from '../src/live/tax';
import { ROUTER, V3_QUOTER, V3_ROUTER } from '../src/server/dex/abis';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { Converter } from '../src/server/convert/converter';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { DEFAULT_TRADER, TokenTrader, type LiveFill, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import { SpendHolds, type ReservedBalance } from '../src/server/swap/holds';
import { SwapService } from '../src/server/swap/service';
import type { SwapAllocation } from '../src/server/swap/types';
import { swapForHost } from '../src/server/swap/wire';
import { MockChain, NET, ME } from './helpers/mockChain';
import { MultiDexMock, type Tok } from './helpers/multiDex';

const RH = chainByKey('robinhood')!;
const UNI = RH.dexes.find((d) => d.id === 'uniswap-v3')!;
const V2 = RH.dexes.find((d) => d.id === 'uniswap-v2')!;
const WETH: Tok = { address: RH.wrappedNative.address, symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' };
const USDG: Tok = { address: RH.stables[0].address, symbol: 'USDG', decimals: 6, name: 'Global Dollar' };
const MEME: Tok = { address: '0x' + 'ab'.repeat(20), symbol: 'MEME', decimals: 18, name: 'Meme' };
const OWNER = '0x1234567890123456789012345678901234567890';
const OTHER = '0x' + 'cd'.repeat(20);
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const raw = (human: number, dec: number) => BigInt(Math.round(human * 1e6)) * 10n ** BigInt(dec) / 1_000_000n;

function fund(m: MultiDexMock, token: Tok, amount: bigint) {
  m.wallet.set(`${OWNER.toLowerCase()}:${token.address.toLowerCase()}`, amount);
}

function world(o: { v2?: { a: Tok; aAmt: number; b: Tok; bAmt: number }; v3?: boolean } = {}) {
  const m = new MultiDexMock();
  m.addToken(WETH);
  m.addToken(USDG);
  m.addToken(MEME);
  m.gasPrice = 1_000n * 10n ** 9n;
  m.native = 100n * E18;
  fund(m, WETH, 1_000n * E18);
  fund(m, USDG, 1_000n * E6);
  fund(m, MEME, 1_000n * E18);
  m.addV2('uniswap-v2', { router: V2.router, factory: V2.factory, feeBps: 30, wrapped: WETH.address });
  if (o.v2) m.v2Pair('uniswap-v2', o.v2.a, o.v2.aAmt, o.v2.b, o.v2.bAmt);
  if (o.v3) {
    m.addV3('uniswap-v3', { factory: UNI.factory, quoter: UNI.quoter! });
    m.v3Pool('uniswap-v3', WETH, 100, USDG, 300_000, 500);
  }
  return m;
}

function serviceFor(m: MultiDexMock, o: {
  allocations?: () => SwapAllocation[];
  reservations?: ReservedBalance[] | (() => ReservedBalance[]);
  holds?: SpendHolds;
  now?: () => number;
  taxes?: (chainId: number, token: string) => { buy: number; sell: number; transfer: number };
  v3Proven?: (chainId: number, token: string) => boolean;
  signer?: boolean;
} = {}) {
  clearDecimalsCache();
  const signer = o.signer === false ? null : {
    getAddress: async () => OWNER,
    sendTransaction: async () => { throw new Error('swap service must not send'); },
  };
  const rt = new ChainRuntime(RH, m, signer);
  const now = o.now ?? (() => 1_800_000_000_000);
  const service = new SwapService({
    runtime: () => rt,
    allocations: o.allocations ?? (() => []),
    reservations: !o.reservations ? undefined : typeof o.reservations === 'function' ? o.reservations : () => o.reservations as ReservedBalance[],
    holds: o.holds ?? new SpendHolds({ now }),
    taxes: o.taxes,
    v3Proven: o.v3Proven,
    nowSec: () => Math.floor(now() / 1000),
  });
  return { service, rt };
}

describe('swap desk rules', () => {
  it('a transfer-only tax sets taxOut so minOut is the post-tax amount', async () => {
    const m = world({ v2: { a: WETH, aAmt: 100, b: USDG, bAmt: 300_000 } });
    const { service } = serviceFor(m, {
      taxes: (_c, token) => token.toLowerCase() === USDG.address.toLowerCase()
        ? { buy: 0, sell: 0, transfer: 0.03 } : { buy: 0, sell: 0, transfer: 0 },
    });
    const amountIn = E18;
    const q = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'paper', slippageBps: 100,
    });
    const routerOut = getAmountOut(amountIn, raw(100, 18), raw(300_000, 6), 30);
    const expected = afterTax(routerOut, 0.03);
    expect(q.fees.taxOut).toBe(0.03);
    expect(q.expectedOut).toBe(expected);
    expect(q.minOut).toBe(applySlippage(expected, 100));
    expect(q.minOut < routerOut).toBe(true);
    expect(q.feeOnTransfer).toBe(true);
  });

  it('prices gas at base fee plus tip, not maxFeePerGas', async () => {
    const m = world({ v2: { a: WETH, aAmt: 100, b: USDG, bAmt: 300_000 } });
    const base = 100n * 10n ** 9n;
    const tip = 2n * 10n ** 9n;
    m.gasPrice = 1_000n * 10n ** 9n;
    m.getFeeData = async () => ({ gasPrice: m.gasPrice, maxFeePerGas: m.gasPrice, maxPriorityFeePerGas: tip });
    (m as MultiDexMock & { getBlockNumber: () => Promise<number>; getBlock: (n: number) => Promise<{ baseFeePerGas: bigint }> }).getBlockNumber = async () => 1;
    (m as MultiDexMock & { getBlock: (n: number) => Promise<{ baseFeePerGas: bigint }> }).getBlock = async () => ({ baseFeePerGas: base });
    const { service } = serviceFor(m);
    const q = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn: E18, owner: OWNER, mode: 'paper',
    });
    expect(q.gasWei).toBe(BigInt(RH.gasUnits.swap) * (base + tip));
    expect(q.gasWei < BigInt(RH.gasUnits.swap) * m.gasPrice).toBe(true);
  });

  it('prices gas through a wrapped-native pool when neither token is wrapped', async () => {
    const m = world();
    m.v2Pair('uniswap-v2', WETH, 100, USDG, 300_000);
    m.v2Pair('uniswap-v2', MEME, 1_000_000, USDG, 2_000_000);
    const { service } = serviceFor(m);
    const q = await service.quote({
      chainId: 4663, tokenIn: MEME.address, tokenOut: USDG.address, amountIn: E18, owner: OWNER, mode: 'paper',
    });
    const gasWei = BigInt(RH.gasUnits.swap) * m.gasPrice;
    expect(q.route.gasOut).toBe(getAmountOut(gasWei, raw(100, 18), raw(300_000, 6), 30));
    expect(q.route.gasOut > 0n).toBe(true);
    expect(q.route.netOut).toBe(q.expectedOut - q.route.gasOut);
  });

  it('quotes and swaps a taxed V3 input for the same amount', async () => {
    const m = world({ v3: true });
    const seen: { to: string; data: string }[] = [];
    const orig = m.call.bind(m);
    m.call = async (c) => { seen.push({ to: c.to, data: c.data }); return orig(c); };
    const { service } = serviceFor(m, {
      taxes: (_c, token) => token.toLowerCase() === WETH.address.toLowerCase()
        ? { buy: 0, sell: 0.05, transfer: 0 } : { buy: 0, sell: 0, transfer: 0 },
      v3Proven: (_c, token) => token.toLowerCase() === WETH.address.toLowerCase(),
    });
    const amountIn = E18;
    const q = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'live',
    });
    expect(q.route.kind).toBe('v3');
    const quoted = seen.find((c) => c.data.startsWith(V3_QUOTER.getFunction('quoteExactInputSingle').selector))!;
    const params = V3_QUOTER.decodeFunctionData('quoteExactInputSingle', quoted.data)[0] as { amountIn: bigint };
    expect(params.amountIn).toBe(amountIn);
    expect(params.amountIn).not.toBe(afterTax(amountIn, 0.05));
    const outer = V3_ROUTER.parseTransaction({ data: q.tx!.data })!;
    const inner = V3_ROUTER.parseTransaction({ data: (outer.args[1] as string[])[0] })!;
    expect((inner.args[0] as { amountIn: bigint }).amountIn).toBe(amountIn);
    expect(q.holdId).toBeTruthy();
  });

  it('live mode pins owner and recipient to the signer', async () => {
    const m = world({ v2: { a: WETH, aAmt: 100, b: USDG, bAmt: 300_000 } });
    fund(m, WETH, 10n * E18);
    m.wallet.set(`${OTHER.toLowerCase()}:${WETH.address.toLowerCase()}`, 0n);
    const { service } = serviceFor(m);
    const q = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn: E18,
      owner: OTHER, recipient: OTHER, mode: 'live',
    });
    const parsed = ROUTER.parseTransaction({ data: q.tx!.data })!;
    expect(parsed.args[3]).toBe(OWNER);
    expect(q.tx).toMatchObject({ to: V2.router });
  });

  it('two live quotes cannot both spend the same balance; paper quotes do not hold', async () => {
    const m = world({ v2: { a: USDG, aAmt: 1_000_000, b: WETH, bAmt: 100 } });
    fund(m, USDG, 1_000n * E6);
    let now = 1_800_000_000_000;
    const holds = new SpendHolds({ now: () => now });
    const { service } = serviceFor(m, { holds, now: () => now });
    const req = (amountIn: bigint, mode: 'paper' | 'live') => service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn, owner: OWNER, mode,
    });
    const papers = await Promise.all([req(800n * E6, 'paper'), req(800n * E6, 'paper')]);
    expect(papers.every((q) => q.tx === null && q.holdId === null)).toBe(true);
    expect(holds.list()).toEqual([]);

    const settled = await Promise.allSettled([req(800n * E6, 'live'), req(800n * E6, 'live')]);
    const ok = settled.filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof req>>>[];
    const bad = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(String(bad[0].reason.message)).toMatch(/reservations/);
    expect(ok[0].value.tx).not.toBeNull();
    expect(ok[0].value.holdId).toBeTruthy();

    service.release(ok[0].value.holdId!);
    const again = await req(800n * E6, 'live');
    expect(again.tx).not.toBeNull();
    now += 11 * 60_000;
    const afterExpiry = await req(800n * E6, 'live');
    expect(afterExpiry.holdId).toBeTruthy();
    expect(holds.list().map((h) => h.id)).toEqual([afterExpiry.holdId]);
  });

  it('uses the hub safety report: fee-on-transfer on V2, V3 only after it is proven, and a copy builds nothing', async () => {
    const m = world({ v3: true });
    m.v2Pair('uniswap-v2', WETH, 100, USDG, 300_000);
    const signer = { getAddress: async () => OWNER, sendTransaction: async () => { throw new Error('swap service must not send'); } };
    const rt = new ChainRuntime(RH, m, signer);
    const safety = (taxMode: 'v2-fot' | 'v3-proven'): SafetyReport => ({
      at: 1, risk: 'medium', liveAllowed: true, reasons: [],
      buyTaxPct: 0, sellTaxPct: 0.05, transferTaxPct: 0,
      honeypot: false, proxy: null, depth: [], liquidityUsd: 1, simulated: true,
      taxMode, poolKind: taxMode === 'v3-proven' ? 'v3' : 'v2',
    });
    const market = (taxMode: 'v2-fot' | 'v3-proven'): MarketDef => ({
      key: 'robinhood:WETH/USDG-tax', chainId: 4663,
      base: { address: WETH.address, symbol: 'WETH', decimals: 18 },
      quote: { address: USDG.address, symbol: 'USDG', decimals: 6 },
      pool: { dex: 'uniswap-v2', kind: 'v2', address: '0x' + '12'.repeat(20), feeBps: 30 },
      probe: 1, quoteKind: 'stable', custom: true, safety: safety(taxMode),
    });
    const amountIn = E18;
    const ask = (hub: Hub) => swapForHost(false, { hub, allocations: () => [], reservations: () => [] })!.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn,
      owner: OTHER, recipient: OTHER, mode: 'live',
    });
    const blocked = await ask(new Hub({ runtimes: [rt], markets: [market('v2-fot')], legacyNet: NETWORKS.mainnet }));
    expect(blocked.route.id).toBe('uniswap-v2');
    expect(blocked.feeOnTransfer).toBe(true);
    expect(blocked.fees).toMatchObject({ taxIn: 0.05, taxOut: 0 });
    const poolIn = afterTax(amountIn, 0.05);
    const routerOut = getAmountOut(poolIn, raw(100, 18), raw(300_000, 6), 30);
    expect(blocked.expectedOut).toBe(routerOut);
    expect(blocked.minOut).toBe(applySlippage(routerOut, 100));
    const parsed = ROUTER.parseTransaction({ data: blocked.tx!.data })!;
    expect(parsed.name).toBe('swapExactTokensForTokensSupportingFeeOnTransferTokens');
    expect(parsed.args[0]).toBe(amountIn);
    expect(parsed.args[1]).toBe(blocked.minOut);
    expect(parsed.args[3]).toBe(OWNER);

    const proven = await ask(new Hub({ runtimes: [rt], markets: [market('v3-proven')], legacyNet: NETWORKS.mainnet }));
    expect(proven.route.kind).toBe('v3');
    expect(swapForHost(true, { hub: new Hub({ runtimes: [rt], markets: [market('v2-fot')], legacyNet: NETWORKS.mainnet }), allocations: () => [], reservations: () => [] })).toBeUndefined();
  });

  it('counts token-trader positions, converter jobs and in-flight router moves', async () => {
    const pos = (mode: 'live' | 'paper'): Position => ({
      id: mode, chainId: 4663, pool: '0x' + '11'.repeat(20), dex: 'uniswap-v2', label: 'MEME/USDG',
      token: MEME.address, spend: USDG.address, mode, entryPrice: 1, price: 1, peak: 1,
      tokens: 40, entryTokens: 40, spent: 250, spentUsd: 250, openedAt: 1, entryVolume: 0, volume: 0,
      entryLiq: 0, liq: 0, entrySellTax: 0, sellTax: 0, sellSimOk: true, feeBps: 30, quoteReserve: 1, tokenReserve: 1,
      usdPerSpend: 1, buyTax: 0, tp1Done: false, tp2Done: false, source: 'scan', exitPlan: 'hold',
    });
    const store = new MemoryStore<TraderState>();
    store.save({ version: 1, on: true, options: DEFAULT_TRADER, positions: [pos('live'), pos('paper')], trades: [], feed: [], cursors: {}, snipesAt: [] });
    const trader = new TokenTrader({ store });
    expect(trader.reservations()).toEqual([
      { chainId: 4663, address: MEME.address, native: false, amount: 40, source: 'token-trader' },
      { chainId: 4663, address: USDG.address, native: false, amount: 250, source: 'token-trader' },
    ]);

    const m = world({ v2: { a: USDG, aAmt: 1_000_000, b: WETH, bAmt: 400 } });
    fund(m, USDG, 1_000n * E6);
    const { service } = serviceFor(m, { reservations: trader.reservations() });
    await expect(service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn: 800n * E6, owner: OWNER, mode: 'paper',
    })).rejects.toThrow(/reservations/);
    const ok = await service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn: 700n * E6, owner: OWNER, mode: 'paper',
    });
    expect(ok.expectedOut > 0n).toBe(true);

    const chain = new MockChain(0.00001);
    chain.pls = 10_000_000n * E18;
    chain.setBal('DAI', 20);
    const hub = Hub.single(NET, chain, chain);
    const cv = new Converter({ hub, allocations: () => [], approval: 'exact', fetchJson: async () => ({ items: [], next_page_params: null }), pollMs: 1 });
    const plan = await cv.plan({ chainId: NET.chainId, target: NATIVE });
    const coin = plan.rows.find((r) => r.ok && r.amount > 0 && r.coin.symbol === 'DAI');
    expect(coin).toBeTruthy();
    cv.run(plan.id, [coin!.coin.id]);
    const held = cv.reservations();
    expect(held.some((r) => r.source === 'converter' && r.amount > 0 && r.chainId === NET.chainId)).toBe(true);
    for (let i = 0; i < 400 && !cv.job()?.finishedAt; i++) await new Promise((r) => setTimeout(r, 5));
    expect(cv.job()?.finishedAt).toBeTruthy();
    expect(cv.reservations()).toEqual([]);

    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.000009, upperPrice: 0.000011, gridCount: 4, totalCapitalUsd: 20 });
    const eng = (bot as unknown as { engines: Map<string, { state: { mode: string; inFlight: unknown } }> }).engines.get(id)!;
    eng.state.mode = 'live';
    eng.state.inFlight = {
      job: { id: 'j', intervalIndex: 0, side: 'buy', triggerPrice: 1, levelPrice: 1, amount: 12, createdAt: 1 },
      tokenOut: WETH.address, decimalsOut: 18, amountInHuman: 12, price: 1, deadline: 1,
    };
    expect(bot.routerReservations()).toEqual([expect.objectContaining({ amount: 12, source: 'in-flight', chainId: NET.chainId })]);
  });

  it('reserves the spend coin of an in-flight live buy until it lands or fails', async () => {
    const gate = (): GateInput => ({
      mode: 'live', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 6,
      buyTax: 0, sellTax: 0, liquidityUsd: 1e5, minLiquidityUsd: 0,
      canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
      holderConcentration: null, recentLiqPull: false, liveAllowed: true,
    });
    const fresh: FreshPool = {
      chainId: 4663, pool: '0x' + '11'.repeat(20), dex: 'uniswap-v2', kind: 'v2',
      token: MEME.address, spend: USDG.address, tokenSymbol: 'MEME', spendSymbol: 'USDG',
      liquidityUsd: 1e5, volumeUsd: 1e4, createdAt: 0, source: 'new',
      quoteReserve: 1_000_000, tokenReserve: 1_000_000, feeBps: 30, price: 1, usdPerSpend: 1,
    };
    async function hangBuy(end: 'fill' | 'fail') {
      let go!: (v: LiveFill | Error) => void;
      let started!: () => void;
      const opened = new Promise<void>((r) => { started = r; });
      const gateP = new Promise<LiveFill>((resolve, reject) => {
        go = (v) => (v instanceof Error ? reject(v) : resolve(v));
      });
      let spend = 0;
      const trader = new TokenTrader({
        store: new MemoryStore<TraderState>(),
        now: () => 1_800_000_000_000,
        discover: async () => [fresh],
        assess: async () => gate(),
        live: {
          buy: async (_pool, amount) => { spend = amount; started(); return gateP; },
          sell: async () => { throw new Error('no sell'); },
        },
      });
      trader.configure({ mode: 'live', perTradeUsd: 800, totalUsd: 800, minPoolAgeSec: 0, chains: [4663] });
      trader.turnOn();
      const ticking = trader.tick();
      await opened;
      const m = world({ v2: { a: USDG, aAmt: 1_000_000, b: WETH, bAmt: 400 } });
      fund(m, USDG, 1_000n * E6);
      const { service } = serviceFor(m, { reservations: () => trader.reservations() });
      const amountIn = amountToUnits(spend, 6);
      expect(trader.reservations()).toEqual([
        { chainId: 4663, address: USDG.address, native: false, amount: spend, source: 'token-trader' },
      ]);
      await expect(service.quote({
        chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn, owner: OWNER, mode: 'live',
      })).rejects.toThrow(/reservations/);
      if (end === 'fill') go({ tokens: 100, spent: spend, spentUsd: spend, price: 1, impact: 0 });
      else go(new Error('buy reverted'));
      await ticking;
      return { trader, service, amountIn, spend };
    }

    const filled = await hangBuy('fill');
    const usdg = filled.trader.reservations().filter((r) => r.address.toLowerCase() === USDG.address.toLowerCase());
    expect(usdg).toEqual([{ chainId: 4663, address: USDG.address, native: false, amount: filled.spend, source: 'token-trader' }]);
    expect(filled.trader.status().positions).toHaveLength(1);
    const left = await filled.service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address,
      amountIn: amountToUnits(1_000 - filled.spend, 6), owner: OWNER, mode: 'live',
    });
    expect(left.tx).not.toBeNull();

    const failed = await hangBuy('fail');
    expect(failed.trader.reservations()).toEqual([]);
    expect(failed.trader.status().positions).toHaveLength(0);
    const again = await failed.service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn: failed.amountIn, owner: OWNER, mode: 'live',
    });
    expect(again.tx).not.toBeNull();
  });
});
