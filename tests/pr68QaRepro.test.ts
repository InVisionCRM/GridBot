/**
 * QA repro for the native-ETH / WETH mismatch, with the assertions flipped:
 * a pool whose currency is not the market token is refused. No transaction is sent.
 * The fork leg confirms the probe sells only the bought ETH, and skips when the RPC is down.
 */
import { JsonRpcProvider } from 'ethers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHAINS } from '../src/live/chains';
import type { MarketDef, PoolRef } from '../src/live/markets';
import { LiveExecutor, Quoter, type ChainReader } from '../src/server/bot/chain';
import { ERC20, PERMIT2, V4_QUOTER, V4_STATE_VIEW } from '../src/server/dex/abis';
import type { Hop } from '../src/server/dex/safety';
import { V4Adapter } from '../src/server/dex/v4';
import { simulateV4RoundTrip, v4Leg } from '../src/server/dex/v4Safety';
import { permit2MaxExpiration, poolId, UINT160_MAX } from '../src/server/dex/v4PoolKey';
import type { ChainRuntime } from '../src/server/chains/runtime';

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TOK = '0xc50C3c7a92E1b512Ec982770Abe91948F20356d0';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ME = '0x' + '0'.repeat(34) + '0a11ce';
const PID = '0x892cfd4e384f62fc574cd1b46380b2f4028c887439b92329dfd7ca5fc706da99';
const LIMITS = { slippageBps: 100, deadlineMinutes: 5, maxPriceImpact: 0.03 };
const HOOKS = { canSend: () => true, onSent: () => undefined };

const hood = CHAINS.find((c) => c.id === 4663)!;
const cfg = hood.dexes.find((d) => d.id === 'uniswap-v4')!;

const nativePool: PoolRef = {
  dex: 'uniswap-v4', kind: 'v4', address: PID, feeBps: 100,
  v4: { currency0: ZERO, currency1: TOK, fee: 10000, tickSpacing: 200, hooks: ZERO, poolId: PID, dynamicFee: false },
};

const wethId = '0x' + '11'.repeat(32);
const wethPool: PoolRef = {
  dex: 'uniswap-v4', kind: 'v4', address: wethId, feeBps: 30,
  v4: { currency0: WETH, currency1: TOK, fee: 3000, tickSpacing: 60, hooks: ZERO, poolId: wethId, dynamicFee: false },
};

function reader(nativeBal: bigint, permit2: { amount: bigint; expiration: bigint } = { amount: 0n, expiration: 0n }): ChainReader {
  return {
    async call(tx) {
      const sel = tx.data.slice(0, 10);
      if (sel === V4_STATE_VIEW.getFunction('getSlot0')!.selector) {
        return V4_STATE_VIEW.encodeFunctionResult('getSlot0', [1908495653441889301188931688731428n, 201799n, 0n, 10000n]);
      }
      if (sel === V4_STATE_VIEW.getFunction('getLiquidity')!.selector) {
        return V4_STATE_VIEW.encodeFunctionResult('getLiquidity', [10n ** 22n]);
      }
      if (sel === V4_QUOTER.getFunction('quoteExactInputSingle')!.selector) {
        return V4_QUOTER.encodeFunctionResult('quoteExactInputSingle', [5n * 10n ** 23n, 40_000n]);
      }
      if (sel === ERC20.getFunction('balanceOf')!.selector) return ERC20.encodeFunctionResult('balanceOf', [10n ** 20n]);
      if (sel === ERC20.getFunction('allowance')!.selector) return ERC20.encodeFunctionResult('allowance', [0n]);
      if (sel === ERC20.getFunction('decimals')!.selector) return ERC20.encodeFunctionResult('decimals', [18]);
      if (sel === PERMIT2.getFunction('allowance')!.selector) {
        return PERMIT2.encodeFunctionResult('allowance', [permit2.amount, permit2.expiration, 0n]);
      }
      throw new Error(`unexpected ${sel}`);
    },
    async getBalance() { return nativeBal; },
    async getFeeData() { return { gasPrice: 10n ** 7n, maxFeePerGas: null }; },
    async getTransactionCount() { return 7; },
    async getTransactionReceipt() { return null; },
  };
}

function market(pool: PoolRef, nativeQuote = false): MarketDef {
  return {
    key: 'TOK/WETH', chainId: 4663,
    base: { address: TOK, symbol: 'TOK', decimals: 18 },
    quote: { address: WETH, symbol: nativeQuote ? 'ETH' : 'WETH', decimals: 18, ...(nativeQuote ? { native: true } : {}) },
    pool, probe: 1, quoteKind: 'wrapped', custom: true,
  };
}

function rig(nativeBal: bigint, pool: PoolRef, nativeQuote = false, approval: 'exact' | 'max' = 'exact', permit2?: { amount: bigint; expiration: bigint }) {
  const sent: { to: string; data: string; value: bigint }[] = [];
  const ad = new V4Adapter(reader(nativeBal, permit2), cfg, WETH);
  const q = new Quoter(reader(nativeBal, permit2), market(pool, nativeQuote), { chain: hood, adapter: ad });
  const signer = {
    async getAddress() { return ME; },
    async sendTransaction(tx: { to: string; data: string; value: bigint }) {
      sent.push({ to: tx.to, data: tx.data, value: tx.value });
      const hash = '0x' + sent.length.toString(16).padStart(64, '0');
      return { hash, wait: async () => ({ status: 1, gasUsed: 21_000n, gasPrice: 10n ** 7n, logs: [] as [] }) };
    },
  };
  const ex = new LiveExecutor(q, signer, { approval, receiptTimeoutMs: 1000 });
  return { sent, ex, q };
}

