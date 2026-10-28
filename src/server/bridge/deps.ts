import type { QuoteCache } from './cache';
import type { HttpClient } from './http';
import type { RateLimiter } from './rateLimit';
import type { BridgeLog } from './types';

export interface BridgeDeps {
  http: HttpClient;
  limiter: RateLimiter;
  cache: QuoteCache;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  secrets: readonly string[];
  log?: BridgeLog;
  key?: string;
}
