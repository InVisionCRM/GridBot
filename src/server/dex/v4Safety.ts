/**
 * V4 round-trip simulation. Same Result shape and stages as simulateRoundTrip, through SafetyProbeV4 at its own
 * address so the V2/V3 probe bytecode is never rebuilt. The probe buys and sells the exact PoolKey, hooks included.
 */
import { Interface } from 'ethers';
import type { DexConfig } from '../../live/chains';
import type { PoolRef } from '../../live/markets';
import type { ChainRuntime } from '../chains/runtime';
import { qty, type Hop, type ProbeResult } from './safety';
import { SAFETY_PROBE_V4_RUNTIME } from './probeV4Code';
import { NATIVE } from '../../live/swapMath';
import { isZero, sameAddr, ZERO } from './types';
import type { V4PoolKey } from './v4PoolKey';

/**
 * The probe is called with market addresses. WETH stands in for address(0) when that is the pool currency,
 * because the safety call passes quote.address (the wrapped coin) even on a native market. Live swaps do not
 * use this mapping: they require the currency to equal the market token.
 */
function probeCurrency(token: string, key: V4PoolKey, wrapped: string): string {
  if (token === NATIVE || sameAddr(token, wrapped)) {
    if (isZero(key.currency0) || isZero(key.currency1)) return ZERO;
    if (sameAddr(key.currency0, wrapped)) return key.currency0;
    if (sameAddr(key.currency1, wrapped)) return key.currency1;
  }
  return [key.currency0, key.currency1].find((c) => sameAddr(c, token)) ?? token;
}

/** Throwaway address. Different from the V2/V3 probe so a shared RPC cache cannot mix the two bytecodes. */
export const PROBE_V4_ADDRESS = '0x5afe00000000000000000000000000000000b4e4';
const PROBE_FROM = '0x000000000000000000000000000000000000dEaD';
const HOP = '(uint8 kind,address router,address quoter,uint24 fee,address tokenIn,address tokenOut)';
const LEG = '((address,address,uint24,int24,address),bool,address,address,address)';

export const PROBE_V4_IFACE = new Interface([
  `function probe(address weth, uint256 wethIn, ${HOP} prep, bool hasPrep, ${LEG} buy, ${LEG} sell) returns ((uint256 quoteIn,uint256 expectedBuy,uint256 gotBuy,uint256 transferSent,uint256 transferGot,uint256 sellIn,uint256 expectedSell,uint256 gotSell,uint8 stage,bytes err,uint256 gasBuy,uint256 gasSell) r)`,
]);

export interface V4Leg {
  key: V4PoolKey;
  zeroForOne: boolean;
  quoter: string;
  router: string;
  permit2: string;
}

/** The buy or sell leg for a pool. tokenIn/tokenOut are market addresses (WETH stands in for native). */
export function v4Leg(pool: PoolRef, tokenIn: string, tokenOut: string, cfg: DexConfig, wrapped: string): V4Leg {
  const key = pool.v4;
  if (!key) throw new Error('V4 pool is missing its PoolKey');
  if (!cfg.quoter || !cfg.permit2) throw new Error(`${cfg.id}: V4 simulation needs a quoter and Permit2`);
  const cin = probeCurrency(tokenIn, key, wrapped);
  const cout = probeCurrency(tokenOut, key, wrapped);
  const zeroForOne = sameAddr(cin, key.currency0);
  if (!zeroForOne && !sameAddr(cin, key.currency1)) throw new Error('tokenIn is not in this V4 pool');
  if (!sameAddr(cout, zeroForOne ? key.currency1 : key.currency0)) throw new Error('tokenOut is not in this V4 pool');
  return {
    key: { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks },
    zeroForOne, quoter: cfg.quoter, router: cfg.router, permit2: cfg.permit2,
  };
}

function legTuple(l: V4Leg): unknown[] {
  return [[l.key.currency0, l.key.currency1, l.key.fee, l.key.tickSpacing, l.key.hooks], l.zeroForOne, l.quoter, l.router, l.permit2];
}

function decodeErr(data: string): string {
  if (!data || data === '0x') return '';
  try {
    if (data.startsWith('0x08c379a0')) return String(new Interface(['function Error(string)']).decodeFunctionData('Error', data)[0]).slice(0, 80);
  } catch { /* fallthrough */ }
  return data.slice(0, 18);
}

/** Run SafetyProbeV4 via eth_call with a state override. Throws if the RPC rejects overrides. */
export async function simulateV4RoundTrip(
  rt: ChainRuntime, a: { weth: string; wethIn: bigint; prep: Hop | null; buy: V4Leg; sell: V4Leg },
): Promise<ProbeResult> {
  if (!rt.reader.send) throw new Error('reader cannot send raw eth_call');
  const zero: Hop = { kind: 0, router: a.weth, quoter: a.weth, fee: 0, tokenIn: a.weth, tokenOut: a.weth };
  const data = PROBE_V4_IFACE.encodeFunctionData('probe', [
    a.weth, a.wethIn, a.prep ?? zero, !!a.prep, legTuple(a.buy), legTuple(a.sell),
  ]);
  const params = [
    { from: PROBE_FROM, to: PROBE_V4_ADDRESS, data, gas: qty(20_000_000n) }, 'latest',
    { [PROBE_V4_ADDRESS]: { code: SAFETY_PROBE_V4_RUNTIME, balance: qty(a.wethIn * 4n) } },
  ];
  const raw = (rt.reader.sendEach ? await rt.reader.sendEach('eth_call', params) : await rt.reader.send('eth_call', params)) as string;
  const [r] = PROBE_V4_IFACE.decodeFunctionResult('probe', raw);
  return {
    stage: Number(r.stage), quoteIn: r.quoteIn, expectedBuy: r.expectedBuy, gotBuy: r.gotBuy, transferSent: r.transferSent,
    transferGot: r.transferGot, sellIn: r.sellIn, expectedSell: r.expectedSell, gotSell: r.gotSell, err: decodeErr(r.err),
    gasBuy: r.gasBuy, gasSell: r.gasSell,
  };
}
