/** Same-chain swap quotes on the multi-DEX mock. Nothing is broadcast. */
import { beforeEach, describe, expect, it } from 'vitest';
import { chainByKey } from '../src/live/chains';
import { clearDecimalsCache } from '../src/live/decimals';
import { afterTax, type Taxes } from '../src/live/tax';
import { NATIVE, applySlippage, getAmountOut } from '../src/live/swapMath';
import { ROUTER, V3_POOL, V3_QUOTER } from '../src/server/dex/abis';
import { ChainRuntime } from '../src/server/chains/runtime';
import { SwapService } from '../src/server/swap/service';
import type { SwapAggregator, SwapAllocation } from '../src/server/swap/types';
import { DAI, ME, MockChain, NET } from './helpers/mockChain';
import { MultiDexMock, type Tok } from './helpers/multiDex';

const RH = chainByKey('robinhood')!;
const UNI = RH.dexes.find((d) => d.id === 'uniswap-v3')!;
const V2 = RH.dexes.find((d) => d.id === 'uniswap-v2')!;
const WETH: Tok = { address: RH.wrappedNative.address, symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' };
const USDG: Tok = { address: RH.stables[0].address, symbol: 'USDG', decimals: 6, name: 'Global Dollar' };
const OWNER = '0x1234567890123456789012345678901234567890';
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

function fund(m: MultiDexMock, token: Tok, raw: bigint) {
  m.wallet.set(`${OWNER.toLowerCase()}:${token.address.toLowerCase()}`, raw);
}

function world(o: { v2?: { weth: number; usdg: number }; v3?: { weth: number; usdg: number; fee: number } } = {}) {
  const m = new MultiDexMock();
  m.addToken(WETH);
  m.addToken(USDG);
  m.gasPrice = 1_000n * 10n ** 9n;
  m.native = 100n * E18;
  fund(m, WETH, 1_000n * E18);
  fund(m, USDG, 1_000_000n * E6);
  if (o.v3) {
    m.addV3('uniswap-v3', { factory: UNI.factory, quoter: UNI.quoter! });
    m.v3Pool('uniswap-v3', WETH, o.v3.weth, USDG, o.v3.usdg, o.v3.fee);
  }
  if (o.v2) {
    m.addV2('uniswap-v2', { router: V2.router, factory: V2.factory, feeBps: 30, wrapped: WETH.address });
    m.v2Pair('uniswap-v2', WETH, o.v2.weth, USDG, o.v2.usdg);
  }
  return m;
}

function harness(m: MultiDexMock, o: {
  signer?: boolean; allocations?: () => SwapAllocation[]; aggregator?: SwapAggregator;
  taxes?: (chainId: number, token: string) => Taxes;
} = {}) {
  let sends = 0;
  const signer = o.signer === false ? null : {
    getAddress: async () => OWNER,
    sendTransaction: async () => { sends++; throw new Error('swap service must not send'); },
  };
  const rt = new ChainRuntime(RH, m, signer);
  const service = new SwapService({
    runtime: () => rt,
    allocations: o.allocations ?? (() => []),
    aggregator: o.aggregator,
    taxes: o.taxes,
    nowSec: () => 1_700_000_000,
  });
  return { service, sends: () => sends };
}

const raw = (human: number, dec: number) => BigInt(Math.round(human * 1e6)) * 10n ** BigInt(dec) / 1_000_000n;

beforeEach(() => clearDecimalsCache());

describe('swap quotes', () => {
  it('picks the route with the best net output after gas', async () => {
    const m = world({ v2: { weth: 100, usdg: 300_000 }, v3: { weth: 100, usdg: 300_000, fee: 500 } });
    const { service } = harness(m);
    const amountIn = E18;
    const q = await service.quote({ chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'paper', slippageBps: 50 });
    expect(q.routes.map((r) => r.id)).toEqual(['uniswap-v3', 'uniswap-v2']);
    expect(q.route.id).toBe('uniswap-v3');
    expect(q.route.netOut).toBe(q.route.amountOut - q.route.gasOut);
    expect(q.route.netOut > q.routes[1].netOut).toBe(true);
    expect(q.route.amountOut).toBe(getAmountOut(amountIn, raw(100, 18), raw(300_000, 6), 5));
    expect(q.tx).toBeNull();
    expect(q.paper).toBe(true);
    expect(q.decimalsIn).toBe(18);
    expect(q.decimalsOut).toBe(6);
  });

  it('drops an aggregator quote whose extra output does not cover its gas', async () => {
    const m = world({ v3: { weth: 100, usdg: 300_000, fee: 500 } });
    const amountIn = E18;
    const v3Out = getAmountOut(amountIn, raw(100, 18), raw(300_000, 6), 5);
    const aggregator: SwapAggregator = {
      id: 'heavy',
      quote: async () => ({ amountOut: v3Out + 1_000_000n, gasUnits: 50_000_000n, priceImpact: 0, feeBps: 4 }),
    };
    const { service } = harness(m, { aggregator });
    const q = await service.quote({ chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'paper' });
    const ext = q.routes.find((r) => r.id === 'aggregator:heavy')!;
    expect(ext.amountOut > q.routes.find((r) => r.id === 'uniswap-v3')!.amountOut).toBe(true);
    expect(ext.netOut < q.route.netOut).toBe(true);
    expect(q.route.id).toBe('uniswap-v3');
  });

  it('takes the aggregator when its net output is higher', async () => {
    const m = world({ v3: { weth: 100, usdg: 300_000, fee: 500 } });
    const amountIn = E18;
    const v3Out = getAmountOut(amountIn, raw(100, 18), raw(300_000, 6), 5);
    const aggregator: SwapAggregator = {
      id: 'cheap',
      quote: async () => ({ amountOut: v3Out * 2n, gasUnits: 21_000n, priceImpact: 0.001, feeBps: 1 }),
    };
    const { service } = harness(m, { aggregator });
    const q = await service.quote({ chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'paper' });
    expect(q.route.id).toBe('aggregator:cheap');
    expect(q.expectedOut).toBe(v3Out * 2n);
    expect(q.route.netOut > q.routes[1].netOut).toBe(true);
  });

  it('minOut is exact raw-unit slippage for 6 and 18 decimals', async () => {
    const m = world({ v2: { weth: 100, usdg: 300_000 } });
    const { service } = harness(m);
    const slip = 25;
    const reserveW = raw(100, 18), reserveU = raw(300_000, 6);
    const pick = (reserveIn: bigint, reserveOut: bigint, start: bigint) => {
      for (let i = 0n; i < 30n; i++) {
        const amountIn = start + i;
        const out = getAmountOut(amountIn, reserveIn, reserveOut, 30);
        if ((out * 9_975n) % 10_000n !== 0n) return amountIn;
      }
      throw new Error('no amount with a slippage remainder');
    };
    const in6 = pick(reserveU, reserveW, 50_000_000n);
    const toWeth = await service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn: in6, owner: OWNER, mode: 'paper', slippageBps: slip,
    });
    expect(toWeth.decimalsIn).toBe(6);
    expect(toWeth.decimalsOut).toBe(18);
    expect(toWeth.expectedOut).toBe(getAmountOut(in6, reserveU, reserveW, 30));
    expect(toWeth.expectedOut > 2n ** 53n).toBe(true);
    expect(toWeth.minOut).toBe(applySlippage(toWeth.expectedOut, slip));
    expect(toWeth.minOut).toBe(toWeth.expectedOut * 9_975n / 10_000n);

    const in18 = pick(reserveW, reserveU, E18);
    const toUsdg = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn: in18, owner: OWNER, mode: 'paper', slippageBps: slip,
    });
    expect(toUsdg.decimalsIn).toBe(18);
    expect(toUsdg.decimalsOut).toBe(6);
    expect(toUsdg.expectedOut).toBe(getAmountOut(in18, reserveW, reserveU, 30));
    expect(toUsdg.minOut).toBe(applySlippage(toUsdg.expectedOut, slip));
    expect(toUsdg.minOut).toBe(toUsdg.expectedOut * 9_975n / 10_000n);
  });

  it('fee-on-transfer: quotes the post-tax input and sets minOut after tax on the V2 method', async () => {
    const m = world({ v2: { weth: 50, usdg: 100_000 } });
    const taxes = (chainId: number, token: string): Taxes => {
      if (chainId !== 4663) return { buy: 0, sell: 0, transfer: 0 };
      if (token.toLowerCase() === USDG.address.toLowerCase()) return { buy: 0, sell: 0.05, transfer: 0 };
      if (token.toLowerCase() === WETH.address.toLowerCase()) return { buy: 0.02, sell: 0, transfer: 0 };
      return { buy: 0, sell: 0, transfer: 0 };
    };
    const { service, sends } = harness(m, { taxes });
    const amountIn = 1_000n * E6;
    const q = await service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn, owner: OWNER, mode: 'live', slippageBps: 100,
    });
    const poolIn = afterTax(amountIn, 0.05);
    const routerOut = getAmountOut(poolIn, raw(100_000, 6), raw(50, 18), 30);
    const expected = afterTax(routerOut, 0.02);
    expect(q.expectedOut).toBe(expected);
    expect(q.minOut).toBe(applySlippage(expected, 100));
    expect(q.minOut < applySlippage(routerOut, 100)).toBe(true);
    expect(q.feeOnTransfer).toBe(true);
    expect(q.fees).toMatchObject({ lpBps: 30, taxIn: 0.05, taxOut: 0.02 });
    expect(q.tx).not.toBeNull();
    const parsed = ROUTER.parseTransaction({ data: q.tx!.data })!;
    expect(parsed.name).toBe('swapExactTokensForTokensSupportingFeeOnTransferTokens');
    expect(parsed.args[0]).toBe(amountIn);
    expect(parsed.args[1]).toBe(q.minOut);
    expect(sends()).toBe(0);
  });

  it('will not spend balances reserved by live bots', async () => {
    const m = world({ v2: { weth: 100, usdg: 300_000 } });
    fund(m, USDG, 1_000n * E6);
    const allocations = (): SwapAllocation[] => [
      { chainId: 4663, address: USDG.address.toLowerCase(), native: false, allocated: 200 },
      { chainId: 4663, address: USDG.address, native: false, allocated: 400 },
      { chainId: 1, address: USDG.address, native: false, allocated: 1_000_000 },
    ];
    const { service, sends } = harness(m, { allocations });
    await expect(service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn: 500n * E6, owner: OWNER, mode: 'live',
    })).rejects.toThrow(/reservations/);
    const ok = await service.quote({
      chainId: 4663, tokenIn: USDG.address, tokenOut: WETH.address, amountIn: 300n * E6, owner: OWNER, mode: 'paper',
    });
    expect(ok.expectedOut > 0n).toBe(true);
    expect(ok.tx).toBeNull();

    m.native = 10n * E18;
    const nativeAlloc = (): SwapAllocation[] => [{ chainId: 4663, address: WETH.address, native: true, allocated: 9 }];
    const nativeSvc = harness(m, { allocations: nativeAlloc }).service;
    await expect(nativeSvc.quote({
      chainId: 4663, tokenIn: NATIVE, tokenOut: USDG.address, amountIn: 2n * E18, owner: OWNER, mode: 'paper',
    })).rejects.toThrow(/reservations/);
    const small = await nativeSvc.quote({
      chainId: 4663, tokenIn: NATIVE, tokenOut: USDG.address, amountIn: 5n * 10n ** 17n, owner: OWNER, mode: 'paper',
    });
    expect(small.expectedOut > 0n).toBe(true);
    expect(small.tx).toBeNull();
    expect(sends()).toBe(0);
  });

  it('paper mode is quote-only; live mode builds calldata and does not send', async () => {
    const m = world({ v2: { weth: 100, usdg: 300_000 } });
    const amountIn = E18;
    const paper = await harness(m).service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'paper',
    });
    expect(paper.paper).toBe(true);
    expect(paper.tx).toBeNull();
    const noKey = await harness(m, { signer: false }).service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'live',
    });
    expect(noKey.paper).toBe(true);
    expect(noKey.tx).toBeNull();
    expect(noKey.expectedOut).toBe(paper.expectedOut);

    const { service, sends } = harness(m);
    const live = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn, owner: OWNER, mode: 'live', slippageBps: 100,
    });
    expect(live.paper).toBe(false);
    expect(live.tx).toMatchObject({ chainId: 4663, to: V2.router, value: 0n });
    const parsed = ROUTER.parseTransaction({ data: live.tx!.data })!;
    expect(parsed.name).toBe('swapExactTokensForTokens');
    expect(parsed.args[1]).toBe(live.minOut);
    expect(sends()).toBe(0);
  });

  it('discovers a Robinhood 1% Uniswap V3 pool and quotes with fee() via QuoterV2', async () => {
    const m = world({ v3: { weth: 100, usdg: 300_000, fee: 10000 } });
    const seen: { to: string; data: string }[] = [];
    const orig = m.call.bind(m);
    m.call = async (c) => { seen.push({ to: c.to, data: c.data }); return orig(c); };
    const { service } = harness(m);
    const q = await service.quote({
      chainId: 4663, tokenIn: WETH.address, tokenOut: USDG.address, amountIn: 10n ** 17n, owner: OWNER, mode: 'paper',
    });
    expect(q.route.id).toBe('uniswap-v3');
    expect(q.route.pool).toMatchObject({ kind: 'v3', feeTier: 10000, feeBps: 100 });
    const feeSel = V3_POOL.getFunction('fee').selector;
    const pool = q.route.pool!.address;
    expect(seen.some((c) => c.to.toLowerCase() === pool.toLowerCase() && c.data.startsWith(feeSel))).toBe(true);
    const quoted = seen.find((c) => c.to.toLowerCase() === UNI.quoter!.toLowerCase() && c.data.startsWith(V3_QUOTER.getFunction('quoteExactInputSingle').selector));
    expect(quoted).toBeTruthy();
    const params = V3_QUOTER.decodeFunctionData('quoteExactInputSingle', quoted!.data)[0] as { fee: bigint };
    expect(params.fee).toBe(10000n);
    expect(q.expectedOut).toBe(getAmountOut(10n ** 17n, raw(100, 18), raw(300_000, 6), 100));
  });

  it('quotes PulseX on the PulseChain mock and does not send', async () => {
    const pls = chainByKey('pulsechain')!;
    const m = new MockChain(0.00001);
    const rt = new ChainRuntime(pls, m, null);
    const service = new SwapService({ runtime: () => rt, allocations: () => [], nowSec: () => 1_700_000_000 });
    const amountIn = E18;
    const pool = m.pool('DAI');
    const q = await service.quote({
      chainId: pls.id, tokenIn: DAI.address, tokenOut: NET.pulsex.wpls, amountIn, owner: ME, mode: 'live',
    });
    expect(q.paper).toBe(true);
    expect(q.tx).toBeNull();
    expect(q.decimalsIn).toBe(DAI.decimals);
    expect(q.decimalsOut).toBe(18);
    expect(q.expectedOut).toBe(getAmountOut(amountIn, pool.rQ, pool.rW, 29));
    expect(q.route.kind).toBe('v2');
    expect(['pulsex-v1', 'pulsex-v2']).toContain(q.route.id);
    expect(m.sent).toEqual([]);
  });
});
