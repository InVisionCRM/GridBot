/**
 * Token trader decisions (pure). The server (server/bot/tokenTrader.ts) feeds it pools and fills;
 * paper and live share these rules.
 *
 * Discovery for the scan path keeps a pool only when it is old enough (default 24h, a setting) and pairs
 * the chain's native coin or a stablecoin. A sniper pool skips the age check on purpose and still has to
 * pass the safety gate.
 *
 * Exits, in order: sell simulation failed, tax appeared or rose, liquidity pulled, hard stop, trailing stop,
 * take-profit ladders, time stop, volume decay. A sell is split so each piece stays under the price-impact cap.
 */
import { usdAsEth } from '../lib/ethUnits';
import { HARD_CAPS } from '../live/limits';
import { MAX_TAX, TAX_TOLERANCE } from '../live/tax';
import { simBuy, simSell, type CostModel } from './costs';
import { DEFAULT_MAX_HOLDER_SHARE, DEFAULT_MAX_TOP10_SHARE, clampHolderShare, holderBound, thinCoverageReason } from './holders';
import { capSwap, TOKEN_MAX_POOL_SHARE } from './poolSize';
import { isWashVolume } from './scan';
import type { LpUnlockEvidence } from './lpUnlock';
import { v3LockSatisfies, type V3LpReport } from './v3LpLock';

export const DEFAULT_MIN_POOL_AGE_SEC = 24 * 3600;
export const DEFAULT_SNIPER_MIN_LIQ_USD = 5_000;
/** Default cap for the optional trade-size impact check. The 3% sizing cap and the 3%/5% depth rules stay. */
export const DEFAULT_SIZE_IMPACT_CAP = 0.01;

export const EXIT = {
  hardStop: 0.25,
  tp1: 0.5,
  tp1Frac: 1 / 3,
  tp2: 1,
  tp2Frac: 1 / 3,
  trailArm: 0.3,
  trailGap: 0.2,
  timeStopMs: 6 * 3600_000,
  timeStopMinGain: 0.1,
  volDecay: 0.25,
  liqPull: 0.4,
} as const;

/**
 * costs.ts simBuy / simSell take the SELL-SIDE price (what one token fetches after one LP fee): pool mid × (1 − fee).
 * Pools here carry the reserve mid, so convert before calling them (passing the mid charged the fee twice on a paper
 * buy and not at all on a paper sell).
 */
export function sellSidePrice(mid: number, feeBps: number): number {
  return mid * (1 - feeBps / 10_000);
}

/**
 * Effective entry, spend per token actually received: net of the entry fee, price impact, slippage and buy tax.
 * Paper and live use this same formula on their fill (paper: the simBuy fill; live: amountIn / amount received).
 */
export function effectiveEntry(spent: number, tokens: number): number {
  return spent > 0 && tokens > 0 ? spent / tokens : 0;
}

/**
 * Move needed in the pool mid to break even after a buy and a sell: the entry fee, the exit fee, and the sell tax taken
 * from the tokens sold (1%/1% → +2.03%; 1%/1% + 5% sell tax → +7.40%). A buy tax is in the entry already (fewer tokens).
 */
export function breakEvenMove(entryFeeBps: number, exitFeeBps: number, sellTax = 0): number {
  return 1 / ((1 - entryFeeBps / 10_000) * (1 - exitFeeBps / 10_000) * (1 - sellTax)) - 1;
}

export interface FreshPool {
  chainId: number;
  pool: string;
  dex: string;
  kind: 'v2' | 'v3' | 'v4';
  token: string;
  spend: string;
  tokenSymbol: string;
  spendSymbol: string;
  liquidityUsd: number;
  volumeUsd: number;
  /** ms; null when the source didn't say */
  createdAt: number | null;
  source: 'new' | 'trending' | 'snipe';
  /** Spend-side depth, human units */
  quoteReserve: number;
  /** Token-side depth, human units (sell impact) */
  tokenReserve: number;
  /** The pool's swap fee in bps, read from the pool (V3 fee()) or the DEX's V2 fee; never a DEX-wide default tier */
  feeBps: number;
  /** The pool's fee can change between blocks: read it again before every quote (sizing, sells) */
  dynamicFee?: boolean;
  /** Spend per token */
  price: number;
  usdPerSpend: number;
  /** The launch venue it came from (venues.ts); each has an on/off switch (TraderOptions.venues) */
  venue?: string;
}

