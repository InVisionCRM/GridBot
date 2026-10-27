import type { BridgeQuote } from './types';

function cloneQuote(quote: BridgeQuote): BridgeQuote {
  return structuredClone(quote);
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const child of Object.values(v as object)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

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
    return cloneQuote(row.quote);
  }

  set(key: string, quote: BridgeQuote) {
    this.rows.set(key, { at: this.now(), quote: deepFreeze(cloneQuote(quote)) });
  }
}

/**
 * One network read for identical quotes that overlap. Each caller receives its own clone,
 * so a mutation of the returned quote cannot change the cached one or another caller.
 */
export function loadQuote(
  cache: QuoteCache,
  inflight: Map<string, Promise<BridgeQuote>>,
  key: string,
  produce: () => Promise<BridgeQuote>,
): Promise<BridgeQuote> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending.then((quote) => cloneQuote(quote));
  const task = produce().then((quote) => {
    cache.set(key, quote);
    return quote;
  });
  inflight.set(key, task);
  return task.then((quote) => cloneQuote(quote)).finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
}

export const QUOTE_CACHE_TTL_MS = 60_000;

/** Hold time when the provider does not publish an expiry (Relay, Li.Fi). Matches the cache TTL. */
export const QUOTE_HOLD_SEC = 60;
