/**
 * ABI-driven multi-DEX chain mock: any number of Uniswap-V2-style DEXes (router + factory + pairs, per-DEX fee) and
 * V3-style DEXes (factory + pools per fee tier + QuoterV2), plus ERC-20 metadata/balances. Reserves are raw units in
 * each token's own decimals; V3 pools are modelled by their virtual reserves (L/√P, L·√P) so slot0/liquidity agree
 * with the quoter. Every eth_call target is recorded in `calls` so tests can prove WHICH router/quoter was used.
 */
import { getAddress } from 'ethers';
import { getAmountOut } from '../../src/live/swapMath';
import { Q96 } from '../../src/live/v3Math';
import { ERC20, FACTORY, PAIR, ROUTER, V3_FACTORY, V3_POOL, V3_POOL_LP, V3_QUOTER } from '../../src/server/dex/abis';
import { tickAtPrice } from '../../src/live/v3Liquidity';
import type { ReceiptLike } from '../../src/server/bot/chain';

export interface Tok { address: string; symbol: string; decimals: number; name?: string }
interface V2Pair { addr: string; t0: string; t1: string; r0: bigint; r1: bigint }
interface V2Dex { router: string; factory: string; feeBps: number; wrapped: string; pairs: V2Pair[] }
interface V3Pool {
  addr: string; t0: string; t1: string; fee: number; r0: bigint; r1: bigint;
  /** Fee counters (Q128 per unit of liquidity) and per-tick "outside" values; unset ticks read 0 */
  g0: bigint; g1: bigint; outside: Map<number, { o0: bigint; o1: bigint }>;
}
/** Tick spacing per fee tier (Uniswap 100/500/3000/10000; PancakeSwap-style 2500) */
const SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
interface V3Dex { factory: string; quoter: string; pools: V3Pool[] }

const ZERO = '0x' + '0'.repeat(40);
const lc = (a: string) => a.toLowerCase();
const raw = (human: number, dec: number) => BigInt(Math.round(human * 1e6)) * 10n ** BigInt(dec) / 1_000_000n;
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (let i = 0; i < 6; i++) x = (x + n / x) >> 1n;
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

export class MultiDexMock {
  calls: string[] = [];
  tokens = new Map<string, Tok>();
  wallet = new Map<string, bigint>();
  v2 = new Map<string, V2Dex>();
  v3 = new Map<string, V3Dex>();
  gasPrice = 10n ** 9n;
  native = 10n ** 24n;
  private n = 0;

  private nextAddr() { return getAddress('0x' + (0xd000 + ++this.n).toString(16).padStart(40, '0')); }
  addToken(t: Tok) { this.tokens.set(lc(t.address), t); return t; }
  addV2(id: string, d: { router: string; factory: string; feeBps: number; wrapped: string }) { this.v2.set(id, { ...d, pairs: [] }); }
  addV3(id: string, d: { factory: string; quoter: string }) { this.v3.set(id, { ...d, pools: [] }); }

