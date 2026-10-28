/**
 * The host's friends: who is invited, who has signed up, their password hash, their sealed key and their copy's port
 * (data/friends/friends.json). Invite links work once, for INVITE_MS; only a hash of the token is kept. Wrong passwords
 * lock a name for LOCK_MS after LOCK_AFTER tries, and every login waits while more than GLOBAL_FAILS_PER_MIN failed in
 * the last minute (the gateway is on the internet).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Store } from '../bot/store';
import { checkPassword, hashPassword, type PassHash, type Session } from './auth';
import { cleanKey, keyAddress, openKey, sealKey, type SealedKey } from './vault';

/** friendId = null: a new friend signs up; set: that friend sets a new password (they forgot theirs). */
export interface Invite { id: string; tokenHash: string; name: string; friendId: string | null; createdAt: number; expiresAt: number }
export interface Friend {
  id: string; name: string; pass: PassHash; key: SealedKey | null;
  /** The key's public address (null = no key: paper only) */
  address: string | null;
  port: number; createdAt: number; lastLoginAt: number | null;
  /** Part of every session cookie: bumping it logs the friend out everywhere */
  session: number;
  /** Stopped by the host: not started with the server */
  stopped: boolean;
}
export interface FriendsFile { v: 1; host: { name: string; address: string | null }; invites: Invite[]; friends: Friend[] }

export const INVITE_MS = 7 * 86_400_000;
export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60_000;
export const GLOBAL_FAILS_PER_MIN = 30;

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
/** Names log in without regard to case or extra spaces. */
export const loginOf = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Each lock after the first doubles (15 min, 30 min, 1 h …) up to this. */
export const LOCK_MAX_MS = 24 * 3600_000;
/** A name with no failure for this long starts again at the first lock length. */
export const STRIKE_RESET_MS = 24 * 3600_000;
/** Most names the counters file keeps (oldest dropped): random names can't grow it without bound. */
export const GATE_MAX_NAMES = 2000;

/** data/friends/login-limits.json. Names and owner identities are sha256 hashes; no password, hash or cookie. */
export interface LoginGateFile {
  v: 1;
  /** sha256(login) → failures since the last lock, lock end, locks so far (backoff), last failure */
  names: Record<string, { n: number; until: number; strikes: number; last: number }>;
  /** failure times in the last minute (the all-logins pause) */
  recent: number[];
  /** sha256 of Tailscale-User-Login values that logged in as the owner (plus HOST_TAILNET_LOGINS) */
  ownerIds: string[];
  /** The owner session number (HOST_SESSION) ownerIds were learned under; a different one clears them */
  ownerIdsSession?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Tailscale login names compare without case or spaces. */
export const tailnetIdOf = (raw: string) => raw.trim().toLowerCase();

/**
 * Shared by friend and owner log-ins so one burst of guesses hits one limit: LOCK_AFTER wrong tries lock that name,
 * for LOCK_MS the first time and twice as long each time after (up to LOCK_MAX_MS; back to LOCK_MS after a quiet
 * STRIKE_RESET_MS), and GLOBAL_FAILS_PER_MIN failures in a minute pause every login. With a store the counters survive
 * a restart (atomic JsonStore write). `trusted` (the owner from a known device, this computer or their own tailnet
 * login, decided by the gateway) skips the lock and the pause; the password is still checked and a wrong one still
 * counts.
 */
export class LoginGate {
  private f: LoginGateFile;
  constructor(private readonly now: () => number = Date.now, private readonly store?: Store<LoginGateFile>) {
    let loaded: LoginGateFile | null = null;
    try { loaded = store?.load() ?? null; } catch { loaded = null; }
    this.f = loaded?.v === 1
      ? { v: 1, names: loaded.names ?? {}, recent: loaded.recent ?? [], ownerIds: loaded.ownerIds ?? [], ...(loaded.ownerIdsSession != null ? { ownerIdsSession: loaded.ownerIdsSession } : {}) }
      : { v: 1, names: {}, recent: [], ownerIds: [] };
  }

