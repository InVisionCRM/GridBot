/**
 * Logins: scrypt password hashes, and a signed session cookie (HMAC under a key from FRIENDS_SECRET) that survives
 * restarts. A friend's `session` number is part of the signature, so changing the password or removing the friend ends
 * every login they had. The owner's cookie is the same shape with role `host` and subject HOST_ID, which is not a
 * friend id, so an invite can never mint it and a friend cookie can never be read as the owner.
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
/** A login lasts 30 days and is renewed when someone uses the app with under 15 days left. */
export const SESSION_MS = 30 * 86_400_000;
export const RENEW_MS = 15 * 86_400_000;

/** Cookie subject for the owner. Friend ids are UUIDs, so this never collides with one. */
export const HOST_ID = 'host';

/** f = friend id, or HOST_ID when role is host. s = session number. e = expiry (ms). */
export interface Session { f: string; s: number; e: number; role?: 'host' }

const b64 = (b: Buffer) => b.toString('base64url');
const mac = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest();

export function signSession(key: Buffer, s: Session): string {
  const body = b64(Buffer.from(JSON.stringify(s)));
  return `${body}.${b64(mac(key, body))}`;
}

/** The session in a cookie value, or null when it is missing, forged, the wrong shape, or expired. */
export function readSession(key: Buffer, value: string | undefined, now: number): Session | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot), sig = value.slice(dot + 1);
  if (!body || !sig || sig.includes('.')) return null;
  const want = mac(key, body), got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let s: Session;
  try { s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session; } catch { return null; }
  if (typeof s.f !== 'string' || !Number.isInteger(s.s) || !(typeof s.e === 'number' && s.e > now)) return null;
  if (s.role == null) return { f: s.f, s: s.s, e: s.e };
  if (s.role !== 'host' || s.f !== HOST_ID) return null;
  return { f: HOST_ID, s: s.s, e: s.e, role: 'host' };
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
