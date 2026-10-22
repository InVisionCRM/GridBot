/**
 * The liquidity replay behind New bot → Liquidity: the market's pool history (poolHistory) through replayTable at
 * today's gas price, with the pool's fee tier and the share of fees liquidity providers keep. While the history is
 * being read it answers "syncing" with progress; a history synced less than REFRESH_MS ago is used as it is.
 */
import { DEFAULT_LIMITS } from '../../live/limits';
import { gasInBase, LP_GAS } from '../../market/lp';
import { replayTable, type ReplayRow } from '../../market/lpReplay';
import type { Hub } from '../chains/hub';
import { LpPool } from './lpPool';
import { lpShareOf } from './lpShare';
import { KEEP_DAYS, type PoolHistories } from './poolHistory';

export const REPLAY_BANDS = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.2];
/** Replay size when none is given: this many US dollars of the quote coin */
export const REPLAY_USD = 1000;
const REFRESH_MS = 60_000;
/** After a failed sync, the next request waits this long before trying again (the page asks every few seconds) */
const RETRY_MS = 30_000;
const SHARE_TTL_MS = 10 * 60_000;
const DAY_S = 86_400;

export type ReplayAnswer =
  | { state: 'syncing'; done: number; total: number }
  | { state: 'error'; error: string }
  | {
    state: 'ready'; from: number; to: number; swaps: number; capital: number; base: string; quote: string;
    feeTier: number; lpShare: number; gasOpen: number; gasMove: number; maxImpact: number; rows: ReplayRow[];
  };

export class LpReplay {
  private shares = new Map<string, { v: number; at: number }>();
  constructor(private readonly hub: Hub, private readonly histories: PoolHistories, private readonly approval: 'exact' | 'max', private readonly now: () => number = Date.now) {}

  private async lpShare(key: string): Promise<number> {
    const c = this.shares.get(key);
    if (c && this.now() - c.at < SHARE_TTL_MS) return c.v;
    const v = await lpShareOf(this.hub, this.hub.def(key));
    this.shares.set(key, { v, at: this.now() });
    return v;
  }

  async replay(q: { market: string; capital?: number; maxImpact?: number }): Promise<ReplayAnswer> {
    const def = this.hub.def(q.market);
    const rt = this.hub.rt(def.chainId);
    const dex = rt.cfg.dexes.find((x) => x.id === def.pool.dex);
    if (!dex) throw new Error(`unknown DEX ${def.pool.dex}`);
    const pool = new LpPool(rt.reader, def, dex, rt.cfg.wrappedNative.address);
    const lpShare = await this.lpShare(q.market);
    const h = this.histories.get({ chainId: def.chainId, pool: def.pool.address, feeTier: pool.fee, lpShare, logChunk: rt.cfg.logChunk });

    const s = h.state;
    if (!s.syncing && (s.at == null || this.now() - s.at > (s.error ? RETRY_MS : REFRESH_MS))) {
      h.sync().catch(() => { /* kept in h.state.error */ });
    }
    if (s.syncing) return { state: 'syncing', done: s.done, total: s.total };
    if (s.error) return { state: 'error', error: s.error };

    const all = h.minutes, last = all[all.length - 1];
    const rows = last ? all.filter((m) => m.t > last.t - KEEP_DAYS * DAY_S) : [];
    if (rows.length < 2) throw new Error(`${def.base.symbol}/${def.quote.symbol}: no trades in the pool over the last ${KEEP_DAYS} days`);

    const v = await pool.view();
    const snap = await this.hub.quoter(q.market).market();
    const gas = (units: number) => gasInBase(units, snap) * v.price;
    const approvals = this.approval === 'max' ? 0 : [def.base, def.quote].filter((t) => !t.native).length;
    const approve = approvals * gas(rt.cfg.gasUnits.approve), swap = gas(rt.cfg.gasUnits.swap);
    const gasOpen = gas(LP_GAS.v3.open) + approve + swap;
    const gasMove = gas(LP_GAS.v3.close) + gas(LP_GAS.v3.open) + approve + swap;
    const usd = this.hub.usdPerQuote(q.market);
    const capital = q.capital ?? (usd ? REPLAY_USD / usd : null);
    if (!(capital != null && capital > 0)) throw new Error(`no USD price for ${def.quote.symbol}: enter an amount`);
    const maxImpact = q.maxImpact ?? DEFAULT_LIMITS.maxPriceImpact;
    const table = replayTable(rows, {
      baseIs0: v.baseIs0, baseDecimals: def.base.decimals, quoteDecimals: def.quote.decimals, spacing: v.spacing, swapFee: pool.fee / 1e6,
    }, { capital, gasOpen, gasMove, maxImpact }, REPLAY_BANDS);
    return {
      state: 'ready', from: rows[0].t, to: rows[rows.length - 1].t, swaps: rows.reduce((a, m) => a + m.n, 0), capital,
      base: def.base.symbol, quote: def.quote.symbol, feeTier: pool.fee, lpShare, gasOpen, gasMove, maxImpact, rows: table,
    };
  }
}
