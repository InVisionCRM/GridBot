/**
 * The token trader's three strategies (page: ui/TokenTraderPage.tsx step 1; settings: server/bot/tokenTrader.ts
 * TraderOptions). Each is the coins it buys, as the safety gate's settings (market/tokenTrader.ts gateToken), plus the
 * pool age a coin needs and whether the sniper runs. The exit rules (EXIT) are the same for all three, so what one trade
 * can make or lose is the same arithmetic for each; the strategies differ in which coins get in, and how often.
 *
 *  careful  — proven pools: a day old at least with real volume, no tax, nothing an owner can still do to it, holders
 *             spread, at least $50,000 of liquidity, and your own buy moves the price under 1%. The fewest buys, each
 *             checked every way the app can.
 *  balanced — launch day: coins hours old, from the launch venues too (a tax within the cap; an upgradeable contract
 *             whose admin is gone), with the age, wash, owner and size checks on. No holder check (a new launcher coin
 *             has too few holders to read) and no liquidity floor.
 *  wild     — first blocks: anything the safety check lets trade, and the sniper on: a new pool is bought a couple of
 *             blocks after its liquidity lands. Honeypots, sell-blocked, paused and drained coins are still refused.
 */
import { DEFAULT_MIN_POOL_AGE_SEC, DEFAULT_SIZE_IMPACT_CAP, DEFAULT_SNIPER_MIN_LIQ_USD, EXIT } from './tokenTrader';
import { ENFORCED_LIQUIDITY_FLOOR_USD } from './liquidityFloor';
import { DEFAULT_MAX_HOLDER_SHARE, DEFAULT_MAX_TOP10_SHARE } from './holders';
import { SCAN_RULES } from './scan';
import { MAX_TAX } from '../live/tax';

export type TokenStrategyId = 'careful' | 'balanced' | 'wild';
export const TOKEN_STRATEGY_IDS: readonly TokenStrategyId[] = ['careful', 'balanced', 'wild'];

/**
 * What makes a strategy what it is: the risk level and the optional checks. A trader whose settings match these is on
 * that strategy, whatever else was set by hand (amounts, chains, the sniper's timing).
 */
export interface StylePatch {
  risk: 'safe' | 'medium' | 'any'; enforceWashAndAge: boolean; enforceOwnerPowers: boolean;
  enforceLiquidityFloor: boolean; enforceHolderCheck: boolean; enforceSizeImpact: boolean;
}
export const STYLE_KEYS = ['risk', 'enforceWashAndAge', 'enforceOwnerPowers', 'enforceLiquidityFloor', 'enforceHolderCheck', 'enforceSizeImpact'] as const;
/** Everything "Use this" sets: the identity, the pool age a coin needs (with the age check on), and whether the sniper runs */
export interface TokenApply extends StylePatch { minPoolAgeSec: number; sniper: { on: boolean } }
export interface TokenStrategy { id: TokenStrategyId; name: string; tag: string; patch: StylePatch; apply: TokenApply }

const HOUR = 3600;
export const TOKEN_STRATEGY: Record<TokenStrategyId, TokenStrategy> = (() => {
  const careful: StylePatch = { risk: 'safe', enforceWashAndAge: true, enforceOwnerPowers: true, enforceLiquidityFloor: true, enforceHolderCheck: true, enforceSizeImpact: true };
  const balanced: StylePatch = { risk: 'medium', enforceWashAndAge: true, enforceOwnerPowers: true, enforceLiquidityFloor: false, enforceHolderCheck: false, enforceSizeImpact: true };
  const wild: StylePatch = { risk: 'any', enforceWashAndAge: false, enforceOwnerPowers: false, enforceLiquidityFloor: false, enforceHolderCheck: false, enforceSizeImpact: false };
  return {
    careful: { id: 'careful', name: 'Careful', tag: 'proven pools', patch: careful, apply: { ...careful, minPoolAgeSec: DEFAULT_MIN_POOL_AGE_SEC, sniper: { on: false } } },
    balanced: { id: 'balanced', name: 'Balanced', tag: 'launch day', patch: balanced, apply: { ...balanced, minPoolAgeSec: HOUR, sniper: { on: false } } },
    wild: { id: 'wild', name: 'Wild', tag: 'first blocks', patch: wild, apply: { ...wild, minPoolAgeSec: 0, sniper: { on: true } } },
  };
})();
export const TOKEN_STRATEGIES: TokenStrategy[] = TOKEN_STRATEGY_IDS.map((id) => TOKEN_STRATEGY[id]);

/** The strategy these settings are on (by the risk level and the checks; a saved file without a check reads it as off), or null: set by hand. */
export function tokenStrategyOf(o: Partial<Record<string, unknown>> | null | undefined): TokenStrategyId | null {
  if (!o) return null;
  return TOKEN_STRATEGY_IDS.find((id) => STYLE_KEYS.every((k) => (o[k] ?? false) === TOKEN_STRATEGY[id].patch[k])) ?? null;
}

