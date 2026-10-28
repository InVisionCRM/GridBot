/**
 * Read-side provider with RPC fallback: requests go to the current endpoint; on a transport-level failure
 * (timeout, 429/5xx, connection refused, a JSON-RPC error like "Internal error" or "rate limit", …) it rotates to the
 * next endpoint and retries once per endpoint. A real contract revert is an answer and is never retried on another RPC.
 *
 * An endpoint that just failed sits out a short, growing cooldown so rotation skips it while another endpoint works.
 * Per-chain health (request-level failures, after every endpoint was tried) feeds the status, the UI banner and the
 * Activity log (see checkHealth).
 */
import { FetchRequest, JsonRpcProvider } from 'ethers';
import type { ChainReader, ReceiptLike } from '../bot/chain';
import type { LogReader } from '../market/onchain';

export function makeRpc(url: string, chainId: number, timeoutMs = 12_000): JsonRpcProvider {
  const req = new FetchRequest(url);
  req.timeout = timeoutMs;
  // ethers silently retries 429s with backoff until the timeout; surface them so we rotate to the next RPC instead.
  req.setThrottleParams({ maxAttempts: 1 });
  return new JsonRpcProvider(req, chainId, { staticNetwork: true, batchMaxCount: 1 });
}

/** Tiny FIFO semaphore: public RPCs rate-limit bursts, so each chain keeps ≤ N requests in flight. */
class Limiter {
  private active = 0;
  private q: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.q.shift()?.(); }
  }
}

const FINAL = new Set(['INVALID_ARGUMENT', 'NUMERIC_FAULT', 'INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED']);
/**
 * Waits before each retry of a request a single-RPC chain refused with 429. Robinhood's RPC refuses for seconds while
 * eth_getLogs runs (the liquidity replay's swap history); with 0.4 s + 0.8 s, 47 of ~3,100 bot reads failed in six
 * 3–4-minute runs under that load, with these 3 (2026-10-22).
 */
const RATE_LIMIT_WAITS_MS = [1000, 2000, 4000];
const isRateLimited = (e: unknown) => /\b429\b|too many requests|rate limit/i.test(String((e as Error)?.message ?? e));

type CallErr = {
  code?: string; message?: string; data?: string | null; reason?: string | null; revert?: unknown;
  info?: { error?: { code?: number; message?: string } };
};
/** What a node says when a call really reverted (or ran out of gas / hit a bad opcode): deterministic, any RPC agrees. */
const REVERT_TEXT = /revert|invalid opcode|out of gas|stack (underflow|overflow)|invalid jump/i;

/**
 * ethers v6 turns ANY JSON-RPC error on eth_call / eth_estimateGas into CALL_EXCEPTION "missing revert data"
 * (JsonRpcProvider.getRpcError). So cloudflare-eth.com answering {"code":-32603,"message":"Internal error"}, or a node
 * answering {"code":-32005,"message":"Rate limit exceeded"}, looks like a revert. It is only a revert when there is revert
 * data / a reason, the node used code 3, or its message says so. (2026-10-27: Ethereum bots failed every tick while the
 * reader sat on cloudflare-eth.com, which no longer serves eth_call.)
 */
export function isRealRevert(e: unknown): boolean {
  const err = e as CallErr;
  if (err?.code !== 'CALL_EXCEPTION') return false;
  if (err.revert != null || err.reason != null) return true;
  if (typeof err.data === 'string' && err.data.length > 2) return true;
  const inner = err.info?.error;
  // No RPC payload: raised locally (a decode helper, a test double); keep treating it as the contract's answer.
  if (!inner) return true;
  if (inner.code === 3) return true;
  return REVERT_TEXT.test(String(inner.message ?? ''));
}

export function isTransportError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === 'CALL_EXCEPTION') return !isRealRevert(e);
  if (code && FINAL.has(code)) return false;
  const msg = String((e as Error)?.message ?? e);
  if (/execution reverted|revert/i.test(msg) && code !== 'SERVER_ERROR') return false;
  return true;
}

