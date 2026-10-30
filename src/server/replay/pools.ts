/**
 * What the liquidity and grid replays share: which pool history a market reads (one reference per pool, so the two
 * replays of a V3 market use the same saved file), which way round the pool holds the market's coins, and the minutes
 * of a window once the history covers it, starting the read of a window that is not there yet.
 */
import type { PoolSides } from '../../live/v3Liquidity';
import type { PoolMinute } from '../../market/lpReplay';
import type { Hub } from '../chains/hub';
import { V3_POOL } from '../dex/abis';
import { readCall, sameAddr } from '../dex/types';
import { lpShareOf } from '../lp/lpShare';
import type { PoolHistories, PoolHistory, ReplayDays, SyncState } from '../lp/poolHistory';

/** A history read less than this long ago is used as it is */
export const REFRESH_MS = 60_000;
/** After a failed read, the next ask waits this long before trying again (the pages ask every few seconds) */
const RETRY_MS = 30_000;
const SHARE_TTL_MS = 10 * 60_000;
const DAY_S = 86_400;

export type WaitAnswer = { state: 'syncing'; days: ReplayDays; done: number; total: number } | { state: 'error'; error: string };

/**
 * While a pool's history is read: a window it doesn't cover yet shows the read's progress; a top-up of a window already
 * read answers from it (the new trades count on the next ask). Before, every visit a minute after the last read showed
 * the first-read progress screen for the 2–3 s the top-up took (HEX/PLS, 2026-10-26: "syncing 0 of 15 blocks").
 */
export function syncAnswer(s: SyncState, covered: boolean, days: ReplayDays): WaitAnswer | null {
  if (s.error && !s.syncing) return { state: 'error', error: s.error };
  if (!covered) return { state: 'syncing', days, done: s.done, total: s.total };
  return null;
}

export class ReplayPools {
  private shares = new Map<string, { v: number; at: number }>();
  private token0 = new Map<string, string>();
  constructor(private readonly hub: Hub, private readonly histories: PoolHistories, private readonly now: () => number = Date.now) {}

  private async lpShare(market: string): Promise<number> {
    const c = this.shares.get(market);
    if (c && this.now() - c.at < SHARE_TTL_MS) return c.v;
    const v = await lpShareOf(this.hub, this.hub.def(market));
    this.shares.set(market, { v, at: this.now() });
    return v;
  }

  /** The market's pool history: a V3 pool keeps its fee tier and the LPs' share of fees; a V2 pool only its price. */
  async history(market: string): Promise<{ h: PoolHistory; lpShare: number }> {
    const def = this.hub.def(market);
    const rt = this.hub.rt(def.chainId);
    if (!def.pool.address) throw new Error(`${def.base.symbol}/${def.quote.symbol}: no pool address to read trades from`);
    if (def.pool.kind === 'v3') {
      if (def.pool.feeTier == null) throw new Error(`${def.base.symbol}/${def.quote.symbol}: a V3 pool without a fee tier`);
      const lpShare = await this.lpShare(market);
      return { h: this.histories.get({ chainId: def.chainId, pool: def.pool.address, kind: 'v3', feeTier: def.pool.feeTier, lpShare, logChunk: rt.cfg.logChunk }), lpShare };
    }
    return { h: this.histories.get({ chainId: def.chainId, pool: def.pool.address, kind: 'v2', feeTier: def.pool.feeBps * 100, lpShare: 1, logChunk: rt.cfg.logChunk }), lpShare: 1 };
  }

  /** Which way round the pool holds the market's coins (token0 is read once per pool; a native coin is its wrapped token). */
  async sides(market: string): Promise<PoolSides> {
    const def = this.hub.def(market);
    const rt = this.hub.rt(def.chainId);
    let t0 = this.token0.get(def.pool.address);
    if (!t0) {
      [t0] = await readCall<[string]>(rt.reader, def.pool.address, V3_POOL, 'token0');
      this.token0.set(def.pool.address, t0);
    }
    const baseAddr = def.base.native ? rt.cfg.wrappedNative.address : def.base.address;
    return { baseIs0: sameAddr(t0, baseAddr), baseDecimals: def.base.decimals, quoteDecimals: def.quote.decimals };
  }

  /**
   * The minutes of the last `days` days, or what to show while they are read: a window not read yet starts its read
   * now, a read one is topped up once a minute, and a failed read waits RETRY_MS.
   */
  window(h: PoolHistory, days: ReplayDays, label: string): WaitAnswer | { rows: PoolMinute[] } {
    const s = h.state, covered = h.covers(days);
    if (!s.syncing && (s.error ? s.at == null || this.now() - s.at > RETRY_MS : !covered || s.at == null || this.now() - s.at > REFRESH_MS)) {
      h.sync(days).catch(() => { /* kept in h.state.error */ });
    }
    const waiting = syncAnswer(s, covered, days);
    if (waiting) return waiting;
    const all = h.minutes, last = all[all.length - 1];
    const rows = last ? all.filter((m) => m.t > last.t - days * DAY_S) : [];
    if (rows.length < 2) throw new Error(`${label}: no trades in the pool over the last ${days === 1 ? 'day' : `${days} days`}`);
    return { rows };
  }
}
