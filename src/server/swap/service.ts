/**
 * Same-chain swap quotes across this app's DEX adapters, plus an optional aggregator.
 *
 * Given a chain, tokenIn, tokenOut and amountIn (raw units), it quotes every pool the adapters
 * find, prices gas in the output token, and keeps the route with the best net output.
 * Taxes use src/live/tax.ts the same way the grid quoter does: the pool is quoted on the
 * post-sell-tax input, the wallet amount is post-buy-tax, V2 fee-on-transfer swaps set the
 * router minimum on that post-tax amount, and a taxed V3 pool is skipped unless it was proven.
 *
 * Bot-reserved balances (MultiBot.allocations) are subtracted before anything is quoted, and the
 * chain's low-gas floor is kept when the input is the native coin.
 *
 * Paper mode returns the quote only. Live mode also returns calldata. This class has no send
 * path — a later sender can take `tx` (the sendSafe shape) and broadcast it.
 */
import type { ChainConfig } from '../../live/chains';
import { amountToUnits, readDecimals, unitsToString } from '../../live/decimals';
import { DEFAULT_LIMITS } from '../../live/limits';
import type { PoolRef } from '../../live/markets';
import { NATIVE, applySlippage, deadlineFromNow, validateSlippageBps } from '../../live/swapMath';
import { NO_TAX, TAX_TOLERANCE, afterTax, isTaxed, type Taxes } from '../../live/tax';
import type { ChainRuntime } from '../chains/runtime';
import type { ChainReader } from '../bot/chain';
import type { DexAdapter } from '../dex/types';
import { sameAddr } from '../dex/types';
import { NullAggregator } from './aggregator';
import { SpendHolds, type ReservedBalance } from './holds';
import type { SendableTx, SwapAggregator, SwapAllocation, SwapQuoteRequest, SwapQuoteResult, SwapRoute } from './types';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export interface SwapServiceDeps {
  runtime(chainId: number): ChainRuntime;
  allocations(): SwapAllocation[];
  /**
   * Extra coins already committed: token-trader positions (the token and the spend coin),
   * an open converter job, and in-flight router moves. Omitted sources contribute nothing.
   */
  reservations?: () => ReservedBalance[];
  /** Shared so tests can move the clock. Created when omitted. */
  holds?: SpendHolds;
  aggregator?: SwapAggregator;
  /** Per-token taxes from the safety probe. Missing entries are untaxed. Native coin is always untaxed. */
  taxes?(chainId: number, token: string): Taxes;
  /**
   * V3 routers have no fee-on-transfer method. A taxed token is quoted on V3 only when the
   * existing safety probe proved it (taxMode 'v3-proven').
   */
  v3Proven?(chainId: number, token: string): boolean;
  nowSec?: () => number;
}

interface Scored {
  route: SwapRoute;
  tx?: SendableTx;
}

export class SwapService {
  private readonly holds: SpendHolds;
  private spendLock: Promise<void> = Promise.resolve();

  constructor(private readonly d: SwapServiceDeps) {
    this.holds = d.holds ?? new SpendHolds();
  }

  /** Drop a quote-to-execute hold (the quote failed, or the later sender finished). */
  release(id: string) { this.holds.release(id); }

