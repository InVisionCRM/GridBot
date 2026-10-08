/**
 * On-chain quoting and execution through a DEX adapter (Uniswap-V2- or V3-style), written against minimal
 * provider/signer interfaces (satisfied by ethers JsonRpcProvider / Wallet) so it can be fully mocked.
 *
 * Units: price = QUOTE per BASE (sell-side, after the LP fee). Internal field names `pls*` / `gasPls` are kept
 * from the PulseChain-only version and mean BASE units: gas is paid in the chain's native coin and converted to
 * base with basePerNative (= 1 when the base is the native coin, e.g. PLS/DAI, ETH/USDC; 1/spot when the QUOTE is
 * the native coin, e.g. the flipped HEX/PLS).
 *
 * Orientation: either side may be the native coin. Classic PLS/HEX: buys spend HEX for native PLS
 * (swapExactTokensForETH), sells spend PLS (swapExactETHForTokens). Flipped HEX/PLS: buys spend native PLS for HEX
 * (swapExactETHForTokens[SupportingFeeOnTransferTokens]), sells give HEX back for PLS (swapExactTokensForETH…);
 * V3 wraps native input through msg.value and unwraps native output with unwrapWETH9.
 */
import { MaxUint256 } from 'ethers';
import type { LiveNetwork, QuoteToken } from '../../live/networks';
import type { SafetyLimits } from '../../live/limits';
import { chainFromNetwork, type ChainConfig } from '../../live/chains';
import { legacyMarkets, type MarketDef } from '../../live/markets';
import { NATIVE, applySlippage, approvalNeeded, deadlineFromNow, fromUnits, type HopReserves, type SwapCall } from '../../live/swapMath';
import { amountToUnits } from '../../live/decimals';
import { NO_TAX, afterTax, type Taxes } from '../../live/tax';
import type { SharedNonce } from './txGate';
import { ERC20, FACTORY, PAIR, ROUTER, WPLS_EVENTS } from '../dex/abis';
import type { DexAdapter } from '../dex/types';
import { V2Adapter } from '../dex/v2';

export { ERC20, FACTORY, PAIR, ROUTER, WPLS_EVENTS };

/** Gas units used for PulseChain estimates (per-chain values live in ChainConfig.gasUnits). */
export const GAS_UNITS = { approve: 60_000n, swap: 220_000n };

export interface LogLike { address: string; topics: readonly string[]; data: string }
export interface ReceiptLike { status: number | null; gasUsed: bigint; gasPrice?: bigint | null; logs: readonly LogLike[] }

export interface ChainReader {
  call(tx: { to: string; data: string }): Promise<string>;
  getBalance(address: string): Promise<bigint>;
  getFeeData(): Promise<{ gasPrice: bigint | null; maxFeePerGas: bigint | null }>;
  getTransactionCount(address: string, blockTag: 'pending'): Promise<number>;
  getTransactionReceipt(hash: string): Promise<ReceiptLike | null>;
}

export interface SentTx { hash: string; wait(confirms?: number, timeoutMs?: number): Promise<ReceiptLike | null> }
export interface TxSender {
  getAddress(): Promise<string>;
  sendTransaction(tx: { to: string; data: string; value: bigint; nonce: number }): Promise<SentTx>;
}

export type Side = 'buy' | 'sell';

/** Router call: V2 method/args kept for logs and tests; to/data/value is what gets signed. */
export interface TxCall extends Omit<SwapCall, 'method'> {
  method: string;
  to: string;
  data: string;
}

export interface Quote {
  side: Side;
  tokenIn: string;
  tokenOut: string;
  decimalsIn: number;
  decimalsOut: number;
  amountIn: bigint;
  quotedOut: bigint;
  call: TxCall;
  approveAmount: bigint | null;
  /** Router / spender to approve */
  spender: string;
  priceImpact: number;
  /** Estimated gas in BASE units (native × basePerNative) */
  gasPlsEstimate: number;
  /** Estimated gas in the chain's native coin (incl. L1 data fee on OP-stack / Arbitrum L1 component) */
  gasNativeEstimate: number;
  gasWei: bigint;
  /** OP-stack L1 data fee included in gasWei (not visible in gasUsed × gasPrice on the receipt) */
  l1FeeWei: bigint;
  basePerNative: number;
  amountInHuman: number;
  quotedOutHuman: number;
  minOutHuman: number;
  /** quote per base */
  price: number;
  balanceOk: boolean;
  balanceNote: string | null;
  /** Router/pool output BEFORE the output token's tax (raw units) */
  routerOut: bigint;
  /** Amount the pool actually receives after the input token's tax (raw units) */
  poolIn: bigint;
  /** Tax on the input transfer (wallet → pool) and on the output transfer (pool → wallet), fractions */
  taxInPct: number;
  taxOutPct: number;
  /** V2 *SupportingFeeOnTransferTokens router method used */
  feeOnTransfer: boolean;
  /** Pool price (quote per base) WITHOUT taxes — used by the units guard so a tax never looks like a decimals bug */
  poolPrice: number;
  /** Set when live trading this quote is not allowed (taxed token on an unproven V3 pool, token max-tx …) */
  block: string | null;
  /** Minimum the WALLET must receive after tax (= call.amountOutMin on V2; V3's router minimum is pre-tax) */
  walletMin?: bigint;
}