/** Scan discovery. Snipes are not passed here: min age does not apply to them. */
export function filterFresh(pools: FreshPool[], o: { now: number; minAgeMs: number; minLiquidityUsd?: number }): { keep: FreshPool[]; skipped: { pool: FreshPool; why: string }[] } {
  const keep: FreshPool[] = [], skipped: { pool: FreshPool; why: string }[] = [];
  const seen = new Set<string>();
  for (const p of pools) {
    const id = `${p.chainId}:${p.pool.toLowerCase()}`;
    if (seen.has(id)) { skipped.push({ pool: p, why: 'already seen' }); continue; }
    seen.add(id);
    if (!(p.price > 0) || !(p.quoteReserve > 0)) { skipped.push({ pool: p, why: 'no price or depth' }); continue; }
    const minL = o.minLiquidityUsd ?? 0;
    if (p.liquidityUsd < minL) { skipped.push({ pool: p, why: `liquidity ${usdAsEth(p.liquidityUsd)} is below ${usdAsEth(minL)}` }); continue; }
    if (p.createdAt != null && o.minAgeMs > 0 && o.now - p.createdAt < o.minAgeMs) {
      const h = Math.max(0, Math.round((o.now - p.createdAt) / 3600_000));
      skipped.push({ pool: p, why: `pool is ${h}h old (minimum ${Math.round(o.minAgeMs / 3600_000)}h for scan discovery)` });
      continue;
    }
    keep.push(p);
  }
  return { keep, skipped };
}

export interface GateInput {
  mode: 'paper' | 'live';
  risk: 'safe' | 'medium' | 'any';
  honeypot: boolean | null;
  sellSimOk: boolean | null;
  paused: boolean | null;
  decimals: number | null;
  buyTax: number | null;
  sellTax: number | null;
  maxTax?: number;
  liquidityUsd: number;
  minLiquidityUsd: number;
  canPause: boolean | null;
  canBlacklist: boolean | null;
  proxy: boolean | null;
  /**
   * LP can be pulled by the owner (not burned / not locked). null = not detectable, and null is not a block.
   * Assess leaves this null unless `lpUnlockCheck` is on. That option fills it from lpRemovable (V2) or the
   * V3 position-NFT report. Nothing here reads a GoPlus-style LP-holder list.
   */
  lpUnlocked: boolean | null;
  /**
   * Set only when `lpUnlockCheck` ran. `unverified` fails closed for safe/medium.
   * Absent (the default) leaves this gate unchanged.
   */
  lpUnlock?: LpUnlockEvidence;
  /**
   * On-chain V3 position-NFT evidence. Set only when the trader option `v3LpLockCheck` is on.
   * Absent (the default) leaves this gate unchanged.
   */
  v3Lp?: V3LpReport;
  /**
   * Largest holder as a share of circulating supply. null = unknown.
   * Unknown is not a block unless `enforceHolderCheck` is on (safe and medium then fail closed).
   */
  holderConcentration: number | null;
  /**
   * Holder-concentration check. Absent or false: `top10Concentration` and `holdersUnverified` are ignored,
   * and a null `holderConcentration` stays "not a block", which is today's gate.
   */
  enforceHolderCheck?: boolean;
  /** Top 10 holders as a share of circulating supply. Ignored unless `enforceHolderCheck`. */
  top10Concentration?: number | null;
  /** The holder list could not be read. Fails closed for safe and medium only when `enforceHolderCheck`. */
  holdersUnverified?: boolean;
  /** Why the read is unverified. Ignored unless `enforceHolderCheck`. */
  holderUnavailable?: 'no-source' | 'read-failed';
  /** Chain name used in the unavailable skip reason. */
  holderChain?: string;
  /** Largest-holder cap, as a share. Ignored unless `enforceHolderCheck`. Default 10%. */
  maxHolderShare?: number;
  /** Top-10 cap, as a share. Ignored unless `enforceHolderCheck`. Default 40%. */
  maxTop10Share?: number;
  /** Circulating share a log sample did not measure. Ignored unless `enforceHolderCheck`. */
  holderUnseen?: number | null;
  /** The top-10 figure is a full list, so `holderUnseen` is not added to it. */
  top10Exact?: boolean;
  /** Explained balances ÷ totalSupply. Ignored unless `enforceHolderCheck`. */
  holderCoverage?: number | null;
  /** The log window or the explained supply is too thin to trust the shares. */
  holderThin?: boolean;
  holderWindowFrom?: number | null;
  holderCreationBlock?: number | null;
  recentLiqPull: boolean;
  /** The existing safety classifier. Live still requires this. */
  liveAllowed: boolean;
  /**
   * Wash volume and minimum pool age. Ignored unless this is true, so a gate call that leaves it off
   * matches the gate from before this check existed.
   */
  enforceWashAndAge?: boolean;
  /** A volume or age read failed. Safe and medium skip when the flag is on. */
  freshnessUnverified?: boolean;
  /** Used only for the wash check, and only when the flag is on. */
  volumeUsd?: number;
  /** Seconds since the pool was created. null = unknown. Ignored unless the flag is on. */
  poolAgeSec?: number | null;
  /** Same setting as scan discovery (`minPoolAgeSec`). 0 means no age requirement. */
  gateMinPoolAgeSec?: number;
  /**
   * Owner, EIP-1967 admin, and setter scan. Ignored unless this is true, so a gate call that
   * leaves it off matches the gate from before this check existed.
   */
  enforceOwnerPowers?: boolean;
  /** A read we needed failed. Safe and medium skip when the flag is on. */
  ownerPowersUnverified?: boolean;
  /** Skip text when a non-renounced owner holds a blocking power, or a live admin can upgrade. */
  ownerPowersWhy?: string | null;
  /**
   * Quote impact at the sized trade and cap it. Absent or false: `sizeImpact` is ignored, so the gate
   * matches today. The $100/$500/$1000 depth rules and the sizing cap are unchanged either way.
   */
  enforceSizeImpact?: boolean;
  /** Impact at the sized trade. null = the quote failed. Ignored unless `enforceSizeImpact`. */
  sizeImpact?: number | null;
  /** Cap for that impact. Default 1% when the check is on. */
  sizeImpactCap?: number;
}