const pc = (x: number) => `${Math.round(x * 100)}%`;
/** The sniper's timing, as the trader has it set (server/bot/tokenTrader.ts SniperOptions) */
export interface SniperTiming { delayBlocks: number; delaySec: number; maxPerHour: number; minLiquidityUsd: number }

/**
 * The coins a strategy buys: the rules the gate applies to them (market/tokenTrader.ts gateToken), in words, with the
 * numbers it uses. `minAgeSec` is the trader's own pool-age setting (the strategy's when it was just applied); `money`
 * writes a dollar floor the way the page shows money (in ETH: no dollar figure is shown anywhere).
 */
export function tokenProfile(id: TokenStrategyId, minAgeSec: number, sniper: SniperTiming, money: (usd: number) => string): string[] {
  const age = minAgeSec >= 86_400 ? `${Math.round(minAgeSec / 86_400)} day${minAgeSec >= 2 * 86_400 ? 's' : ''}` : `${Math.max(1, Math.round(minAgeSec / HOUR))} h`;
  const wash = `real volume: under ${SCAN_RULES.maxVolumeToLiquidity}× its liquidity in a day`;
  const refused = 'always refused: a honeypot, a sell that fails in simulation, a paused token, liquidity pulled, too little liquidity';
  if (id === 'careful') return [
    `pool at least ${age} old, ${wash}`,
    `no tax at all; not upgradeable; no owner left who can pause, blacklist, mint, or change a tax or a limit`,
    `at least ${money(ENFORCED_LIQUIDITY_FLOOR_USD)} of liquidity; holders spread: the largest under ${pc(DEFAULT_MAX_HOLDER_SHARE)}, the top 10 under ${pc(DEFAULT_MAX_TOP10_SHARE)}`,
    `your own buy moves the price under ${pc(DEFAULT_SIZE_IMPACT_CAP)}`,
    refused,
  ];
  if (id === 'balanced') return [
    `pool at least ${age} old, ${wash}`,
    `a tax up to ${pc(MAX_TAX)} is fine (the launch venues take a cut), an upgradeable contract too if nobody can upgrade it any more; no owner left who can pause, blacklist, mint, or change a tax or a limit`,
    `no holder check and no liquidity floor: a coin hours old has too few holders to read`,
    `your own buy moves the price under ${pc(DEFAULT_SIZE_IMPACT_CAP)}`,
    refused,
  ];
  return [
    `every coin the safety check lets trade, any age, any owner powers, a tax up to ${pc(MAX_TAX)} when live`,
    `the sniper buys a brand-new pool ${sniper.delayBlocks} blocks (${sniper.delaySec} s) after its liquidity lands, from ${money(sniper.minLiquidityUsd)} of liquidity, at most ${sniper.maxPerHour} an hour`,
    'none of the extra checks: age, wash volume, owner powers, holders, the liquidity floor, impact at your size',
    refused,
  ];
}

/** The exit rules every trade runs under (market/tokenTrader.ts EXIT), as facts the page can state */
export const LADDER = {
  stop: EXIT.hardStop, tp1: EXIT.tp1, tp1Frac: EXIT.tp1Frac, tp2: EXIT.tp2, tp2Frac: EXIT.tp2Frac,
  trailArm: EXIT.trailArm, trailGap: EXIT.trailGap, timeStopH: EXIT.timeStopMs / 3_600_000, timeStopMinGain: EXIT.timeStopMinGain,
  liqPull: EXIT.liqPull, deadH: EXIT.deadMs / 3_600_000, sniperMinLiqUsd: DEFAULT_SNIPER_MIN_LIQ_USD,
} as const;

/**
 * A trade's result under the exit rules when the price runs up to `peak` (a gain on the entry, after fees) and then falls
 * back: which thirds sold where, and the total. Below the trail's arming gain a trade ends by the stop or the time stop
 * instead, so that is refused.
 */
export function ladderOutcome(peak: number): { sold: { at: number; frac: number; why: string }[]; total: number } {
  if (!(peak >= EXIT.trailArm)) throw new Error(`The trailing stop arms at +${pc(EXIT.trailArm)}: a run that stops short ends by the stop or the time stop.`);
  const sold: { at: number; frac: number; why: string }[] = [];
  let left = 1;
  if (peak >= EXIT.tp1) { sold.push({ at: EXIT.tp1, frac: EXIT.tp1Frac, why: `a third at +${pc(EXIT.tp1)}` }); left -= EXIT.tp1Frac; }
  if (peak >= EXIT.tp2) { sold.push({ at: EXIT.tp2, frac: EXIT.tp2Frac, why: `a third at +${pc(EXIT.tp2)}` }); left -= EXIT.tp2Frac; }
  sold.push({ at: (1 + peak) * (1 - EXIT.trailGap) - 1, frac: left, why: `the rest ${pc(EXIT.trailGap)} under the peak` });
  return { sold, total: sold.reduce((s, x) => s + x.at * x.frac, 0) };
}

/** How many trades stopped out at −25% one run to `peak` pays for */
export function stopsPaidFor(peak: number): number {
  return ladderOutcome(peak).total / EXIT.hardStop;
}
