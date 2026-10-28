/** Fetch helper for the local API (JSON in/out). */
/**
 * A refused request. `code` is set for a LIVE start's safety block: SAFETY_INCOMPLETE (the check couldn't complete;
 * `canStartAnyway` says the page may offer Start anyway) or SAFETY_BLOCKED (it completed and failed: no bypass).
 */
export class HttpError extends Error {
  readonly code: string | null;
  readonly canStartAnyway: boolean;
  constructor(msg: string, readonly status: number, body: { code?: unknown; canStartAnyway?: unknown } = {}) {
    super(msg);
    this.code = typeof body.code === 'string' ? body.code : null;
    this.canStartAnyway = body.canStartAnyway === true;
  }
}
/** Start anyway is on offer only for a check that couldn't complete, and only when the server says so. */
export const offersStartAnyway = (e: unknown): e is HttpError => e instanceof HttpError && e.code === 'SAFETY_INCOMPLETE' && e.canStartAnyway;

export async function http<T = any>(path: string, method = 'GET', body?: unknown, from?: string): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (from) headers['X-GridBot-From'] = from;
  const r = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  // A friend's login ran out (the friends' gateway answers 401 with login: true): back to its log-in page.
  if (r.status === 401 && j.login === true) window.location.assign('/login');
  if (!r.ok) throw new HttpError(j.error ?? `HTTP ${r.status}`, r.status, j);
  return j as T;
}
export const botApi = (p: string, method = 'GET', body?: unknown, from?: string) => http(`/api/bot/${p}`, method, body, from);
