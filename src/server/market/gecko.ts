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

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const GECKO_TF: Record<TF, [string, number]> = {
  '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1],
};

export class RateLimited extends Error { constructor(public readonly retryAt: number) { super('GeckoTerminal rate limit (429)'); } }

export class GeckoSource {
  private nextAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  calls = 0;
  constructor(
    private readonly fetchFn: FetchFn = (globalThis.fetch as unknown as FetchFn),
    private readonly opts: { minIntervalMs?: number; network?: string; feeBps?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  private now() { return (this.opts.now ?? Date.now)(); }
  private sleep(ms: number) { return (this.opts.sleep ?? ((m) => new Promise((r) => setTimeout(r, m))))(ms); }
  get blockedUntil() { return this.nextAt > this.now() ? this.nextAt : 0; }

  /** Throttled, serialized request. */
  private request<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + (this.opts.minIntervalMs ?? 2500);
      this.calls++;
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** `token` = base token address (price is quoted per base); o.network / o.feeBps override the defaults per market. */
  async ohlcv(pool: string, wpls: string, tf: TF, beforeSec?: number, limit = 1000, o: { network?: string; feeBps?: number } = {}): Promise<Candle[]> {
    const [unit, agg] = GECKO_TF[tf];
    const net = o.network ?? this.opts.network ?? 'pulsechain';
    const q = new URLSearchParams({ aggregate: String(agg), limit: String(limit), currency: 'token', token: wpls });
    if (beforeSec) q.set('before_timestamp', String(beforeSec));
    const url = `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/${unit}?${q}`;
    return this.request(async () => {
      const r = await this.fetchFn(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { this.nextAt = this.now() + 65_000; throw new RateLimited(this.nextAt); }
      if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
      const j = (await r.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      const rows = j.data?.attributes?.ohlcv_list ?? [];
      const k = 1 - (o.feeBps ?? this.opts.feeBps ?? 29) / 10_000;
      return rows
        .filter((x) => x.length >= 6 && x[4] > 0)
        .map(([t, o, h, l, c, v]) => ({ t, o: o * k, h: h * k, l: l * k, c: c * k, v }))
        .sort((a, b) => a.t - b.t);
    });
  }
}
