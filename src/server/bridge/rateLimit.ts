import { BridgeError } from './errors';

export interface RateRule { max: number; windowMs: number }

/**
 * Per-provider sliding window.
 * Li.Fi's public cap is 30 requests per 2 hours. Across and Relay use a tighter default than
 * their published ceilings so a quote loop cannot hammer the keyless endpoints.
 */
export const DEFAULT_LIMITS: Record<'across' | 'relay' | 'lifi', RateRule> = {
  across: { max: 20, windowMs: 60_000 },
  relay: { max: 20, windowMs: 60_000 },
  lifi: { max: 30, windowMs: 2 * 60 * 60 * 1000 },
};

export class RateLimiter {
  private readonly hits: number[] = [];
  /** Absolute ms. take() refuses until this time after a Retry-After longer than the retry budget. */
  private until = 0;
  constructor(private readonly rule: RateRule, private readonly now: () => number) {}

  hold(untilMs: number) {
    if (untilMs > this.until) this.until = untilMs;
  }

  take(provider: string) {
    const t = this.now();
    if (t < this.until) throw new BridgeError(provider, 'rate_limit', `${provider}: rate limit`);
    while (this.hits.length > 0 && t - this.hits[0] >= this.rule.windowMs) this.hits.shift();
    if (this.hits.length >= this.rule.max) {
      const secs = Math.round(this.rule.windowMs / 1000);
      throw new BridgeError(provider, 'rate_limit', `${provider}: rate limit, ${this.rule.max} requests per ${secs}s`);
    }
    this.hits.push(t);
  }
}
