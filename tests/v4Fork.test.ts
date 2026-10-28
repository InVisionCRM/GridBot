/**
 * Robinhood Chain (4663) V4 checks, replayed from a recorded fixture: CI makes no network call.
 *
 * Every JSON-RPC call these tests make is answered from tests/fixtures/v4Fork-rpc.json, captured from the public RPC
 * (which accepts eth_call state overrides) with every 'latest' pinned to one block. All calls therefore see the same
 * chain state, so a later quoter call can no longer drift from the probe's own quote as the live pool trades.
 * A call the fixture lacks (e.g. the probe bytecode or calldata changed) fails loudly instead of going live.
 * Re-record (read-only eth_calls, no transactions, no keys): V4FORK_RECORD=1 npx vitest run tests/v4Fork.test.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const FIXTURE = join(__dirname, 'fixtures', 'v4Fork-rpc.json');
const RECORD = process.env.V4FORK_RECORD === '1';
type Answer = { method: string; result?: unknown; error?: string };
type Fixture = { chainId: number; block: string; recordedAt: string; calls: Record<string, Answer> };

let fx: Fixture;
// Only constructed when re-recording; a replay run never creates a provider, so it cannot reach the network.
const live = RECORD ? new JsonRpcProvider(RPC, 4663, { staticNetwork: true }) : null;

/** 'latest' becomes the pinned block, so the key (and, when recording, the live call) names one exact state. */
const pin = (params: unknown[]) => params.map((p) => (p === 'latest' ? fx.block : p));
const keyOf = (method: string, params: unknown[]) => createHash('sha256').update(JSON.stringify([method, params])).digest('hex');

async function send(method: string, params: unknown[]): Promise<unknown> {
  const pinned = pin(params);
  const key = keyOf(method, pinned);
  if (live) {
    try {
      const result = await live.send(method, pinned);
      fx.calls[key] = { method, result };
      return result;
    } catch (e) {
      fx.calls[key] = { method, error: (e as Error).message.slice(0, 200) };
      throw e;
    }
  }
  const a = fx.calls[key];
  if (!a) throw new Error(`v4Fork fixture has no answer for ${method}; re-record with V4FORK_RECORD=1`);
  if (a.error !== undefined) throw new Error(a.error);
  return a.result;
}
const ethCall = (to: string, data: string) => send('eth_call', [{ to, data }, 'latest']) as Promise<string>;

function rt(): ChainRuntime {
  return { reader: { send } } as unknown as ChainRuntime;
}

beforeAll(async () => {
  if (live) {
    const block = (await live.send('eth_blockNumber', [])) as string;
    fx = { chainId: Number(await live.send('eth_chainId', [])), block, recordedAt: new Date().toISOString(), calls: {} };
  } else {
    if (!existsSync(FIXTURE)) throw new Error(`missing ${FIXTURE}; record it with V4FORK_RECORD=1`);
    fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  }
}, 30_000);

afterAll(() => {
  if (live && fx) writeFileSync(FIXTURE, JSON.stringify(fx, null, 1) + '\n');
});

describe('Robinhood V4 fork', () => {
  it('quotes the vanilla 1% ETH pool and round-trips it through SafetyProbeV4', async () => {
    expect(fx.chainId).toBe(4663);
    expect(Number(await send('eth_chainId', []))).toBe(4663);
    expect(poolId(NATIVE_KEY)).toBe(NATIVE_POOL);
    const cfg = CHAINS.find((c) => c.id === 4663)!.dexes.find((d) => d.id === 'uniswap-v4')!;
    const slotRaw = await ethCall(cfg.stateView!, V4_STATE_VIEW.encodeFunctionData('getSlot0', [NATIVE_POOL]));
    const slot = V4_STATE_VIEW.decodeFunctionResult('getSlot0', slotRaw);
    expect(Number(slot[3])).toBe(10000);
    const quoteRaw = await ethCall(cfg.quoter!, V4_QUOTER.encodeFunctionData('quoteExactInputSingle', [{
      poolKey: NATIVE_KEY, zeroForOne: true, exactAmount: 10n ** 15n, hookData: '0x',
    }]));
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
    const quoteRaw = await ethCall(cfg.quoter!, V4_QUOTER.encodeFunctionData('quoteExactInputSingle', [{
      poolKey: key, zeroForOne: true, exactAmount: proceeds, hookData: '0x',
    }]));
    const [quoted] = V4_QUOTER.decodeFunctionResult('quoteExactInputSingle', quoteRaw);
    // Same pinned state as the probe, so this is deterministic. The probe quotes its sell after its own buy has moved
    // the pool, so this pre-buy quote may sit one unit off (it does in the recorded fixture: 2115442 vs 2115443).
    // Live, the pool also traded between the two calls, which pushed the gap past one unit and flaked on macOS CI.
    const drift = probe.expectedSell > quoted ? probe.expectedSell - quoted : quoted - probe.expectedSell;
    expect(drift <= 1n).toBe(true);
    expect(probe.gotSell).toBe(probe.expectedSell);
  }, 180_000);
});
