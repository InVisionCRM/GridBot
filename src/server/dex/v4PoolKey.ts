/**
 * Uniswap V4 PoolKey, pool id, and Universal Router calldata.
 *
 * Pool id = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)), currencies sorted by uint160.
 * Dynamic-fee pools store DYNAMIC_FEE_FLAG (0x800000) in PoolKey.fee; the live LP fee is StateView.getSlot0().lpFee.
 *
 * Universal Router 2.1.1 and 2.1.2 share calldata. ExactInputSingleParams includes uint256 minHopPriceX36
 * between amountOutMinimum and hookData. 0 disables that per-hop check; amountOutMinimum is the slippage floor.
 * Encoding the pre-2.1.1 struct (no minHopPriceX36) reverts on the Robinhood routers.
 * Command V4_SWAP = 0x10. Actions: SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f.
 */
import { AbiCoder, getAddress, keccak256 } from 'ethers';
import { PERMIT2, V4_ROUTER } from './abis';

export const DYNAMIC_FEE_FLAG = 0x800000;
export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT160_MAX = (1n << 160n) - 1n;
export const UINT48_MAX = (1n << 48n) - 1n;

/** V4_SWAP command byte. */
export const V4_SWAP_COMMAND = '0x10';
/** SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL. */
export const V4_SWAP_ACTIONS = '0x060c0f';

const coder = AbiCoder.defaultAbiCoder();

export interface V4PoolKey {
  currency0: string;
  currency1: string;
  /** Static fee in hundredths of a bip, or DYNAMIC_FEE_FLAG. */
  fee: number;
  tickSpacing: number;
  hooks: string;
}

export function isDynamicFee(fee: number): boolean {
  return (fee & DYNAMIC_FEE_FLAG) !== 0;
}

/** LP fee (hundredths of a bip, the V3 fee-tier unit) → basis points. 10000 → 100 (1%). */
export function lpFeeBps(lpFee: number): number {
  return lpFee / 100;
}

/** Sort two currencies by uint160 ascending, the order PoolKey requires. */
export function sortCurrencies(a: string, b: string): [string, string] {
  const ca = BigInt(a), cb = BigInt(b);
  if (ca === cb) throw new Error('V4 pool currencies must differ');
  const [lo, hi] = ca < cb ? [a, b] : [b, a];
  return [getAddress(lo), getAddress(hi)];
}

export function encodePoolKey(key: V4PoolKey): string {
  return coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  );
}

/** keccak256 of the abi-encoded PoolKey. Matches PoolManager's pool id. */
export function poolId(key: V4PoolKey): string {
  return keccak256(encodePoolKey(key));
}

export interface V4ExactIn {
  key: V4PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMin: bigint;
  hookData?: string;
}

function fit128(n: bigint, label: string): void {
  if (n < 0n || n > UINT128_MAX) throw new Error(`${label} must fit in uint128`);
}

/**
 * The V4_SWAP input: abi.encode(actions, params[]) for one exact-in hop.
 * minHopPriceX36 is 0. SETTLE_ALL pulls the input currency; TAKE_ALL pays the output currency.
 */
export function encodeV4ExactInputSingle(p: V4ExactIn): string {
  fit128(p.amountIn, 'amountIn');
  fit128(p.amountOutMin, 'amountOutMin');
  const currencyIn = p.zeroForOne ? p.key.currency0 : p.key.currency1;
  const currencyOut = p.zeroForOne ? p.key.currency1 : p.key.currency0;
  const p0 = coder.encode(
    ['tuple(address,address,uint24,int24,address)', 'bool', 'uint128', 'uint128', 'uint256', 'bytes'],
    [[p.key.currency0, p.key.currency1, p.key.fee, p.key.tickSpacing, p.key.hooks], p.zeroForOne, p.amountIn, p.amountOutMin, 0n, p.hookData ?? '0x'],
  );
  const p1 = coder.encode(['address', 'uint256'], [currencyIn, p.amountIn]);
  const p2 = coder.encode(['address', 'uint256'], [currencyOut, p.amountOutMin]);
  return coder.encode(['bytes', 'bytes[]'], [V4_SWAP_ACTIONS, [p0, p1, p2]]);
}

/** Universal Router execute(commands, inputs, deadline) for a single V4_SWAP command. */
export function encodeUniversalRouterExecute(input: string, deadline: bigint): string {
  return V4_ROUTER.encodeFunctionData('execute', [V4_SWAP_COMMAND, [input], deadline]);
}

/** Permit2.approve(token, spender, uint160 amount, uint48 expiration). spender is the Universal Router. */
export function encodePermit2Approve(token: string, spender: string, amount: bigint, expiration: bigint): string {
  if (amount < 0n || amount > UINT160_MAX) throw new Error('Permit2 amount exceeds uint160');
  if (expiration < 0n || expiration > UINT48_MAX) throw new Error('Permit2 expiration exceeds uint48');
  return PERMIT2.encodeFunctionData('approve', [token, spender, amount, expiration]);
}
