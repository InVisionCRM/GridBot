/**
 * Read-side provider with RPC fallback: requests go to the current endpoint; on a transport-level failure
 * (timeout, 429/5xx, connection refused, …) it rotates to the next endpoint and retries once per endpoint.
 * Reverts (CALL_EXCEPTION) are real answers and are never retried on another RPC.
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

const FINAL = new Set(['CALL_EXCEPTION', 'INVALID_ARGUMENT', 'NUMERIC_FAULT', 'INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED']);

export function isTransportError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code && FINAL.has(code)) return false;
  const msg = String((e as Error)?.message ?? e);
  if (/execution reverted|revert/i.test(msg) && code !== 'SERVER_ERROR') return false;
  return true;
}

export interface RpcStatus { url: string; ok: boolean; lastError: string | null; latencyMs: number | null; at: number | null; switches: number }

export class FallbackReader implements ChainReader, LogReader {
  private i = 0;
  private readonly limiter: Limiter;
  readonly status: RpcStatus;
  constructor(readonly urls: string[], readonly chainId: number, private readonly providers: JsonRpcProvider[] = urls.map((u) => makeRpc(u, chainId)), concurrency = 4) {
    this.limiter = new Limiter(concurrency);
    if (!urls.length) throw new Error(`chain ${chainId}: no RPC URLs`);
    this.status = { url: urls[0], ok: true, lastError: null, latencyMs: null, at: null, switches: 0 };
  }
  get current(): JsonRpcProvider { return this.providers[this.i]; }
  get currentUrl() { return this.urls[this.i]; }

  private run<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.limiter.run(() => this.attempt(fn));
  }

  private async attempt<T>(fn: (p: JsonRpcProvider) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    // Single-RPC chains get a short backoff instead of rotation (public endpoints 429 on bursts).
    const tries = Math.max(3, this.providers.length);
    for (let n = 0; n < tries; n++) {
      if (n >= this.providers.length || (n > 0 && this.providers.length === 1)) await new Promise((r) => setTimeout(r, 400 * n));
      const t0 = Date.now();
      try {
        const out = await fn(this.current);
        Object.assign(this.status, { url: this.currentUrl, ok: true, latencyMs: Date.now() - t0, at: Date.now() });
        return out;
      } catch (e) {
        if (!isTransportError(e)) throw e;
        lastErr = e;
        Object.assign(this.status, { ok: false, lastError: String((e as Error)?.message ?? e).slice(0, 160), at: Date.now() });
        if (this.providers.length > 1) { this.i = (this.i + 1) % this.providers.length; this.status.switches++; this.status.url = this.currentUrl; }
      }
    }
    throw lastErr;
  }

  call(tx: { to: string; data: string }) { return this.run((p) => p.call(tx)); }
  getBalance(a: string) { return this.run((p) => p.getBalance(a)); }
  getFeeData() { return this.run((p) => p.getFeeData()); }
  getTransactionCount(a: string, tag: 'pending') { return this.run((p) => p.getTransactionCount(a, tag)); }
  getTransactionReceipt(h: string) { return this.run((p) => p.getTransactionReceipt(h)) as Promise<ReceiptLike | null>; }
  getBlockNumber() { return this.run((p) => p.getBlockNumber()); }
  getBlock(n: number) { return this.run((p) => p.getBlock(n)); }
  getLogs(f: Parameters<LogReader['getLogs']>[0]) { return this.run((p) => p.getLogs(f)); }
  getCode(a: string) { return this.run((p) => p.getCode(a)); }
  getStorage(a: string, slot: string) { return this.run((p) => p.getStorage(a, slot)); }
  send(method: string, params: unknown[]) { return this.run((p) => p.send(method, params)); }

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
