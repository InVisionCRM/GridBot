/**
 * Login lockout hardening (#55 follow-up): counters survive a restart, locks back off exponentially per name, and
 * guesses by someone else can never lock the owner out: a known owner device, this computer, or the owner's own
 * tailnet login skips the lock (never the password). A tailnet address alone does not (shared devices have one too),
 * and forwarded headers can't fake any of it. Funnel stays refused.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JsonStore, MemoryStore } from '../src/server/bot/store';
import {
  Friends, GLOBAL_FAILS_PER_MIN, LOCK_AFTER, LOCK_MAX_MS, LOCK_MS, LoginGate, STRIKE_RESET_MS, type FriendsFile, type LoginGateFile,
} from '../src/server/friends/accounts';
import { DEVICE_COOKIE, hashPassword, HOST_ID, signDevice, signSession } from '../src/server/friends/auth';
import { createGateway } from '../src/server/friends/gateway';
import { OwnerLogin } from '../src/server/friends/owner';
import { subKey } from '../src/server/friends/vault';

const secret = randomBytes(32);
const sessionKey = subKey(secret, 'session');
const PASS = 'correct horse battery staple';
const PUBLIC = 'mac.tailnet.ts.net';
const KYLE = 'kyle@example.com';
let ownerHash: Awaited<ReturnType<typeof hashPassword>>;
beforeAll(async () => { ownerHash = await hashPassword(PASS); });

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'gate-')), 'login-limits.json');
function clock(t0 = 1_793_129_093_757) { const c = { t: t0, now: () => c.t }; return c; }
function lockOut(g: LoginGate, login = 'owner') { for (let i = 0; i < LOCK_AFTER; i++) g.fail(login); }

describe('LoginGate: persisted counters', () => {
  it('a lock survives a restart; the file has no names, passwords or cookies', () => {
    const file = tmpFile(), c = clock();
    const g = new LoginGate(c.now, new JsonStore<LoginGateFile>(file));
    lockOut(g, 'owner');
    expect(g.lockedFor('owner')).toBe(LOCK_MS);
    const again = new LoginGate(c.now, new JsonStore<LoginGateFile>(file)); // restart
    expect(again.lockedFor('owner')).toBe(LOCK_MS);
    expect(() => again.begin('owner')).toThrow(/Too many wrong passwords for this name/);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('"owner"');
    expect(Object.keys(JSON.parse(text).names)[0]).toMatch(/^[0-9a-f]{64}$/); // sha256 of the name
    expect(text).not.toContain(PASS);
    expect(existsSync(`${file}.tmp`)).toBe(false); // atomic write: temp file renamed into place
    expect(JSON.parse(text)).toMatchObject({ v: 1, recent: expect.any(Array), ownerIds: [] });
  });

  it('the all-logins pause and the failure count below the lock survive a restart too', () => {
    const file = tmpFile(), c = clock();
    const g = new LoginGate(c.now, new JsonStore<LoginGateFile>(file));
    for (let i = 0; i < LOCK_AFTER - 1; i++) g.fail('alex');
    for (let i = 0; i < GLOBAL_FAILS_PER_MIN; i++) g.fail(`random-${i}`);
    const again = new LoginGate(c.now, new JsonStore<LoginGateFile>(file));
    expect(() => again.begin('anyone')).toThrow(/Wait a minute/);
    c.t += 61_000;
    again.fail('alex'); // the 5th: locks, because the first 4 were kept
    expect(again.lockedFor('alex')).toBe(LOCK_MS);
  });

  it('a corrupt file starts clean instead of crashing the gateway', () => {
    const store = { load: () => { throw new Error('bad json'); }, save: () => undefined };
    expect(() => new LoginGate(Date.now, store)).not.toThrow();
  });
});

describe('LoginGate: exponential backoff per name', () => {
  it('15 min, 30 min, 1 h, 2 h … capped at 24 h', () => {
    expect([1, 2, 3, 4, 5].map((k) => LoginGate.lockMs(k) / 60_000)).toEqual([15, 30, 60, 120, 240]);
    expect(LoginGate.lockMs(20)).toBe(LOCK_MAX_MS);
  });

  it('each lock after the first doubles, per name; a quiet day resets it', () => {
    const c = clock();
    const g = new LoginGate(c.now, new MemoryStore<LoginGateFile>());
    const seen: number[] = [];
    for (let k = 0; k < 4; k++) {
      lockOut(g);
      seen.push(g.lockedFor('owner') / 60_000);
      c.t += g.lockedFor('owner') + 1;
    }
    expect(seen).toEqual([15, 30, 60, 120]);
    lockOut(g, 'alex'); // another name starts at the first length
    expect(g.lockedFor('alex')).toBe(LOCK_MS);
    c.t += STRIKE_RESET_MS + 1;
    lockOut(g);
    expect(g.lockedFor('owner')).toBe(LOCK_MS);
  });

  it('a correct password clears the name', () => {
    const c = clock();
    const g = new LoginGate(c.now, new MemoryStore<LoginGateFile>());
    lockOut(g); c.t += LOCK_MS + 1;
    g.ok('owner');
    lockOut(g);
    expect(g.lockedFor('owner')).toBe(LOCK_MS);
  });
});

describe('gateway: an attacker cannot lock the owner out', () => {
  const servers: http.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

  async function setup(o: { tailnetLogins?: string[]; file?: string } = {}) {
    const gate = new LoginGate(Date.now, o.file ? new JsonStore<LoginGateFile>(o.file) : new MemoryStore<LoginGateFile>());
    const owner = new OwnerLogin({ login: 'owner', pass: ownerHash, session: 2, tailnetLogins: o.tailnetLogins }, gate);
    const friends = new Friends(new MemoryStore<FriendsFile>(), secret, { gate, reserved: (n) => owner.isOwnerName(n) });
    friends.setHost({ name: 'Kyle', address: `https://${PUBLIC}` });
    const app = createGateway({
      friends, sessionKey, owner, hostPort: 1, publicDir: null,
      copyState: () => 'running' as const, liveBots: async () => 0, signUp: async () => { throw new Error('unused'); }, setKey: async () => undefined,
      origins: () => [`https://${PUBLIC}`, 'http://127.0.0.1'], publicHosts: () => [PUBLIC],
    });
    const srv = http.createServer(app);
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return { port: (srv.address() as AddressInfo).port, gate };
  }
  const post = (port: number, headers: http.OutgoingHttpHeaders, password: string) => new Promise<{ status: number; text: string; cookies: string[] }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/login', method: 'POST', headers: { origin: `https://${PUBLIC}`, 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), cookies: ([] as string[]).concat(res.headers['set-cookie'] ?? []) }));
    });
    req.on('error', reject);
    req.end(`name=owner&password=${encodeURIComponent(password)}`);
  });
  // what tailscale serve forwards
  const shared = { host: PUBLIC, 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'friend@example.com' };
  const kyleTailnet = { host: PUBLIC, 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': KYLE };
  const kyleTaggedNoLogin = { host: PUBLIC, 'x-forwarded-for': '100.101.102.104' };
  const local = { host: '127.0.0.1' };
  const locked = (r: { status: number; text: string }) => r.status === 400 && /Too many wrong passwords/.test(r.text);
  async function lockFromShared(port: number) {
    for (let i = 0; i < LOCK_AFTER; i++) expect((await post(port, shared, 'guess-' + i)).status).toBe(400);
    expect(locked(await post(port, shared, PASS))).toBe(true); // the attacker, even with the right password, waits
  }

  it("the owner's tailnet login (HOST_TAILNET_LOGINS) logs in while the name is locked", async () => {
    const { port } = await setup({ tailnetLogins: ['Kyle@Example.com'] });
    await lockFromShared(port);
    const r = await post(port, kyleTailnet, PASS);
    expect(r.status).toBe(303);
    expect(r.cookies.join(';')).toMatch(/gb_session=.+/);
  });

  it("a tailnet login is learned at the owner's first log-in, then bypasses a later lock", async () => {
    const { port } = await setup();
    expect((await post(port, kyleTailnet, PASS)).status).toBe(303); // learned
    await lockFromShared(port);
    expect((await post(port, kyleTailnet, PASS)).status).toBe(303);
  });

  it('a tailnet address alone is not trusted (a device shared with a friend has one)', async () => {
    const { port } = await setup({ tailnetLogins: [KYLE] });
    await lockFromShared(port);
    expect(locked(await post(port, kyleTaggedNoLogin, PASS))).toBe(true);
    expect(locked(await post(port, { ...shared, 'x-forwarded-for': '100.101.102.103' }, PASS))).toBe(true);
  });

  it('a known device (owner-device cookie from an earlier log-in) logs in while locked', async () => {
    const { port } = await setup();
    const first = await post(port, kyleTaggedNoLogin, PASS);
    const dev = first.cookies.find((c) => c.startsWith(`${DEVICE_COOKIE}=`))!;
    expect(dev).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    await lockFromShared(port);
    const cookie = dev.split(';')[0];
    expect((await post(port, { ...kyleTaggedNoLogin, cookie }, PASS)).status).toBe(303);
    // an owner session cookie from before (expired, older password) also marks a known device
    const oldSession = `gb_session=${signSession(sessionKey, { f: HOST_ID, s: 1, e: Date.now() - 1000, role: 'host' })}`;
    expect((await post(port, { ...kyleTaggedNoLogin, cookie: oldSession }, PASS)).status).toBe(303);
  });

  it('this computer (loopback, no forwarding) logs in while locked', async () => {
    const { port } = await setup();
    await lockFromShared(port);
    expect((await post(port, local, PASS)).status).toBe(303);
  });

  it('a trusted source still needs the password, and its wrong guesses still count', async () => {
    const { port, gate } = await setup({ tailnetLogins: [KYLE] });
    await lockFromShared(port);
    const before = gate.lockedFor('owner');
    const r = await post(port, kyleTailnet, 'wrong');
    expect(r.status).toBe(400);
    expect(r.text).toContain('Wrong name or password.');
    expect(r.cookies.join(';')).not.toMatch(/gb_session=[^;]/);
    expect(gate.lockedFor('owner')).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });

  it('the all-logins pause does not stop the owner from a trusted source', async () => {
    const { port, gate } = await setup({ tailnetLogins: [KYLE] });
    for (let i = 0; i < GLOBAL_FAILS_PER_MIN; i++) gate.fail(`spray-${i}`);
    expect((await post(port, shared, PASS)).text).toMatch(/Wait a minute/);
    expect((await post(port, kyleTailnet, PASS)).status).toBe(303);
  });

  it('a lock set before a restart still holds after it, and the bypass still works', async () => {
    const file = tmpFile();
    const a = await setup({ file, tailnetLogins: [KYLE] });
    await lockFromShared(a.port);
    const b = await setup({ file, tailnetLogins: [KYLE] }); // restart: new gate from the same file
    expect(locked(await post(b.port, shared, PASS))).toBe(true);
    expect((await post(b.port, kyleTailnet, PASS)).status).toBe(303);
  });
});

describe('gateway: forwarded headers cannot fake a trusted source', () => {
  const servers: http.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });
  async function lockedGateway() {
    const gate = new LoginGate(Date.now, new MemoryStore<LoginGateFile>());
    const owner = new OwnerLogin({ login: 'owner', pass: ownerHash, session: 1, tailnetLogins: [KYLE] }, gate);
    const friends = new Friends(new MemoryStore<FriendsFile>(), secret, { gate, reserved: (n) => owner.isOwnerName(n) });
    const app = createGateway({
      friends, sessionKey, owner, hostPort: 1, publicDir: null,
      copyState: () => 'running' as const, liveBots: async () => 0, signUp: async () => { throw new Error('unused'); }, setKey: async () => undefined,
      origins: () => [`https://${PUBLIC}`, 'http://127.0.0.1'], publicHosts: () => [PUBLIC],
    });
    const srv = http.createServer(app); servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    lockOut(gate);
    return { port: (srv.address() as AddressInfo).port, gate };
  }
  const post = (port: number, headers: http.OutgoingHttpHeaders) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/login', method: 'POST', headers: { origin: `https://${PUBLIC}`, 'content-type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(`name=owner&password=${encodeURIComponent(PASS)}`);
  });

  it('Funnel with a tailnet X-Forwarded-For and the owner\'s Tailscale login: refused as Funnel, lock unchanged', async () => {
    const { port, gate } = await lockedGateway();
    const before = gate.lockedFor('owner');
    for (const h of [
      { host: PUBLIC, 'tailscale-funnel-request': '?1', 'x-forwarded-for': '100.101.102.103', 'tailscale-user-login': KYLE },
      { host: PUBLIC, 'x-forwarded-for': '100.101.102.103, 203.0.113.7', 'tailscale-user-login': KYLE },
      { host: PUBLIC, 'x-forwarded-for': '203.0.113.7', 'tailscale-user-login': KYLE },
    ]) {
      const r = await post(port, h);
      expect(r.status).toBe(400);
      expect(r.text).toMatch(/not through Tailscale Funnel/);
    }
    expect(gate.lockedFor('owner')).toBeLessThanOrEqual(before);
  });

  it('a forwarded request cannot pass as "this computer"', async () => {
    const { port } = await lockedGateway();
    for (const h of [
      { host: '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },             // forwarded, claiming loopback
      { host: '127.0.0.1', 'x-forwarded-for': '100.70.1.2' },            // a shared device with a loopback Host
      { host: '127.0.0.1', 'x-real-ip': '127.0.0.1' },
      { host: '127.0.0.1', forwarded: 'for=127.0.0.1' },
      { host: '127.0.0.1', 'tailscale-user-login': 'friend@example.com' }, // a Tailscale header at all
      { host: PUBLIC },                                                  // public Host, no forwarding
    ]) {
      const r = await post(port, h);
      expect(r.text).toMatch(/Too many wrong passwords/);
    }
  });

  it('forged or foreign cookies are not a known device', async () => {
    const { port } = await lockedGateway();
    const genuine = signDevice(sessionKey, Date.now());
    const otherKey = signDevice(subKey(randomBytes(32), 'session'), Date.now());
    const friendSession = signSession(sessionKey, { f: 'some-friend-id', s: 1, e: Date.now() + 1e6 });
    for (const cookie of [
      `${DEVICE_COOKIE}=${genuine.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`, // tampered signature
      `${DEVICE_COOKIE}=${otherKey}`,                                             // another server's key
      `${DEVICE_COOKIE}=d1.${Date.now()}.`,                                       // no signature
      `gb_session=${friendSession}`,                                              // a friend's session
    ]) {
      const r = await post(port, { host: PUBLIC, 'x-forwarded-for': '100.70.1.2', 'tailscale-user-login': 'friend@example.com', cookie });
      expect(r.text).toMatch(/Too many wrong passwords/);
    }
  });
});
