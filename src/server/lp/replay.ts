/**
 * The liquidity replay behind New bot → Liquidity: the market's pool history (poolHistory) through replayTable at
 * today's gas price, with the pool's fee tier and the share of fees liquidity providers keep, plus, for each range, the
 * coins a position opened now would hold and its share of the pool's active liquidity, over a window of 1, 7, 30 or
 * 365 days. Until the history covers the window it answers "syncing" with progress (a longer window is read only when
 * it is asked for); a history synced less than REFRESH_MS ago is used as it is.
 */
import { DEFAULT_LIMITS } from '../../live/limits';
import { gasInBase, LP_GAS } from '../../market/lp';
import { positionFor, replayTable, type ReplayRow } from '../../market/lpReplay';
import type { Hub } from '../chains/hub';
import { LpPool } from './lpPool';
import { DEFAULT_DAYS, REPLAY_DAYS, type ReplayDays } from './poolHistory';
import { REFRESH_MS, type ReplayPools, type WaitAnswer } from '../replay/pools';

export const REPLAY_BANDS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2];
/** Replay size when none is given: this many US dollars of the quote coin */
export const REPLAY_USD = 1000;

export type ReplayAnswer =
  | WaitAnswer
  | {
    state: 'ready'; days: ReplayDays; from: number; to: number; swaps: number; capital: number; base: string; quote: string;
    feeTier: number; lpShare: number; gasOpen: number; gasMove: number; maxImpact: number; rows: ReplayRow[];
  };

/** The window asked for: one of REPLAY_DAYS, DEFAULT_DAYS when none is given. */
export function replayDays(v: unknown): ReplayDays {
  if (v == null || v === '') return DEFAULT_DAYS;
  const n = Number(v);
  if (!REPLAY_DAYS.includes(n as ReplayDays)) throw new Error(`days must be one of ${REPLAY_DAYS.join(', ')}`);
  return n as ReplayDays;
}

export class LpReplay {
  /** The last answer per market and window, kept while the history and the inputs are the same and REFRESH_MS has not passed */
  private answers = new Map<string, { key: string; at: number; answer: ReplayAnswer }>();
  constructor(private readonly hub: Hub, private readonly pools: ReplayPools, private readonly approval: 'exact' | 'max', private readonly now: () => number = Date.now) {}

  async replay(q: { market: string; capital?: number; maxImpact?: number; days?: ReplayDays }): Promise<ReplayAnswer> {
    const days = q.days ?? DEFAULT_DAYS;
    const def = this.hub.def(q.market);
    const rt = this.hub.rt(def.chainId);
    const dex = rt.cfg.dexes.find((x) => x.id === def.pool.dex);
    if (!dex) throw new Error(`unknown DEX ${def.pool.dex}`);
    const pool = new LpPool(rt.reader, def, dex, rt.cfg.wrappedNative.address);
    const { h, lpShare } = await this.pools.history(q.market);
    const w = this.pools.window(h, days, `${def.base.symbol}/${def.quote.symbol}`);
    if (!('rows' in w)) return w;
    const rows = w.rows, last = rows[rows.length - 1];

    const slot = `${q.market}|${days}`, key = `${q.capital ?? ''}|${q.maxImpact ?? ''}|${rows.length}|${last.t}|${last.n}`;
    const kept = this.answers.get(slot);
    if (kept && kept.key === key && this.now() - kept.at < REFRESH_MS) return kept.answer;

    const v = await pool.view();
    const snap = await this.hub.quoter(q.market).market();
    const gas = (units: number) => gasInBase(units, snap) * v.price;
    const approvals = this.approval === 'max' ? 0 : [def.base, def.quote].filter((t) => !t.native).length;
    const approve = approvals * gas(rt.cfg.gasUnits.approve), swap = gas(rt.cfg.gasUnits.swap);
    const gasOpen = gas(LP_GAS.v3.open) + approve + swap;
    const gasMove = gas(LP_GAS.v3.close) + gas(LP_GAS.v3.open) + approve + swap;
    const usd = this.hub.usdPerQuote(q.market);
    const capital = q.capital ?? (usd ? REPLAY_USD / usd : null);
    if (!(capital != null && capital > 0)) throw new Error(`no price for ${def.quote.symbol}: enter an amount`);
    const maxImpact = q.maxImpact ?? DEFAULT_LIMITS.maxPriceImpact;
    const sides = { baseIs0: v.baseIs0, baseDecimals: def.base.decimals, quoteDecimals: def.quote.decimals, spacing: v.spacing, swapFee: pool.fee / 1e6 };
    const table = await replayTable(rows, sides, { capital, gasOpen, gasMove, maxImpact }, REPLAY_BANDS);
    const active = Number(v.liquidity);
    const now = new Map(REPLAY_BANDS.map((b) => [b, positionFor(capital, b, v.tick, sides)]));
    const answer: ReplayAnswer = {
      state: 'ready', days, from: rows[0].t, to: rows[rows.length - 1].t, swaps: rows.reduce((a, m) => a + m.n, 0), capital,
      base: def.base.symbol, quote: def.quote.symbol, feeTier: pool.fee, lpShare, gasOpen, gasMove, maxImpact,
      rows: table.map((r) => { const at = now.get(r.bandPct)!; return { ...r, coinsNow: at.coins, poolShareNow: at.L / (at.L + active) }; }),
    };
    this.answers.set(slot, { key, at: this.now(), answer });
    return answer;
  }
}
