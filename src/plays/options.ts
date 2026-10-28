/**
 * Plays defaults and the on/off switch (pure). Nothing here starts a timer or registers a hook.
 *
 * The switch is Plays' own. Stop all / STOP chain sets `entriesHalted` and blocks new plays
 * (regular and launchpad) until resume. Exits keep running unless `offMode` is `full`.
 * Live dollar limits are null until someone sets them. The proposal constant is not applied.
 */
import { HARD_CAPS } from '../live/limits';
import { DEFAULT_PLAYS_CHAIN, playsChain, quoteTokens } from './chainConfig';
import { LAUNCHPADS, type LaunchpadId } from './types';

export interface LiveLimits {
  perPlayUsd: number;
  maxOpenUsd: number;
  dailyLossUsd: number;
  weeklyLossUsd: number;
}

/**
 * ROI Strategist's pending figures. Not a default and not read by validation.
 * Live stays unset until these, or replacements, are approved.
 */
export const LIVE_LIMITS_PROPOSAL = {
  note: 'pending approval; not applied',
  perPlayUsd: 50,
  maxOpenUsd: 150,
  dailyLossUsd: 40,
  weeklyLossUsd: 100,
} as const;

export interface LaunchpadOptions {
  /** Launchpad's own switch. Default off. Stop all still blocks it via the shared halt. */
  on: boolean;
  mode: 'paper' | 'live';
  /** Paper size in ETH. Default 0.25. Cannot be raised above that here. */
  paperEth: number;
  /** At most this many open launchpad plays. Default 2. */
  maxOpen: number;
  /** PumpPill and Arrow only. */
  venues: LaunchpadId[];
  /** Post-migration liquidity floor, USD. Default 20_000. */
  minLiquidityUsd: number;
}

export interface PlaysOptions {
  mode: 'paper' | 'live';
  /**
   * `exits`: the off switch and Stop all leave exits running.
   * `full`: nothing runs, exits included.
   */
  offMode: 'exits' | 'full';
  /** Chain ids this book will accept. Default [4663]. */
  chains: number[];
  /** At most this many open regular plays. Default 3. */
  maxOpen: number;
  /** Biggest fraction of the book one play may use. Default 0.35. */
  maxPerPlay: number;
  /** Fraction of the book kept unspent. Default 0.20. */
  reserve: number;
  /** Price-impact cap, fraction. Default 0.01. */
  maxImpact: number;
  /** Sell-tax cap, fraction. Default 0.03. */
  maxSellTax: number;
  /** Buy tax plus sell tax above this fraction is a reject. Default 0.05. */
  maxBuySellTax: number;
  /** Spot-pool liquidity floor, USD. Default 50_000. Launchpad uses its own floor. */
  minLiquidityUsd: number;
  /** Minimum pool age in hours. Launchpad candidates are exempt. Default 24. */
  minPoolAgeH: number;
  /** No new play on a token within this many hours of its last open. Default 24. */
  tokenCooldownH: number;
  /** Per-token pause after a losing exit, in hours. Default 2. */
  lossCooldownH: number;
  /** Losing exits in a Detroit day that pause new entries for the rest of that day. Default 3. */
  maxLosingExitsPerDay: number;
  /** Skip when the round-trip cost is above this fraction of size. Default 0.03. */
  maxRoundTripCost: number;
  /** Null until live limits are approved. Paper does not read them. */
  liveLimits: LiveLimits | null;
  launchpad: LaunchpadOptions;
}

export const DEFAULT_PLAYS: PlaysOptions = {
  mode: 'paper',
  offMode: 'exits',
  chains: [DEFAULT_PLAYS_CHAIN],
  maxOpen: 3,
  maxPerPlay: 0.35,
  reserve: 0.20,
  maxImpact: 0.01,
  maxSellTax: 0.03,
  maxBuySellTax: 0.05,
  minLiquidityUsd: 50_000,
  minPoolAgeH: 24,
  tokenCooldownH: 24,
  lossCooldownH: 2,
  maxLosingExitsPerDay: 3,
  maxRoundTripCost: 0.03,
  liveLimits: null,
  launchpad: {
    on: false,
    mode: 'paper',
    paperEth: 0.25,
    maxOpen: 2,
    venues: ['PumpPill', 'Arrow'],
    minLiquidityUsd: 20_000,
  },
};