export interface GateResult {
  ok: boolean;
  liveOk: boolean;
  reason: string | null;
  /** Present only when the input carried a V3 report. */
  v3Lp?: V3LpReport;
  /** Present only when the input carried an lpUnlockCheck result. */
  lpUnlock?: LpUnlockEvidence;
  /** Set for aggressive mode when coverage is thin. Safe and medium skip instead. */
  warn?: string;
}

/**
 * The trade-size impact rule. null impact (the quote threw or never came back) fails closed.
 * A cap outside (0, 5%] falls back to 1% rather than letting the trade through.
 */
export function sizeImpactReason(impact: number | null, cap: number): string | null {
  const limit = cap > 0 && cap <= HARD_CAPS.maxPriceImpact ? cap : DEFAULT_SIZE_IMPACT_CAP;
  if (impact == null || !Number.isFinite(impact)) return 'price impact at this size could not be verified';
  if (impact > limit) return `price impact ${(impact * 100).toFixed(2)}% at this size is over the ${(limit * 100).toFixed(2)}% cap`;
  return null;
}

/**
 * Extra gate in front of the existing classifier. It does not weaken it: live still needs liveAllowed,
 * and a honeypot, a failed sell, a pause, or a tax over the cap is blocked in both modes.
 */
export function gateToken(g: GateInput): GateResult {
  const maxTax = g.maxTax ?? MAX_TAX;
  // No evidence keys unless that check actually ran, so a flag-off result stays { liveOk, ok, reason }.
  const carried = (): Partial<Pick<GateResult, 'v3Lp' | 'lpUnlock'>> => {
    const extra: Partial<Pick<GateResult, 'v3Lp' | 'lpUnlock'>> = {};
    if (g.v3Lp !== undefined) extra.v3Lp = g.v3Lp;
    if (g.lpUnlock !== undefined) extra.lpUnlock = g.lpUnlock;
    return extra;
  };
  const hard = (reason: string): GateResult => ({ ok: false, liveOk: false, reason, ...carried() });
  if (g.honeypot === true) return hard('honeypot: the sell simulation was blocked');
  if (g.sellSimOk === false) return hard('sell simulation failed');
  if (g.paused === true) return hard('token is paused');
  if (g.decimals == null || !(g.decimals >= 0 && g.decimals <= 36)) return hard('decimals unreadable');
  if (g.liquidityUsd < g.minLiquidityUsd) return hard(`liquidity ${usdAsEth(g.liquidityUsd)} is under the ${usdAsEth(g.minLiquidityUsd)} minimum`);
  if (g.recentLiqPull) return hard('liquidity was pulled');
  const tax = Math.max(g.buyTax ?? 0, g.sellTax ?? 0);
  if (g.mode === 'live' && tax > maxTax) return hard(`tax ${(tax * 100).toFixed(1)}% is over the ${(maxTax * 100).toFixed(0)}% live cap`);
  if (g.mode === 'live' && !g.liveAllowed) return hard('safety check does not allow live trading');
  let coverageWarn: string | null = null;
  if (g.enforceHolderCheck && g.holderThin) {
    const msg = thinCoverageReason({ coverage: g.holderCoverage ?? null, windowFrom: g.holderWindowFrom, creationBlock: g.holderCreationBlock });
    if (g.risk === 'safe' || g.risk === 'medium') return hard(msg);
    coverageWarn = msg;
  }
  if (g.enforceHolderCheck && !g.holderThin && g.holdersUnverified && (g.risk === 'safe' || g.risk === 'medium')) {
    const chain = g.holderChain && g.holderChain.trim() ? g.holderChain.trim() : 'this chain';
    if (g.holderUnavailable === 'no-source') return hard(`holder concentration unavailable: no holder data source for ${chain}`);
    return hard(`holder concentration unavailable: holder read failed for ${chain}`);
  }
  if (g.risk === 'safe' || g.risk === 'medium') {
    if (g.canPause === true) return hard('owner can pause');
    // Both reports are optional. With neither present, only an explicit lpUnlocked true blocks; null does not.
    // When the V3 check ran, unverified and verified-but-not-locked both block, even if lpUnlocked was left null.
    if (g.v3Lp?.status === 'unverified') return hard('V3 liquidity lock unverified');
    if (g.v3Lp?.status === 'verified' && !v3LockSatisfies(g.v3Lp)) return hard('liquidity is unlocked');
    if (g.lpUnlock?.status === 'unverified') return hard(g.lpUnlock.kind === 'v3' ? 'V3 liquidity lock unverified' : 'liquidity lock unverified');
    if (g.lpUnlocked === true && !v3LockSatisfies(g.v3Lp)) return hard('liquidity is unlocked');
    if (tax > maxTax) return hard(`tax ${(tax * 100).toFixed(1)}% is over the ${(maxTax * 100).toFixed(0)}% cap`);
  }
  if (g.risk === 'safe') {
    if (g.proxy === true) return hard('contract is upgradeable');
    if (g.canBlacklist === true) return hard('owner can blacklist');
    if (tax > TAX_TOLERANCE) return hard(`tax ${(tax * 100).toFixed(2)}% (safe allows none)`);
    if (g.holderConcentration != null && g.holderConcentration > 0.5) return hard(`one holder has ${(g.holderConcentration * 100).toFixed(0)}%`);
  }
  if ((g.risk === 'safe' || g.risk === 'medium') && g.enforceWashAndAge) {
    if (g.freshnessUnverified) return hard('pool age or volume could not be verified');
    const volume = g.volumeUsd ?? 0;
    if (isWashVolume(volume, g.liquidityUsd)) return hard(`volume is ${Math.round(volume / g.liquidityUsd)}× liquidity`);
    const min = g.gateMinPoolAgeSec ?? 0;
    if (min > 0 && g.poolAgeSec == null) return hard('pool age could not be verified');
    if (min > 0 && g.poolAgeSec != null && g.poolAgeSec < min) {
      const h = Math.max(0, Math.round(g.poolAgeSec / 3600));
      return hard(`pool is ${h}h old (minimum ${Math.round(min / 3600)}h)`);
    }
  }
  if ((g.risk === 'safe' || g.risk === 'medium') && g.enforceOwnerPowers) {
    if (g.ownerPowersUnverified) return hard(g.ownerPowersWhy || 'owner powers could not be verified');
    if (g.ownerPowersWhy) return hard(g.ownerPowersWhy);
  }
  if (g.enforceHolderCheck && !g.holderThin && (g.risk === 'safe' || g.risk === 'medium') && g.holderConcentration != null && g.top10Concentration != null) {
    const maxHolder = clampHolderShare(g.maxHolderShare ?? DEFAULT_MAX_HOLDER_SHARE, DEFAULT_MAX_HOLDER_SHARE);
    const maxTop10 = clampHolderShare(g.maxTop10Share ?? DEFAULT_MAX_TOP10_SHARE, DEFAULT_MAX_TOP10_SHARE);
    const chain = g.holderChain && g.holderChain.trim() ? g.holderChain.trim() : 'this chain';
    const bound = holderBound({
      largest: g.holderConcentration, top10: g.top10Concentration, unseen: g.holderUnseen ?? 0, top10Exact: g.top10Exact,
      maxHolder, maxTop10,
    });
    if (bound === 'largest') return hard(`one holder has ${(g.holderConcentration * 100).toFixed(0)}% (maximum ${(maxHolder * 100).toFixed(0)}%)`);
    if (bound === 'top10') return hard(`top 10 holders have ${(g.top10Concentration * 100).toFixed(0)}% (maximum ${(maxTop10 * 100).toFixed(0)}%)`);
    if (bound === 'unread') return hard(`holder concentration unavailable: holder read failed for ${chain}`);
  }
  if (g.enforceSizeImpact) {
    const why = sizeImpactReason(g.sizeImpact ?? null, g.sizeImpactCap ?? DEFAULT_SIZE_IMPACT_CAP);
    if (why) return hard(why);
  }
  // Honeypot and a failed sell already returned above, so live only still needs the classifier and the tax cap.
  const passed: GateResult = { ok: true, liveOk: g.liveAllowed && tax <= maxTax, reason: null, ...carried() };
  if (coverageWarn) passed.warn = coverageWarn;
  return passed;
}

