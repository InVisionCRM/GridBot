/**
 * The smart trader's three strategies (Kyle 2026-11-08: "develop strategies the same way where I don't have to set every
 * individual setting"). Each is a complete set of its options (server/bot/autopilot.ts AutoOptions). Pure: the page and
 * the server share it. The numbers the cards cite are the walk-forward in the README (October 2026, 92 pools × 4 weeks).
 *
 *  farmer — liquidity ranges only, on coins already in the app that passed the safety check with low risk. Ranking
 *           ranges by what they earned last week is the best predictor the walk-forward found (rank correlation 0.73
 *           with next week; the top tenth was expected to earn 14.1% and earned 12.5%). Three pools, loss limit 10%.
 *  swing  — grids only, where the price swings most, coins not in the app yet included, up to medium risk. The daily
 *           swing predicts next week's grid earnings (0.43; the top tenth 7.2% expected, 7.4% earned). Four pools, 15%.
 *  wide   — everything the safety check lets trade live, grids and ranges, six pools, loss limit 20%: the most bets,
 *           each ranked by its estimate.
 */
export type SmartStrategyId = 'farmer' | 'swing' | 'wide';
export const SMART_STRATEGY_IDS: readonly SmartStrategyId[] = ['farmer', 'swing', 'wide'];
export type SmartRisk = 'safe' | 'medium' | 'any';
/** The options a strategy sets: the shape of server/bot/autopilot.ts AutoOptions */
export interface SmartOptions { grid: boolean; lp: boolean; newTokens: boolean; risk: SmartRisk; slots: number; stopLossPct: number }
export const SMART_OPTION_KEYS = ['grid', 'lp', 'newTokens', 'risk', 'slots', 'stopLossPct'] as const;
export interface SmartStrategy { id: SmartStrategyId; name: string; options: SmartOptions }

export const SMART_STRATEGY: Record<SmartStrategyId, SmartStrategy> = {
  farmer: { id: 'farmer', name: 'Fee farmer', options: { grid: false, lp: true, newTokens: false, risk: 'safe', slots: 3, stopLossPct: 0.10 } },
  swing: { id: 'swing', name: 'Swing grids', options: { grid: true, lp: false, newTokens: true, risk: 'medium', slots: 4, stopLossPct: 0.15 } },
  wide: { id: 'wide', name: 'Wide net', options: { grid: true, lp: true, newTokens: true, risk: 'any', slots: 6, stopLossPct: 0.20 } },
};

/** The strategy whose options these are, exactly; null when set by hand. */
export function smartStrategyOf(o: Partial<SmartOptions> | null | undefined): SmartStrategyId | null {
  if (!o) return null;
  return SMART_STRATEGY_IDS.find((id) => SMART_OPTION_KEYS.every((k) => o[k] === SMART_STRATEGY[id].options[k])) ?? null;
}

/**
 * How good each estimate is, from the walk-forward (README "Which ranking predicts next week"): its rank correlation with
 * the week after, and what the top tenth of pools was expected to earn against what it earned.
 */
export const WALK_FORWARD = {
  grid: { rank: 0.43, topExpected: 0.072, topEarned: 0.074 },
  lp: { rank: 0.73, topExpected: 0.141, topEarned: 0.125 },
} as const;

/** One pool a strategy would open now, from the planner (market/autopilot.ts): its estimate, what reaching it costs, and the money it gets */
export interface SmartPick {
  label: string; how: 'grid' | 'lp'; dex: string;
  /** The pool's own estimate for the week (market/scan.ts expectedGrid / expectedLp) */
  expected: number;
  /** Swapping the budget's coin into the pool's coin and back (both pools' fees); 0 for the budget's own coin */
  cost: number;
  /** The entry swap's fee, impact and tax at the size it opens at */
  entry: number;
  /** expected − cost − entry: what the planner ranks on */
  score: number;
  /** Budget coins it would get */
  capital: number;
  risk: string | null;
  /** The pair's price change over the test week (shown, never ranked) */
  movePct: number;
}

/**
 * What a strategy would do right now with a budget, from today's scan and cash alone (server/bot/autopilot.ts preview):
 * the same planner that runs when it is on, with no bots held.
 */
export interface SmartPreview {
  /** false: the chain's scan is missing, failed or still running (`why` says which) */
  ready: boolean;
  why: string | null;
  scanAt: number | null;
  /** Pools the scan found on the chain, and the ways of them this strategy may use (one pool can be a grid and a range) */
  pools: number;
  allowed: number;
  opens: SmartPick[];
  /** Budget coins not placed, and why */
  waiting: number;
  waitWhy: string | null;
  /**
   * The budget's expected first week as a share of the amount: Σ score × capital ÷ amount. Each pool's estimate after the
   * swaps in and the entry; money waiting earns nothing. null when nothing opens.
   */
  weekPct: number | null;
  /** Why the other ways were left out, most common first */
  gone: { why: string; n: number }[];
}

/** The budget's expected first week from its picks (see SmartPreview.weekPct). */
export function previewWeek(opens: Pick<SmartPick, 'score' | 'capital'>[], amount: number): number | null {
  if (!(amount > 0) || !opens.length) return null;
  return opens.reduce((s, p) => s + p.score * p.capital, 0) / amount;
}
