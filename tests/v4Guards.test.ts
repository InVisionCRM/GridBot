/**
 * Add-token must be able to pick a native-ETH V4 pool or a WETH V4 pool, and each guard that
 * refuses a mismatched pool has to be the reason a test fails. A hand-built quote skips Quoter.quote,
 * so only the executor guard can stop the send.
 */
import { AbiCoder } from 'ethers';
import { describe, expect, it } from 'vitest';
import { CHAINS } from '../src/live/chains';
import { clearDecimalsCache } from '../src/live/decimals';
import type { MarketDef, PoolRef } from '../src/live/markets';
import { NETWORKS } from '../src/live/networks';
import { LiveExecutor, PaperExecutor, Quoter, type ChainReader, type Quote } from '../src/server/bot/chain';
import { MemoryStore } from '../src/server/bot/store';
import { Hub } from '../src/server/chains/hub';
import { ChainRuntime } from '../src/server/chains/runtime';
import { ERC20 } from '../src/server/dex/abis';
import { V4Adapter, v4PoolMatches } from '../src/server/dex/v4';

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const TOK = '0xc50C3c7a92E1b512Ec982770Abe91948F20356d0';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ME = '0x' + '0'.repeat(34) + '0a11ce';
const enc = AbiCoder.defaultAbiCoder();

const hood = CHAINS.find((c) => c.id === 4663)!;
const cfg = hood.dexes.find((d) => d.id === 'uniswap-v4')!;

function pool(id: string, currency0: string, currency1: string, fee: number, tickSpacing: number): PoolRef {
  return {
    dex: 'uniswap-v4', kind: 'v4', address: id, feeBps: fee / 100,
    v4: { currency0, currency1, fee, tickSpacing, hooks: ZERO, poolId: id, dynamicFee: false },
  };
}

const nativePool = pool('0x' + 'aa'.repeat(32), ZERO, TOK, 10000, 200);
const wethPool = pool('0x' + '11'.repeat(32), WETH, TOK, 3000, 60);
const oddPool = pool('0x' + '22'.repeat(32), USDG, TOK, 500, 10);

function reader(): ChainReader {
  return {
    async call(tx) {
      const sel = tx.data.slice(0, 10);
      if (sel === '0x313ce567') return enc.encode(['uint256'], [18]);
      if (sel === ERC20.getFunction('symbol')!.selector) {
        return ERC20.encodeFunctionResult('symbol', [tx.to.toLowerCase() === TOK.toLowerCase() ? 'TOK' : 'WETH']);
      }
      if (sel === ERC20.getFunction('name')!.selector) return ERC20.encodeFunctionResult('name', ['Token']);
      if (sel === ERC20.getFunction('totalSupply')!.selector) return ERC20.encodeFunctionResult('totalSupply', [10n ** 18n]);
      if (sel === ERC20.getFunction('balanceOf')!.selector) return ERC20.encodeFunctionResult('balanceOf', [0n]);
      return '0x';
    },
    async getBalance() { return 0n; },
    async getFeeData() { return { gasPrice: 1n, maxFeePerGas: null }; },
    async getTransactionCount() { return 0; },
    async getTransactionReceipt() { return null; },
    async getCode() { return '0x' + '00'.repeat(500); },
  } as ChainReader;
}

function hub() {
  clearDecimalsCache();
  const ad = new V4Adapter(reader(), cfg, WETH);
  ad.findPools = async (a, b) => {
    const ids = [a.toLowerCase(), b.toLowerCase()];
    const has = (x: string) => ids.includes(x.toLowerCase());
    if (!has(TOK)) return [];
    if (has(ZERO)) return [nativePool, wethPool, oddPool];
    if (has(WETH)) return [wethPool, nativePool, oddPool];
    return [];
  };
  ad.state = async (p) => {
    const v = p.v4!;
    const face = (c: string) => c.toLowerCase() === ZERO ? WETH : c;
    return {
      pool: p, token0: face(v.currency0), token1: face(v.currency1),
      reserve0: 10n ** 24n, reserve1: 10n ** 24n, sqrtPriceX96: 2n ** 96n, liquidity: 10n ** 18n,
    };
  };
  ad.quote = async (p) => ({ amountOut: p.address === nativePool.address ? 5n * 10n ** 18n : 10n ** 18n, impact: 0.01 });
  const rt = new ChainRuntime(hood, reader(), null, { adapters: [ad] });
  return new Hub({ runtimes: [rt], markets: [], legacyNet: NETWORKS.mainnet, custom: new MemoryStore() });
}

function sendableQuote(): Quote {
  return {
    side: 'buy', tokenIn: WETH, tokenOut: TOK, decimalsIn: 18, decimalsOut: 18,
    amountIn: 10n ** 15n, quotedOut: 1n,
    call: {
      method: 'execute', args: [], value: 10n ** 15n, to: cfg.router, data: '0x1234',
      path: [WETH, TOK], amountIn: 10n ** 15n, amountOutMin: 1n, deadline: 1n,
    },
    approveAmount: null, spender: cfg.permit2!, priceImpact: 0,
    gasWei: 0n, l1FeeWei: 0n, basePerNative: 1, gasNativeEstimate: 0, gasPlsEstimate: 0,
    amountInHuman: 0.001, quotedOutHuman: 1, minOutHuman: 1, price: 1, poolPrice: 1,
    balanceOk: true, balanceNote: null, routerOut: 1n, poolIn: 10n ** 15n,
    taxInPct: 0, taxOutPct: 0, feeOnTransfer: false, block: null, walletMin: 1n,
  };
}