export interface BuySize {
  spend: number;
  usd: number;
  tokens: number;
  impact: number;
  why: string;
}

/** Size a buy from the pool's depth, the impact cap, the pool-share cap, and the owner's per-trade and total limits. */
export function sizeBuy(p: {
  perTradeUsd: number; totalUsd: number; openUsd: number;
  quoteReserve: number; usdPerSpend: number; feeBps: number;
  buyTax?: number; price: number; maxImpact: number; maxPoolShare?: number;
}): BuySize | null {
  const impactCap = Math.min(p.maxImpact, HARD_CAPS.maxPriceImpact);
  if (!(p.perTradeUsd > 0) || !(p.usdPerSpend > 0) || !(p.price > 0)) return null;
  const roomUsd = Math.max(0, p.totalUsd - p.openUsd);
  const askUsd = Math.min(p.perTradeUsd, roomUsd);
  if (!(askUsd > 0)) return null;
  const askSpend = askUsd / p.usdPerSpend;
  const fit = capSwap({ quoteIn: askSpend, quoteReserve: p.quoteReserve, feeBps: p.feeBps, maxImpact: impactCap, maxPoolShare: p.maxPoolShare ?? TOKEN_MAX_POOL_SHARE });
  if (!(fit.amount > 0)) return null;
  const model: CostModel = {
    feeBps: p.feeBps, pool: { quoteReserve: p.quoteReserve, plsReserve: p.quoteReserve / p.price },
    gasPricePls: 0, approval: 'exact', slippageBps: 0, buyTaxPct: p.buyTax ?? 0,
  };
  const fill = simBuy(fit.amount, sellSidePrice(p.price, p.feeBps), model);
  const usd = fit.amount * p.usdPerSpend;
  const why = fit.why
    ? `${fit.why}; ${usdAsEth(usd)} after fees and ${(((p.buyTax ?? 0) * 100).toFixed(1))}% buy tax`
    : `${usdAsEth(usd)}, price impact ${(fit.impact * 100).toFixed(2)}%`;
  return { spend: fit.amount, usd, tokens: fill.pls, impact: fit.impact, why };
}

