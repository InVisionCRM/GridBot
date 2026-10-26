import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Friends, LOCK_AFTER, LoginGate, type FriendsFile } from '../src/server/friends/accounts';
import { checkPassword, cookieValue, hashPassword, HOST_ID, readSession, signSession } from '../src/server/friends/auth';
import { createGateway, proxyUpgrade } from '../src/server/friends/gateway';
import { OwnerLogin, formatPassHash, parsePassHash } from '../src/server/friends/owner';
import { configuredHosts, requestHostAllowed } from '../src/server/friends/publicHost';
import { subKey } from '../src/server/friends/vault';
import { takeHostAuth } from '../src/server/env';
import { createApp } from '../src/server/app';
import { MockChain, NET } from './helpers/mockChain';

const secret = randomBytes(32);
const sessionKey = subKey(secret, 'session');
const PASS = 'correct horse battery';
const PUBLIC = 'mac.tailnet.ts.net';

let ownerHash: Awaited<ReturnType<typeof hashPassword>>;
beforeAll(async () => { ownerHash = await hashPassword(PASS); });

describe('owner password hash', () => {
  it('round-trips and refuses a bad value without echoing it', async () => {
    const raw = formatPassHash(ownerHash);
    expect(parsePassHash(raw)).toEqual({ salt: ownerHash.salt, hash: ownerHash.hash });
    expect(await checkPassword(PASS, parsePassHash(raw))).toBe(true);
    expect(() => parsePassHash('not-a-real-secret-hash')).toThrow(/not a password hash/);
    try { parsePassHash('not-a-real-secret-hash'); } catch (e) { expect((e as Error).message).not.toContain('not-a-real-secret-hash'); }
  });

  it('takeHostAuth removes the hash from the environment', async () => {
    process.env.HOST_PASSWORD_HASH = formatPassHash(ownerHash);
    process.env.HOST_LOGIN = 'Kyle';
    process.env.HOST_SESSION = '4';
    try {
      const got = takeHostAuth();
      expect(process.env.HOST_PASSWORD_HASH).toBeUndefined();
      expect(process.env.HOST_LOGIN).toBeUndefined();
      expect(process.env.HOST_SESSION).toBeUndefined();
      expect(got).toMatchObject({ login: 'kyle', session: 4 });
      expect(got?.pass.hash).toBe(ownerHash.hash);
    } finally {
      delete process.env.HOST_PASSWORD_HASH;
      delete process.env.HOST_LOGIN;
      delete process.env.HOST_SESSION;
    }
  });

  it('a bad HOST_PASSWORD_HASH is refused without echoing it, and is still removed', () => {
    process.env.HOST_PASSWORD_HASH = 'not-a-real-secret-hash';
    try {
      expect(() => takeHostAuth()).toThrow(/not a password hash/);
      expect(process.env.HOST_PASSWORD_HASH).toBeUndefined();
      process.env.HOST_PASSWORD_HASH = 'not-a-real-secret-hash';
      try { takeHostAuth(); } catch (e) { expect((e as Error).message).not.toContain('not-a-real-secret-hash'); }
    } finally {
      delete process.env.HOST_PASSWORD_HASH;
    }
  });

  it('npm run host:password writes a hash, not the password, and bumps the session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hostpw-'));
    const envFile = join(dir, '.env');
    const script = join(__dirname, '..', 'scripts', 'hostPassword.mjs');
    writeFileSync(envFile, 'PRIVATE_KEY=0xabc\n');
    expect(() => execFileSync(process.execPath, [script, '--stdin'], { cwd: dir, input: 'short\n', encoding: 'utf8' })).toThrow();
    expect(readFileSync(envFile, 'utf8')).not.toContain('HOST_PASSWORD_HASH');
    execFileSync(process.execPath, [script, '--stdin'], { cwd: dir, input: `${PASS}\n`, encoding: 'utf8' });
    const once = readFileSync(envFile, 'utf8');
    expect(once).toContain('PRIVATE_KEY=0xabc');
    expect(once).not.toContain(PASS);
    expect(once).toMatch(/^HOST_LOGIN=owner$/m);
    expect(once).toMatch(/^HOST_SESSION=1$/m);
    const line = /^HOST_PASSWORD_HASH=(.+)$/m.exec(once)?.[1] ?? '';
    expect(line).not.toContain(PASS);
    execFileSync(process.execPath, [script, '--stdin'], { cwd: dir, input: `${PASS}\n`, encoding: 'utf8' });
    const twice = readFileSync(envFile, 'utf8');
    expect(twice).toMatch(/^HOST_SESSION=2$/m);
    expect(twice).not.toContain(PASS);
  });
});