/** One-line reason for logs and the UI: the RPC's own error when ethers wrapped it as "missing revert data". */
export function rpcErrorText(e: unknown): string {
  const inner = (e as CallErr)?.info?.error;
  if ((e as CallErr)?.code === 'CALL_EXCEPTION' && inner?.message) return `RPC error ${inner.code ?? ''} ${inner.message}`.replace(/\s+/g, ' ').trim().slice(0, 160);
  return String((e as Error)?.message ?? e).slice(0, 160);
}

/** Cooldown after an endpoint fails: 30 s, doubling per failure in a row, at most 10 min. */
export const ENDPOINT_COOLDOWN_MS = 30_000;
const ENDPOINT_COOLDOWN_MAX_MS = 600_000;
/** A chain failing (every endpoint) for this long raises the banner + Activity entry. RPC_ALERT_MINUTES overrides. */
export const RPC_ALERT_AFTER_MS = 3 * 60_000;
/** No request-level failure for this long (and a success since) ends the episode. */
export const RPC_RECOVER_MS = 2 * 60_000;

export interface RpcStatus { url: string; ok: boolean; lastError: string | null; latencyMs: number | null; at: number | null; switches: number }

export interface EndpointHealth { url: string; ok: boolean; failsInRow: number; lastError: string | null; lastOkAt: number | null; lastFailAt: number | null; coolUntil: number | null }

/** Chain-level health: request-level failures (every endpoint tried) in the current episode. */
export interface ChainRpcHealth {
  state: 'ok' | 'degraded' | 'down';
  /** First request-level failure of the current episode (null: healthy) */
  failingSince: number | null;
  lastFailAt: number | null;
  lastOkAt: number | null;
  /** Request-level failures in the current episode */
  failures: number;
  lastError: string | null;
  /** The banner / Activity alert is up for this episode */
  alerted: boolean;
  current: string;
  switches: number;
  endpoints: EndpointHealth[];
}

export type HealthChange = { kind: 'alert'; minutes: number; failures: number; lastError: string | null } | { kind: 'recovered'; minutes: number; failures: number };

export class FallbackReader implements ChainReader, LogReader {
  private i = 0;
  private readonly limiter: Limiter;
  readonly status: RpcStatus;
  private readonly endpoints: EndpointHealth[];
  private episode: { since: number; lastFailAt: number; failures: number; lastError: string | null; alerted: boolean } | null = null;
  private lastOkAt: number | null = null;
  constructor(
    readonly urls: string[], readonly chainId: number,
    private readonly providers: JsonRpcProvider[] = urls.map((u) => makeRpc(u, chainId)), concurrency = 4,
    private readonly now: () => number = Date.now,
  ) {
    this.limiter = new Limiter(concurrency);
    if (!urls.length) throw new Error(`chain ${chainId}: no RPC URLs`);
    this.status = { url: urls[0], ok: true, lastError: null, latencyMs: null, at: null, switches: 0 };
    this.endpoints = urls.map((url) => ({ url, ok: true, failsInRow: 0, lastError: null, lastOkAt: null, lastFailAt: null, coolUntil: null }));
  }
  get current(): JsonRpcProvider { return this.providers[this.i]; }
  get currentUrl() { return this.urls[this.i]; }