  /** Human reserves: `ra` of token a and `rb` of token b. Returns the pair address. */
  v2Pair(dex: string, a: Tok, ra: number, b: Tok, rb: number, at?: string): string {
    const d = this.v2.get(dex)!;
    const [x, y] = lc(a.address) < lc(b.address) ? [[a, ra], [b, rb]] as const : [[b, rb], [a, ra]] as const;
    const addr = at ?? this.nextAddr();
    d.pairs.push({ addr, t0: x[0].address, t1: y[0].address, r0: raw(x[1], x[0].decimals), r1: raw(y[1], y[0].decimals) });
    return addr;
  }
  v3Pool(dex: string, a: Tok, ra: number, b: Tok, rb: number, fee: number, at?: string): string {
    const d = this.v3.get(dex)!;
    const [x, y] = lc(a.address) < lc(b.address) ? [[a, ra], [b, rb]] as const : [[b, rb], [a, ra]] as const;
    const addr = at ?? this.nextAddr();
    d.pools.push({ addr, t0: x[0].address, t1: y[0].address, fee, r0: raw(x[1], x[0].decimals), r1: raw(y[1], y[0].decimals), g0: 0n, g1: 0n, outside: new Map() });
    return addr;
  }
  v3ByAddr(addr: string): V3Pool {
    for (const d of this.v3.values()) for (const p of d.pools) if (lc(p.addr) === lc(addr)) return p;
    throw new Error(`mock: no V3 pool ${addr}`);
  }
  /** Fees earned by the pool's in-range liquidity: raise the global counters (Q128 per unit of liquidity). */
  addFees(addr: string, d0: bigint, d1: bigint) { const p = this.v3ByAddr(addr); p.g0 += d0; p.g1 += d1; }
  /** Move a V3 pool's price by scaling reserves: × k on token1 per token0 (keeps √(r0·r1)). */
  movePrice(addr: string, k: number) {
    const p = this.v3ByAddr(addr), s = Math.sqrt(k);
    p.r0 = BigInt(Math.round(Number(p.r0) / s)); p.r1 = BigInt(Math.round(Number(p.r1) * s));
  }
  /** Current tick of a V3 pool (from its reserves) */
  v3Tick(addr: string) { const p = this.v3ByAddr(addr); return tickAtPrice(Number(p.r1) / Number(p.r0)); }

  private findV2(d: V2Dex, a: string, b: string) { return d.pairs.find((p) => (lc(p.t0) === lc(a) && lc(p.t1) === lc(b)) || (lc(p.t0) === lc(b) && lc(p.t1) === lc(a))); }
  private findV3(d: V3Dex, a: string, b: string, fee: number) { return d.pools.find((p) => p.fee === fee && ((lc(p.t0) === lc(a) && lc(p.t1) === lc(b)) || (lc(p.t0) === lc(b) && lc(p.t1) === lc(a)))); }
  private swapOut(p: { t0: string; r0: bigint; r1: bigint }, tokenIn: string, amountIn: bigint, feeBps: number) {
    const inIs0 = lc(p.t0) === lc(tokenIn);
    return getAmountOut(amountIn, inIs0 ? p.r0 : p.r1, inIs0 ? p.r1 : p.r0, feeBps);
  }
  private poolBalance(owner: string, token: string): bigint | null {
    for (const d of this.v2.values()) for (const p of d.pairs) if (lc(p.addr) === lc(owner)) return lc(token) === lc(p.t0) ? p.r0 : lc(token) === lc(p.t1) ? p.r1 : 0n;
    for (const d of this.v3.values()) for (const p of d.pools) if (lc(p.addr) === lc(owner)) return lc(token) === lc(p.t0) ? p.r0 : lc(token) === lc(p.t1) ? p.r1 : 0n;
    return null;
  }

