import { beforeEach, describe, expect, it } from 'vitest';
import { Q96, v3Impact } from '../src/live/v3Math';
import { clearDecimalsCache, DECIMALS_SELECTOR } from '../src/live/decimals';
import type { FreshPool } from '../src/market/tokenTrader';
import { quoteTradeImpact } from '../src/server/market/tradeImpact';
import { ERC20, V3_POOL, V3_QUOTER } from '../src/server/dex/abis';
import { V3Adapter } from '../src/server/dex/v3';
import type { DexConfig } from '../src/live/chains';

const spend = '0x' + '11'.repeat(20);
const token = '0x' + '22'.repeat(20);
const poolAddr = '0x' + '44'.repeat(20);
const quoter = '0x' + '33'.repeat(20);
const amountOut = 900000000000000000n;

const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 4663, pool: poolAddr, dex: 'uniswap-v3', kind: 'v3',
  token, spend, tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 1, createdAt: null, source: 'new',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 1, price: 1, usdPerSpend: 1, ...o,
});

function runtime(call: (data: string) => string | Promise<string>) {
  const reader = { call: async ({ data }: { to: string; data: string }) => call(data) };
  const cfg = {
    id: 'uniswap-v3', name: 'Uniswap V3', kind: 'v3' as const,
    factory: '0x' + '55'.repeat(20), router: '0x' + '66'.repeat(20), quoter,
    feeTiers: [100, 500, 3000, 10000], source: 'test',
  } as DexConfig;
  const adapter = new V3Adapter(reader, cfg, '0x' + '77'.repeat(20));
  return { reader, adapter: () => adapter };
}

describe('trade-size quote', () => {
  beforeEach(() => clearDecimalsCache());

  it('quotes the pool fee() through QuoterV2, not the stored fee tier', async () => {
    const fees: number[] = [];
    const rt = runtime((data) => {
      const sel = data.slice(0, 10);
      if (sel === DECIMALS_SELECTOR) return ERC20.encodeFunctionResult('decimals', [18]);
      if (sel === V3_POOL.getFunction('fee')!.selector) return V3_POOL.encodeFunctionResult('fee', [10000]);
      if (sel === V3_POOL.getFunction('slot0')!.selector) return V3_POOL.encodeFunctionResult('slot0', [Q96, 0]);
      if (sel === V3_POOL.getFunction('liquidity')!.selector) return V3_POOL.encodeFunctionResult('liquidity', [10n ** 24n]);
      if (sel === V3_POOL.getFunction('token0')!.selector) return V3_POOL.encodeFunctionResult('token0', [spend]);
      if (sel === V3_QUOTER.getFunction('quoteExactInputSingle')!.selector) {
        const [params] = V3_QUOTER.decodeFunctionData('quoteExactInputSingle', data);
        fees.push(Number(params.fee));
        return V3_QUOTER.encodeFunctionResult('quoteExactInputSingle', [amountOut, Q96, 0, 150000]);
      }
      throw new Error(`unexpected ${sel}`);
    });
    const impact = await quoteTradeImpact(rt, pool(), 1);
    expect(fees).toEqual([10000]);
    expect(impact).toBeCloseTo(v3Impact(10n ** 18n, amountOut, 1, 100), 8);
  });

  it('throws when the quoter call fails', async () => {
    const rt = runtime(() => { throw new Error('missing revert data'); });
    await expect(quoteTradeImpact(rt, pool(), 1)).rejects.toThrow();
  });
});