  private save() {
    if (!this.store) return;
    const now = this.now();
    this.f.recent = this.f.recent.filter((t) => t > now - 60_000);
    const keys = Object.keys(this.f.names);
    for (const k of keys) { const e = this.f.names[k]; if (e.until <= now && now - e.last > STRIKE_RESET_MS) delete this.f.names[k]; }
    const left = Object.entries(this.f.names);
    if (left.length > GATE_MAX_NAMES) {
      left.sort((a, b) => a[1].last - b[1].last);
      for (const [k] of left.slice(0, left.length - GATE_MAX_NAMES)) delete this.f.names[k];
    }
    try { this.store.save(this.f); } catch { /* counters stay in memory; the next save retries */ }
  }

  /** Lock length for the k-th lock (1-based). */
  static lockMs(strikes: number): number {
    return Math.min(LOCK_MAX_MS, LOCK_MS * 2 ** Math.max(0, strikes - 1));
  }

  /** ms until this name may try again (0 = not locked). */
  lockedFor(login: string): number {
    const e = this.f.names[sha(login)];
    return e ? Math.max(0, e.until - this.now()) : 0;
  }

  begin(login: string, o: { trusted?: boolean } = {}) {
    if (o.trusted) return;
    const now = this.now();
    this.f.recent = this.f.recent.filter((t) => t > now - 60_000);
    if (this.f.recent.length >= GLOBAL_FAILS_PER_MIN) throw new Error('Too many wrong passwords just now. Wait a minute and try again.');
    const wait = this.lockedFor(login);
    if (wait > 0) throw new Error(`Too many wrong passwords for this name. Try again in ${Math.ceil(wait / 60_000)} min.`);
  }

  fail(login: string) {
    const now = this.now();
    this.f.recent.push(now);
    const k = sha(login);
    const l = this.f.names[k] ?? { n: 0, until: 0, strikes: 0, last: 0 };
    if (l.last && now - l.last > STRIKE_RESET_MS && l.until <= now) { l.strikes = 0; l.n = 0; }
    l.n++;
    l.last = now;
    if (l.n >= LOCK_AFTER) { l.n = 0; l.strikes++; l.until = now + LoginGate.lockMs(l.strikes); }
    this.f.names[k] = l;
    this.save();
  }

  ok(login: string) {
    const k = sha(login);
    if (!(k in this.f.names)) return;
    delete this.f.names[k];
    this.save();
  }

  /**
   * The owner's current session number (HOST_SESSION; `npm run host:password` bumps it). Learned tailnet logins from
   * another (or an unknown) session number are forgotten: a password change revokes them, like the owner's device and
   * session cookies. HOST_TAILNET_LOGINS in .env is not affected. The failure counters are kept.
   */
  ownerCredential(session: number) {
    if (this.f.ownerIdsSession === session) return;
    this.f.ownerIds = [];
    this.f.ownerIdsSession = session;
    this.save();
  }

  /** The owner's own Tailscale login (Tailscale-User-Login): its tailnet devices skip the lock. */
  trustOwnerId(raw: string) {
    const h = sha(tailnetIdOf(raw));
    if (!raw.trim() || this.f.ownerIds.includes(h)) return;
    this.f.ownerIds.push(h);
    this.save();
  }
  isOwnerId(raw: string | null | undefined): boolean {
    return !!raw?.trim() && this.f.ownerIds.includes(sha(tailnetIdOf(raw)));
  }
}

export function cleanName(raw: string): string {
  const n = raw.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N} ._'-]{2,32}$/u.test(n)) throw new Error('A name is 2 to 32 letters, numbers, spaces, dots or dashes.');
  return n;
}