export interface Fill {
  txHash: string;
  approvalTxHash?: string;
  amountInHuman: number;
  amountOutHuman: number;
  /** Gas in base units */
  gasPls: number;
  /** Gas in native units */
  gasNative?: number;
  /** amountOut parsed from receipt logs or balance change (false = fell back to amountOutMin / paper) */
  fromReceipt: boolean;
  /** Where amountOut came from: wallet balance change (actual, after tax), Transfer/Withdrawal log, amountOutMin, paper sim */
  outSource?: 'balance' | 'log' | 'minOut' | 'paper';
  /** Expected (quoted, after known tax) output */
  expectedOutHuman?: number;
  /** 1 − actual / expected (positive = received less than expected: slippage or a tax increase) */
  shortfallPct?: number;
  /** Combined tax applied on this swap (input × output legs) */
  taxPct?: number;
}

export interface MarketSnapshot {
  /** getPrice(): quote per base */
  spot: number;
  /** Pool depth in human units (V2 reserves; V3 virtual reserves of the active range) */
  quoteReserve: number;
  plsReserve: number;
  /** Gas price in BASE units per gas unit (native gas price × basePerNative) */
  gasPricePls: number;
  /** LP fee of this market's pool (bps) */
  feeBps?: number;
  gasUnits?: { approve: number; swap: number };
  /** Extra per-swap cost in base units (OP-stack L1 data fee / Arbitrum L1 component) */
  extraPlsPerSwap?: number;
  /** Token taxes per leg (fractions): buying base (quote sell-tax × base buy-tax) and selling base */
  buyTaxPct?: number;
  sellTaxPct?: number;
  gasPriceNative?: number;
  basePerNative?: number;
  /** Pool TVL in quote units (V3: token balances held by the pool) */
  tvlQuote?: number;
}

export interface ExecHooks {
  /** Checked before every transaction is sent. Return false to abort (kill switch). */
  canSend(): boolean;
  onSent(stage: 'approve' | 'swap', hash: string): void;
}

export class ExecError extends Error {
  constructor(
    message: string,
    public readonly opts: { gasPls?: number; approvalTxHash?: string; swapTxHash?: string; aborted?: boolean; pending?: boolean; retryable?: boolean } = {},
  ) {
    super(message);
  }
}

export interface Executor {
  readonly mode: 'paper' | 'live';
  address(): Promise<string | null>;
  getPrice(): Promise<number>;
  balances(): Promise<{ pls: number; stable: number }>;
  quote(side: Side, amount: number, limits: SafetyLimits): Promise<Quote>;
  execute(q: Quote, hooks: ExecHooks): Promise<Fill>;
  /** Look up a swap sent before a restart. null = not mined (yet). */
  recover(swapTxHash: string, tokenOut: string, decimalsOut: number): Promise<{ ok: boolean; amountOutHuman: number; gasPls: number } | null>;
}

function shortErr(e: unknown): string {
  const a = e as { shortMessage?: string; reason?: string; message?: string };
  const m = a?.shortMessage ?? a?.reason ?? a?.message ?? String(e);
  return m.length > 300 ? m.slice(0, 300) + '…' : m;
}

export interface QuoterCtx {
  chain: ChainConfig;
  adapter: DexAdapter;
  /** Resolve the adapter of the market's CURRENT pool (pool can be switched at runtime: PulseX V1/V2 ↔ 9mm …) */
  resolve?: (dexId: string) => DexAdapter;
  /** Base units per 1 native coin; omitted / base is native → 1 */
  basePerNative?: () => Promise<number>;
  /** Extra L1 cost in wei for a tx (OP-stack data fee, Arbitrum L1 gas × price) */
  l1Fee?: (to: string, data: string, gasPrice: bigint) => Promise<{ wei: bigint; separate: boolean }>;
  /** Pool TVL in quote units (optional, V3) */
  tvl?: () => Promise<number | null>;
  /** Verify the market's stored decimals against decimals() on-chain (cached); throws on mismatch */
  verifyDecimals?: () => Promise<void>;
  /** Measured taxes of a token on this chain (custom tokens; others → none) */
  taxOf?: (address: string) => Taxes;
}

/** Read-only quoting for one market, shared by paper and live modes. */
export class Quoter {
  readonly def: MarketDef;
  readonly chain: ChainConfig;
  private readonly ctx: QuoterCtx;
  get adapter(): DexAdapter { return this.ctx.resolve ? this.ctx.resolve(this.def.pool.dex) : this.ctx.adapter; }
  lastBasePerNative = 1;

