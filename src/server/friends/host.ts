/**
 * Friends' copies, wired together for the host app: the registry (accounts.ts), the copies (copies.ts) and the
 * gateway (gateway.ts) on its own port. index.ts starts it when FRIENDS_SECRET is set; app.ts serves its view and
 * actions to the host's Tools → Friends, which, like the rest of the host's API, answers local requests only.
 */
import http from 'node:http';
import { join } from 'node:path';
import { JsonStore } from '../bot/store';
import { Friends, type Friend, type FriendsFile } from './accounts';
import { Copies, portFree, type CopySpec, type CopyStatus } from './copies';
import { createGateway } from './gateway';
import { subKey } from './vault';

export interface FriendRow { id: string; name: string; address: string | null; port: number; createdAt: number; lastLoginAt: number | null; stopped: boolean; copy: CopyStatus }
export interface FriendsView {
  port: number;
  host: { name: string; address: string | null };
  invites: { id: string; name: string; reset: boolean; createdAt: number; expiresAt: number }[];
  friends: FriendRow[];
}

export class FriendsHost {
  readonly friends: Friends;
  readonly copies: Copies;
  private server: http.Server | null = null;
  /** Ports handed out by sign-ups still in progress, so two at once can't get the same one */
  private reserved = new Set<number>();

  constructor(private readonly o: {
    secret: Buffer; dataDir: string;
    /** The built server, which each copy runs */
    entry: string;
    hostEnv: NodeJS.ProcessEnv;
    /** The host app's port (copies fetch candles and the scan from it) and the gateway's */
    hostPort: number; port: number;
    publicDir: string | null;
    /** The host's own signing addresses: a friend can't use the host's key */
    hostAddresses: () => string[];
    say: (msg: string, level: 'info' | 'warn') => void;
  }) {
    const root = join(o.dataDir, 'friends');
    this.friends = new Friends(new JsonStore<FriendsFile>(join(root, 'friends.json')), o.secret, { hostAddresses: o.hostAddresses });
    this.copies = new Copies({
      root, entry: o.entry, hostEnv: o.hostEnv, say: o.say,
      host: () => ({ name: this.friends.host().name, url: `http://127.0.0.1:${o.hostPort}` }),
    });
  }

  private spec(f: Friend): CopySpec { return { id: f.id, name: f.name, port: f.port, key: this.friends.key(f.id) }; }

  /** Opens the gateway, then starts every copy the host hasn't stopped (their bots carry on where they were). */
  async start() {
    const app = createGateway({
      friends: this.friends, sessionKey: subKey(this.o.secret, 'session'), publicDir: this.o.publicDir,
      copyState: (id) => this.copies.status(id).state,
      liveBots: (id) => this.copies.liveBots(id),
      signUp: (token, p) => this.signUp(token, p),
      setKey: (id, raw) => this.setKey(id, raw),
      origins: () => this.origins(),
    });
    this.server = await new Promise<http.Server>((resolve, reject) => {
      const s = app.listen(this.o.port, '127.0.0.1', () => resolve(s));
      s.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new Error(`The friends' port ${this.o.port} is in use. Set FRIENDS_PORT=… in .env.`) : e));
    });
    for (const f of this.friends.list()) if (!f.stopped) this.copies.start(this.spec(f));
  }

  stop() { this.copies.stopAll(); this.server?.close(); }

  origins(): string[] {
    const a = this.friends.host().address;
    return [...(a ? [a] : []), `http://127.0.0.1:${this.o.port}`, `http://localhost:${this.o.port}`];
  }

  private async freePort(): Promise<number> {
    const used = new Set([this.o.hostPort, ...this.friends.list().map((f) => f.port), ...this.reserved]);
    for (let p = this.o.port + 1; p < this.o.port + 500; p++) {
      if (used.has(p)) continue;
      this.reserved.add(p);
      if (await portFree(p)) return p;
      this.reserved.delete(p);
    }
    throw new Error('No free port for a new copy.');
  }

  async signUp(token: string, p: { name: string; password: string; key: string }): Promise<Friend> {
    const port = await this.freePort();
    try {
      const f = await this.friends.signUp(token, p, port);
      this.copies.start(this.spec(f));
      this.o.say(`${f.name} signed up; their copy is starting on port ${port}.`, 'info');
      return f;
    } finally {
      this.reserved.delete(port);
    }
  }

  /** A key change while live bots exist would leave their coins with the old key, so it is refused. */
  async setKey(id: string, raw: string | null) {
    const f = this.friends.get(id);
    if (f.key) {
      const n = await this.copies.liveBots(id);
      if (n > 0) throw new Error(`You have ${n} live bot${n === 1 ? '' : 's'}. Stop and remove ${n === 1 ? 'it' : 'them'} in the app first.`);
    }
    this.friends.setKey(id, raw);
    if (!f.stopped) await this.copies.restart(this.spec(this.friends.get(id)));
  }

  // ── The host's Tools → Friends ───────────────────────────────────────
  view(): FriendsView {
    return {
      port: this.o.port, host: this.friends.host(),
      invites: this.friends.invites().map((i) => ({ id: i.id, name: i.name, reset: i.friendId != null, createdAt: i.createdAt, expiresAt: i.expiresAt })),
      friends: this.friends.list().map((f) => ({
        id: f.id, name: f.name, address: f.address, port: f.port, createdAt: f.createdAt, lastLoginAt: f.lastLoginAt, stopped: f.stopped, copy: this.copies.status(f.id),
      })),
    };
  }
  setHost(p: { name?: string; address?: string }) { this.friends.setHost(p); }
  invite(name: string) { return { link: this.friends.createInvite(name).link }; }
  resetLink(id: string) { return { link: this.friends.createReset(id).link }; }
  cancelInvite(id: string) { this.friends.cancelInvite(id); }

  startCopy(id: string) {
    this.friends.setStopped(id, false);
    this.copies.start(this.spec(this.friends.get(id)));
  }
  async stopCopy(id: string) {
    this.friends.setStopped(id, true);
    await this.copies.stop(id);
  }
  async restartCopy(id: string) {
    const f = this.friends.get(id);
    if (f.stopped) throw new Error(`${f.name}'s copy is stopped. Start it instead.`);
    await this.copies.restart(this.spec(f));
  }

  /** Deletes the friend, their copy's folder and their key. With a key, their copy must show no live bots first. */
  async remove(id: string) {
    const f = this.friends.get(id);
    if (f.key) {
      if (this.copies.status(id).state !== 'running') throw new Error(`Start ${f.name}'s copy first, so it can be checked for live bots before it is removed.`);
      const n = await this.copies.liveBots(id);
      if (n > 0) throw new Error(`${f.name} has ${n} live bot${n === 1 ? '' : 's'}. Ask them to stop and remove ${n === 1 ? 'it' : 'them'} first, so no coins are left in a bot nobody runs.`);
    }
    await this.copies.remove(id);
    this.friends.remove(id);
    this.o.say(`${f.name} was removed, with their copy.`, 'info');
  }
}
