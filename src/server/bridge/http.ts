import { BridgeError, sanitizeText } from './errors';
import type { RateLimiter } from './rateLimit';
import type { BridgeLog } from './types';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResult {
  status: number;
  body: unknown;
  retryAfterMs: number | null;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResult>;

export const HTTP_MAX_ATTEMPTS = 3;

function retryWait(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 5_000) return retryAfterMs;
  return Math.min(5_000, 200 * 2 ** attempt);
}

function retryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function failureText(provider: string, status: number, body: unknown, secrets: readonly string[]): string {
  let detail = '';
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) detail = sanitizeText(m.trim().slice(0, 180), secrets);
  }
  const base = `${provider}: HTTP ${status}`;
  return detail ? `${base}: ${detail}` : base;
}

function throwLogged(provider: string, code: BridgeError['code'], message: string, log?: BridgeLog): never {
  log?.('error', message);
  throw new BridgeError(provider, code, message);
}

/**
 * One JSON call with a timeout owned by the HttpClient, a per-provider rate limit, and retries.
 * Only 429 and 5xx are retried. Errors never include a query string or a quote key.
 */
export async function requestJson(o: {
  provider: string;
  limiter: RateLimiter;
  http: HttpClient;
  sleep: (ms: number) => Promise<void>;
  secrets: readonly string[];
  log?: BridgeLog;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}): Promise<unknown> {
  for (const s of o.secrets) {
    if (s && o.url.includes(s)) throwLogged(o.provider, 'invalid', `${o.provider}: request was refused`, o.log);
  }
  let last = '';
  for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt++) {
    o.limiter.take(o.provider);
    let res: HttpResult;
    try {
      res = await o.http({ url: o.url, method: o.method, headers: o.headers, body: o.body });
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      const raw = e instanceof Error ? e.message : 'request failed';
      if (raw === 'timed out') throwLogged(o.provider, 'timeout', `${o.provider}: timed out`, o.log);
      const cleaned = raw === 'network request failed' ? '' : sanitizeText(raw, o.secrets);
      const msg = cleaned && cleaned !== 'network request failed' ? `${o.provider}: request failed: ${cleaned}` : `${o.provider}: request failed`;
      throwLogged(o.provider, 'http', msg, o.log);
    }
    if (res.status >= 200 && res.status < 300) {
      if (res.body === null || res.body === undefined) throwLogged(o.provider, 'invalid', `${o.provider}: response is missing`, o.log);
      return res.body;
    }
    last = failureText(o.provider, res.status, res.body, o.secrets);
    if (retryable(res.status) && attempt < HTTP_MAX_ATTEMPTS - 1) {
      await o.sleep(retryWait(attempt, res.retryAfterMs));
      continue;
    }
    throwLogged(o.provider, 'http', last, o.log);
  }
  throwLogged(o.provider, 'http', last || `${o.provider}: request failed`, o.log);
}

/** fetch wrapper used outside tests. Redirects are refused. The thrown text never includes the URL. */
export function createFetchHttp(fetchImpl: typeof fetch, timeoutMs: number): HttpClient {
  return async (req) => {
    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new Error('timed out');
      throw new Error('network request failed');
    }
    const retry = res.headers.get('retry-after');
    const retryAfterMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : null;
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text) as unknown; } catch { body = null; }
    }
    return { status: res.status, body, retryAfterMs };
  };
}

export function baseHeaders(keyHeader?: { name: string; value: string }): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'GridBot' };
  if (keyHeader) headers[keyHeader.name] = keyHeader.value;
  return headers;
}

/** A quote key is a single header token. The value is never put in an error. */
export function optionalKey(raw: string | undefined, provider: string): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim();
  if (!v) return undefined;
  if (v !== raw || !/^[A-Za-z0-9._~+/=-]{8,256}$/.test(v)) {
    throw new BridgeError(provider, 'invalid', `${provider}: quote key was rejected`);
  }
  return v;
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