  /** new Quoter(reader, net, quoteToken) = legacy PulseX market; new Quoter(reader, market, ctx) = any market. */
  constructor(readonly reader: ChainReader, a: LiveNetwork | MarketDef, b: QuoteToken | QuoterCtx) {
    if ('pulsex' in a) {
      const net = a, q = b as QuoteToken;
      const chain = chainFromNetwork(net);
      const m = legacyMarkets(net).find((x) => x.key === q.symbol)
        ?? legacyMarkets({ ...net, quotes: [q] })[0];
      this.def = m;
      this.chain = chain;
      this.ctx = { chain, adapter: new V2Adapter(reader, chain.dexes[0], net.pulsex.wpls) };
    } else {
      this.def = a;
      this.ctx = b as QuoterCtx;
      this.chain = this.ctx.chain;
    }
  }

  get base() { return this.def.base; }
  /** Quote token (legacy name `stable`) */
  get stable() { return { ...this.def.quote, name: this.def.quote.name ?? this.def.quote.symbol, kind: this.def.quoteKind === 'stable' ? 'stable' as const : 'token' as const }; }
  get key() { return this.def.key; }
  get feeBps() { return this.def.pool.feeBps; }

  private decimalsOk: Promise<void> | null = null;
  /** Decimals verified on-chain once per Quoter (cached); a mismatch refuses every quote. */
  async ensureDecimals(): Promise<void> {
    if (!this.ctx.verifyDecimals) return;
    this.decimalsOk ??= this.ctx.verifyDecimals().catch((e) => { this.decimalsOk = null; throw e; });
    return this.decimalsOk;
  }

  /** Taxes of one token (fractions). */
  taxOf(address: string): Taxes { return this.ctx.taxOf ? this.ctx.taxOf(address) : NO_TAX; }
  /** Per-leg taxes: buy = quote leaves wallet (its sell tax) × base leaves pool (its buy tax); sell mirrors it. */
  legTaxes(): { buy: number; sell: number } {
    const b = this.taxOf(this.def.base.address), q = this.taxOf(this.def.quote.address);
    return { buy: 1 - (1 - q.sell) * (1 - b.buy), sell: 1 - (1 - b.sell) * (1 - q.buy) };
  }

  async basePerNative(): Promise<number> {
    if (this.def.base.native || !this.ctx.basePerNative) return 1;
    const v = await this.ctx.basePerNative();
    if (v > 0 && Number.isFinite(v)) this.lastBasePerNative = v;
    return this.lastBasePerNative;
  }

  /** Legacy helpers (V2 only) */
  async amountsOut(amountIn: bigint, path: string[]): Promise<bigint[]> {
    const raw = await this.reader.call({ to: this.chain.dexes.find((d) => d.id === this.def.pool.dex)!.router, data: ROUTER.encodeFunctionData('getAmountsOut', [amountIn, path]) });
    return [...(ROUTER.decodeFunctionResult('getAmountsOut', raw)[0] as bigint[])];
  }
  async hops(path: string[]): Promise<HopReserves[]> {
    const st = await this.adapter.state(this.def.pool, path[0], path[1]);
    const inIs0 = st.token0.toLowerCase() === path[0].toLowerCase();
    return [{ reserveIn: inIs0 ? st.reserve0 : st.reserve1, reserveOut: inIs0 ? st.reserve1 : st.reserve0 }];
  }

  /** Probe size in base units; a flipped market without a cached spot sizes it from a reverse quote of probeQuote. */
  private probeSize: number | null = null;
  private async probeBase(): Promise<number> {
    const { base, quote, probe, probeQuote, pool } = this.def;
    if (probe > 0) return probe;
    if (this.probeSize) return this.probeSize;
    if (!(probeQuote && probeQuote > 0)) throw new Error(`${this.def.key}: no probe size`);
    const q = await this.quoteRaw(pool, quote.address, base.address, amountToUnits(probeQuote, quote.decimals));
    const b = fromUnits(q.amountOut, base.decimals);
    if (!(b > 0)) throw new Error(`${this.def.key}: reverse probe returned 0`);
    this.probeSize = +b.toPrecision(3);
    return this.probeSize;
  }
  private quoteRaw(pool: MarketDef['pool'], i: string, o: string, a: bigint) {
    return (this.adapter.quote as (p: typeof pool, i: string, o: string, a: bigint, w?: boolean) => ReturnType<DexAdapter['quote']>)(pool, i, o, a, false);
  }

  /** Quote per base, from an exact-in quote of `probe` base (includes the LP fee). */
  async getPrice(): Promise<number> {
    await this.ensureDecimals();
    const { base, quote, pool } = this.def;
    const probe = await this.probeBase();
    // At least one raw unit (0-decimals tokens with a fractional probe); price uses the units actually quoted.
    let amt = amountToUnits(probe, base.decimals);
    if (amt <= 0n) amt = 1n;
    const q = await this.quoteRaw(pool, base.address, quote.address, amt);
    return fromUnits(q.amountOut, quote.decimals) / fromUnits(amt, base.decimals);
  }

