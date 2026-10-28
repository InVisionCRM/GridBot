/**
 * Keyless quote and status clients for Across, Relay, and Li.Fi.
 *
 * Nothing here signs, approves on-chain, or broadcasts. `quote` returns an approve transaction
 * and a deposit transaction. A later caller can hand the deposit to the sendSafe wrapper from PR #52 as
 * `{ from, to, data, value }`. This module does not read the environment. Optional quote keys
 * are constructor arguments, sent only as headers. Once PR #52 lands, the host passes the three
 * keys already taken out of the environment. Do not construct this from a friend's copy.
 *
 * PR #59's route table decides which provider to ask: Across is primary, Relay is the fallback,
 * Li.Fi is discovery-only (`discoveryOnly` is always true on a Li.Fi quote). `sameAsset` should
 * follow that table's relation `same-asset`. Ethereum USDC and Robinhood USDG are not the same
 * coin. Canonical slow routes are not a provider here and must not be added as one.
 */
import { redact, registerSecret } from '../bot/logger';
import { BridgeError } from './errors';
import { QuoteCache, QUOTE_CACHE_TTL_MS } from './cache';
import type { BridgeDeps } from './deps';
import { AcrossClient } from './across';
import { createFetchHttp, delay, optionalKey, type HttpClient } from './http';
import { LifiClient } from './lifi';
import { DEFAULT_LIMITS, RateLimiter, type RateRule } from './rateLimit';
import { RelayClient } from './relay';
import type { BridgeId, BridgeLog, BridgeProvider, BridgeQuoteRequest, BridgeStatusQuery } from './types';

export interface BridgeKeys {
  across?: string;
  relay?: string;
  lifi?: string;
}

export interface BridgeClientOptions {
  keys?: BridgeKeys;
  http?: HttpClient;
  /** Used only when `http` is omitted. Tests pass `http` and do not call the network. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  cache?: QuoteCache;
  limits?: { across: RateRule; relay: RateRule; lifi: RateRule };
  log?: BridgeLog;
  /** 2-byte Across integrator id: 4 hex characters, with or without a 0x prefix. */
  integratorId?: string;
}

export interface BridgeClients {
  across: AcrossClient;
  relay: RelayClient;
  lifi: LifiClient;
}

export function createBridgeProviders(o: BridgeClientOptions = {}): BridgeClients {
  const now = o.now ?? Date.now;
  const http = o.http ?? createFetchHttp(o.fetch ?? fetch, o.timeoutMs ?? 10_000, now);
  const cache = o.cache ?? new QuoteCache(QUOTE_CACHE_TTL_MS, now);
  const limits = o.limits ?? DEFAULT_LIMITS;
  const keys = {
    across: optionalKey(o.keys?.across, 'across'),
    relay: optionalKey(o.keys?.relay, 'relay'),
    lifi: optionalKey(o.keys?.lifi, 'lifi'),
  };
  const secrets = [keys.across, keys.relay, keys.lifi].filter((s): s is string => !!s);
  for (const secret of secrets) registerSecret(secret, 6);
  const integratorId = normalizeIntegratorId(o.integratorId);
  const sleep = o.sleep ?? delay;
  const log = o.log ? (level: 'info' | 'warn' | 'error', msg: string) => o.log!(level, redact(msg)) : undefined;
  const common = { http, cache, now, sleep, secrets, log };
  return {
    across: new AcrossClient(deps(common, new RateLimiter(limits.across, now), keys.across, integratorId)),
    relay: new RelayClient(deps(common, new RateLimiter(limits.relay, now), keys.relay)),
    lifi: new LifiClient(deps(common, new RateLimiter(limits.lifi, now), keys.lifi)),
  };
}

function normalizeIntegratorId(raw: string | undefined): string | undefined {
  if (raw == null || !raw.trim()) return undefined;
  const hex = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
    throw new BridgeError('across', 'invalid', 'across: integrator id was rejected');
  }
  return hex.toLowerCase();
}

function deps(common: Omit<BridgeDeps, 'limiter' | 'key' | 'integratorId'>, limiter: RateLimiter, key: string | undefined, integratorId?: string): BridgeDeps {
  return { ...common, limiter, ...(key ? { key } : {}), ...(integratorId ? { integratorId } : {}) };
}

export function bridgeQuote(clients: BridgeClients, provider: BridgeId, req: BridgeQuoteRequest) {
  return client(clients, provider).quote(req);
}

export function bridgeStatus(clients: BridgeClients, q: BridgeStatusQuery) {
  return client(clients, q.provider).status(q);
}

function client(clients: BridgeClients, provider: BridgeId): BridgeProvider {
  const c = clients[provider];
  if (!c || c.id !== provider) throw new Error('bridge: provider is missing');
  return c;
}

export { AcrossClient, ACROSS_API, ACROSS_SPOKE, ACROSS_PERIPHERY } from './across';
export { RelayClient, RELAY_API } from './relay';
export { LifiClient, LIFI_API, LIFI_DIAMOND, LIFI_DIAMONDS, lifiDiamond } from './lifi';
export { RELAY_DEPOSITORY, RELAY_PROXY_V3, RELAY_ROUTER_V3 } from './allow';
export { QuoteCache, QUOTE_CACHE_TTL_MS, QUOTE_HOLD_SEC } from './cache';
export { RateLimiter, DEFAULT_LIMITS } from './rateLimit';
export { withinEta, filterByEta } from './eta';
export { assertQuoteMatches } from './validate';
export { BridgeError, sanitizeText } from './errors';
export { createFetchHttp, HTTP_MAX_ATTEMPTS } from './http';
export { LIFI_FEE_BPS, SAME_ASSET_SURPLUS_BPS, lifiFeeAmount, sameAssetSurplus } from './parse';
export type {
  BridgeEta, BridgeFees, BridgeId, BridgeProvider, BridgeQuote, BridgeQuoteRequest, BridgeStatus, BridgeStatusQuery, BridgeStatusState,
  BridgeToken, FeeComponent, ReceivedFill, UnsignedTx,
} from './types';
