/**
 * Calldata for the position manager (pure). The same builders the LP bot sends were simulated (eth_call) as real
 * position owners on Ethereum, Robinhood and PulseChain (9mm) before shipping — see tests/lpCalls.test.ts.
 *
 * Native coin: a position always holds the wrapped token. Opening pays the native side with the tx value
 * (mint + refundETH returns any unused part); exiting/collecting sends the tokens to the position manager itself
 * (recipient 0) and then unwrapWETH9 + sweepToken hand out the native coin and the other token.
 */
import { V3_NPM } from '../dex/abis';

const ZERO = '0x0000000000000000000000000000000000000000';
const U128_MAX = 2n ** 128n - 1n;

export interface MintArgs {
  token0: string; token1: string; fee: number; tickLower: number; tickUpper: number;
  amount0: bigint; amount1: bigint; min0: bigint; min1: bigint; recipient: string; deadline: bigint;
  /** Which token is the native coin paid with the tx value (null = none) */
  native: 0 | 1 | null;
}
export function mintTx(a: MintArgs): { data: string; value: bigint } {
  const mint = V3_NPM.encodeFunctionData('mint', [{
    token0: a.token0, token1: a.token1, fee: a.fee, tickLower: a.tickLower, tickUpper: a.tickUpper,
    amount0Desired: a.amount0, amount1Desired: a.amount1, amount0Min: a.min0, amount1Min: a.min1, recipient: a.recipient, deadline: a.deadline,
  }]);
  const value = a.native == null ? 0n : a.native === 0 ? a.amount0 : a.amount1;
  return value > 0n ? { data: V3_NPM.encodeFunctionData('multicall', [[mint, V3_NPM.encodeFunctionData('refundETH')]]), value } : { data: mint, value: 0n };
}

/** Collect every owed token of `tokenId` to `recipient`; as an eth_call from the owner it quotes the fees owed now. */
export function collectAllData(tokenId: bigint, recipient: string): string {
  return V3_NPM.encodeFunctionData('collect', [{ tokenId, recipient, amount0Max: U128_MAX, amount1Max: U128_MAX }]);
}

/** Pay out to `to`: direct for two ERC-20s; via the position manager + unwrap/sweep when one side is native. */
function payout(tokenId: bigint, to: string, nativeOther: string | null): string[] {
  return nativeOther
    ? [collectAllData(tokenId, ZERO),
      V3_NPM.encodeFunctionData('unwrapWETH9', [0n, to]), V3_NPM.encodeFunctionData('sweepToken', [nativeOther, 0n, to])]
    : [collectAllData(tokenId, to)];
}

/** Remove all liquidity, collect principal + fees to `to`, burn the NFT — one multicall. `nativeOther` = the non-native token when one side is native. */
export function exitData(a: { tokenId: bigint; liquidity: bigint; min0: bigint; min1: bigint; deadline: bigint; to: string; nativeOther: string | null }): string {
  return V3_NPM.encodeFunctionData('multicall', [[
    V3_NPM.encodeFunctionData('decreaseLiquidity', [{ tokenId: a.tokenId, liquidity: a.liquidity, amount0Min: a.min0, amount1Min: a.min1, deadline: a.deadline }]),
    ...payout(a.tokenId, a.to, a.nativeOther),
    V3_NPM.encodeFunctionData('burn', [a.tokenId]),
  ]]);
}

/** Collect the fees owed to `to` (the position stays open). */
export function collectData(a: { tokenId: bigint; to: string; nativeOther: string | null }): string {
  const calls = payout(a.tokenId, a.to, a.nativeOther);
  return calls.length === 1 ? calls[0] : V3_NPM.encodeFunctionData('multicall', [calls]);
}