export interface ExitPos {
  entryPrice: number;
  price: number;
  peak: number;
  openedAt: number;
  now: number;
  entryVolume: number;
  volume: number;
  entryLiq: number;
  liq: number;
  sellTax: number;
  entrySellTax: number;
  sellSimOk: boolean;
  tp1Done: boolean;
  tp2Done: boolean;
  remainingFrac: number;
  /**
   * The pool fee the exit pays, as a fraction (0.003 = 0.3%). `entryPrice` is the effective entry (fees, impact and buy
   * tax in); gains are measured on what a token fetches after this fee, so TP / SL / trail arming are net of both
   * fees: with 1% in and 1% out, break-even is +2.03% in the mid. Default 0 (gross, the old behaviour).
   */
  exitFee?: number;
  /**
   * Sell tax the exit pays (fraction), taken from the tokens before the pool: gains are net of it too, so TP / SL are
   * net of every cost. The bot passes the entry-time sell tax; a tax that rises later is the separate "sell tax rose"
   * exit. Default 0.
   */
  exitTax?: number;
}

export type ExitDecision = { action: 'hold' } | { action: 'sell'; frac: number; why: string };

/** What to do with an open position. `frac` is a share of the original size (the remainder on a full exit). */
export function decideExit(p: ExitPos): ExitDecision {
  const keep = (1 - Math.max(0, Math.min(p.exitFee ?? 0, 0.99))) * (1 - Math.max(0, Math.min(p.exitTax ?? 0, 0.99)));
  const gain = p.entryPrice > 0 ? (p.price * keep) / p.entryPrice - 1 : 0;
  const left = Math.max(0, Math.min(1, p.remainingFrac));
  if (!(left > 0)) return { action: 'hold' };
  const all = (why: string): ExitDecision => ({ action: 'sell', frac: left, why });
  if (!p.sellSimOk) return all('sell simulation failed');
  if (p.sellTax > p.entrySellTax + 0.005 || (p.entrySellTax <= TAX_TOLERANCE && p.sellTax > TAX_TOLERANCE)) return all(`sell tax rose to ${(p.sellTax * 100).toFixed(1)}%`);
  if (p.entryLiq > 0 && p.liq < p.entryLiq * (1 - EXIT.liqPull)) return all(`liquidity down ${((1 - p.liq / p.entryLiq) * 100).toFixed(0)}% from entry`);
  if (gain <= -EXIT.hardStop) return all(`hard stop ${(gain * 100).toFixed(1)}% from entry`);
  const armed = p.peak * keep >= p.entryPrice * (1 + EXIT.trailArm);
  if (armed && p.price <= p.peak * (1 - EXIT.trailGap)) return all(`trailing stop ${((1 - p.price / p.peak) * 100).toFixed(0)}% off the peak`);
  if (!p.tp1Done && gain >= EXIT.tp1) return { action: 'sell', frac: Math.min(left, EXIT.tp1Frac), why: `take profit ${(gain * 100).toFixed(0)}% (sell a third)` };
  if (!p.tp2Done && gain >= EXIT.tp2) return { action: 'sell', frac: Math.min(left, EXIT.tp2Frac), why: `take profit ${(gain * 100).toFixed(0)}% (sell a third)` };
  if (p.now - p.openedAt >= EXIT.timeStopMs && gain < EXIT.timeStopMinGain) return all(`time stop after ${((p.now - p.openedAt) / 3600_000).toFixed(1)}h and only ${(gain * 100).toFixed(1)}% up`);
  if (p.entryVolume > 0 && p.volume < p.entryVolume * EXIT.volDecay && gain <= 0) return all(`volume fell to ${((p.volume / p.entryVolume) * 100).toFixed(0)}% of the entry window and price is not up`);
  return { action: 'hold' };
}

