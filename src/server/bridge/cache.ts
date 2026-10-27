import type { BridgeQuote } from './types';

/** In-memory quote cache. A hit is not a network call and does not spend a rate-limit slot. */
export class QuoteCache {
  private readonly rows = new Map<string, { at: number; quote: BridgeQuote }>();
  constructor(private readonly ttlMs: number, private readonly now: () => number) {}

  get(key: string): BridgeQuote | null {
    const row = this.rows.get(key);
    if (!row) return null;
    if (this.ttlMs <= 0 || this.now() - row.at >= this.ttlMs) {
      this.rows.delete(key);
      return null;
    }
    if (row.quote.expiresAt * 1000 <= this.now()) {
      this.rows.delete(key);
      return null;
    }
    return row.quote;
  }

  set(key: string, quote: BridgeQuote) {
    this.rows.set(key, { at: this.now(), quote });
  }
}

export const QUOTE_CACHE_TTL_MS = 60_000;

/** Hold time when the provider does not publish an expiry (Relay, Li.Fi). Matches the cache TTL. */
export const QUOTE_HOLD_SEC = 60;