  private async l1(to: string, data: string, gasPrice: bigint) {
    if (!this.ctx.l1Fee) return { wei: 0n, separate: false };
    try { return await this.ctx.l1Fee(to, data, gasPrice); } catch { return { wei: 0n, separate: false }; }
  }

  /** Spot, pool depth, fee and gas (in base units) for the cost gate, start gate and backtests. */
  async market(): Promise<MarketSnapshot> {
    await this.ensureDecimals();
    const { base, quote, pool } = this.def;
    const [spot, st, fee, bpn, tvl] = await Promise.all([
      this.getPrice(), this.adapter.state(pool, quote.address, base.address), this.reader.getFeeData(), this.basePerNative(),
      this.ctx.tvl ? this.ctx.tvl().catch(() => null) : Promise.resolve(null),
    ]);
    const quoteIs0 = st.token0.toLowerCase() === quote.address.toLowerCase();
    const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
    let extra = 0;
    if (this.ctx.l1Fee) {
      const dummy = this.adapter.buildSwap({ pool, tokenIn: this.tokenIn('buy'), tokenOut: this.tokenOut('buy'), amountIn: 10n ** BigInt(quote.decimals), amountOutMin: 1n, recipient: '0x000000000000000000000000000000000000dEaD', deadline: 2n ** 40n });
      extra = fromUnits((await this.l1(dummy.to, dummy.data, gasPrice)).wei, 18) * bpn;
    }
    return {
      spot,
      quoteReserve: fromUnits(quoteIs0 ? st.reserve0 : st.reserve1, quote.decimals),
      plsReserve: fromUnits(quoteIs0 ? st.reserve1 : st.reserve0, base.decimals),
      gasPricePls: fromUnits(gasPrice, 18) * bpn,
      feeBps: pool.feeBps, gasUnits: this.chain.gasUnits, extraPlsPerSwap: extra,
      buyTaxPct: this.legTaxes().buy, sellTaxPct: this.legTaxes().sell,
      gasPriceNative: fromUnits(gasPrice, 18), basePerNative: bpn,
      ...(tvl != null ? { tvlQuote: tvl } : {}),
    };
  }

  async allowance(owner: string, token: string): Promise<bigint> {
    const raw = await this.reader.call({ to: token, data: ERC20.encodeFunctionData('allowance', [owner, this.adapter.spender]) });
    return ERC20.decodeFunctionResult('allowance', raw)[0] as bigint;
  }

  async tokenBalance(owner: string, token: string): Promise<bigint> {
    const raw = await this.reader.call({ to: token, data: ERC20.encodeFunctionData('balanceOf', [owner]) });
    return ERC20.decodeFunctionResult('balanceOf', raw)[0] as bigint;
  }

  /** ERC-20 (or NATIVE) spent / received for a side. Either side may be the native coin (classic or flipped). */
  private ref(t: MarketDef['base']) { return t.native ? NATIVE : t.address; }
  tokenIn(side: Side) { return side === 'buy' ? this.ref(this.def.quote) : this.ref(this.def.base); }
  tokenOut(side: Side) { return side === 'buy' ? this.ref(this.def.base) : this.ref(this.def.quote); }
  /** Side of the market holding the custom (safety-checked) token: base classically, quote when flipped. */
  get tokenSide(): 'base' | 'quote' { return this.def.flipped ? 'quote' : 'base'; }