/**
 * The exit rules of an open position as a person reads them: what each one does and how far the price is from setting
 * it off (the same math as decideExit). `move` = the price change from now that fires it (−0.24 = a 24% fall); null
 * once taken. `at` = the result after costs that fires it (−0.25 for the stop), when it is a fixed level (not an armed
 * trail, which follows the peak). The time stop has `msLeft` and `ms` (its whole span) instead.
 */
export interface ExitTarget { key: 'stop' | 'trail' | 'tp1' | 'tp2' | 'time'; label: string; does: string; move: number | null; at?: number; msLeft?: number; ms?: number; done?: boolean; armed?: boolean }
export function exitTargets(p: ExitPos): ExitTarget[] {
  const keep = (1 - Math.max(0, Math.min(p.exitFee ?? 0, 0.99))) * (1 - Math.max(0, Math.min(p.exitTax ?? 0, 0.99)));
  const at = (gain: number) => (p.price > 0 && keep > 0 ? (p.entryPrice * (1 + gain)) / keep / p.price - 1 : null);
  const armed = p.peak * keep >= p.entryPrice * (1 + EXIT.trailArm);
  const gain = p.entryPrice > 0 ? (p.price * keep) / p.entryPrice - 1 : 0;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    { key: 'stop', label: 'Stop-loss', does: `sells all at −${pct(EXIT.hardStop)}`, move: at(-EXIT.hardStop), at: -EXIT.hardStop },
    armed
      ? { key: 'trail', label: 'Trailing stop', does: `sells all ${pct(EXIT.trailGap)} below its peak`, move: p.price > 0 ? (p.peak * (1 - EXIT.trailGap)) / p.price - 1 : null, armed: true }
      : { key: 'trail', label: 'Trailing stop', does: `arms at +${pct(EXIT.trailArm)}`, move: at(EXIT.trailArm), at: EXIT.trailArm, armed: false },
    { key: 'tp1', label: 'Take profit', does: `sells a third at +${pct(EXIT.tp1)}`, move: p.tp1Done ? null : at(EXIT.tp1), at: EXIT.tp1, done: p.tp1Done },
    { key: 'tp2', label: 'Take profit', does: `sells a third at +${pct(EXIT.tp2)}`, move: p.tp2Done ? null : at(EXIT.tp2), at: EXIT.tp2, done: p.tp2Done },
    {
      key: 'time', label: 'Time stop', move: null, msLeft: Math.max(0, p.openedAt + EXIT.timeStopMs - p.now), ms: EXIT.timeStopMs,
      does: gain >= EXIT.timeStopMinGain ? `off: up over +${pct(EXIT.timeStopMinGain)}` : `sells all at ${EXIT.timeStopMs / 3600_000} h if under +${pct(EXIT.timeStopMinGain)}`,
    },
  ];
}

