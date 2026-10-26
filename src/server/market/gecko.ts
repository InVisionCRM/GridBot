/**
 * GeckoTerminal public OHLCV (no key). Verified Oct 2026:
 *   GET https://api.geckoterminal.com/api/v2/networks/{slug}/pools/{pool}/ohlcv/{day|hour|minute}
 *       ?aggregate=1|4|5|15&limit≤1000&before_timestamp=<sec>&currency=token&token=<base token>
 * → [t, o, h, l, c, v] newest first; price = quote per base token, volume in QUOTE token units.
 * slug per chain: pulsechain, eth, robinhood (see chains.ts).
 * Limits: 30 calls/min public, ≤1000 candles/call, ~6 months of history. We throttle to ≤24/min and
 * back off 65 s on 429. Prices are trade/mid prices; × (1 − fee) to match the grid's sell-side getPrice units.
 */
import type { Candle, TF } from '../../market/candles';
import { parseTopPools, type TopPool } from '../../market/scan';

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const GECKO_TF: Record<TF, [string, number]> = {
  '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1],
};

export class RateLimited extends Error { constructor(public readonly retryAt: number) { super('GeckoTerminal rate limit (429)'); } }

/** Slowest spacing the adaptive pace backs off to (≈5 requests a minute). */
export const MAX_GAP_MS = 12_000;
/** Successful requests in a row before the spacing tightens by 0.5 s again. */
export const SPEEDUP_AFTER = 20;

/**
 * Adaptive pace: the documented 30 calls/min does not hold everywhere. Measured 2026-10-17 from a cloud IP: 6–7
 * requests then a 429 at both 2.5 s and 7 s spacing, so a fixed 2.5 s pace hit a 65 s back-off every ~10 requests
 * (79% of a 663 s scan). Each 429 doubles the spacing (up to MAX_GAP_MS); SPEEDUP_AFTER successes in a row shorten
 * it by 0.5 s (down to minIntervalMs), so it settles at whatever this connection is allowed.
 */
export class GeckoSource {
  private nextAt = 0;
  private backoffUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private gap: number;
  private okStreak = 0;
  calls = 0;
  /** When each 429 came back (the last 200), for the System check */
  readonly limits: number[] = [];
  constructor(
    private readonly fetchFn: FetchFn = (globalThis.fetch as unknown as FetchFn),
    private readonly opts: { minIntervalMs?: number; network?: string; feeBps?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) { this.gap = opts.minIntervalMs ?? 2500; }

  private now() { return (this.opts.now ?? Date.now)(); }
  /** Current spacing between requests (ms). */
  get pace() { return this.gap; }
  private limited() {
    this.limits.push(this.now());
    if (this.limits.length > 200) this.limits.shift();
    this.gap = Math.min(MAX_GAP_MS, this.gap * 2);
    this.okStreak = 0;
    this.nextAt = this.backoffUntil = this.now() + 65_000;
    return new RateLimited(this.nextAt);
  }
  private succeeded() {
    if (++this.okStreak >= SPEEDUP_AFTER && this.gap > (this.opts.minIntervalMs ?? 2500)) {
      this.gap = Math.max(this.opts.minIntervalMs ?? 2500, this.gap - 500);
      this.okStreak = 0;
    }
  }
  private sleep(ms: number) { return (this.opts.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms); }
  get blockedUntil() { return this.nextAt > this.now() ? this.nextAt : 0; }
  /** End of the 65 s back-off after a 429 (0 when not backing off; the pace between calls doesn't count). */
  get limitedUntil() { return this.backoffUntil > this.now() ? this.backoffUntil : 0; }
  /** 429s received in the last `ms` */
  limitedWithin(ms: number) { const from = this.now() - ms; return this.limits.filter((t) => t >= from).length; }

  /** Throttled, serialized request. */
  private request<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + this.gap;
      this.calls++;
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** One GeckoTerminal URL's JSON, paced and backed off like every call (also what the host relays for friends' copies). */
  getJson(url: string): Promise<unknown> {
    return this.request(async () => {
      const r = await this.fetchFn(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) throw this.limited();
      if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
      this.succeeded();
      return r.json();
    });
  }

  /** Top pools of one DEX on a network by 24 h volume (20 per page). */
  async topPools(network: string, dex: string, page = 1): Promise<TopPool[]> {
    return parseTopPools(await this.getJson(`https://api.geckoterminal.com/api/v2/networks/${network}/dexes/${dex}/pools?sort=h24_volume_usd_desc&page=${page}`));
  }

  /** Newly created pools on a network (one page). Same row shape as the top-pool list, including pool_created_at. */
  async newPools(network: string, page = 1): Promise<TopPool[]> {
    return parseTopPools(await this.getJson(`https://api.geckoterminal.com/api/v2/networks/${network}/new_pools?page=${page}`));
  }

  /** Trending pools on a network (one page). */
  async trendingPools(network: string, page = 1): Promise<TopPool[]> {
    return parseTopPools(await this.getJson(`https://api.geckoterminal.com/api/v2/networks/${network}/trending_pools?page=${page}`));
  }

  /** `token` = base token address (price is quoted per base); o.network / o.feeBps override the defaults per market. */
  async ohlcv(pool: string, wpls: string, tf: TF, beforeSec?: number, limit = 1000, o: { network?: string; feeBps?: number } = {}): Promise<Candle[]> {
    const [unit, agg] = GECKO_TF[tf];
    const net = o.network ?? this.opts.network ?? 'pulsechain';
    const q = new URLSearchParams({ aggregate: String(agg), limit: String(limit), currency: 'token', token: wpls });
    if (beforeSec) q.set('before_timestamp', String(beforeSec));
    const j = (await this.getJson(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/${unit}?${q}`)) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const rows = j.data?.attributes?.ohlcv_list ?? [];
    const k = 1 - (o.feeBps ?? this.opts.feeBps ?? 29) / 10_000;
    return rows
      .filter((x) => x.length >= 6 && x[4] > 0)
      .map(([t, o, h, l, c, v]) => ({ t, o: o * k, h: h * k, l: l * k, c: c * k, v }))
      .sort((a, b) => a.t - b.t);
  }
}
