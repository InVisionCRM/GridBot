/**
 * Friends' copies share the host's GeckoTerminal budget. GeckoTerminal limits by IP (measured: 6–7 calls, then 429s),
 * so copies pacing themselves separately would starve each other and the host's daily scan. A copy asks the host
 * instead (relayFetch → GET /api/host/gecko on the host app): one client paces every call made from this computer, and
 * a request another copy just made is answered from a cache. The daily scan is the host's too (hostScan): one scan for
 * everyone, which the copies show.
 */
import { RateLimited, type FetchFn, type GeckoSource } from '../market/gecko';

/** Copies relay candle requests only, so the relay can't be pointed anywhere else. */
export const OHLCV_URL = /^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/[a-z0-9-]+\/pools\/0x[0-9a-fA-F]{40}\/ohlcv\/(day|hour|minute)\?[A-Za-z0-9_=&.-]*$/;
/** Candles before a timestamp don't change (kept 6 h); the newest ones do (kept 60 s). */
export const HISTORY_TTL_MS = 6 * 3600_000;
export const LATEST_TTL_MS = 60_000;
const CACHE_MAX = 2000;
/** Relayed requests waiting at once; another is told to back off (429) rather than wait minutes in line. */
export const MAX_WAITING = 6;

export type RelayAnswer = { status: 200; body: unknown } | { status: 429; retryAt: number } | { status: 400 | 502; error: string };

export class GeckoRelay {
  private cache = new Map<string, { at: number; body: unknown }>();
  private waiting = 0;

  /** busy = the host's daily scan is running: it has the budget, as it does over the host's own candle sync */
  constructor(private readonly gecko: GeckoSource, private readonly o: { busy: () => boolean; now?: () => number }) {}

  private now() { return (this.o.now ?? Date.now)(); }

  async get(url: string): Promise<RelayAnswer> {
    if (!OHLCV_URL.test(url)) return { status: 400, error: 'Only GeckoTerminal candle URLs are relayed.' };
    const hit = this.cache.get(url), ttl = url.includes('before_timestamp=') ? HISTORY_TTL_MS : LATEST_TTL_MS;
    if (hit && this.now() - hit.at < ttl) return { status: 200, body: hit.body };
    if (this.o.busy() || this.gecko.limitedUntil || this.waiting >= MAX_WAITING) return { status: 429, retryAt: Math.max(this.gecko.limitedUntil, this.now() + 65_000) };
    this.waiting++;
    try {
      const body = await this.gecko.getJson(url);
      this.cache.delete(url);
      this.cache.set(url, { at: this.now(), body });
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      return { status: 200, body };
    } catch (e) {
      return e instanceof RateLimited ? { status: 429, retryAt: e.retryAt } : { status: 502, error: (e as Error).message };
    } finally {
      this.waiting--;
    }
  }
}

/** A copy's GeckoTerminal fetch: the same URL, asked of the host's relay (which answers 429 when the copy should wait). */
export function relayFetch(hostUrl: string): FetchFn {
  return (url) => fetch(`${hostUrl}/api/host/gecko?url=${encodeURIComponent(url)}`);
}

/** The daily scan a copy shows: the host's. Starting one from a copy is refused (one scan serves everyone). */
export function hostScan(hostUrl: string, hostName: string) {
  return {
    async status(): Promise<unknown> {
      const r = await fetch(`${hostUrl}/api/opportunities`);
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(`${hostName}'s app didn't send the scan: ${j.error ?? `HTTP ${r.status}`}`);
      return j;
    },
    run(): Promise<unknown> {
      throw new Error(`${hostName}'s app scans once a day for everyone, so a scan can't be started here.`);
    },
  };
}
