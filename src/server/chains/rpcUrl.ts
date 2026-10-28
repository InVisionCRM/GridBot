/**
 * RPC URLs can carry an API key: in the path (https://eth-mainnet.g.alchemy.com/v2/<key>), the query (?apikey=<key>),
 * or userinfo (https://user:<key>@host). The full URL is used only to make requests. Anything shown or logged uses
 * rpcHost (scheme://host[:port]), and registerRpcUrl makes the logger and the API cut the rest wherever it appears.
 */
import { REDACT_FLOOR, redact, registerSecret, registerUrlOrigin, registerUrlPrefix } from '../bot/logger';

/** scheme://host[:port] only: no path, query, fragment or userinfo. Unparseable input shows as "[rpc]". */
export function rpcHost(url: string): string;
export function rpcHost(url: string | null | undefined): string | null;
export function rpcHost(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    const u = new URL(String(url).trim());
    return u.host ? `${u.protocol}//${u.host}` : '[rpc]';
  } catch { return '[rpc]'; }
}

/** True when the URL has anything beyond scheme://host[:port] (a path other than "/", a query, a fragment or userinfo). */
export function rpcHasSecretParts(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return !!(u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash);
  } catch { return false; }
}

/** A path segment, query value or userinfo part that could be a key: 8+ characters with a letter and a digit, or 20+. */
const looksLikeKey = (s: string) => s.length >= 20 || (s.length >= 8 && /\d/.test(s) && /[a-z]/i.test(s));

function decoded(s: string): string[] {
  try { const d = decodeURIComponent(s); return d === s ? [s] : [s, d]; } catch { return [s]; }
}

/** The parts of a URL to redact: the full URL and every key-like path segment, query value and userinfo part. */
export function rpcSecretParts(url: string): string[] {
  const raw = url.trim();
  if (!rpcHasSecretParts(raw)) return [];
  const u = new URL(raw);
  const out = new Set<string>([raw]);
  const parts = [
    u.username, u.password, u.hash.replace(/^#/, ''),
    ...u.pathname.split('/'),
    ...u.search.replace(/^\?/, '').split('&').flatMap((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv] : [kv.slice(i + 1)]; }),
  ];
  for (const p of parts) for (const v of decoded(p)) if (looksLikeKey(v)) out.add(v);
  return [...out];
}

/**
 * Register a configured RPC URL with log and API redaction. A URL with only scheme://host[:port] registers nothing.
 * Returns the display form.
 */
export function registerRpcUrl(url: string): string {
  const host = rpcHost(url);
  if (rpcHasSecretParts(url)) {
    registerUrlOrigin(host);
    const u = new URL(url.trim());
    // A message cut inside the password leaves no whole secret and no origin to match: cut from the user name on.
    if (u.username || u.password) registerUrlPrefix(`${u.protocol}//${u.username}${u.password ? ':' : '@'}`, host);
    for (const s of rpcSecretParts(url)) registerSecret(s, Math.max(REDACT_FLOOR, 8));
  }
  return host;
}

/** Every RPC URL the environment configures: RPC_URL and RPC_URL_<SLUG> (comma-separated lists). */
export function envRpcUrls(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /^RPC_URL(_[A-Z0-9_]+)?$/.test(k) && typeof v === 'string')
    .flatMap(([, v]) => v!.split(','))
    .map((s) => s.trim())
    .filter((s) => /^(https?|wss?):\/\//i.test(s));
}

type WithUrl = { url?: string; lastError?: string | null };
const safeText = (s: string | null | undefined) => (s == null ? s : redact(s));
const safeUrl = (u: string | undefined) => (typeof u === 'string' ? rpcHost(u) : u);
/** A reader's RpcStatus (or one endpoint) for the API: host-only URL, redacted error. */
export function safeRpcStatus<T extends WithUrl>(s: T | null | undefined): T | null {
  return s ? { ...s, url: safeUrl(s.url), lastError: safeText(s.lastError) } : null;
}
/** A reader's chain health for the API: host-only current URL and endpoints, redacted errors. */
export function safeRpcHealth<T extends { current?: string; lastError?: string | null; endpoints?: WithUrl[] }>(h: T | null | undefined): T | null {
  if (!h) return null;
  return {
    ...h, current: safeUrl(h.current), lastError: safeText(h.lastError),
    ...(Array.isArray(h.endpoints) && { endpoints: h.endpoints.map((e) => safeRpcStatus(e)) }),
  };
}

/** Boot: register every RPC URL the environment and the chain readers use. Call before anything logs. */
export function registerRpcUrls(env: Record<string, string | undefined>, readers: Iterable<{ urls: readonly string[] }> = []): void {
  for (const u of envRpcUrls(env)) registerRpcUrl(u);
  for (const r of readers) for (const u of r.urls) registerRpcUrl(u);
}

/** The per-chain line logged at boot. The RPC is shown as scheme://host[:port]. */
export function chainBootLine(rt: {
  cfg: { name: string; id: number; status?: string; dexes: { name: string }[]; trading: { reason?: string | null } };
  tradable: boolean; reader: { currentUrl?: string };
}, addr: string | null): string {
  const c = rt.cfg;
  return `  ${c.name} (${c.id})${c.status === 'testnet' ? ' TESTNET' : ''} · ${rt.tradable ? c.dexes.map((d) => d.name).join(', ') : `trading unavailable — ${c.trading.reason ?? 'no DEX'}`} · RPC ${rt.reader.currentUrl ? rpcHost(rt.reader.currentUrl) : '?'} · ${addr ? `signer ${addr}` : 'paper only'}`;
}
