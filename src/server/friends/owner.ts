/**
 * The owner's login on the gateway: a scrypt hash kept outside data/friends (HOST_PASSWORD_HASH in .env).
 * An invite cannot create this login, and its cookie is a different subject (`host`) from any friend's.
 */
import { loginOf, LoginGate, tailnetIdOf } from './accounts';
import { checkPassword, HOST_ID, type PassHash, type Session } from './auth';

export const OWNER_MIN_PASSWORD = 12;

export interface OwnerConfig {
  login: string; pass: PassHash; session: number;
  /** HOST_TAILNET_LOGINS: the owner's Tailscale login(s) (Tailscale-User-Login), trusted from the start */
  tailnetLogins?: string[];
}

/** salt.hash, both standard base64, as written by npm run host:password. */
export function formatPassHash(h: PassHash): string {
  return `${h.salt}.${h.hash}`;
}

export function parsePassHash(raw: string): PassHash {
  const bad = 'HOST_PASSWORD_HASH in .env is not a password hash. Run npm run host:password again.';
  const v = raw.trim();
  const i = v.indexOf('.');
  if (i <= 0 || v.includes('.', i + 1)) throw new Error(bad);
  const salt = v.slice(0, i), hash = v.slice(i + 1);
  if (!/^[A-Za-z0-9+/]+=*$/.test(salt) || !/^[A-Za-z0-9+/]+=*$/.test(hash)) throw new Error(bad);
  const sb = Buffer.from(salt, 'base64'), hb = Buffer.from(hash, 'base64');
  if (sb.length !== 16 || hb.length !== 32) throw new Error(bad);
  return { salt: sb.toString('base64'), hash: hb.toString('base64') };
}

/** Empty means the default login name `owner`. */
export function ownerLoginFrom(raw: string | undefined): string {
  const n = (raw ?? '').trim();
  return loginOf(n || 'owner');
}

export class OwnerLogin {
  constructor(private readonly cfg: OwnerConfig | null, private readonly gate: LoginGate) {}

  get enabled(): boolean { return this.cfg != null; }
  /** Normalized login, or null when no owner password is set. */
  get loginName(): string | null { return this.cfg?.login ?? null; }

  isOwnerName(name: string): boolean {
    return !!this.cfg && loginOf(name) === this.cfg.login;
  }

  /** The signed cookie's subject. Caller checks the name is the owner's first. */
  /**
   * A device of the owner's own tailnet login: configured (HOST_TAILNET_LOGINS) or learned from an earlier owner log-in.
   * Only meaningful for a request tailscale serve forwarded (it deletes client-sent Tailscale-* headers).
   */
  isOwnerTailnet(id: string | null | undefined): boolean {
    if (!id?.trim()) return false;
    return (this.cfg?.tailnetLogins ?? []).some((x) => tailnetIdOf(x) === tailnetIdOf(id)) || this.gate.isOwnerId(id);
  }

  /**
   * `trusted` (decided by the gateway: a known owner device, this computer, or the owner's own tailnet login) skips the
   * lockout and the all-logins pause, so guesses by someone else can't lock the owner out. The password is always
   * checked, and a wrong one always counts. `tailnetId` is remembered after a correct password.
   */
  async login(name: string, password: string, o: { trusted?: boolean; tailnetId?: string | null } = {}): Promise<{ id: typeof HOST_ID; session: number }> {
    if (!this.cfg || !this.isOwnerName(name)) throw new Error('Wrong name or password.');
    const login = this.cfg.login;
    this.gate.begin(login, { trusted: o.trusted });
    const ok = password.length <= 256 && await checkPassword(password, this.cfg.pass);
    if (!ok) {
      this.gate.fail(login);
      throw new Error('Wrong name or password.');
    }
    this.gate.ok(login);
    if (o.tailnetId?.trim()) this.gate.trustOwnerId(o.tailnetId);
    return { id: HOST_ID, session: this.cfg.session };
  }

  /** A signed, unexpired host cookie whose session number is still the current password's. */
  current(s: Session): boolean {
    return !!this.cfg && s.role === 'host' && s.f === HOST_ID && s.s === this.cfg.session;
  }
}
