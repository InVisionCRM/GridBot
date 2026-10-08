/** Fetch helper for the local API (JSON in/out). */
export async function http<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(path, {
    method,
    headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}
export const botApi = (p: string, method = 'GET', body?: unknown) => http(`/api/bot/${p}`, method, body);