  async quote(req: SwapQuoteRequest): Promise<SwapQuoteResult> {
    if (req.amountIn <= 0n) throw new Error('amountIn must be positive');
    const rt = this.d.runtime(req.chainId);
    const cfg = rt.cfg;
    const tokenIn = norm(req.tokenIn);
    const tokenOut = norm(req.tokenOut);
    if (tokenIn === tokenOut || (tokenIn !== NATIVE && tokenOut !== NATIVE && sameAddr(tokenIn, tokenOut))) throw new Error('tokenIn and tokenOut must differ');
    const slippageBps = req.slippageBps ?? DEFAULT_LIMITS.slippageBps;
    const slipErr = validateSlippageBps(slippageBps);
    if (slipErr) throw new Error(slipErr);
    const maxImpact = req.maxPriceImpact ?? DEFAULT_LIMITS.maxPriceImpact;
    if (!(maxImpact > 0 && maxImpact < 1)) throw new Error('max price impact must be between 0 and 100%');
    const deadlineMin = req.deadlineMinutes ?? DEFAULT_LIMITS.deadlineMinutes;
    if (!(deadlineMin >= 1 && deadlineMin <= 60)) throw new Error('Deadline must be between 1 and 60 minutes.');
    // Live calldata is only ever for the signer. The request's owner and recipient are ignored.
    const live = req.mode === 'live' && rt.signer != null;
    let owner: string;
    let recipient: string;
    if (live) {
      const signer = await rt.signer!.getAddress();
      if (!ADDR.test(signer)) throw new Error('signer address is not a wallet');
      owner = signer;
      recipient = signer;
    } else {
      owner = req.owner;
      recipient = req.recipient ?? req.owner;
      if (!ADDR.test(owner)) throw new Error('owner must be a wallet address');
      if (!ADDR.test(recipient)) throw new Error('Recipient must be a wallet address');
    }
    const paper = !live;

    const inNative = tokenIn === NATIVE;
    const outNative = tokenOut === NATIVE;
    const [decimalsIn, decimalsOut] = await Promise.all([
      inNative ? Promise.resolve(18) : readDecimals(rt.reader, cfg.id, tokenIn),
      outNative ? Promise.resolve(18) : readDecimals(rt.reader, cfg.id, tokenOut),
    ]);
    const deadline = deadlineFromNow(deadlineMin, this.d.nowSec?.());
    let holdId: string | null = null;
    await this.spendCritical(async () => {
      await this.assertSpendable(rt, cfg, tokenIn, inNative, owner, req.amountIn, decimalsIn);
      if (!paper) holdId = this.holds.place({ chainId: cfg.id, token: tokenIn, native: inNative, amount: req.amountIn, expiresAt: Number(deadline) * 1000 });
    });

    try {
    const poolIn = inNative ? cfg.wrappedNative.address : tokenIn;
    const poolOut = outNative ? cfg.wrappedNative.address : tokenOut;
    const taxInTok = this.tax(cfg.id, inNative ? null : tokenIn);
    const taxOutTok = this.tax(cfg.id, outNative ? null : tokenOut);
    const taxInPct = taxInTok.sell;
    // Buy is the pool→wallet haircut. A token that only taxes transfers still takes that on the way out.
    const taxOutPct = walletOutTax(taxOutTok);
    const poolAmount = afterTax(req.amountIn, taxInPct);
    if (poolAmount <= 0n) {
      if (holdId) this.holds.release(holdId);
      throw new Error('Trade amount rounds to zero after the input token tax');
    }
    const gasPrice = await effectiveGasPrice(rt.reader);
    const inIsWrapped = inNative || sameAddr(tokenIn, cfg.wrappedNative.address);
    const outIsWrapped = outNative || sameAddr(tokenOut, cfg.wrappedNative.address);

    const scored: Scored[] = [];
    await Promise.all([...rt.adapters.values()].map(async (ad) => {
      let pools: PoolRef[] = [];
      try { pools = await ad.findPools(poolIn, poolOut); } catch { return; }
      const seen = new Set<string>();
      for (const pool of pools) {
        const addr = pool.address.toLowerCase();
        if (seen.has(addr)) continue;
        seen.add(addr);
        // V3 has no fee-on-transfer router method. Skip a taxed token unless the safety probe proved it.
        if (ad.kind === 'v3' && !this.v3TaxOk(cfg.id, tokenIn, taxInTok, tokenOut, taxOutTok)) continue;
        try {
          scored.push(await this.scorePool(rt, ad, pool, {
            cfg, tokenIn, tokenOut, poolIn, poolOut, amountIn: req.amountIn, poolAmount,
            taxInPct, taxOutPct, taxInTok, taxOutTok, slippageBps, gasPrice, inIsWrapped, outIsWrapped,
            recipient, deadline, paper,
          }));
        } catch { /* this pool did not quote */ }
      }
    }));

    const agg = this.d.aggregator ?? new NullAggregator();
    try {
      const ext = await agg.quote({ chainId: cfg.id, tokenIn, tokenOut, amountIn: req.amountIn });
      if (ext && ext.amountOut > 0n) {
        const gasUnits = ext.gasUnits > 0n ? ext.gasUnits : BigInt(cfg.gasUnits.swap);
        const gasWei = gasUnits * gasPrice;
        const gasOut = await this.gasInOutput(rt, tokenOut, gasWei, req.amountIn, ext.amountOut, inIsWrapped, outIsWrapped);
        const minOut = applySlippage(ext.amountOut, slippageBps);
        const route: SwapRoute = {
          id: `aggregator:${agg.id}`, kind: 'aggregator', amountOut: ext.amountOut, routerOut: ext.amountOut, minOut,
          priceImpact: ext.priceImpact, gasUnits, gasWei, gasOut, netOut: ext.amountOut - gasOut,
          feeBps: ext.feeBps, taxIn: 0, taxOut: 0, feeOnTransfer: false, pool: null,
        };
        const tx = !paper && ext.tx ? { chainId: cfg.id, to: ext.tx.to, data: ext.tx.data, value: ext.tx.value, method: 'aggregator' } : undefined;
        scored.push({ route, ...(tx ? { tx } : {}) });
      }
    } catch { /* aggregator is optional */ }

    const usable = scored.filter((s) => s.route.priceImpact <= maxImpact && s.route.amountOut > 0n);
    if (!usable.length) {
      if (holdId) this.holds.release(holdId);
      if (scored.length) throw new Error(`Every route moves the price more than ${(maxImpact * 100).toFixed(1)}%.`);
      throw new Error('No pool for this pair on a DEX this app trades.');
    }
    usable.sort((a, b) => cmp(a.route, b.route));
    const best = usable[0];
    let tx: SendableTx | null = null;
    if (!paper) {
      if (best.tx) tx = best.tx;
      else if (best.route.kind === 'aggregator') tx = null;
      else {
        if (holdId) this.holds.release(holdId);
        throw new Error('Best route did not build a transaction');
      }
    }
    if (!tx && holdId) { this.holds.release(holdId); holdId = null; }
    const r = best.route;
    return {
      paper, chainId: cfg.id, tokenIn, tokenOut, amountIn: req.amountIn, decimalsIn, decimalsOut,
      expectedOut: r.amountOut, minOut: r.minOut, priceImpact: r.priceImpact, gasEstimate: r.gasUnits, gasWei: r.gasWei,
      fees: { lpBps: r.feeBps, taxIn: r.taxIn, taxOut: r.taxOut },
      taxes: { in: taxInTok, out: taxOutTok },
      feeOnTransfer: r.feeOnTransfer,
      route: r,
      routes: usable.map((s) => s.route),
      tx,
      holdId,
    };
    } catch (e) {
      if (holdId) this.holds.release(holdId);
      throw e;
    }
  }

