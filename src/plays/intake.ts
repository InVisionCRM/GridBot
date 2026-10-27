/**
 * Intake rules (pure). A play is opened only from a vetted pass joined to its candidate.
 * X fields are context: `x_buzz` never opens a play, and mentions, authors, sentiment and flags
 * never raise the score. Severe red flags block. Any other flag lowers the score.
 * Status `rejected` and V4 pools are skipped. Limits come from the plays config and are not widened.
 */
import { playsChain, quoteTokens } from './chainConfig';
import { roundTripFromTiers, roundTripTooCostly } from './netMath';
import {
  entriesStopped, sizeRoom,
  type PlaysControl, type PlaysOptions,
} from './options';
import { LAUNCHPADS, type Candidate, type FeeTier, type LaunchpadId, type Vetted } from './types';

export const RED_FLAG_PENALTY = 0.15;
const EPS = 1e-12;
const HOUR = 3600_000;

export type IntakeCode =
  | 'open'
  | 'rejected'
  | 'v4'
  | 'x_only'
  | 'red_flag'
  | 'no_vetted'
  | 'veto'
  | 'id_mismatch'
  | 'chain'
  | 'dex'
  | 'launchpad'
  | 'liquidity'
  | 'pool_age'
  | 'tax'
  | 'impact'
  | 'cost'
  | 'fee_tier'
  | 'cooldown'
  | 'loss_cooldown'
  | 'day_pause'
  | 'max_open'
  | 'token_open'
  | 'duplicate'
  | 'switched_off'
  | 'stop_all'
  | 'lp_unlocked'
  | 'room'
  | 'live_limits';

export interface IntakeDecision {
  ok: boolean;
  code: IntakeCode;
  why: string | null;
  /** Strength after non-severe flags. Null when the row did not reach scoring. */
  score: number | null;
  /** USD size after the half-size paper rule and the book room. Null when the row is not open. */
  sizeUsd: number | null;
  /** ETH size for a launchpad paper play. Null on the regular book. */
  sizeEth: number | null;
  /** True when unlocked liquidity cut the size in half and confined the pass to paper. */
  paperOnly: boolean;
  severeFlags: string[];
  otherFlags: string[];
  /** Impact cap used, as a fraction, after clamping the vetted percent down to the config. */
  impactCap: number | null;
}

export interface PlayHistory {
  usedCandidateIds: string[];
  /** Token addresses already open on this book. */
  openTokens: string[];
  openCount: number;
  /** When the last play on this token opened, epoch ms. */
  lastOpenTs?: number;
  /** When the last losing exit on this token landed, epoch ms. */
  lastLossExitTs?: number;
  /** Losing exits already counted today, across tokens. */
  losingExitsToday: number;
  /** Set to apply the 35% per-play cap and the 20% reserve. */
  bookUsd?: number;
  openUsd?: number;
}

export interface IntakeCosts {
  entryTier: FeeTier;
  exitTier: FeeTier;
  impactEntry: number;
  impactExit: number;
  gasQuoteEntry: number;
  gasQuoteExit: number;
  /** Quote units this check is priced at. Gas is divided by this. */
  size: number;
}

export interface IntakeRequest {
  candidate: Candidate;
  vetted: Vetted | null;
  now: number;
  control: PlaysControl;
  options: PlaysOptions;
  history: PlayHistory;
  costs?: IntakeCosts;
  /** Launchpad uses its own switch, size and open-count. It does not share the regular book. */
  book?: 'plays' | 'launchpad';
}