/** Where friends open the app: an https origin with no path (`tailscale serve status` prints https://computer.tailnet.ts.net). */
export function cleanAddress(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error('Paste the whole address, starting with https://'); }
  if (u.protocol !== 'https:') throw new Error('The address must start with https:// (`tailscale serve status` prints one).');
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('Paste only the address, like https://your-computer.your-tailnet.ts.net');
  return u.origin;
}

export class Friends {
  private f: FriendsFile;
  private readonly gate: LoginGate;

  constructor(
    private readonly store: Store<FriendsFile>, private readonly secret: Buffer,
    private readonly o: { now?: () => number; hostAddresses?: () => string[]; gate?: LoginGate; reserved?: (login: string) => boolean } = {},
  ) {
    this.f = store.load() ?? { v: 1, host: { name: '', address: null }, invites: [], friends: [] };
    this.gate = o.gate ?? new LoginGate(() => this.now());
  }

  private now() { return (this.o.now ?? Date.now)(); }
  private save() { this.store.save(this.f); }

  host() { return { ...this.f.host }; }
  setHost(p: { name?: string; address?: string }) {
    if (p.name != null) this.f.host.name = cleanName(p.name);
    if (p.address != null) this.f.host.address = cleanAddress(p.address);
    this.save();
  }

  list(): readonly Friend[] { return this.f.friends; }
  get(id: string): Friend {
    const f = this.f.friends.find((x) => x.id === id);
    if (!f) throw new Error('No such friend.');
    return f;
  }
  /** A signed session is still good: its friend exists and hasn't been logged out since. */
  current(s: Session): Friend | null {
    const f = this.f.friends.find((x) => x.id === s.f);
    return f && f.session === s.s ? f : null;
  }

  // ── Invites ─────────────────────────────────────────────────────────
  invites(): Invite[] {
    const now = this.now();
    if (this.f.invites.some((i) => i.expiresAt <= now)) { this.f.invites = this.f.invites.filter((i) => i.expiresAt > now); this.save(); }
    return this.f.invites;
  }
  /** The link is shown once (only its hash is kept). */
  createInvite(name: string): { invite: Invite; link: string } {
    const n = cleanName(name);
    if (this.o.reserved?.(loginOf(n))) throw new Error('That name is reserved for the owner of this computer.');
    return this.link(n, null);
  }
  /** A one-time link for a friend who forgot their password. Their copy, bots and key stay as they are. */
  createReset(friendId: string): { invite: Invite; link: string } {
    const f = this.get(friendId);
    const out = this.link(f.name, f.id);
    this.f.invites = this.f.invites.filter((i) => i.friendId !== f.id || i.id === out.invite.id);
    this.save();
    return out;
  }
  private link(name: string, friendId: string | null) {
    if (!this.f.host.name) throw new Error('Add your name first: friends see who invited them.');
    if (!this.f.host.address) throw new Error('Add the address friends open first (from `tailscale serve status`).');
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    const invite: Invite = { id: randomUUID(), tokenHash: hashToken(token), name, friendId, createdAt: now, expiresAt: now + INVITE_MS };
    this.f.invites.push(invite);
    this.save();
    return { invite, link: `${this.f.host.address}/invite/${token}` };
  }
  cancelInvite(id: string) {
    const n = this.f.invites.length;
    this.f.invites = this.f.invites.filter((i) => i.id !== id);
    if (this.f.invites.length === n) throw new Error('No such invite.');
    this.save();
  }
  inviteFor(token: string): Invite | null {
    const h = hashToken(token);
    return this.invites().find((i) => i.tokenHash === h) ?? null;
  }

