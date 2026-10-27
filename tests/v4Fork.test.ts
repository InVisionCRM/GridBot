/**
 * Live Robinhood Chain (4663) checks. The public RPC accepts eth_call state overrides.
 * Skipped when the RPC cannot be reached, so a unit run without network still passes the rest of the suite
 * only if this file's own `it`s are the ones that need the network — they fail closed when the chain id is wrong.
 */
import { JsonRpcProvider } from 'ethers';
import { describe, expect, it } from 'vitest';
import { CHAINS } from '../src/live/chains';
import type { ChainRuntime } from '../src/server/chains/runtime';
import { V4_QUOTER, V4_STATE_VIEW } from '../src/server/dex/abis';
import type { Hop } from '../src/server/dex/safety';
import { simulateV4RoundTrip, v4Leg } from '../src/server/dex/v4Safety';
import { poolId } from '../src/server/dex/v4PoolKey';
import type { PoolRef } from '../src/live/markets';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NATIVE_KEY = {
  currency0: ZERO,
  currency1: '0xc50C3c7a92E1b512Ec982770Abe91948F20356d0',
  fee: 10000,
  tickSpacing: 200,
  hooks: ZERO,
};
const NATIVE_POOL = '0x892cfd4e384f62fc574cd1b46380b2f4028c887439b92329dfd7ca5fc706da99';

const provider = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });

function rt(): ChainRuntime {
  return { reader: { send: (method: string, params: unknown[]) => provider.send(method, params) } } as unknown as ChainRuntime;
}

describe('Robinhood V4 fork', () => {
  it('quotes the vanilla 1% ETH pool and round-trips it through SafetyProbeV4', async () => {
    const chainId = Number(await provider.send('eth_chainId', []));
    expect(chainId).toBe(4663);
    expect(poolId(NATIVE_KEY)).toBe(NATIVE_POOL);
    const cfg = CHAINS.find((c) => c.id === 4663)!.dexes.find((d) => d.id === 'uniswap-v4')!;
    const slotRaw = await provider.call({ to: cfg.stateView!, data: V4_STATE_VIEW.encodeFunctionData('getSlot0', [NATIVE_POOL]) });
    const slot = V4_STATE_VIEW.decodeFunctionResult('getSlot0', slotRaw);
    expect(Number(slot[3])).toBe(10000);
    const quoteRaw = await provider.call({
      to: cfg.quoter,
      data: V4_QUOTER.encodeFunctionData('quoteExactInputSingle', [{
        poolKey: NATIVE_KEY, zeroForOne: true, exactAmount: 10n ** 15n, hookData: '0x',
      }]),
    });
    const [amountOut] = V4_QUOTER.decodeFunctionResult('quoteExactInputSingle', quoteRaw);
    expect(amountOut > 0n).toBe(true);

    const pool: PoolRef = {
      dex: 'uniswap-v4', kind: 'v4', address: NATIVE_POOL, feeBps: 100,
      v4: { ...NATIVE_KEY, poolId: NATIVE_POOL, dynamicFee: false },
    };
    const probe = await simulateV4RoundTrip(rt(), {
      weth: WETH, wethIn: 10n ** 15n, prep: null,
      buy: v4Leg(pool, WETH, NATIVE_KEY.currency1, cfg, WETH),
      sell: v4Leg(pool, NATIVE_KEY.currency1, WETH, cfg, WETH),
    });
    expect(probe.stage, probe.err).toBe(0);
    expect(probe.expectedBuy > 0n).toBe(true);
    expect(probe.gotBuy).toBe(probe.expectedBuy);
    expect(probe.transferGot).toBe(probe.transferSent);
    expect(probe.transferSent > 0n).toBe(true);
    expect(probe.expectedSell > 0n).toBe(true);
    expect(probe.gotSell).toBe(probe.expectedSell);
  }, 180_000);

  it('buys USDG→ETH through Permit2 after a V3 WETH→USDG prep hop', async () => {
    const cfg = CHAINS.find((c) => c.id === 4663)!.dexes.find((d) => d.id === 'uniswap-v4')!;
    const v3 = CHAINS.find((c) => c.id === 4663)!.dexes.find((d) => d.id === 'uniswap-v3')!;
    // No-hook 0.05% ETH/USDG pool (currency0 is native ETH). The buy input is USDG, so the probe
    // approves Permit2 and Permit2 approves the Universal Router before execute.
    const key = { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
    const id = '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982';
    expect(poolId(key)).toBe(id);
    const pool: PoolRef = {
      dex: 'uniswap-v4', kind: 'v4', address: id, feeBps: 5,
      v4: { ...key, poolId: id, dynamicFee: false },
    };
    const prep: Hop = { kind: 1, router: v3.router, quoter: v3.quoter!, fee: 100, tokenIn: WETH, tokenOut: USDG };
    const probe = await simulateV4RoundTrip(rt(), {
      weth: WETH, wethIn: 10n ** 15n, prep,
      buy: v4Leg(pool, USDG, WETH, cfg, WETH),
      sell: v4Leg(pool, WETH, USDG, cfg, WETH),
    });
    expect(probe.stage, probe.err).toBe(0);
    expect(probe.quoteIn > 0n).toBe(true);
    expect(probe.expectedBuy > 0n).toBe(true);
    expect(probe.gotBuy).toBe(probe.expectedBuy);
    expect(probe.transferGot).toBe(probe.transferSent);
    expect(probe.transferSent > 0n).toBe(true);
    expect(probe.expectedSell > 0n).toBe(true);
    expect(probe.gotSell).toBe(probe.expectedSell);
  }, 180_000);

  it('sells only the ETH bought, not the funding balance, when native ETH is the sell currency', async () => {
    const cfg = CHAINS.find((c) => c.id === 4663)!.dexes.find((d) => d.id === 'uniswap-v4')!;
    const v3 = CHAINS.find((c) => c.id === 4663)!.dexes.find((d) => d.id === 'uniswap-v3')!;
    const key = { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
    const id = '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982';
    const pool: PoolRef = {
      dex: 'uniswap-v4', kind: 'v4', address: id, feeBps: 5,
      v4: { ...key, poolId: id, dynamicFee: false },
    };
    const wethIn = 10n ** 15n;
    const prep: Hop = { kind: 1, router: v3.router, quoter: v3.quoter!, fee: 100, tokenIn: WETH, tokenOut: USDG };
    const probe = await simulateV4RoundTrip(rt(), {
      weth: WETH, wethIn, prep,
      buy: v4Leg(pool, USDG, WETH, cfg, WETH),
      sell: v4Leg(pool, WETH, USDG, cfg, WETH),
    });
    expect(probe.stage, probe.err).toBe(0);
    const proceeds = probe.gotBuy - probe.transferSent;
    // The state override endows wethIn * 4. After the WETH deposit the leftover funding is 3 * wethIn,
    // so the old sell (the whole ETH balance) is larger than the bought remainder and fails this equality.
    expect(probe.sellIn).toBe(proceeds);
    expect(probe.sellIn < wethIn * 3n).toBe(true);
    const quoteRaw = await provider.call({
      to: cfg.quoter,
      data: V4_QUOTER.encodeFunctionData('quoteExactInputSingle', [{
        poolKey: key, zeroForOne: true, exactAmount: proceeds, hookData: '0x',
      }]),
    });
    const [quoted] = V4_QUOTER.decodeFunctionResult('quoteExactInputSingle', quoteRaw);
    expect(probe.expectedSell).toBe(quoted);
    expect(probe.gotSell).toBe(quoted);
  }, 180_000);
});