  /**
   * Build a quote. amount = quote-token units for buys, base units for sells (or exact raw units via opts.amountInUnits).
   * `account` is the recipient (any address in paper mode). `allowance` = current allowance of the ERC-20 input (null = skip).
   *
   * Taxes: the pool receives amountIn × (1 − input tax) and the wallet receives routerOut × (1 − output tax); quotedOut is
   * that post-tax amount, so lot guards, ledgers and paper fills all see what actually arrives.
   */
  async quote(side: Side, amount: number, limits: SafetyLimits, account: string, allowance: bigint | null, opts: { amountInUnits?: bigint } = {}): Promise<Quote> {
    await this.ensureDecimals();
    const { base, quote, pool } = this.def;
    const tokenIn = this.tokenIn(side), tokenOut = this.tokenOut(side);
    const decimalsIn = side === 'buy' ? quote.decimals : base.decimals;
    const decimalsOut = side === 'buy' ? base.decimals : quote.decimals;
    const amountIn = opts.amountInUnits ?? amountToUnits(amount, decimalsIn);
    if (amountIn <= 0n) throw new Error(`Trade amount rounds to zero at ${decimalsIn} decimals`);
    const aIn = side === 'buy' ? quote.address : base.address, aOut = side === 'buy' ? base.address : quote.address;
    const taxInPct = this.taxOf(aIn).sell, taxOutPct = this.taxOf(aOut).buy;
    const poolIn = afterTax(amountIn, taxInPct);
    if (poolIn <= 0n) throw new Error('Trade amount rounds to zero after the input token tax');
    const ad = this.adapter;
    const [q, fee, bpn] = await Promise.all([ad.quote(pool, aIn, aOut, poolIn), this.reader.getFeeData(), this.basePerNative()]);
    const routerOut = q.amountOut;
    const quotedOut = afterTax(routerOut, taxOutPct);
    if (quotedOut <= 0n) throw new Error(`Quoted output rounds to zero at ${decimalsOut} decimals`);
    const taxed = taxInPct > 0 || taxOutPct > 0;
    // V2 forks: custom tokens always go through the fee-on-transfer methods (a tax can be switched on at any time);
    // those check the RECIPIENT's balance change, so the minimum is post-tax. V3 routers check the pool's output,
    // so the router minimum is pre-tax and the post-tax amount is verified from the balance change afterwards.
    const feeOnTransfer = ad.kind === 'v2' && (taxed || !!this.def.custom);
    const amountOutMin = applySlippage(ad.kind === 'v2' ? quotedOut : routerOut, limits.slippageBps);
    const walletMin = applySlippage(quotedOut, limits.slippageBps);
    const deadline = deadlineFromNow(limits.deadlineMinutes);
    const built = ad.buildSwap({ pool, tokenIn, tokenOut, amountIn, amountOutMin, recipient: account, deadline, feeOnTransfer });
    const approveAmount = allowance == null ? null : approvalNeeded(tokenIn, allowance, amountIn);
    const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const units = BigInt((approveAmount != null ? this.chain.gasUnits.approve : 0) + this.chain.gasUnits.swap);
    const l1 = await this.l1(built.to, built.data, gasPrice);
    const gasWei = units * gasPrice + l1.wei;
    const amountInHuman = fromUnits(amountIn, decimalsIn);
    const quotedOutHuman = fromUnits(quotedOut, decimalsOut);
    const poolInHuman = fromUnits(poolIn, decimalsIn), routerOutHuman = fromUnits(routerOut, decimalsOut);
    const call: TxCall = {
      method: built.method, args: built.args, value: built.value, to: built.to, data: built.data,
      path: [aIn, aOut], amountIn, amountOutMin, deadline,
    };
    let block: string | null = null;
    if (taxed && ad.kind === 'v3' && this.def.safety?.taxMode !== 'v3-proven') block = 'taxed token on a V3 pool that was not proven by simulation — switch to a V2 pool';
    const s = this.def.safety;
    // Token limits are in the custom token's units: the base classically, the quote when flipped.
    const tokAmt = this.tokenSide === 'base' ? (side === 'buy' ? routerOutHuman : amountInHuman) : (side === 'buy' ? amountInHuman : routerOutHuman);
    const tokSym = this.tokenSide === 'base' ? base.symbol : quote.symbol;
    if (!block && s?.maxTxTokens != null && tokAmt > s.maxTxTokens * 0.999) block = `${tokAmt.toPrecision(6)} ${tokSym} exceeds the token's max transaction ${s.maxTxTokens.toPrecision(6)}`;
    return {
      side, tokenIn, tokenOut, decimalsIn, decimalsOut, amountIn, quotedOut, call, approveAmount, spender: ad.spender,
      priceImpact: q.impact,
      gasWei, l1FeeWei: l1.separate ? l1.wei : 0n, basePerNative: bpn,
      gasNativeEstimate: fromUnits(gasWei, 18), gasPlsEstimate: fromUnits(gasWei, 18) * bpn,
      amountInHuman, quotedOutHuman, minOutHuman: fromUnits(walletMin, decimalsOut),
      price: side === 'buy' ? amountInHuman / quotedOutHuman : quotedOutHuman / amountInHuman,
      poolPrice: side === 'buy' ? poolInHuman / routerOutHuman : routerOutHuman / poolInHuman,
      balanceOk: !block, balanceNote: block,
      routerOut, poolIn, taxInPct, taxOutPct, feeOnTransfer, block, walletMin,
    };
  }
}

const ZERO_TOPIC = '0x' + '0'.repeat(64);

/**
 * Read the actual output from receipt logs; null if no matching log.
 * Native out: WETH9 Withdrawal(src, wad) from the wrapped native, or a burn Transfer(src → 0) (Arbitrum aeWETH-style).
 */
export function parseAmountOut(receipt: ReceiptLike, account: string, tokenOut: string, wrappedNative: string): bigint | null {
  const me = account.toLowerCase();
  const transferTopic = ERC20.getEvent('Transfer')!.topicHash;
  // ERC-20 out: SUM of Transfer(* → me) — a taxed token sends the tax elsewhere and the net to us (sometimes in parts).
  let sum: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      if (tokenOut === NATIVE && log.address.toLowerCase() === wrappedNative.toLowerCase()) {
        if (log.topics[0] === transferTopic && log.topics[2] === ZERO_TOPIC) return ERC20.parseLog(log)!.args.value as bigint;
        const ev = WPLS_EVENTS.parseLog(log);
        if (ev?.name === 'Withdrawal') return ev.args.wad as bigint;
      } else if (tokenOut !== NATIVE && log.address.toLowerCase() === tokenOut.toLowerCase()) {
        const ev = ERC20.parseLog(log);
        if (ev?.name === 'Transfer' && (ev.args.to as string).toLowerCase() === me) sum = (sum ?? 0n) + (ev.args.value as bigint);
      }
    } catch { /* other event */ }
  }
  return sum;
}

