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
