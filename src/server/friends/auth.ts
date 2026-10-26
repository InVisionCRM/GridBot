/**
 * Friends' logins: scrypt password hashes, and a signed session cookie (HMAC under a key from FRIENDS_SECRET) that
 * survives host restarts. A friend's `session` number is part of the signature, so changing the password or removing
 * the friend ends every login they had.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface PassHash { salt: string; hash: string }

/** About 0.1 s per check; run off the main thread (async scrypt) so the bots keep ticking. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const MIN_PASSWORD = 8;

function derive(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw, salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(pw: string): Promise<PassHash> {
  if (pw.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the password.`);
  const salt = randomBytes(16);
  return { salt: salt.toString('base64'), hash: (await derive(pw, salt)).toString('base64') };
}

export async function checkPassword(pw: string, h: PassHash): Promise<boolean> {
  const want = Buffer.from(h.hash, 'base64');
  const got = await derive(pw, Buffer.from(h.salt, 'base64'));
  return got.length === want.length && timingSafeEqual(got, want);
}

export const COOKIE = 'gb_session';
/** A login lasts 30 days and is renewed when a friend uses the app with under 15 days left. */
export const SESSION_MS = 30 * 86_400_000;
export const RENEW_MS = 15 * 86_400_000;

/** f = friend id, s = their session number, e = expiry (ms) */
export interface Session { f: string; s: number; e: number }

const b64 = (b: Buffer) => b.toString('base64url');
const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest();

export function signSession(key: Buffer, s: Session): string {
  const body = b64(Buffer.from(JSON.stringify(s)));
  return `${body}.${b64(mac(key, body))}`;
}

/** The session in a cookie value, or null when it is missing, forged or expired. */
export function readSession(key: Buffer, value: string | undefined, now: number): Session | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const want = mac(key, body), got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
  return typeof s.f === 'string' && Number.isInteger(s.s) && s.e > now ? s : null;
}

/** One cookie out of a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** HttpOnly + Secure (Funnel serves https; browsers also keep Secure cookies on http://127.0.0.1) + SameSite=Lax. */
export function sessionCookie(value: string | null, maxAgeMs = SESSION_MS): string {
  return `${COOKIE}=${value ?? ''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? Math.floor(maxAgeMs / 1000) : 0}`;
}
