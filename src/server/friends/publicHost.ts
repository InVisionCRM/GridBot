/**
 * Which public names may open the friends' gateway (tailscale serve sends Host: <mac>.<tailnet>.ts.net).
 * Loopback is always allowed. The host app on 3847 does not use this: it still accepts localhost only.
 */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function hostnameOf(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  try {
    const u = s.includes('://') ? new URL(s) : new URL(`https://${s}`);
    return u.hostname ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Hostnames from the Tools → Friends address and from GATEWAY_HOST (either may be a bare name or an https URL). */
export function configuredHosts(address: string | null | undefined, gatewayHost: string | null | undefined): string[] {
  const out: string[] = [];
  for (const h of [hostnameOf(address), hostnameOf(gatewayHost)]) if (h && !out.includes(h)) out.push(h);
  return out;
}

/** Origins a gateway change may come from: the saved address, https on each configured host, and the gateway's own loopback. */
export function configuredOrigins(address: string | null | undefined, gatewayHost: string | null | undefined, port: number): string[] {
  const origins = new Set<string>();
  if (address) origins.add(address);
  for (const h of configuredHosts(address, gatewayHost)) origins.add(`https://${h}`);
  origins.add(`http://127.0.0.1:${port}`);
  origins.add(`http://localhost:${port}`);
  return [...origins];
}

/**
 * The Host header tailscale serve (or a local browser) used. X-Forwarded-Host is not consulted: a client can set it.
 * A port is ignored, so `mac.ts.net:443` matches `mac.ts.net`.
 */
export function requestHostAllowed(hostHeader: string | undefined, publicHosts: readonly string[]): boolean {
  const raw = (hostHeader ?? '').trim().toLowerCase();
  if (!raw || raw.includes('/') || raw.includes('@') || raw.includes(',')) return false;
  if (LOCAL_HOST.test(raw)) return true;
  const name = raw.endsWith(']') ? raw : raw.replace(/:\d+$/, '');
  return publicHosts.some((h) => h === name);
}

// ── Tailscale Funnel vs tailnet ─────────────────────────────────────────
// What `tailscale serve` / `tailscale funnel` (HTTPS proxy mode) set on the request it forwards to 127.0.0.1:3850,
// from tailscale/ipn/ipnlocal/serve.go (addProxyForwardedHeaders, addTailscaleIdentityHeaders):
//   both:    Host = the public name (<mac>.<tailnet>.ts.net), X-Forwarded-Host = the same, X-Forwarded-Proto = https,
//            X-Forwarded-For = the client's address (Set, not appended: a client-sent value is replaced).
//   Funnel:  Tailscale-Funnel-Request: ?1, and no identity headers. X-Forwarded-For is the client's public IP.
//   tailnet: Tailscale-User-Login / -Name / -Profile-Pic (none for tagged devices), Tailscale-Headers-Info,
//            X-Forwarded-For = the device's tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48).
// Serve deletes client-sent Tailscale-* headers first, so Tailscale-Funnel-Request can't be removed by the client.
// Both are checked: either one marks the request as from the internet.

/** A loopback or Tailscale (CGNAT 100.64.0.0/10, ULA fd7a:115c:a1e0::/48) address. */
export function isLocalOrTailnetIp(raw: string | null | undefined): boolean {
  let ip = (raw ?? '').trim().toLowerCase();
  if (!ip) return false;
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  return /^fd7a:115c:a1e0:/.test(ip);
}

/**
 * The request came through Tailscale Funnel (the public internet), not from the tailnet or this computer: Funnel's
 * own marker, or a forwarded client address that is neither loopback nor a tailnet address. A request from
 * another address on the socket (the gateway listens on 127.0.0.1, so only if that ever changes) counts too.
 */
export function viaFunnel(headers: Record<string, string | string[] | undefined>, remoteAddress?: string | null): boolean {
  if (headers['tailscale-funnel-request'] != null) return true;
  const xff = headers['x-forwarded-for'];
  if (xff != null) {
    const all = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (!all.length || all.some((ip) => !isLocalOrTailnetIp(ip))) return true;
  }
  if (remoteAddress && !isLocalOrTailnetIp(remoteAddress)) return true;
  return false;
}

export const FUNNEL_OWNER_REFUSED = 'The owner log-in works only from your tailnet or this computer, not through Tailscale Funnel. Open the address with the Tailscale app on.';