  private tax(chainId: number, token: string | null): Taxes {
    if (!token) return NO_TAX;
    return this.d.taxes?.(chainId, token) ?? NO_TAX;
  }

  /** Untaxed tokens need no proof. A taxed ERC-20 on V3 needs v3Proven for that token. */
  private v3TaxOk(chainId: number, tokenIn: string, taxIn: Taxes, tokenOut: string, taxOut: Taxes): boolean {
    const ok = (token: string, tax: Taxes) => !isTaxed(tax) || token === NATIVE || (this.d.v3Proven?.(chainId, token) ?? false);
    return ok(tokenIn, taxIn) && ok(tokenOut, taxOut);
  }

  /** Check and (for live calldata) hold without another quote slipping in between. */
  private async spendCritical<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prev = this.spendLock;
    this.spendLock = prev.then(() => gate);
    await prev;
    try { return await fn(); } finally { release(); }
  }

  private async assertSpendable(rt: ChainRuntime, cfg: ChainConfig, tokenIn: string, native: boolean, owner: string, amountIn: bigint, decimals: number) {
    const balance = native ? await rt.reader.getBalance(owner) : await rt.tokenBalance(owner, tokenIn);
    let reserved = 0n;
    const add = (amount: number) => { if (amount > 0) reserved += amountToUnits(amount, decimals); };
    for (const a of this.d.allocations()) {
      if (a.chainId !== cfg.id) continue;
      if (native ? a.native : !a.native && sameAddr(a.address, tokenIn)) add(a.allocated);
    }
    for (const a of this.d.reservations?.() ?? []) {
      if (a.chainId !== cfg.id) continue;
      if (native ? a.native : !a.native && sameAddr(a.address, tokenIn)) add(a.amount);
    }
    const quoteHeld = this.holds.held(cfg.id, tokenIn, native);
    const gasKeep = native ? amountToUnits(cfg.lowGasNative, 18) : 0n;
    const held = reserved + quoteHeld + gasKeep;
    const spendable = balance > held ? balance - held : 0n;
    if (amountIn > spendable) {
      const why = reserved > 0n || quoteHeld > 0n ? 'after live-bot reservations' : 'of the wallet';
      throw new Error(`Not enough to swap ${unitsToString(amountIn, decimals)}: ${unitsToString(spendable, decimals)} is spendable ${why}${native && gasKeep > 0n ? ' (gas kept aside)' : ''}.`);
    }
  }

  private async scorePool(rt: ChainRuntime, ad: DexAdapter, pool: PoolRef, x: {
    cfg: ChainConfig; tokenIn: string; tokenOut: string; poolIn: string; poolOut: string;
    amountIn: bigint; poolAmount: bigint; taxInPct: number; taxOutPct: number;
    taxInTok: Taxes; taxOutTok: Taxes; slippageBps: number; gasPrice: bigint;
    inIsWrapped: boolean; outIsWrapped: boolean; recipient: string; deadline: bigint; paper: boolean;
  }): Promise<Scored> {
    // V2 pulls amountIn and the pool sees the post-tax remainder. V3 sends amountIn straight through,
    // so the quoter and the router are given the same amount.
    const quoteAmount = ad.kind === 'v3' ? x.amountIn : x.poolAmount;
    const q = await ad.quote(pool, x.poolIn, x.poolOut, quoteAmount);
    const routerOut = q.amountOut;
    const amountOut = afterTax(routerOut, x.taxOutPct);
    if (amountOut <= 0n) throw new Error('quoted output is zero');
    const taxed = isTaxed(x.taxInTok) || isTaxed(x.taxOutTok);
    // V2 checks the recipient balance, so the minimum is post-tax. V3 checks the pool output, so the
    // router minimum stays pre-tax; minOut on the quote is still what the wallet must receive.
    const feeOnTransfer = ad.kind === 'v2' && taxed;
    const routerMin = applySlippage(ad.kind === 'v2' ? amountOut : routerOut, x.slippageBps);
    const minOut = applySlippage(amountOut, x.slippageBps);
    const gasUnits = q.gasEstimate && q.gasEstimate > 0n ? q.gasEstimate : BigInt(x.cfg.gasUnits.swap);
    const gasWei = gasUnits * x.gasPrice;
    const gasOut = await this.gasInOutput(rt, x.tokenOut, gasWei, x.amountIn, amountOut, x.inIsWrapped, x.outIsWrapped);
    const route: SwapRoute = {
      id: ad.cfg.id, kind: ad.kind, amountOut, routerOut, minOut, priceImpact: q.impact,
      gasUnits, gasWei, gasOut, netOut: amountOut - gasOut, feeBps: pool.feeBps,
      taxIn: x.taxInPct, taxOut: x.taxOutPct, feeOnTransfer, pool,
    };
    if (x.paper) return { route };
    const built = ad.buildSwap({
      pool, tokenIn: x.tokenIn, tokenOut: x.tokenOut, amountIn: x.amountIn, amountOutMin: routerMin,
      recipient: x.recipient, deadline: x.deadline, feeOnTransfer,
    });
    return { route, tx: { chainId: x.cfg.id, to: built.to, data: built.data, value: built.value, method: built.method } };
  }

  /** Gas priced in tokenOut raw units. Neither leg wrapped: convert through a wrapped-native pool. */
  private async gasInOutput(rt: ChainRuntime, tokenOut: string, gasWei: bigint, amountIn: bigint, amountOut: bigint, inIsWrapped: boolean, outIsWrapped: boolean): Promise<bigint> {
    if (gasWei <= 0n) return 0n;
    if (outIsWrapped) return gasWei;
    if (inIsWrapped && amountIn > 0n) return gasWei * amountOut / amountIn;
    const wrapped = rt.cfg.wrappedNative.address;
    const forward = await this.probeOut(rt, wrapped, tokenOut, gasWei);
    if (forward != null) return forward;
    const unit = 10n ** 12n;
    const back = await this.probeOut(rt, tokenOut, wrapped, unit);
    if (back != null && back > 0n) return gasWei * unit / back;
    return 0n;
  }

  /** First pool's exact-in output, or null when this pair is not quoted. */
  private async probeOut(rt: ChainRuntime, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint | null> {
    for (const ad of rt.adapters.values()) {
      let pools: PoolRef[] = [];
      try { pools = await ad.findPools(tokenIn, tokenOut); } catch { continue; }
      for (const pool of pools) {
        try {
          const q = await ad.quote(pool, tokenIn, tokenOut, amountIn, false);
          if (q.amountOut > 0n) return q.amountOut;
        } catch { /* next pool */ }
      }
    }
    return null;
  }
}