export function freshPlaysOptions(): PlaysOptions {
  return structuredClone(DEFAULT_PLAYS);
}

export interface PlaysControl {
  /** Regular book's own switch. Default false. */
  on: boolean;
  /** Stop all / STOP chain. Blocks new plays on both books. */
  entriesHalted: boolean;
  /** Null while halted means every chain. Ignored when `entriesHalted` is false. */
  haltChains: number[] | null;
  offMode: 'exits' | 'full';
}

export const DEFAULT_PLAYS_CONTROL: PlaysControl = {
  on: false,
  entriesHalted: false,
  haltChains: null,
  offMode: 'exits',
};

export function freshPlaysControl(over: Partial<PlaysControl> = {}): PlaysControl {
  return { ...DEFAULT_PLAYS_CONTROL, ...over, haltChains: over.haltChains === undefined ? DEFAULT_PLAYS_CONTROL.haltChains : over.haltChains };
}

/** Stop all (chainId null) or STOP chain. A global halt stays global if a later chain stop arrives. */
export function applyStopAll(control: PlaysControl, chainId: number | null): PlaysControl {
  if (chainId == null || (control.entriesHalted && control.haltChains == null)) {
    return { ...control, entriesHalted: true, haltChains: null };
  }
  const prev = control.entriesHalted && control.haltChains ? control.haltChains : [];
  return { ...control, entriesHalted: true, haltChains: [...new Set([...prev, chainId])] };
}

export function resumeEntries(control: PlaysControl): PlaysControl {
  return { ...control, entriesHalted: false, haltChains: null };
}

export function entriesStopped(control: PlaysControl, chainId: number): boolean {
  if (!control.entriesHalted) return false;
  if (control.haltChains == null) return true;
  return control.haltChains.includes(chainId);
}

/** New regular plays. Stop all blocks this even when `on` is true. */
export function canOpenPlay(control: PlaysControl, chainId: number): boolean {
  if (!control.on || control.offMode === 'full') return false;
  return !entriesStopped(control, chainId);
}

/** Exits run while offMode is `exits`, including after Stop all and while the switch is off. */
export function canExitPlay(control: PlaysControl): boolean {
  return control.offMode !== 'full';
}

/** Room for one more regular play: the per-play cap, and the book minus the reserve minus what is already open. */
export function sizeRoom(bookUsd: number, openUsd: number, options: PlaysOptions): number {
  if (!(bookUsd > 0) || !Number.isFinite(openUsd)) return 0;
  const cap = bookUsd * options.maxPerPlay;
  const room = bookUsd * (1 - options.reserve) - Math.max(0, openUsd);
  return Math.max(0, Math.min(cap, room));
}

