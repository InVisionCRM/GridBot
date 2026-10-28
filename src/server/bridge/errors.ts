export type BridgeErrorCode = 'http' | 'rate_limit' | 'invalid' | 'timeout';

export class BridgeError extends Error {
  readonly provider: string;
  readonly code: BridgeErrorCode;
  constructor(provider: string, code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.provider = provider;
    this.code = code;
  }
}

/** Drop quote keys and query strings. A URL in an error keeps host and path only. */
export function sanitizeText(msg: string, secrets: readonly string[]): string {
  let out = msg;
  for (const s of secrets) {
    if (s.length < 8) continue;
    out = out.split(s).join('[REDACTED]');
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join('[REDACTED]');
  }
  out = out.replace(/https?:\/\/[^\s'")]+/gi, (url) => {
    const cut = url.split('?')[0].split('#')[0];
    try {
      const u = new URL(cut);
      return `${u.host}${u.pathname}`;
    } catch {
      return '[url]';
    }
  });
  return out;
}