function gasOf(r: ReceiptLike | null | undefined): bigint {
  return r ? r.gasUsed * (r.gasPrice ?? 0n) : 0n;
}

/** Signs with the server signer for this chain. One transaction at a time per chain; nonces tracked per chain. */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private nonce: number | null = null;
  private addr: string | null = null;

  constructor(
    readonly quoter: Quoter,
    private readonly signer: TxSender,
    private readonly opts: { approval: 'exact' | 'max'; receiptTimeoutMs: number; sharedNonce?: SharedNonce },
  ) {}

  async address(): Promise<string> {
    return (this.addr ??= await this.signer.getAddress());
  }

  getPrice() { return this.quoter.getPrice(); }

  async balances() {
    const a = await this.address();
    const { base, stable } = this.quoter;
    const [b, st] = await Promise.all([
      base.native ? this.quoter.reader.getBalance(a) : this.quoter.tokenBalance(a, base.address),
      stable.native ? this.quoter.reader.getBalance(a) : this.quoter.tokenBalance(a, stable.address),
    ]);
    return { pls: fromUnits(b, base.decimals), stable: fromUnits(st, stable.decimals) };
  }

  async quote(side: Side, amount: number, limits: SafetyLimits): Promise<Quote> {
    const a = await this.address();
    const tin = this.quoter.tokenIn(side);
    const allowance = tin !== NATIVE ? await this.quoter.allowance(a, tin) : null;
    // Exact raw units; a float that lands within 1 ppm above the on-chain balance (e.g. selling a 24-decimals lot
    // booked as a float) is clamped to the balance instead of failing.
    await this.quoter.ensureDecimals();
    const decIn = side === 'buy' ? this.quoter.def.quote.decimals : this.quoter.def.base.decimals;
    let units = amountToUnits(amount, decIn);
    const bal = tin !== NATIVE ? await this.quoter.tokenBalance(a, tin) : null;
    if (bal != null && bal < units && units - bal <= units / 1_000_000n + 1n) units = bal;
    const q = await this.quoter.quote(side, amount, limits, a, allowance, { amountInUnits: units });
    const nat = this.quoter.chain.nativeSymbol;
    const nativeBal = await this.quoter.reader.getBalance(a);
    if (bal != null) {
      const sym = side === 'buy' ? this.quoter.stable.symbol : this.quoter.base.symbol;
      if (bal < q.amountIn) { q.balanceOk = false; q.balanceNote = `need ${q.amountInHuman} ${sym}, have ${fromUnits(bal, q.decimalsIn)}`; }
    }
    const needNative = (tin === NATIVE ? q.amountIn : 0n) + q.gasWei;
    if (nativeBal < needNative) { q.balanceOk = false; q.balanceNote = `need ≈${fromUnits(needNative, 18).toPrecision(4)} ${nat} incl. gas, have ${fromUnits(nativeBal, 18).toPrecision(4)}`; }
    const mw = this.quoter.def.safety?.maxWalletTokens;
    // The custom token is received on buys classically, on sells when flipped.
    const receivesToken = side === (this.quoter.tokenSide === 'base' ? 'buy' : 'sell');
    if (receivesToken && mw != null && q.tokenOut !== NATIVE) {
      const held = fromUnits(await this.quoter.tokenBalance(a, q.tokenOut), q.decimalsOut);
      const sym = this.quoter.tokenSide === 'base' ? this.quoter.base.symbol : this.quoter.stable.symbol;
      if (held + q.quotedOutHuman > mw * 0.999) { q.balanceOk = false; q.balanceNote = `holding ${held.toPrecision(6)} + ${q.quotedOutHuman.toPrecision(6)} ${sym} would exceed the token's max wallet ${mw.toPrecision(6)}`; }
    }
    if (q.block) { q.balanceOk = false; q.balanceNote = q.block; }
    return q;
  }

  /** Send with an explicit nonce. On a send error the local nonce is dropped and re-synced from the chain. */
  private async send(req: { to: string; data: string; value: bigint }): Promise<SentTx> {
    const a = await this.address();
    const shared = this.opts.sharedNonce;
    let n: number;
    if (shared) {
      n = await shared.next(() => this.quoter.reader.getTransactionCount(a, 'pending'));
    } else {
      if (this.nonce == null) this.nonce = await this.quoter.reader.getTransactionCount(a, 'pending');
      n = this.nonce;
    }
    try {
      const tx = await this.signer.sendTransaction({ ...req, nonce: n });
      if (!shared) this.nonce = n + 1;
      return tx;
    } catch (e) {
      if (shared) shared.invalidate(); else this.nonce = null;
      throw e;
    }
  }

  /** Wait for a receipt. ethers v6 throws on revert with the receipt attached; normalize that. */
  private async waitFor(tx: SentTx): Promise<ReceiptLike> {
    try {
      const r = await tx.wait(1, this.opts.receiptTimeoutMs);
      if (!r) throw Object.assign(new Error('receipt timeout'), { code: 'TIMEOUT' });
      return r;
    } catch (e) {
      const rec = (e as { receipt?: ReceiptLike }).receipt;
      if (rec) return rec;
      throw e;
    }
  }

  async execute(q: Quote, hooks: ExecHooks): Promise<Fill> {
    let gasWei = 0n;
    let approvalTxHash: string | undefined;
    let swapTxHash: string | undefined;
    const k = q.basePerNative || 1;
    const fail = (msg: string, extra: Partial<ExecError['opts']> = {}) =>
      new ExecError(msg, { gasPls: fromUnits(gasWei, 18) * k, approvalTxHash, swapTxHash, ...extra });

    if (!hooks.canSend()) throw fail('stopped before sending', { aborted: true });

    if (q.approveAmount != null) {
      const amt = this.opts.approval === 'max' ? MaxUint256 : q.approveAmount;
      let tx: SentTx;
      try {
        tx = await this.send({ to: q.tokenIn, data: ERC20.encodeFunctionData('approve', [q.spender, amt]), value: 0n });
      } catch (e) {
        throw fail(`approve send failed: ${shortErr(e)}`, { retryable: true });
      }
      approvalTxHash = tx.hash;
      hooks.onSent('approve', tx.hash);
      let r: ReceiptLike;
      try { r = await this.waitFor(tx); } catch (e) {
        if (this.opts.sharedNonce) this.opts.sharedNonce.invalidate(); else this.nonce = null;
        throw fail(`approve not confirmed: ${shortErr(e)}`, { retryable: true });
      }
      gasWei += gasOf(r);
      if (r.status !== 1) throw fail('approve reverted', { retryable: true });
    }

    if (!hooks.canSend()) throw fail('stopped between approve and swap', { aborted: true });

    // Actual received = balance change of the output token (sends are serialized per chain by the TxGate, so the
    // delta is this swap's). Native out uses the WETH Withdrawal log (native balance also moves by gas).
    const me = await this.address();
    const ercOut = q.tokenOut !== NATIVE;
    let pre: bigint | null = null;
    if (ercOut) { try { pre = await this.quoter.tokenBalance(me, q.tokenOut); } catch { pre = null; } }

    let tx: SentTx;
    try {
      tx = await this.send({ to: q.call.to, data: q.call.data, value: q.call.value });
    } catch (e) {
      throw fail(`swap send failed: ${shortErr(e)}`, { retryable: true });
    }
    swapTxHash = tx.hash;
    hooks.onSent('swap', tx.hash);
    let r: ReceiptLike;
    try { r = await this.waitFor(tx); } catch (e) {
      // Unknown outcome: the tx may still be mined. Never resend; the engine reconciles by hash.
      throw fail(`swap not confirmed yet: ${shortErr(e)}`, { pending: true });
    }
    gasWei += gasOf(r) + q.l1FeeWei;
    if (r.status !== 1) throw fail(`swap reverted (price moved past slippage, deadline passed${q.taxInPct || q.taxOutPct || this.quoter.def.custom ? ', or the token tax changed' : ''})`, { retryable: true });
    const parsed = parseAmountOut(r, me, q.tokenOut, this.quoter.chain.wrappedNative.address);
    let post: bigint | null = null;
    if (ercOut && pre != null) { try { post = await this.quoter.tokenBalance(me, q.tokenOut); } catch { post = null; } }
    const delta = pre != null && post != null ? post - pre : null;
    let out: bigint, outSource: Fill['outSource'];
    if (delta != null && delta > 0n) { out = delta; outSource = 'balance'; }
    else if (parsed != null) { out = parsed; outSource = 'log'; }
    else { out = q.walletMin ?? q.call.amountOutMin; outSource = 'minOut'; }
    const outHuman = fromUnits(out, q.decimalsOut);
    return {
      txHash: tx.hash, approvalTxHash, amountInHuman: q.amountInHuman, amountOutHuman: outHuman,
      gasPls: fromUnits(gasWei, 18) * k, gasNative: fromUnits(gasWei, 18), fromReceipt: outSource !== 'minOut',
      outSource, expectedOutHuman: q.quotedOutHuman, shortfallPct: q.quotedOutHuman > 0 ? 1 - outHuman / q.quotedOutHuman : 0,
      taxPct: 1 - (1 - q.taxInPct) * (1 - q.taxOutPct),
    };
  }

  async recover(hash: string, tokenOut: string, decimalsOut: number) {
    const r = await this.quoter.reader.getTransactionReceipt(hash);
    if (!r) return null;
    const gasPls = fromUnits(gasOf(r), 18) * this.quoter.lastBasePerNative;
    if (r.status !== 1) return { ok: false, amountOutHuman: 0, gasPls };
    const out = parseAmountOut(r, await this.address(), tokenOut, this.quoter.chain.wrappedNative.address);
    return { ok: true, amountOutHuman: out != null ? fromUnits(out, decimalsOut) : 0, gasPls };
  }
}

