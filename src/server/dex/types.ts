/**
 * DEX adapter interface: one implementation per AMM family (Uniswap-V2-style, Uniswap-V3-style).
 * Adapters only read (eth_call) and build calldata; signing/sending stays in LiveExecutor.
 */
import type { DexConfig, DexKind } from '../../live/chains';
import type { PoolRef } from '../../live/markets';
import type { ChainReader } from '../bot/chain';

export interface PoolState {
  pool: PoolRef;
  token0: string;
  token1: string;
  /** V2: actual reserves. V3: virtual reserves of the active range (L/√P, L·√P). Raw units. */
  reserve0: bigint;
  reserve1: bigint;
  sqrtPriceX96?: bigint;
  liquidity?: bigint;
}

export interface QuoteOut {
  amountOut: bigint;
  /** fraction 0..1, excluding the LP fee */
  impact: number;
  gasEstimate?: bigint;
}

export interface SwapRequest {
  pool: PoolRef;
  /** ERC-20 address or 'native' */
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOutMin: bigint;
  recipient: string;
  deadline: bigint;
  /** V2: use the *SupportingFeeOnTransferTokens router method (taxed / custom tokens). Ignored by V3. */
  feeOnTransfer?: boolean;
}

export interface BuiltSwap {
  to: string;
  data: string;
  value: bigint;
  /** Router method (for logs / tests) */
  method: string;
  args: unknown[];
}

export interface DexAdapter {
  readonly cfg: DexConfig;
  readonly kind: DexKind;
  /** Address to approve ERC-20 input to */
  readonly spender: string;
  /** All pools for an unordered token pair (V2: getPair; V3: getPool per fee tier). Empty = none. */
  findPools(a: string, b: string): Promise<PoolRef[]>;
  state(pool: PoolRef, a: string, b: string): Promise<PoolState>;
  /** Exact-in quote at the real size (V2 getAmountsOut, V3 QuoterV2) + impact vs mid. ERC-20 addresses. */
  quote(pool: PoolRef, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<QuoteOut>;
  buildSwap(r: SwapRequest): BuiltSwap;
}

export async function readCall<T = unknown[]>(reader: Pick<ChainReader, 'call'>, to: string, iface: import('ethers').Interface, fn: string, args: unknown[] = []): Promise<T> {
  const raw = await reader.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw) as unknown as T;
}

export const ZERO = '0x0000000000000000000000000000000000000000';
export const isZero = (a: string) => /^0x0+$/.test(a);
export const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