export function normFlag(flag: string): string {
  return flag.toLowerCase().replace(/[_/-]+/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function startsWithWord(parts: string[], word: string): boolean {
  return parts.some((part) => part === word || part.startsWith(word));
}

/** Scam, rug warning, honeypot, dev dumping, and can't-sell. Other text is not severe. */
export function isSevereRedFlag(flag: string): boolean {
  const norm = normFlag(flag);
  if (!norm) return false;
  const parts = norm.split(' ');
  if (startsWithWord(parts, 'honeypot') || startsWithWord(parts, 'scam') || startsWithWord(parts, 'rug')) return true;
  if (parts.some((part) => part === 'devdump' || part === 'devdumping')) return true;
  const devAt = parts.findIndex((part) => part === 'dev' || part === 'developer');
  if (devAt >= 0 && parts.slice(devAt + 1).some((part) => part === 'dump' || part.startsWith('dump'))) return true;
  if (norm.includes("can't sell") || norm.includes('cant sell') || norm.includes('cannot sell') || norm.includes('can not sell')) return true;
  return parts.includes('unsellable');
}

export function classifyRedFlags(flags: string[]): { severe: string[]; other: string[] } {
  const severe: string[] = [];
  const other: string[] = [];
  for (const flag of flags) {
    if (flag.trim() === '') continue;
    (isSevereRedFlag(flag) ? severe : other).push(flag);
  }
  return { severe, other };
}

/** Non-severe flags each subtract RED_FLAG_PENALTY. The score never goes below 0 and never uses X fields. */
export function scoreAfterFlags(strength: number, otherCount: number): number {
  if (!Number.isFinite(strength)) return 0;
  const base = Math.min(1, Math.max(0, strength));
  return Math.max(0, base - otherCount * RED_FLAG_PENALTY);
}

export function isRejectedStatus(status: string | undefined): boolean {
  return status?.trim().toLowerCase() === 'rejected';
}

export function canonicalLaunchpad(name: string): LaunchpadId | null {
  return LAUNCHPADS.find((id) => id.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

export interface Screen {
  code: 'rejected' | 'v4' | 'red_flag' | 'x_only' | null;
  why: string | null;
  severe: string[];
  other: string[];
  score: number;
}

/** Status, pool kind, red flags and the X-signal rule. Does not look at the vetted row. */
export function screenCandidate(candidate: Candidate): Screen {
  const flags = classifyRedFlags(candidate.redFlags);
  const score = scoreAfterFlags(candidate.strength, flags.other.length);
  const base = { severe: flags.severe, other: flags.other, score };
  if (isRejectedStatus(candidate.status)) return { ...base, code: 'rejected', why: 'candidate status is rejected' };
  if (candidate.poolKind === 'V4') return { ...base, code: 'v4', why: "this app doesn't swap V4" };
  if (flags.severe.length) return { ...base, code: 'red_flag', why: `red flag: ${flags.severe.join(', ')}` };
  if (candidate.signal === 'x_buzz') return { ...base, code: 'x_only', why: 'X signal only' };
  return { ...base, code: null, why: null };
}

/**
 * Unlocked liquidity does not veto a paper pass. It halves `sizeUsd` and refuses live.
 * The stored vetted size is left unchanged; callers use the size returned here.
 */
export function sizeForPass(vetted: Vetted, mode: 'paper' | 'live'): { ok: true; sizeUsd: number; paperOnly: boolean } | { ok: false; why: string } {
  if (!vetted.lpUnlocked) return { ok: true, sizeUsd: vetted.sizeUsd, paperOnly: false };
  if (mode === 'live') return { ok: false, why: 'Unlocked liquidity is a half-size paper pass, so live is refused.' };
  return { ok: true, sizeUsd: vetted.sizeUsd / 2, paperOnly: true };
}

export function launchpadPaperEth(options: PlaysOptions, lpUnlocked: boolean): number {
  return lpUnlocked ? options.launchpad.paperEth / 2 : options.launchpad.paperEth;
}

/** Impact cap for a vetted row: the officer's percent, or the config, whichever is smaller. */
export function cappedImpact(maxImpactPct: number, options: PlaysOptions): number {
  return Math.min(maxImpactPct / 100, options.maxImpact);
}

export function reviewPlay(req: IntakeRequest): IntakeDecision {
  const book = req.book ?? 'plays';
  const screen = screenCandidate(req.candidate);
  const flags = { severeFlags: screen.severe, otherFlags: screen.other };
  const no = (code: IntakeCode, why: string, extra: Partial<IntakeDecision> = {}): IntakeDecision => ({
    ok: false, code, why, score: null, sizeUsd: null, sizeEth: null, paperOnly: false, impactCap: null, ...flags, ...extra,
  });
  if (screen.code) return no(screen.code, screen.why ?? screen.code);

  const chain = playsChain(req.candidate.chainId);
  if (!req.options.chains.includes(req.candidate.chainId) || !chain) {
    return no('chain', `chain ${req.candidate.chainId} is not enabled for plays`);
  }
  if (!chain.dexIds.includes(req.candidate.dex)) return no('dex', `dex ${req.candidate.dex} is not enabled for plays`);
  const quotes = quoteTokens(req.candidate.chainId) ?? [];
  if (!quotes.some((q) => q.address.toLowerCase() === req.candidate.quote.toLowerCase())) {
    return no('chain', `quote is not ${quotes.map((q) => q.symbol).join(' or ') || 'a plays quote token'}`);
  }

  const venueName = req.candidate.launchpad ?? req.vetted?.launchpad;
  const venue = venueName ? canonicalLaunchpad(venueName) : null;
  if (venueName && !venue) return no('launchpad', `launchpad ${venueName} is not supported`);
  if (book === 'launchpad') {
    if (!venueName || !venue) return no('launchpad', 'not a launchpad candidate');
    if (!req.options.launchpad.venues.includes(venue)) return no('launchpad', `launchpad ${venue} is not enabled`);
  } else if (venueName) {
    return no('launchpad', 'launchpad candidates are a separate book');
  }

  if (req.control.offMode === 'full') return no('switched_off', 'plays is off completely');
  const bookOn = book === 'launchpad' ? req.options.launchpad.on : req.control.on;
  if (!bookOn) return no(book === 'launchpad' ? 'launchpad' : 'switched_off', book === 'launchpad' ? 'launchpad plays are off' : 'plays is off');
  if (entriesStopped(req.control, req.candidate.chainId)) return no('stop_all', 'new plays are stopped (Stop all)');

  const vetted = req.vetted;
  if (!vetted) return no('no_vetted', 'no vetted row');
  if (vetted.candidateId !== req.candidate.id) return no('id_mismatch', 'vetted a different candidate');
  if (!vetted.pass) return no('veto', 'vetted pass is false');

  if (req.history.usedCandidateIds.includes(req.candidate.id)) return no('duplicate', 'candidate already used');
  if (req.history.openTokens.some((token) => token.toLowerCase() === req.candidate.token.toLowerCase())) {
    return no('token_open', 'token is already open');
  }

  if (!venue && req.candidate.poolAgeH < req.options.minPoolAgeH) {
    return no('pool_age', `pool is ${fmtHours(req.candidate.poolAgeH)} old (minimum ${fmtHours(req.options.minPoolAgeH)})`);
  }
  const floor = liquidityFloor(req.candidate, req.options, venue != null);
  if (floor != null && req.candidate.liqUsd < floor) {
    return no('liquidity', `liquidity $${Math.round(req.candidate.liqUsd).toLocaleString('en-US')} is under the $${Math.round(floor).toLocaleString('en-US')} minimum`);
  }

  const { buy, sell } = vetted.taxes;
  if (sell > req.options.maxSellTax + EPS) {
    return no('tax', `sell tax ${(sell * 100).toFixed(1)}% is over the ${(req.options.maxSellTax * 100).toFixed(0)}% cap`);
  }
  if (buy + sell > req.options.maxBuySellTax + EPS) {
    return no('tax', `buy plus sell tax ${((buy + sell) * 100).toFixed(1)}% is over the ${(req.options.maxBuySellTax * 100).toFixed(0)}% cap`);
  }

  const sized = sizeForPass(vetted, req.options.mode);
  if (!sized.ok) return no('lp_unlocked', sized.why, { paperOnly: true });
  let sizeUsd = sized.sizeUsd;
  const paperOnly = sized.paperOnly;
  const sizeEth = book === 'launchpad' ? launchpadPaperEth(req.options, paperOnly) : null;

  if (req.options.mode === 'live' && !req.options.liveLimits) {
    return no('live_limits', 'live dollar limits are not set', { paperOnly });
  }

  if (book !== 'launchpad' && req.history.bookUsd != null) {
    const room = sizeRoom(req.history.bookUsd, req.history.openUsd ?? 0, req.options);
    if (!(room > 0)) return no('room', 'no room under the per-play cap and the reserve', { paperOnly });
    sizeUsd = Math.min(sizeUsd, room);
  }

  const maxOpen = book === 'launchpad' ? req.options.launchpad.maxOpen : req.options.maxOpen;
  if (req.history.openCount >= maxOpen) return no('max_open', `${maxOpen} plays already open`, { paperOnly });

  if (req.history.lastOpenTs != null && req.now - req.history.lastOpenTs < req.options.tokenCooldownH * HOUR) {
    return no('cooldown', `token cooldown has ${hoursLeft(req.options.tokenCooldownH * HOUR - (req.now - req.history.lastOpenTs))} left`, { paperOnly });
  }
  if (req.history.lastLossExitTs != null && req.now - req.history.lastLossExitTs < req.options.lossCooldownH * HOUR) {
    return no('loss_cooldown', `loss cooldown has ${hoursLeft(req.options.lossCooldownH * HOUR - (req.now - req.history.lastLossExitTs))} left`, { paperOnly });
  }
  if (req.history.losingExitsToday >= req.options.maxLosingExitsPerDay) {
    return no('day_pause', `paused for the rest of the day after ${req.options.maxLosingExitsPerDay} losing exits`, { paperOnly });
  }

  const impactCap = cappedImpact(vetted.maxImpactPct, req.options);
  if (!req.costs) return no('cost', 'round-trip cost was not supplied, so the play is skipped', { paperOnly, impactCap });
  const quoted = Math.max(req.costs.impactEntry, req.costs.impactExit);
  if (quoted > impactCap + EPS) {
    return no('impact', `price impact ${(quoted * 100).toFixed(2)}% is over the ${(impactCap * 100).toFixed(2)}% cap`, { paperOnly, impactCap });
  }

  const rt = roundTripFromTiers({
    size: req.costs.size,
    entryTier: req.costs.entryTier,
    exitTier: req.costs.exitTier,
    impactEntry: req.costs.impactEntry,
    impactExit: req.costs.impactExit,
    taxEntry: 1 - (1 - buy) * (1 - vetted.taxes.transfer),
    taxExit: sell,
    gasQuoteEntry: req.costs.gasQuoteEntry,
    gasQuoteExit: req.costs.gasQuoteExit,
  });
  if ('error' in rt) {
    const dynamic = rt.error.includes('dynamic') || rt.error.includes('unreadable');
    return no(dynamic ? 'fee_tier' : 'cost', rt.error, { paperOnly, impactCap });
  }
  if (roundTripTooCostly(rt.costFrac, req.options.maxRoundTripCost)) {
    return no('cost', `round-trip cost ${(rt.costFrac * 100).toFixed(2)}% of size is over the ${(req.options.maxRoundTripCost * 100).toFixed(0)}% cap`, { paperOnly, impactCap });
  }

  return {
    ok: true, code: 'open', why: null, score: screen.score, sizeUsd, sizeEth, paperOnly,
    severeFlags: screen.severe, otherFlags: screen.other, impactCap,
  };
}

function liquidityFloor(candidate: Candidate, options: PlaysOptions, launchpad: boolean): number | null {
  if (!launchpad) return options.minLiquidityUsd;
  if (candidate.curveProgress != null && candidate.curveProgress < 1) return null;
  return options.launchpad.minLiquidityUsd;
}

function fmtHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

function hoursLeft(ms: number): string {
  const hours = Math.round((Math.max(0, ms) / HOUR) * 10) / 10;
  return `${hours}h`;
}