function norm(t: string): string {
  const s = t.trim();
  if (s.toLowerCase() === NATIVE) return NATIVE;
  return s;
}

/** Buy tax when the probe measured one; otherwise a transfer-only tax, which still leaves the wallet short. */
function walletOutTax(t: Taxes): number {
  if (t.buy > TAX_TOLERANCE) return t.buy;
  if (t.transfer > TAX_TOLERANCE) return t.transfer;
  return 0;
}

type FeeSnap = { gasPrice: bigint | null; maxFeePerGas: bigint | null; maxPriorityFeePerGas?: bigint | null };
type BlockSnap = { baseFeePerGas?: bigint | null } | null;

/**
 * What a transaction is expected to pay per gas: base fee + tip, capped by maxFeePerGas.
 * Legacy chains (no base fee) use eth_gasPrice.
 */
async function effectiveGasPrice(reader: ChainReader): Promise<bigint> {
  const fee = await reader.getFeeData() as FeeSnap;
  const tip = fee.maxPriorityFeePerGas ?? 0n;
  const extra = reader as ChainReader & { getBlockNumber?: () => Promise<number>; getBlock?: (n: number) => Promise<BlockSnap> };
  let base: bigint | null = null;
  if (typeof extra.getBlockNumber === 'function' && typeof extra.getBlock === 'function') {
    try {
      const n = await extra.getBlockNumber();
      const b = await extra.getBlock(n);
      if (b?.baseFeePerGas != null && b.baseFeePerGas > 0n) base = b.baseFeePerGas;
    } catch { /* legacy price below */ }
  }
  if (base != null) {
    const want = base + tip;
    const cap = fee.maxFeePerGas;
    return cap != null && cap > 0n && cap < want ? cap : want;
  }
  return fee.gasPrice ?? 0n;
}

function cmp(a: SwapRoute, b: SwapRoute): number {
  if (a.netOut !== b.netOut) return a.netOut > b.netOut ? -1 : 1;
  if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
  if (a.gasWei !== b.gasWei) return a.gasWei < b.gasWei ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