describe('PR 68 QA repro: V4 currency must match the market', () => {
  it('blocks a WETH-market buy of an address(0) pool and sends nothing', async () => {
    const { sent, ex } = rig(10n ** 15n, nativePool);
    const q = await ex.quote('buy', 0.0009, LIMITS);
    expect(q.tokenIn).toBe(WETH);
    expect(q.call.value).toBe(0n);
    expect(q.balanceOk).toBe(false);
    expect(q.balanceNote).toMatch(/native ETH and WETH/);
    await expect(ex.execute(q, HOOKS)).rejects.toThrow(/native ETH and WETH/);
    expect(sent).toHaveLength(0);
  });

  it('blocks a WETH-market sell of an address(0) pool and does not book minOut', async () => {
    const { sent, ex } = rig(10n ** 18n, nativePool);
    const q = await ex.quote('sell', 1000, LIMITS);
    expect(q.tokenOut).toBe(WETH);
    expect(q.balanceOk).toBe(false);
    expect(q.call.value).toBe(0n);
    await expect(ex.execute(q, HOOKS)).rejects.toThrow(/native ETH and WETH/);
    expect(sent).toHaveLength(0);
  });

  it('blocks a native market on a WETH-currency pool', async () => {
    const { sent, ex } = rig(10n ** 18n, wethPool, true);
    const q = await ex.quote('buy', 0.0009, LIMITS);
    expect(q.tokenIn).toBe('native');
    expect(q.balanceOk).toBe(false);
    expect(q.permit2).toBeUndefined();
    await expect(ex.execute(q, HOOKS)).rejects.toThrow(/native ETH and WETH/);
    expect(sent).toHaveLength(0);
  });

  it('caps a max Permit2 approval at 30 days, keeps both approval hashes, and skips gas when the allowance covers the trade', async () => {
    const open = rig(10n ** 18n, wethPool, false, 'max');
    const q = await open.ex.quote('buy', 0.0009, LIMITS);
    expect(q.balanceOk).toBe(true);
    expect(q.call.value).toBe(0n);
    expect(q.tokenIn).toBe(WETH);
    expect(q.permit2?.token).toBe(WETH);
    const before = Math.floor(Date.now() / 1000);
    const fill = await open.ex.execute(q, HOOKS);
    expect(open.sent).toHaveLength(3);
    expect(open.sent[2].value).toBe(0n);
    const decoded = PERMIT2.decodeFunctionData('approve', open.sent[1].data);
    const after = Math.floor(Date.now() / 1000);
    const exp = decoded[3] as bigint;
    expect(exp >= permit2MaxExpiration(before) && exp <= permit2MaxExpiration(after)).toBe(true);
    expect(Number(exp - BigInt(before))).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(Number(exp - BigInt(after))).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    expect(fill.permit2TxHash).toBe('0x' + '2'.padStart(64, '0'));
    expect(fill.approvalTxHash).toBe(`${'0x' + '1'.padStart(64, '0')},${fill.permit2TxHash}`);

    const exact = rig(10n ** 18n, wethPool, false, 'exact');
    const qe = await exact.ex.quote('buy', 0.0009, LIMITS);
    await exact.ex.execute(qe, HOOKS);
    const exactExp = PERMIT2.decodeFunctionData('approve', exact.sent[1].data)[3] as bigint;
    expect(exactExp).toBe(qe.call.deadline);

    const covered = rig(10n ** 18n, wethPool, false, 'exact', { amount: UINT160_MAX, expiration: BigInt(after + 40 * 24 * 60 * 60) });
    const qc = await covered.ex.quote('buy', 0.0009, LIMITS);
    expect(qc.permit2).toBeUndefined();
    expect(q.gasWei - qc.gasWei).toBe(BigInt(hood.gasUnits.approve) * 10n ** 7n);
  });
});

describe('PR 68 QA repro: native ETH sell is only the bought remainder', () => {
  const provider = new JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
  let rpc: 'up' | 'down' | 'wrong' = 'down';
  beforeAll(async () => {
    try {
      const id = await Promise.race([
        provider.send('eth_chainId', []),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000)),
      ]);
      rpc = Number(id) === 4663 ? 'up' : 'wrong';
    } catch { rpc = 'down'; }
  }, 12_000);

  it('sellIn equals gotBuy minus the transfer, and skips when the RPC is unreachable', async (ctx) => {
    if (rpc === 'down') ctx.skip();
    const key = { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
    const id = '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982';
    expect(poolId(key)).toBe(id);
    const v3 = hood.dexes.find((d) => d.id === 'uniswap-v3')!;
    const pool: PoolRef = {
      dex: 'uniswap-v4', kind: 'v4', address: id, feeBps: 5,
      v4: { ...key, poolId: id, dynamicFee: false },
    };
    const prep: Hop = { kind: 1, router: v3.router, quoter: v3.quoter!, fee: 100, tokenIn: WETH, tokenOut: USDG };
    const rt = { reader: { send: (method: string, params: unknown[]) => provider.send(method, params) } } as unknown as ChainRuntime;
    const probe = await simulateV4RoundTrip(rt, {
      weth: WETH, wethIn: 10n ** 15n, prep,
      buy: v4Leg(pool, USDG, WETH, cfg, WETH),
      sell: v4Leg(pool, WETH, USDG, cfg, WETH),
    });
    expect(probe.stage, probe.err).toBe(0);
    expect(probe.sellIn).toBe(probe.gotBuy - probe.transferSent);
    expect(probe.sellIn < probe.gotBuy).toBe(true);
  }, 180_000);
});