  /** Uses up the invite. The port is chosen by the caller (a free one, see copies.ts). */
  async signUp(token: string, p: { name: string; password: string; key: string }, port: number): Promise<Friend> {
    const used = 'This invite link has been used or has expired. Ask for a new one.';
    if (this.inviteFor(token)?.friendId !== null) throw new Error(used);
    const pass = await hashPassword(p.password);
    // Every check after the wait, so two taps on one link can't both get through.
    const inv = this.inviteFor(token);
    if (!inv || inv.friendId !== null) throw new Error(used);
    const name = cleanName(p.name);
    if (this.o.reserved?.(loginOf(name))) throw new Error('That name is reserved for the owner of this computer.');
    if (this.f.friends.some((x) => loginOf(x.name) === loginOf(name))) throw new Error('That name is taken. Pick another.');
    const id = randomUUID();
    const sealed = p.key.trim() ? this.sealed(id, p.key) : { key: null, address: null };
    const f: Friend = { id, name, pass, ...sealed, port, createdAt: this.now(), lastLoginAt: this.now(), session: 1, stopped: false };
    this.f.friends.push(f);
    this.f.invites = this.f.invites.filter((i) => i.id !== inv.id);
    this.save();
    return f;
  }

  /** A reset link: the friend's new password; every other login of theirs ends. */
  async resetPassword(token: string, password: string): Promise<Friend> {
    const used = 'This link has been used or has expired. Ask for a new one.';
    if (!this.inviteFor(token)?.friendId) throw new Error(used);
    const pass = await hashPassword(password);
    const inv = this.inviteFor(token);
    if (!inv?.friendId) throw new Error(used);
    const f = this.get(inv.friendId);
    Object.assign(f, { pass, session: f.session + 1, lastLoginAt: this.now() });
    this.f.invites = this.f.invites.filter((i) => i.id !== inv.id);
    this.save();
    return f;
  }

  // ── Logins ──────────────────────────────────────────────────────────
  /** Checked against when the name doesn't exist, so a wrong name takes as long as a wrong password. */
  private dummy: Promise<PassHash> | null = null;

  async login(name: string, password: string): Promise<Friend> {
    const login = loginOf(name);
    this.gate.begin(login);
    const f = this.f.friends.find((x) => loginOf(x.name) === login);
    const ok = password.length <= 256 && await checkPassword(password, f?.pass ?? await (this.dummy ??= hashPassword('not-a-password')));
    if (!f || !ok) {
      this.gate.fail(login);
      throw new Error('Wrong name or password.');
    }
    this.gate.ok(login);
    f.lastLoginAt = this.now();
    this.save();
    return f;
  }

  /** Logs out every other device too (new session number); the caller signs a new cookie for this one. */
  async changePassword(id: string, current: string, next: string): Promise<Friend> {
    const f = this.get(id);
    if (!(await checkPassword(current, f.pass))) throw new Error('The current password is wrong.');
    f.pass = await hashPassword(next);
    f.session++;
    this.save();
    return f;
  }

  // ── Keys ────────────────────────────────────────────────────────────
  private sealed(id: string, raw: string): { key: SealedKey; address: string } {
    const key = cleanKey(raw);
    const address = keyAddress(key);
    const lower = address.toLowerCase();
    if ((this.o.hostAddresses?.() ?? []).some((a) => a.toLowerCase() === lower)) throw new Error('That is the host\'s own key. Use a key of your own.');
    if (this.f.friends.some((x) => x.id !== id && x.address?.toLowerCase() === lower)) throw new Error('Another friend already uses this key. Each copy needs its own.');
    return { key: sealKey(this.secret, id, key), address };
  }
  /** null removes the key (paper only). The caller checks that the copy has no live bots first. */
  setKey(id: string, raw: string | null): Friend {
    const f = this.get(id);
    Object.assign(f, raw == null ? { key: null, address: null } : this.sealed(id, raw));
    this.save();
    return f;
  }
  /** The friend's key, opened to start their copy. */
  key(id: string): string | null {
    const f = this.get(id);
    return f.key ? openKey(this.secret, f.id, f.key) : null;
  }

  setStopped(id: string, stopped: boolean) { this.get(id).stopped = stopped; this.save(); }
  remove(id: string) {
    this.get(id);
    this.f.friends = this.f.friends.filter((x) => x.id !== id);
    this.f.invites = this.f.invites.filter((i) => i.friendId !== id);
    this.save();
  }
}