  async call({ to, data }: { to: string; data: string }): Promise<string> {
    const t = lc(to);
    this.calls.push(t);
    for (const d of this.v2.values()) {
      if (t === lc(d.router)) {
        const f = ROUTER.parseTransaction({ data })!;
        if (f.name === 'factory') return ROUTER.encodeFunctionResult('factory', [d.factory]);
        if (f.name === 'WPLS' || f.name === 'WETH') return ROUTER.encodeFunctionResult(f.name, [d.wrapped]);
        const [amountIn, path] = f.args as unknown as [bigint, string[]];
        const p = this.findV2(d, path[0], path[1]);
        if (!p) throw new Error('mock: PulseXLibrary: INVALID_PATH');
        return ROUTER.encodeFunctionResult('getAmountsOut', [[amountIn, this.swapOut(p, path[0], amountIn, d.feeBps)]]);
      }
      if (t === lc(d.factory)) {
        const [a, b] = FACTORY.decodeFunctionData('getPair', data) as unknown as [string, string];
        return FACTORY.encodeFunctionResult('getPair', [this.findV2(d, a, b)?.addr ?? ZERO]);
      }
      const p = d.pairs.find((x) => lc(x.addr) === t);
      if (p) {
        const f = PAIR.parseTransaction({ data })!;
        if (f.name === 'token0') return PAIR.encodeFunctionResult('token0', [p.t0]);
        if (f.name === 'token1') return PAIR.encodeFunctionResult('token1', [p.t1]);
        return PAIR.encodeFunctionResult('getReserves', [p.r0, p.r1, 0]);
      }
    }
    for (const d of this.v3.values()) {
      if (t === lc(d.factory)) {
        const [a, b, fee] = V3_FACTORY.decodeFunctionData('getPool', data) as unknown as [string, string, bigint];
        return V3_FACTORY.encodeFunctionResult('getPool', [this.findV3(d, a, b, Number(fee))?.addr ?? ZERO]);
      }
      if (t === lc(d.quoter)) {
        const f = V3_QUOTER.parseTransaction({ data })!;
        const q = f.args[0] as { tokenIn: string; tokenOut: string; amountIn: bigint; fee: bigint };
        const p = this.findV3(d, q.tokenIn, q.tokenOut, Number(q.fee));
        if (!p) throw new Error('mock: quoter: no pool');
        return V3_QUOTER.encodeFunctionResult('quoteExactInputSingle', [this.swapOut(p, q.tokenIn, q.amountIn, Number(q.fee) / 100), 0n, 1, 90_000n]);
      }
      const p = d.pools.find((x) => lc(x.addr) === t);
      if (p) {
        const lp = V3_POOL_LP.parseTransaction({ data });
        if (lp?.name === 'tickSpacing') return V3_POOL_LP.encodeFunctionResult('tickSpacing', [SPACING[p.fee]]);
        if (lp?.name === 'feeGrowthGlobal0X128') return V3_POOL_LP.encodeFunctionResult('feeGrowthGlobal0X128', [p.g0]);
        if (lp?.name === 'feeGrowthGlobal1X128') return V3_POOL_LP.encodeFunctionResult('feeGrowthGlobal1X128', [p.g1]);
        if (lp?.name === 'ticks') {
          const o = p.outside.get(Number(lp.args[0])) ?? { o0: 0n, o1: 0n };
          return V3_POOL_LP.encodeFunctionResult('ticks', [0n, 0n, o.o0, o.o1, 0n, 0n, 0n, false]);
        }
        const f = V3_POOL.parseTransaction({ data })!;
        if (f.name === 'token0') return V3_POOL.encodeFunctionResult('token0', [p.t0]);
        if (f.name === 'token1') return V3_POOL.encodeFunctionResult('token1', [p.t1]);
        if (f.name === 'fee') return V3_POOL.encodeFunctionResult('fee', [p.fee]);
        if (f.name === 'liquidity') return V3_POOL.encodeFunctionResult('liquidity', [isqrt(p.r0 * p.r1)]);
        return V3_POOL.encodeFunctionResult('slot0', [isqrt((p.r1 * Q96 * Q96) / p.r0), tickAtPrice(Number(p.r1) / Number(p.r0))]);
      }
    }
    const tok = this.tokens.get(t);
    if (tok) {
      const f = ERC20.parseTransaction({ data })!;
      if (f.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [tok.decimals]);
      if (f.name === 'symbol') return ERC20.encodeFunctionResult('symbol', [tok.symbol]);
      if (f.name === 'name') return ERC20.encodeFunctionResult('name', [tok.name ?? tok.symbol]);
      if (f.name === 'totalSupply') return ERC20.encodeFunctionResult('totalSupply', [10n ** 30n]);
      if (f.name === 'allowance') return ERC20.encodeFunctionResult('allowance', [0n]);
      if (f.name === 'balanceOf') {
        const owner = f.args[0] as string;
        return ERC20.encodeFunctionResult('balanceOf', [this.poolBalance(owner, t) ?? this.wallet.get(`${lc(owner)}:${t}`) ?? 0n]);
      }
    }
    throw new Error(`mock: unexpected call to ${to}`);
  }

  async getCode(a: string) { return this.tokens.has(lc(a)) ? '0x6080604052' : '0x'; }
  async getStorage() { return '0x' + '0'.repeat(64); }
  async getBalance() { return this.native; }
  async getFeeData() { return { gasPrice: this.gasPrice, maxFeePerGas: this.gasPrice }; }
  async getTransactionCount() { return 0; }
  async getTransactionReceipt(_hash: string): Promise<ReceiptLike | null> { return null; }
}