/** Split a token sell so each piece stays under the impact cap. Pieces are human token amounts. */
export function splitSell(tokens: number, tokenReserve: number, feeBps: number, maxImpact: number): number[] {
  if (!(tokens > 0)) return [];
  const cap = Math.min(maxImpact, HARD_CAPS.maxPriceImpact);
  const room = capSwap({ quoteIn: tokens, quoteReserve: tokenReserve, feeBps, maxImpact: cap, maxPoolShare: 1 }).amount;
  if (!(room > 0)) return [];
  if (tokens <= room * 1.001) return [tokens];
  const n = Math.ceil(tokens / room);
  const piece = tokens / n;
  return Array.from({ length: n }, () => piece);
}

export interface ReplayCandle { t: number; price: number; volume: number; liq: number }
export interface ReplayResult {
  pnlPct: number;
  exits: string[];
  held: boolean;
  buys: number;
  sells: number;
}

/**
 * One paper buy at the first candle, then the exit rules. Fills use the same simBuy / simSell as live paper,
 * with the pool's fee and a reserve implied by `liq` (quote depth ≈ liquidity / 2).
 */
export function replay(candles: ReplayCandle[], o: { feeBps?: number; maxImpact?: number; spend?: number } = {}): ReplayResult {
  if (candles.length < 2) return { pnlPct: 0, exits: [], held: false, buys: 0, sells: 0 };
  const feeBps = o.feeBps ?? 30;
  const maxImpact = o.maxImpact ?? 0.03;
  const c0 = candles[0];
  const quoteReserve = Math.max(1, c0.liq / 2);
  const spend = Math.min(o.spend ?? quoteReserve * 0.01, quoteReserve * TOKEN_MAX_POOL_SHARE);
  const model = (price: number, liq: number): CostModel => ({
    feeBps, pool: { quoteReserve: Math.max(1, liq / 2), plsReserve: Math.max(1, liq / 2) / price }, gasPricePls: 0, approval: 'exact', slippageBps: 10,
  });
  const buy = simBuy(spend, sellSidePrice(c0.price, feeBps), model(c0.price, c0.liq));
  const entryPrice = effectiveEntry(spend, buy.pls);
  let tokens = buy.pls;
  const entryTokens = tokens;
  let quote = 0;
  let tp1Done = false, tp2Done = false;
  let peak = c0.price;
  const exits: string[] = [];
  let sells = 0;
  for (const c of candles.slice(1)) {
    if (c.price > peak) peak = c.price;
    const remainingFrac = entryTokens > 0 ? tokens / entryTokens : 0;
    const d = decideExit({
      entryPrice, exitFee: feeBps / 10_000, price: c.price, peak, openedAt: c0.t, now: c.t,
      entryVolume: c0.volume, volume: c.volume, entryLiq: c0.liq, liq: c.liq,
      sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done, tp2Done, remainingFrac,
    });
    if (d.action !== 'sell' || !(tokens > 0)) continue;
    const qty = Math.min(tokens, entryTokens * d.frac);
    const m = model(c.price, c.liq);
    for (const part of splitSell(qty, m.pool!.plsReserve, feeBps, maxImpact)) {
      const s = simSell(part, sellSidePrice(c.price, feeBps), m);
      quote += s.quote;
      tokens -= part;
      sells++;
    }
    exits.push(d.why);
    if (d.why.includes('take profit') && !tp1Done) tp1Done = true;
    else if (d.why.includes('take profit')) tp2Done = true;
    if (tokens <= entryTokens * 1e-9) break;
  }
  const last = candles[candles.length - 1];
  const mark = tokens > 0 ? simSell(tokens, sellSidePrice(last.price, feeBps), model(last.price, last.liq)).quote : 0;
  const pnlPct = spend > 0 ? (quote + mark - spend) / spend : 0;
  return { pnlPct, exits, held: tokens > entryTokens * 1e-6, buys: 1, sells };
}