  private run<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.limiter.run(() => this.attempt(fn));
  }

  /** Next endpoint after the current one that is not cooling down; plain next when all are. */
  private rotate() {
    const n = this.providers.length, t = this.now();
    let next = (this.i + 1) % n;
    for (let k = 1; k <= n; k++) {
      const j = (this.i + k) % n;
      const cool = this.endpoints[j].coolUntil;
      if (j !== this.i && (cool == null || cool <= t)) { next = j; break; }
    }
    this.i = next;
    this.status.switches++;
    this.status.url = this.currentUrl;
  }

  private markOk(i: number) {
    const ep = this.endpoints[i], t = this.now();
    Object.assign(ep, { ok: true, failsInRow: 0, lastOkAt: t, coolUntil: null });
    this.lastOkAt = t;
  }

  private markFail(i: number, e: unknown) {
    const ep = this.endpoints[i], t = this.now();
    ep.failsInRow++;
    Object.assign(ep, {
      ok: false, lastError: rpcErrorText(e), lastFailAt: t,
      coolUntil: t + Math.min(ENDPOINT_COOLDOWN_MAX_MS, ENDPOINT_COOLDOWN_MS * 2 ** (ep.failsInRow - 1)),
    });
  }

  /** Every endpoint was tried and the request still failed on transport: a chain-level failure. */
  private noteChainFailure(e: unknown) {
    const t = this.now(), err = rpcErrorText(e);
    if (!this.episode) this.episode = { since: t, lastFailAt: t, failures: 0, lastError: err, alerted: false };
    this.episode.failures++;
    this.episode.lastFailAt = t;
    this.episode.lastError = err;
  }

  private async attempt<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    // Several RPCs: the next one at once, then short pauses. One RPC: a 429 is waited out for seconds, anything else
    // gets short pauses.
    const single = this.providers.length === 1, tries = Math.max(3, this.providers.length);
    for (let n = 0; ; n++) {
      const t0 = Date.now(), at = this.i;
      try {
        const out = await fn(this.current);
        Object.assign(this.status, { url: this.currentUrl, ok: true, latencyMs: Date.now() - t0, at: Date.now() });
        this.markOk(at);
        return out;
      } catch (e) {
        if (!isTransportError(e)) { this.markOk(at); throw e; } // the RPC answered (a real revert): it is healthy
        Object.assign(this.status, { ok: false, lastError: rpcErrorText(e), at: Date.now() });
        this.markFail(at, e);
        if (!single) this.rotate();
        const limited = single && isRateLimited(e);
        if (limited ? n >= RATE_LIMIT_WAITS_MS.length : n + 1 >= tries) { this.noteChainFailure(e); throw e; }
        const wait = limited ? RATE_LIMIT_WAITS_MS[n] : single || n + 1 >= this.providers.length ? 400 * (n + 1) : 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /** Per-chain RPC health for the status (state: ok, degraded = an endpoint is failing, down = the chain is failing). */
  health(): ChainRpcHealth {
    const ep = this.episode;
    // An endpoint that failed but hasn't been tried since stays !ok; only a recent failure marks the chain degraded.
    const t = this.now(), anyBad = this.endpoints.some((x) => !x.ok && x.lastFailAt != null && t - x.lastFailAt < RPC_RECOVER_MS);
    return {
      state: ep ? 'down' : anyBad ? 'degraded' : 'ok',
      failingSince: ep?.since ?? null, lastFailAt: ep?.lastFailAt ?? null, lastOkAt: this.lastOkAt,
      failures: ep?.failures ?? 0, lastError: ep?.lastError ?? null, alerted: ep?.alerted ?? false,
      current: this.currentUrl, switches: this.status.switches, endpoints: this.endpoints.map((x) => ({ ...x })),
    };
  }

  /**
   * Called on the poll loop. 'alert' once when the chain has kept failing for alertAfterMs; 'recovered' once when an
   * alerted episode is over (no failure for recoverMs and a success since). An episode that ends before the alert
   * just closes quietly.
   */
  checkHealth(alertAfterMs = RPC_ALERT_AFTER_MS, recoverMs = RPC_RECOVER_MS): HealthChange | null {
    const ep = this.episode, t = this.now();
    if (!ep) return null;
    const quiet = t - ep.lastFailAt >= recoverMs && this.lastOkAt != null && this.lastOkAt > ep.lastFailAt;
    if (quiet) {
      this.episode = null;
      return ep.alerted ? { kind: 'recovered', minutes: Math.max(1, Math.round((ep.lastFailAt - ep.since) / 60_000)), failures: ep.failures } : null;
    }
    if (!ep.alerted && t - ep.since >= alertAfterMs && t - ep.lastFailAt < recoverMs) {
      ep.alerted = true;
      return { kind: 'alert', minutes: Math.round((t - ep.since) / 60_000), failures: ep.failures, lastError: ep.lastError };
    }
    return null;
  }

  call(tx: { to: string; data: string; from?: string }) { return this.run((p) => p.call(tx)); }
  getBalance(a: string) { return this.run((p) => p.getBalance(a)); }
  getFeeData() { return this.run((p) => p.getFeeData()); }
  getTransactionCount(a: string, tag: 'pending' | 'latest') { return this.run((p) => p.getTransactionCount(a, tag)); }
  getTransactionReceipt(h: string) { return this.run((p) => p.getTransactionReceipt(h)) as Promise<ReceiptLike | null>; }
  getBlockNumber() { return this.run((p) => p.getBlockNumber()); }
  getBlock(n: number) { return this.run((p) => p.getBlock(n)); }
  getLogs(f: Parameters<LogReader['getLogs']>[0]) { return this.run((p) => p.getLogs(f)); }
  getCode(a: string) { return this.run((p) => p.getCode(a)); }
  getStorage(a: string, slot: string) { return this.run((p) => p.getStorage(a, slot)); }
  send(method: string, params: unknown[]) { return this.run((p) => p.send(method, params)); }

  /**
   * One eth_sendRawTransaction on the current endpoint. No rotation inside this call.
   * sendSafe rebroadcasts the same bytes itself, after hasTx, when this one times out.
   * The start index is captured here. Later reads move `this.i` and must not change which
   * endpoints this send still has to try, or how many.
   */
  private broadcastOrigin = -1;
  /** How many endpoints this send has already been given, including broadcastRaw. */
  private broadcastTried = 0;

  broadcastRaw(raw: string): Promise<unknown> {
    const at = this.i;
    this.broadcastOrigin = at;
    this.broadcastTried = 1;
    return this.limiter.run(() => this.providers[at].send('eth_sendRawTransaction', [raw]));
  }

  /**
   * The same signed bytes on the next endpoint that this send has not already tried.
   * Same hash, not a new transaction. An endpoint that timed out is not tried again.
   * Stops after one attempt per endpoint (code NO_ENDPOINT), so a broadcast cannot hold
   * the chain gate open by following the read cursor around the list.
   */
  broadcastNext(raw: string): Promise<unknown> {
    const n = this.providers.length;
    if (this.broadcastOrigin < 0) {
      this.broadcastOrigin = this.i;
      this.broadcastTried = 1;
    }
    if (this.broadcastTried >= n) return Promise.reject(Object.assign(new Error('no further endpoint'), { code: 'NO_ENDPOINT' }));
    const j = (this.broadcastOrigin + this.broadcastTried) % n;
    this.broadcastTried += 1;
    return this.limiter.run(() => this.providers[j].send('eth_sendRawTransaction', [raw]));
  }

  /** True when any endpoint already has this hash (tx or receipt). Used after "nonce too low". */
  hasTx(hash: string): Promise<boolean> {
    return this.limiter.run(async () => {
      for (let n = 0; n < this.providers.length; n++) {
        const p = this.providers[(this.i + n) % this.providers.length];
        try {
          if (await p.send('eth_getTransactionByHash', [hash])) return true;
        } catch { /* this endpoint has no answer; try the next */ }
        try {
          if (await p.send('eth_getTransactionReceipt', [hash])) return true;
        } catch { /* this endpoint has no answer; try the next */ }
      }
      return false;
    });
  }

  /** Try every endpoint in order (from the current one) until one answers; for capability-dependent calls. */
  sendEach(method: string, params: unknown[]): Promise<unknown> {
    return this.limiter.run(async () => {
      let lastErr: unknown;
      for (let n = 0; n < this.providers.length; n++) {
        const i = (this.i + n) % this.providers.length;
        try { return await this.providers[i].send(method, params); } catch (e) { lastErr = e; }
      }
      throw lastErr;
    });
  }
}