describe('owner name is not an invite', () => {
  it('refuses to invite or sign up the owner name, and a host-role cookie for a friend does not parse', async () => {
    const gate = new LoginGate();
    const owner = new OwnerLogin({ login: 'owner', pass: ownerHash, session: 1 }, gate);
    const friends = new Friends(new MemoryStore<FriendsFile>(), secret, { gate, reserved: (n) => owner.isOwnerName(n) });
    friends.setHost({ name: 'Kyle', address: 'https://box.tail1.ts.net' });
    expect(() => friends.createInvite('Owner')).toThrow(/reserved/);
    const { link } = friends.createInvite('Alex');
    await expect(friends.signUp(link.split('/invite/')[1], { name: 'owner', password: 'correct horse', key: '' }, 4000)).rejects.toThrow(/reserved/);
    const alex = await friends.signUp(link.split('/invite/')[1], { name: 'Alex', password: 'correct horse', key: '' }, 4000);
    expect(alex.id).not.toBe(HOST_ID);
    expect(JSON.stringify(friends.list())).not.toContain(ownerHash.hash);
    const forged = signSession(sessionKey, { f: alex.id, s: alex.session, e: Date.now() + 1e6, role: 'host' });
    expect(readSession(sessionKey, forged, Date.now())).toBeNull();
    expect(configuredHosts('https://Box.Tail1.ts.net', 'Mac.Tailnet.ts.net:443')).toEqual(['box.tail1.ts.net', 'mac.tailnet.ts.net']);
    expect(requestHostAllowed('Mac.Tailnet.ts.net:443', ['mac.tailnet.ts.net'])).toBe(true);
    expect(requestHostAllowed('127.0.0.1:3850', [])).toBe(true);
    expect(requestHostAllowed('evil.example', ['mac.tailnet.ts.net'])).toBe(false);
  });
});

