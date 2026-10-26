/** Fetch helper for the local API (JSON in/out). */
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
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}
export const botApi = (p: string, method = 'GET', body?: unknown, from?: string) => http(`/api/bot/${p}`, method, body, from);