const pos = (n: number) => Number.isFinite(n) && n > 0;
const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/** Problems with a plays config. An empty list is a config the pure checks will accept. Limits cannot be loosened past the defaults. */
export function validatePlaysOptions(options: PlaysOptions): string[] {
  const e: string[] = [];
  if (options.mode !== 'paper' && options.mode !== 'live') e.push('Mode must be paper or live.');
  if (options.offMode !== 'exits' && options.offMode !== 'full') e.push('Off mode must be exits or full.');
  if (options.mode === 'live') {
    const live = options.liveLimits;
    if (!live) e.push('Live mode needs dollar limits. They are unset on purpose until they are approved.');
    else if (![live.perPlayUsd, live.maxOpenUsd, live.dailyLossUsd, live.weeklyLossUsd].every(pos)) e.push('Live dollar limits must each be above 0.');
  } else if (options.liveLimits) {
    const live = options.liveLimits;
    if (![live.perPlayUsd, live.maxOpenUsd, live.dailyLossUsd, live.weeklyLossUsd].every(pos)) e.push('Live dollar limits must each be above 0.');
  }
  if (!Array.isArray(options.chains) || options.chains.length === 0) e.push('Pick at least one chain.');
  else {
    const seen = new Set<number>();
    for (const id of options.chains) {
      if (!Number.isInteger(id)) { e.push(`Chain ${String(id)} is not a plays chain.`); continue; }
      if (seen.has(id)) { e.push(`Chain ${id} is listed twice.`); continue; }
      seen.add(id);
      if (!playsChain(id)) e.push(`Chain ${id} is not in the plays chain list.`);
      else if (!quoteTokens(id)?.length) e.push(`Chain ${id} quote tokens are not on the registry.`);
    }
  }
  if (!Number.isInteger(options.maxOpen) || options.maxOpen < 1 || options.maxOpen > DEFAULT_PLAYS.maxOpen) e.push('Open plays must be from 1 to 3.');
  if (!(options.maxPerPlay > 0) || options.maxPerPlay > DEFAULT_PLAYS.maxPerPlay) e.push('Per-play cap must be above 0% and at most 35%.');
  if (!(options.reserve >= DEFAULT_PLAYS.reserve) || options.reserve >= 1) e.push('Reserve must be from 20% up to, but not including, 100%.');
  if (pos(options.maxPerPlay) && unit(options.reserve) && options.maxPerPlay + options.reserve > 1) e.push('Per-play cap plus the reserve is over 100% of the book.');
  const impactCap = Math.min(DEFAULT_PLAYS.maxImpact, HARD_CAPS.maxPriceImpact);
  if (!(options.maxImpact > 0) || options.maxImpact > impactCap) e.push('Price-impact cap must be above 0% and at most 1%.');
  if (!unit(options.maxSellTax) || options.maxSellTax > DEFAULT_PLAYS.maxSellTax) e.push('Sell-tax cap must be from 0% to 3%.');
  if (!(options.maxBuySellTax > 0) || options.maxBuySellTax > DEFAULT_PLAYS.maxBuySellTax) e.push('Buy-plus-sell tax reject must be above 0% and at most 5%.');
  if (!(options.minLiquidityUsd >= DEFAULT_PLAYS.minLiquidityUsd)) e.push('Liquidity floor must be at least $50,000.');
  if (!(options.minPoolAgeH >= DEFAULT_PLAYS.minPoolAgeH)) e.push('Pool age must be at least 24 hours.');
  if (!(options.tokenCooldownH >= DEFAULT_PLAYS.tokenCooldownH)) e.push('Per-token cooldown must be at least 24 hours.');
  if (!(options.lossCooldownH >= DEFAULT_PLAYS.lossCooldownH)) e.push('Per-token cooldown after a loss must be at least 2 hours.');
  if (!Number.isInteger(options.maxLosingExitsPerDay) || options.maxLosingExitsPerDay < 1 || options.maxLosingExitsPerDay > DEFAULT_PLAYS.maxLosingExitsPerDay) {
    e.push('Daily losing-exit pause must be from 1 to 3.');
  }
  if (!(options.maxRoundTripCost > 0) || options.maxRoundTripCost > DEFAULT_PLAYS.maxRoundTripCost) e.push('Round-trip cost cap must be above 0% and at most 3% of size.');
  e.push(...validateLaunchpad(options.launchpad));
  return e;
}

function validateLaunchpad(lp: LaunchpadOptions | undefined): string[] {
  const e: string[] = [];
  if (!lp || typeof lp.on !== 'boolean') return ['Launchpad config is missing.'];
  if (lp.mode !== 'paper' && lp.mode !== 'live') e.push('Launchpad mode must be paper or live.');
  if (lp.mode === 'live') e.push('Launchpad live mode is not enabled.');
  if (!(lp.paperEth > 0) || lp.paperEth > DEFAULT_PLAYS.launchpad.paperEth) e.push('Launchpad paper size must be above 0 and at most 0.25 ETH.');
  if (!Number.isInteger(lp.maxOpen) || lp.maxOpen < 1 || lp.maxOpen > DEFAULT_PLAYS.launchpad.maxOpen) e.push('Launchpad open plays must be from 1 to 2.');
  if (!(lp.minLiquidityUsd >= DEFAULT_PLAYS.launchpad.minLiquidityUsd)) e.push('Launchpad post-migration liquidity must be at least $20,000.');
  if (!Array.isArray(lp.venues) || lp.venues.length === 0) e.push('Launchpad needs at least one venue.');
  else {
    const allowed = new Set<string>(LAUNCHPADS);
    for (const venue of lp.venues) {
      if (!allowed.has(venue)) e.push(`Launchpad venue ${String(venue)} is not supported. PumpPill and Arrow only.`);
    }
  }
  return e;
}

/** Calendar date in America/Detroit, `YYYY-MM-DD`. The daily loss pause uses this day. */
export function detroitDay(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function sameDetroitDay(a: number, b: number): boolean {
  return detroitDay(a) === detroitDay(b);
}