/**
 * Paper mode: real on-chain quotes, simulated fills at the quoted amount, estimated gas. No key needed.
 * Charges the same approve gas live would (every ERC-20-input swap in 'exact' mode, first per token in 'max').
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;
  static readonly ADDRESS = '0x000000000000000000000000000000000000dEaD';
  private approved = new Set<string>();
  constructor(
    readonly quoter: Quoter,
    private readonly simBalances: () => { pls: number; stable: number },
    private readonly approval: 'exact' | 'max' = 'exact',
  ) {}
  async address() { return null; }
  getPrice() { return this.quoter.getPrice(); }
  async balances() { return this.simBalances(); }
  async quote(side: Side, amount: number, limits: SafetyLimits) {
    const tin = this.quoter.tokenIn(side);
    const simAllowance = tin !== NATIVE ? (this.approval === 'max' && this.approved.has(`${this.quoter.adapter.spender}:${tin}`) ? MaxUint256 : 0n) : null;
    // Exact raw units for sells of a float lot: clamp within 1 ppm of the paper balance (mirrors LiveExecutor).
    await this.quoter.ensureDecimals();
    const decIn = side === 'buy' ? this.quoter.def.quote.decimals : this.quoter.def.base.decimals;
    let units = amountToUnits(amount, decIn);
    const b = this.simBalances();
    if (side === 'sell') {
      const held = amountToUnits(b.pls, decIn);
      if (held < units && units - held <= units / 1_000_000n + 1n) units = held;
    }
    const q = await this.quoter.quote(side, amount, limits, PaperExecutor.ADDRESS, simAllowance, { amountInUnits: units });
    if (side === 'buy' && b.stable + 1e-9 < q.amountInHuman) { q.balanceOk = false; q.balanceNote = `paper ${this.quoter.stable.symbol} ${b.stable.toFixed(4)} < ${q.amountInHuman}`; }
    if (side === 'sell' && b.pls + 1e-6 < q.amountInHuman) { q.balanceOk = false; q.balanceNote = `paper ${this.quoter.base.symbol} ${b.pls.toFixed(2)} < ${q.amountInHuman}`; }
    // Paper honours token limits too (max-tx is in q.block); a taxed token on an unproven V3 pool is fine on paper.
    const mw = this.quoter.def.safety?.maxWalletTokens;
    const tokBase = this.quoter.tokenSide === 'base';
    if (mw != null && side === (tokBase ? 'buy' : 'sell') && (tokBase ? b.pls : b.stable) + q.quotedOutHuman > mw * 0.999) { q.balanceOk = false; q.balanceNote = `paper holding + ${side} would exceed the token's max wallet ${mw.toPrecision(6)}`; }
    if (q.block && !q.block.startsWith('taxed token on a V3')) { q.balanceOk = false; q.balanceNote = q.block; }
    else if (q.block) { q.balanceOk = true; q.balanceNote = null; }
    return q;
  }
  async execute(q: Quote, hooks: ExecHooks): Promise<Fill> {
    if (!hooks.canSend()) throw new ExecError('stopped', { aborted: true });
    const hash = `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (q.approveAmount != null) this.approved.add(`${q.spender}:${q.tokenIn}`);
    // Paper fill = the post-tax quote (taxes measured by the safety probe are applied in Quoter.quote).
    return {
      txHash: hash, amountInHuman: q.amountInHuman, amountOutHuman: q.quotedOutHuman, gasPls: q.gasPlsEstimate, gasNative: q.gasNativeEstimate,
      fromReceipt: false, outSource: 'paper', expectedOutHuman: q.quotedOutHuman, shortfallPct: 0, taxPct: 1 - (1 - q.taxInPct) * (1 - q.taxOutPct),
    };
  }
  async recover() { return null; }
}

/** Placeholder executor for a bot whose market is no longer configured (custom market removed). */
export class UnavailableExecutor implements Executor {
  readonly mode: 'paper' | 'live';
  constructor(mode: 'paper' | 'live', private readonly why: string) { this.mode = mode; }
  async address() { return null; }
  async getPrice(): Promise<number> { throw new Error(this.why); }
  async balances() { return { pls: 0, stable: 0 }; }
  async quote(): Promise<Quote> { throw new Error(this.why); }
  async execute(): Promise<Fill> { throw new ExecError(this.why, { aborted: true }); }
  async recover() { return null; }
}