describe('add-token: a wrapped quote discovers both V4 currencies', () => {
  it('auto-picks the address(0) pool and the market spends native ETH', async () => {
    const r = await hub().inspect({ chainId: 4663, address: TOK, quote: WETH });
    expect(r.pools.filter((p) => p.refOut != null).map((p) => p.address).sort()).toEqual([nativePool.address, wethPool.address].sort());
    expect(r.chosen!.address).toBe(nativePool.address);
    expect(r.draft!.quote).toMatchObject({ address: WETH, symbol: 'ETH', native: true });
    expect(v4PoolMatches(r.draft!.pool, r.draft!.base, r.draft!.quote)).toBe(true);
  });

  it('a hand-picked WETH-currency pool stays a WETH market', async () => {
    const r = await hub().inspect({ chainId: 4663, address: TOK, quote: WETH, pool: wethPool.address });
    expect(r.draft!.pool.address).toBe(wethPool.address);
    expect(r.draft!.quote.native).toBeUndefined();
    expect(r.draft!.quote.symbol).toBe('WETH');
    expect(v4PoolMatches(r.draft!.pool, r.draft!.base, r.draft!.quote)).toBe(true);
  });

  it('a hand-picked address(0) pool becomes a native market', async () => {
    const r = await hub().inspect({ chainId: 4663, address: TOK, quote: WETH, pool: nativePool.address });
    expect(r.draft!.quote).toMatchObject({ symbol: 'ETH', native: true });
    expect(v4PoolMatches(r.draft!.pool, r.draft!.base, r.draft!.quote)).toBe(true);
  });

  it('inspect refuses a pool whose currency is neither WETH nor native ETH', async () => {
    await expect(hub().inspect({ chainId: 4663, address: TOK, quote: WETH, pool: oddPool.address })).rejects.toThrow(/does not match/);
  });
});

describe('repick refuses a V4 pool that is not this market currency', () => {
  it('a WETH market cannot switch onto an address(0) pool', async () => {
    const h = hub();
    const added = await h.addMarket({ chainId: 4663, address: TOK, quote: WETH, pool: wethPool.address });
    expect(added.quote.native).toBeUndefined();
    await expect(h.setPool(added.key, { pool: nativePool.address })).rejects.toThrow(/pool 0x[0-9a-f]+: V4 pool currency does not match/i);
    expect(h.def(added.key).pool.address).toBe(wethPool.address);
  });

  it('a native market cannot switch onto a WETH-currency pool', async () => {
    const h = hub();
    const added = await h.addMarket({ chainId: 4663, address: TOK, quote: WETH, pool: nativePool.address });
    expect(added.quote.native).toBe(true);
    await expect(h.setPool(added.key, { pool: wethPool.address })).rejects.toThrow(/pool 0x[0-9a-f]+: V4 pool currency does not match/i);
    const same = await h.setPool(added.key, { pool: nativePool.address });
    expect(same.def.pool.address).toBe(nativePool.address);
  });
});

describe('executor guard blocks a hand-built mismatched quote before any send', () => {
  function mismatched() {
    const sent: { value: bigint }[] = [];
    const ad = new V4Adapter(reader(), cfg, WETH);
    const def: MarketDef = {
      key: 'TOK/WETH', chainId: 4663,
      base: { address: TOK, symbol: 'TOK', decimals: 18 },
      quote: { address: WETH, symbol: 'WETH', decimals: 18 },
      pool: nativePool, probe: 1, quoteKind: 'wrapped', custom: true,
    };
    const q = new Quoter(reader(), def, { chain: hood, adapter: ad });
    const signer = {
      async getAddress() { return ME; },
      async sendTransaction(tx: { value: bigint }) {
        sent.push({ value: tx.value });
        return { hash: '0x' + 'ab'.repeat(32), wait: async () => ({ status: 1, gasUsed: 1n, gasPrice: 1n, logs: [] }) };
      },
    };
    return { sent, q, signer };
  }

  it('LiveExecutor.execute sends nothing', async () => {
    const { sent, q, signer } = mismatched();
    const ex = new LiveExecutor(q, signer, { approval: 'exact', receiptTimeoutMs: 1000 });
    await expect(ex.execute(sendableQuote(), { canSend: () => true, onSent: () => undefined })).rejects.toThrow(/does not match/);
    expect(sent).toHaveLength(0);
  });

  it('PaperExecutor.execute does not fill', async () => {
    const { q } = mismatched();
    const ex = new PaperExecutor(q, () => ({ pls: 1, stable: 1 }));
    await expect(ex.execute(sendableQuote(), { canSend: () => true, onSent: () => undefined })).rejects.toThrow(/does not match/);
  });
});