/** DexScreener pair row → a fresh pool, or null when it isn't a token/native or token/stable pair. */
export function fromDexPair(row: {
  chainId: string; dexId: string; pairAddress: string;
  baseToken: { address: string; symbol: string }; quoteToken: { address: string; symbol: string };
  priceNative?: string; priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number };
  pairCreatedAt?: number;
}, chain: { id: number; dexId: string; spend: Set<string>; wrapped: string }): FreshPool | null {
  if (row.chainId !== chain.dexId) return null;
  const b = row.baseToken.address.toLowerCase(), q = row.quoteToken.address.toLowerCase();
  const bs = chain.spend.has(b), qs = chain.spend.has(q);
  if (bs === qs) return null;
  const token = bs ? q : b, spend = bs ? b : q;
  const priceUsd = Number(row.priceUsd);
  const nativePx = Number(row.priceNative);
  // priceNative is the token's price in the chain's native coin. Orient as spend per token.
  const usdPerSpend = qs && nativePx > 0 && priceUsd > 0 ? priceUsd / nativePx : priceUsd > 0 && !qs ? priceUsd : 1;
  const spendPerToken = qs ? nativePx : nativePx > 0 ? 1 / nativePx : 0;
  const liq = row.liquidity?.usd ?? 0;
  return {
    chainId: chain.id, pool: row.pairAddress.toLowerCase(), dex: row.dexId, kind: 'v2',
    token, spend, tokenSymbol: (bs ? row.quoteToken : row.baseToken).symbol, spendSymbol: (bs ? row.baseToken : row.quoteToken).symbol,
    liquidityUsd: liq, volumeUsd: row.volume?.h24 ?? 0,
    createdAt: row.pairCreatedAt != null ? row.pairCreatedAt : null,
    source: 'new', quoteReserve: usdPerSpend > 0 ? (liq / 2) / usdPerSpend : 0,
    tokenReserve: spendPerToken > 0 && usdPerSpend > 0 ? (liq / 2) / usdPerSpend / spendPerToken : 0,
    feeBps: 30, price: spendPerToken, usdPerSpend: usdPerSpend || 1,
  };
}

/** A GeckoTerminal pool row with USD prices on both sides → a token/spend pool, or null. */
export function fromTopPool(p: { address: string; name: string; dex: string; base: string; quote: string; liquidityUsd: number; volume24Usd: number; createdAt: number | null; basePriceUsd: number | null; quotePriceUsd: number | null }, chain: { id: number; spend: string[]; kind?: 'v2' | 'v3' | 'v4'; feeBps?: number }, source: FreshPool['source'] = 'new'): FreshPool | null {
  const spendable = new Set(chain.spend.map((a) => a.toLowerCase()));
  const b = p.base.toLowerCase(), q = p.quote.toLowerCase();
  const bs = spendable.has(b), qs = spendable.has(q);
  if (bs === qs) return null;
  const tokenUsd = bs ? p.quotePriceUsd : p.basePriceUsd;
  const spendUsd = bs ? p.basePriceUsd : p.quotePriceUsd;
  if (!(tokenUsd && spendUsd && spendUsd > 0)) return null;
  const price = tokenUsd / spendUsd;
  if (!(price > 0)) return null;
  // GeckoTerminal names V3/V4 pools with their fee tier ("PEPE / WETH 0.3%"): the symbol is the first word of each side
  // (2026-10-30: "WETH 0.3%" was taken as the spend coin's symbol and shown on every amount)
  const [left, right] = p.name.split('/').map((s) => s.trim().split(/\s+/)[0]);
  const tokenSymbol = (bs ? right : left) || 'TOKEN';
  const spendSymbol = (bs ? left : right) || 'QUOTE';
  const quoteReserve = (p.liquidityUsd / 2) / spendUsd;
  return {
    chainId: chain.id, pool: p.address.toLowerCase(), dex: p.dex, kind: chain.kind ?? 'v3',
    token: bs ? q : b, spend: bs ? b : q, tokenSymbol, spendSymbol,
    liquidityUsd: p.liquidityUsd, volumeUsd: p.volume24Usd, createdAt: p.createdAt, source,
    quoteReserve, tokenReserve: quoteReserve / price, feeBps: chain.feeBps ?? 30, price, usdPerSpend: spendUsd,
  };
}