describe('owner gateway', () => {
  const servers: http.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });
  const listen = async (s: http.Server) => { servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); return (s.address() as AddressInfo).port; };

  async function setup() {
    const gate = new LoginGate();
    const owner = new OwnerLogin({ login: 'owner', pass: ownerHash, session: 1 }, gate);
    const store = new MemoryStore<FriendsFile>();
    const friends = new Friends(store, secret, { gate, reserved: (n) => owner.isOwnerName(n) });
    friends.setHost({ name: 'Kyle', address: 'https://box.tail1.ts.net' });
    const hostSeen: http.IncomingHttpHeaders[] = [];
    const bot = new MultiBot({ net: NET, reader: new MockChain(1e-5), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    const hostApp = createApp({ bot, net: NET, heartbeatMs: 60_000, statusThrottleMs: 60_000 });
    const hostSrv = http.createServer((req, res) => { hostSeen.push({ ...req.headers }); hostApp(req, res); });
    const hostPort = await listen(hostSrv);
    const friendSeen: http.IncomingHttpHeaders[] = [];
    const friendSrv = http.createServer((req, res) => {
      friendSeen.push({ ...req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ who: 'friend', path: req.url }));
    });
    const friendPort = await listen(friendSrv);
    const alex = await friends.signUp(friends.createInvite('Alex').link.split('/invite/')[1], { name: 'Alex', password: 'correct horse', key: '' }, friendPort);
    const deps = {
      friends, sessionKey, owner, hostPort, publicDir: null as string | null,
      copyState: () => 'running' as const, liveBots: async () => 0, signUp: async () => { throw new Error('unused'); }, setKey: async () => undefined,
      origins: () => ['https://box.tail1.ts.net', `https://${PUBLIC}`, 'http://127.0.0.1', 'http://localhost'],
      publicHosts: () => [PUBLIC, 'box.tail1.ts.net'],
    };
    // Origins are matched exactly. Tests send https://mac.tailnet.ts.net, which has no port.
    const app = createGateway(deps);
    const gw = await listen(http.createServer(app));
    const exp = Date.now() + 1e9;
    const ownerCookie = `gb_session=${signSession(sessionKey, { f: HOST_ID, s: 1, e: exp, role: 'host' })}`;
    const friendCookie = `gb_session=${signSession(sessionKey, { f: alex.id, s: alex.session, e: exp })}`;
    return { gw, hostPort, hostSeen, friendSeen, ownerCookie, friendCookie, alex, deps, app };
  }

  const raw = (port: number, path: string, headers: http.OutgoingHttpHeaders, body?: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });

  it('no cookie sends the browser to login and the API to 401', async () => {
    const { gw, hostSeen } = await setup();
    const page = await raw(gw, '/', { host: PUBLIC });
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe('/login');
    const api = await raw(gw, '/api/bot/status', { host: PUBLIC });
    expect(api.status).toBe(401);
    expect(JSON.parse(api.text)).toMatchObject({ login: true });
    expect(hostSeen).toHaveLength(0);
    expect(page.text + api.text).not.toContain(ownerHash.hash);
    expect(page.text + api.text).not.toContain(secret.toString('hex'));
  });

  it('locks the owner name after repeated wrong passwords', async () => {
    const { gw } = await setup();
    const post = (password: string) => raw(gw, '/login', {
      host: `127.0.0.1`, origin: `https://${PUBLIC}`, 'content-type': 'application/x-www-form-urlencoded',
    }, `name=owner&password=${encodeURIComponent(password)}`);
    for (let i = 0; i < LOCK_AFTER; i++) {
      const r = await post('wrong-password');
      expect(r.status).toBe(400);
      expect(r.text).toContain('Wrong name or password.');
      expect(r.text).not.toContain(PASS);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const locked = await post(PASS);
    expect(locked.status).toBe(400);
    expect(locked.text).toMatch(/Too many wrong passwords for this name/);
  });

  it('a friend cookie reaches the friend copy and never the host app', async () => {
    const { gw, hostSeen, friendSeen, friendCookie } = await setup();
    const r = await raw(gw, '/api/health', { host: PUBLIC, cookie: friendCookie, 'x-forwarded-for': '100.9.9.9' });
    expect(JSON.parse(r.text)).toMatchObject({ who: 'friend' });
    expect(hostSeen).toHaveLength(0);
    expect(friendSeen[0].cookie).toBeUndefined();
    expect(friendSeen[0]['x-forwarded-for']).toBeUndefined();
    expect(friendSeen[0].host).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('an owner cookie reaches the host API with a localhost Host and, on a change, a localhost Origin', async () => {
    const { gw, hostPort, hostSeen, friendSeen, ownerCookie } = await setup();
    const health = await raw(gw, '/api/health', { host: PUBLIC, cookie: ownerCookie, 'x-forwarded-for': '100.1.2.3', 'x-forwarded-host': 'evil.example' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ ok: true });
    expect(health.text).not.toContain(ownerHash.hash);
    expect(friendSeen).toHaveLength(0);
    expect(hostSeen[0].host).toBe(`127.0.0.1:${hostPort}`);
    expect(hostSeen[0].cookie).toBeUndefined();
    expect(hostSeen[0].origin).toBeUndefined();
    expect(hostSeen[0]['x-forwarded-for']).toBeUndefined();
    expect(hostSeen[0]['x-forwarded-host']).toBeUndefined();
    const stop = await raw(gw, '/api/bot/stop-all', {
      host: PUBLIC, cookie: ownerCookie, origin: `https://${PUBLIC}`, 'content-type': 'application/json', 'x-forwarded-proto': 'https',
    }, '{}');
    expect(stop.status).toBe(200);
    expect(JSON.parse(stop.text)).toEqual({ ok: true });
    expect(hostSeen.at(-1)?.origin).toBe(`http://127.0.0.1:${hostPort}`);
    expect(hostSeen.at(-1)?.host).toBe(`127.0.0.1:${hostPort}`);
    expect(hostSeen.at(-1)?.cookie).toBeUndefined();
  });

  it('refuses a change from another site, a foreign host, and a spoofed X-Forwarded-Host', async () => {
    const { gw, hostSeen, ownerCookie } = await setup();
    const csrf = await raw(gw, '/api/bot/stop-all', {
      host: PUBLIC, cookie: ownerCookie, origin: 'https://evil.example', 'content-type': 'application/json',
    }, '{}');
    expect(csrf.status).toBe(403);
    const missing = await raw(gw, '/api/bot/stop-all', { host: PUBLIC, cookie: ownerCookie, 'content-type': 'application/json' }, '{}');
    expect(missing.status).toBe(403);
    const evil = await raw(gw, '/api/health', { host: 'evil.example', cookie: ownerCookie, 'x-forwarded-host': PUBLIC });
    expect(evil.status).toBe(403);
    expect(hostSeen).toHaveLength(0);
  });

  it('refuses a forged, expired, or old owner cookie, and a friend id signed as the owner', async () => {
    const { gw, hostSeen, ownerCookie, alex } = await setup();
    // The signature's first character: every one of its bits is the signature's (the last one's lowest bits are padding,
    // so changing only those can leave the cookie valid)
    const at = ownerCookie.lastIndexOf('.') + 1;
    const flip = ownerCookie.slice(0, at) + (ownerCookie[at] === 'a' ? 'b' : 'a') + ownerCookie.slice(at + 1);
    for (const cookie of [
      flip,
      `gb_session=${signSession(sessionKey, { f: HOST_ID, s: 1, e: Date.now() - 1000, role: 'host' })}`,
      `gb_session=${signSession(sessionKey, { f: HOST_ID, s: 99, e: Date.now() + 1e9, role: 'host' })}`,
      `gb_session=${signSession(sessionKey, { f: alex.id, s: alex.session, e: Date.now() + 1e9, role: 'host' })}`,
      `gb_session=${signSession(randomBytes(32), { f: HOST_ID, s: 1, e: Date.now() + 1e9, role: 'host' })}`,
    ]) {
      const r = await raw(gw, '/api/health', { host: PUBLIC, cookie });
      expect(r.status).toBe(401);
    }
    expect(hostSeen).toHaveLength(0);
  });

  it('logging in as the owner sets a host cookie; logging in as a friend does not', async () => {
    const { gw, alex } = await setup();
    const owner = await raw(gw, '/login', {
      host: PUBLIC, origin: `https://${PUBLIC}`, 'content-type': 'application/x-www-form-urlencoded',
    }, `name=Owner&password=${encodeURIComponent(PASS)}`);
    expect(owner.status).toBe(303);
    const oc = cookieValue(String(owner.headers['set-cookie']), 'gb_session');
    expect(readSession(sessionKey, oc, Date.now())).toMatchObject({ f: HOST_ID, role: 'host', s: 1 });
    const friend = await raw(gw, '/login', {
      host: PUBLIC, origin: `https://${PUBLIC}`, 'content-type': 'application/x-www-form-urlencoded',
    }, 'name=Alex&password=correct+horse');
    const fc = cookieValue(String(friend.headers['set-cookie']), 'gb_session');
    const s = readSession(sessionKey, fc, Date.now());
    expect(s?.role).toBeUndefined();
    expect(s?.f).toBe(alex.id);
  });

  it('the live stream passes through to the host app', async () => {
    const { gw, ownerCookie } = await setup();
    const got = await new Promise<string>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: gw, path: '/api/bot/stream', headers: { host: PUBLIC, cookie: ownerCookie } }, (res) => {
        res.once('data', (c) => { resolve(c.toString()); r.destroy(); });
      });
      r.on('error', reject);
      setTimeout(() => reject(new Error('no data while the stream is open')), 2000);
    });
    expect(got).toContain('event: hello');
  });

  it('the host app still rejects the public host and a public origin on a direct connection', async () => {
    const { hostPort } = await setup();
    const host = await raw(hostPort, '/api/health', { host: PUBLIC });
    expect(host.status).toBe(403);
    expect(host.text).toContain('forbidden host');
    const origin = await raw(hostPort, '/api/bot/stop-all', {
      host: `127.0.0.1:${hostPort}`, origin: `https://${PUBLIC}`, 'content-type': 'application/json',
    }, '{}');
    expect(origin.status).toBe(403);
    expect(origin.text).toContain('forbidden origin');
  });

  it('an upgrade for the owner is proxied without the cookie; a friend upgrade does not hit the host', async () => {
    const hostSeen: http.IncomingHttpHeaders[] = [];
    const friendSeen: http.IncomingHttpHeaders[] = [];
    const host = http.createServer((_req, res) => res.end('no'));
    host.on('upgrade', (req, socket) => {
      hostSeen.push({ ...req.headers });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello-ws');
      socket.end();
    });
    const friend = http.createServer((_req, res) => res.end('no'));
    friend.on('upgrade', (req, socket) => {
      friendSeen.push({ ...req.headers });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfriend-ws');
      socket.end();
    });
    const hostPort = await listen(host);
    const friendPort = await listen(friend);
    const gate = new LoginGate();
    const owner = new OwnerLogin({ login: 'owner', pass: ownerHash, session: 1 }, gate);
    const friends = new Friends(new MemoryStore<FriendsFile>(), secret, { gate, reserved: (n) => owner.isOwnerName(n) });
    friends.setHost({ name: 'Kyle', address: 'https://box.tail1.ts.net' });
    const alex = await friends.signUp(friends.createInvite('Alex').link.split('/invite/')[1], { name: 'Alex', password: 'correct horse', key: '' }, friendPort);
    const deps = {
      friends, sessionKey, owner, hostPort, publicDir: null as string | null,
      copyState: () => 'running' as const, liveBots: async () => 0, signUp: async () => { throw new Error('unused'); }, setKey: async () => undefined,
      origins: () => [`https://${PUBLIC}`], publicHosts: () => [PUBLIC],
    };
    const srv = http.createServer(createGateway(deps));
    srv.on('upgrade', (req, socket, head) => proxyUpgrade(deps, req, socket, head));
    const gw = await listen(srv);
    const open = (cookie: string) => new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: gw, path: '/ws',
        headers: { Host: PUBLIC, Connection: 'Upgrade', Upgrade: 'websocket', Cookie: cookie, 'X-Forwarded-For': '100.1.2.3' },
      });
      req.on('upgrade', (_res, socket, head) => {
        let data = head.toString();
        socket.on('data', (c) => { data += c.toString(); });
        socket.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
      setTimeout(() => reject(new Error('upgrade timed out')), 2000);
    });
    const ownerCookie = `gb_session=${signSession(sessionKey, { f: HOST_ID, s: 1, e: Date.now() + 1e9, role: 'host' })}`;
    expect(await open(ownerCookie)).toContain('hello-ws');
    expect(hostSeen[0].cookie).toBeUndefined();
    expect(hostSeen[0].host).toBe(`127.0.0.1:${hostPort}`);
    expect(hostSeen[0]['x-forwarded-for']).toBeUndefined();
    const friendCookie = `gb_session=${signSession(sessionKey, { f: alex.id, s: alex.session, e: Date.now() + 1e9 })}`;
    expect(await open(friendCookie)).toContain('friend-ws');
    expect(hostSeen).toHaveLength(1);
    expect(friendSeen[0].cookie).toBeUndefined();
  });
});
