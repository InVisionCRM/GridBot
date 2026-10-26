import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/server/bot/store';
import { Friends, LOCK_AFTER, INVITE_MS, type FriendsFile } from '../src/server/friends/accounts';
import { cookieValue, readSession, signSession } from '../src/server/friends/auth';
import { childEnv } from '../src/server/friends/copies';
import { createGateway } from '../src/server/friends/gateway';
import { GeckoRelay, relayFetch } from '../src/server/friends/relay';
import { createApp } from '../src/server/app';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MockChain, NET } from './helpers/mockChain';
import { keyAddress, openKey, sealKey, subKey } from '../src/server/friends/vault';
import { GeckoSource, type FetchFn } from '../src/server/market/gecko';

const secret = randomBytes(32);
const key = () => Wallet.createRandom().privateKey;

function registry(o: { now?: () => number; hostAddresses?: () => string[] } = {}) {
  const f = new Friends(new MemoryStore<FriendsFile>(), secret, o);
  f.setHost({ name: 'Kyle', address: 'https://box.tail1.ts.net' });
  return f;
}
const tokenOf = (link: string) => link.split('/invite/')[1];

describe('friends: keys at rest', () => {
  it('opens only with the same secret and the same friend', () => {
    const k = key();
    const box = sealKey(secret, 'a', k);
    expect(JSON.stringify(box)).not.toContain(k.slice(2));
    expect(openKey(secret, 'a', box)).toBe(k);
    expect(() => openKey(randomBytes(32), 'a', box)).toThrow(/not the one it was saved with/);
    expect(() => openKey(secret, 'b', box)).toThrow();
  });
  it('rejects a bad key without repeating it', () => {
    expect(() => sealKey(secret, 'a', 'hello-not-a-key-1234567890')).toThrow(/isn't a private key/);
    try { sealKey(secret, 'a', 'zz'.repeat(32)); } catch (e) { expect((e as Error).message).not.toContain('zz'.repeat(32)); }
  });
});

describe('friends: invites, logins, sessions', () => {
  it('an invite works once; the key is sealed and its address kept', async () => {
    const f = registry();
    const { link } = f.createInvite('Alex');
    const k = key();
    const a = await f.signUp(tokenOf(link), { name: 'Alex', password: 'correct horse', key: k }, 4000);
    expect(a.address).toBe(keyAddress(k));
    expect(f.key(a.id)).toBe(k);
    await expect(f.signUp(tokenOf(link), { name: 'Sam', password: 'correct horse', key: '' }, 4001)).rejects.toThrow(/used or has expired/);
  });
  it('an invite expires after 7 days', async () => {
    let t = 1e12;
    const f = registry({ now: () => t });
    const { link } = f.createInvite('Alex');
    t += INVITE_MS + 1;
    expect(f.inviteFor(tokenOf(link))).toBeNull();
  });
  it("refuses the host's key and a key another friend uses", async () => {
    const hostKey = key(), k = key();
    const f = registry({ hostAddresses: () => [keyAddress(hostKey)] });
    await expect(f.signUp(tokenOf(f.createInvite('Alex').link), { name: 'Alex', password: 'correct horse', key: hostKey }, 4000)).rejects.toThrow(/host's own key/);
    await f.signUp(tokenOf(f.createInvite('Sam').link), { name: 'Sam', password: 'correct horse', key: k }, 4001);
    await expect(f.signUp(tokenOf(f.createInvite('Jo').link), { name: 'Jo', password: 'correct horse', key: k }, 4002)).rejects.toThrow(/Another friend already uses/);
  });
  it('locks a name after repeated wrong passwords; the error never says which part was wrong', async () => {
    const f = registry();
    await f.signUp(tokenOf(f.createInvite('Alex').link), { name: 'Alex', password: 'correct horse', key: '' }, 4000);
    await expect(f.login('nobody', 'x')).rejects.toThrow('Wrong name or password.');
    for (let i = 0; i < LOCK_AFTER; i++) await expect(f.login('alex', 'wrong')).rejects.toThrow('Wrong name or password.');
    await expect(f.login('ALEX ', 'correct horse')).rejects.toThrow(/Too many wrong passwords for this name/);
  });
  it('a new-password link ends every earlier login', async () => {
    const f = registry();
    const a = await f.signUp(tokenOf(f.createInvite('Alex').link), { name: 'Alex', password: 'correct horse', key: '' }, 4000);
    const before = { f: a.id, s: a.session, e: Date.now() + 1e6 };
    expect(f.current(before)).not.toBeNull();
    await f.resetPassword(tokenOf(f.createReset(a.id).link), 'battery staple');
    expect(f.current(before)).toBeNull();
    expect((await f.login('alex', 'battery staple')).id).toBe(a.id);
  });
  it('session cookies: signed, tamper-proof, expiring', () => {
    const k = subKey(secret, 'session');
    const v = signSession(k, { f: 'a', s: 1, e: 2000 });
    expect(readSession(k, v, 1000)).toEqual({ f: 'a', s: 1, e: 2000 });
    expect(readSession(k, v, 3000)).toBeNull();
    expect(readSession(subKey(randomBytes(32), 'session'), v, 1000)).toBeNull();
    const [body, sig] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ f: 'b', s: 1, e: 2000 })).toString('base64url');
    expect(readSession(k, `${forged}.${sig}`, 1000)).toBeNull();
    expect(cookieValue(`x=1; gb_session=${body}.${sig}; y=2`, 'gb_session')).toBe(v);
  });
});

describe("friends: a copy's environment", () => {
  it("carries the friend's key and shared settings, never the host's keys, RPCs or secret", () => {
    const hostEnv = {
      PRIVATE_KEY: '0xhost', PRIVATE_KEY_ETHEREUM: '0xhosteth', FRIENDS_SECRET: 'f'.repeat(64), RPC_URL_ETHEREUM: 'https://eth.example/v2/apikey',
      HOST_PASSWORD_HASH: 'c2FsdA==.aGFzaA==', HOST_LOGIN: 'owner', HOST_SESSION: '1', GATEWAY_HOST: 'mac.tailnet.ts.net',
      HOME: '/home/kyle', PATH: '/usr/bin', STATE_FILE: '/home/kyle/gridbot/data/state.json', CHAINS: 'ethereum,robinhood', POLL_MS: '10000',
    };
    const env = childEnv(hostEnv, { id: 'a', name: 'Alex', port: 3851, key: '0xfriend' }, { name: 'Kyle', url: 'http://127.0.0.1:3847' });
    expect(env).toEqual({
      CHAINS: 'ethereum,robinhood', POLL_MS: '10000', NODE_ENV: 'production', PORT: '3851',
      FRIEND_NAME: 'Alex', HOST_NAME: 'Kyle', HOST_URL: 'http://127.0.0.1:3847', PRIVATE_KEY: '0xfriend',
    });
    const paper = childEnv(hostEnv, { id: 'a', name: 'Alex', port: 3851, key: null }, { name: 'Kyle', url: 'x' });
    expect(paper).not.toHaveProperty('PRIVATE_KEY');
    expect(paper).not.toHaveProperty('HOST_PASSWORD_HASH');
    expect(paper).not.toHaveProperty('FRIENDS_SECRET');
    expect(paper).not.toHaveProperty('GATEWAY_HOST');
  });
});

describe('friends: gateway', () => {
  const servers: http.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  const listen = async (s: http.Server) => { servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); return (s.address() as AddressInfo).port; };

  async function setup() {
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/api/bot/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: hello\ndata: {}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'evil=1' });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    const upPort = await listen(upstream);
    const friends = registry();
    const a = await friends.signUp(tokenOf(friends.createInvite('Alex').link), { name: 'Alex', password: 'correct horse', key: '' }, upPort);
    let state: 'running' | 'stopped' = 'running';
    const app = createGateway({
      friends, sessionKey: subKey(secret, 'session'), publicDir: null,
      copyState: () => state, liveBots: async () => 0, signUp: async () => { throw new Error('unused'); }, setKey: async () => undefined,
      origins: () => ['https://box.tail1.ts.net'],
    });
    const gw = await listen(http.createServer(app));
    const cookie = `gb_session=${signSession(subKey(secret, 'session'), { f: a.id, s: a.session, e: Date.now() + 1e9 })}`;
    return { gw, seen, cookie, setState: (s: typeof state) => { state = s; }, upstream };
  }
  const req = (port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: o.method ?? 'GET', headers: o.headers, body: o.body, redirect: 'manual' });

  it('without a login: pages go to /login, the API answers 401', async () => {
    const { gw } = await setup();
    const r1 = await req(gw, '/');
    expect(r1.status).toBe(303);
    expect(r1.headers.get('location')).toBe('/login');
    const r2 = await req(gw, '/api/bot/status');
    expect(r2.status).toBe(401);
    expect(await r2.json()).toMatchObject({ login: true });
  });

  it("passes a logged-in friend to their copy as a local request, without the gateway's cookie or the origin", async () => {
    const { gw, seen, cookie } = await setup();
    const r = await req(gw, '/api/bot/grids', { method: 'POST', headers: { cookie, origin: 'https://box.tail1.ts.net', 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: '{}' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: '/api/bot/grids', method: 'POST' });
    const h = seen[0];
    expect(h.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(h.cookie).toBeUndefined();
    expect(h.origin).toBeUndefined();
    expect(h['x-forwarded-for']).toBeUndefined();
    expect(r.headers.get('set-cookie') ?? '').not.toContain('evil');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    // not no-referrer: under it a browser's form posts carry "Origin: null" and the gateway would refuse them
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('refuses a change from another site, even with the login cookie', async () => {
    const { gw, seen, cookie } = await setup();
    const r = await req(gw, '/api/bot/stop-all', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
    const r2 = await req(gw, '/api/bot/stop-all', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(r2.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('streams the live feed through as it is written', async () => {
    const { gw, cookie } = await setup();
    const got = await new Promise<string>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: gw, path: '/api/bot/stream', headers: { cookie } }, (res) => {
        res.once('data', (c) => { resolve(c.toString()); r.destroy(); });
      });
      r.on('error', reject);
      setTimeout(() => reject(new Error('no data while the stream is open')), 2000);
    });
    expect(got).toContain('event: hello');
  });

  it("says the copy is starting, or stopped, when it doesn't answer", async () => {
    const { gw, cookie, setState, upstream } = await setup();
    await new Promise((r) => upstream.close(r));
    const page = await req(gw, '/', { headers: { cookie } });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('Your copy is starting');
    setState('stopped');
    const api = await req(gw, '/api/bot/status', { headers: { cookie } });
    expect(await api.json()).toEqual({ error: 'Kyle has stopped your copy.' });
  });
});

describe('friends: GeckoTerminal relay', () => {
  const URL_OK = `https://api.geckoterminal.com/api/v2/networks/eth/pools/0x${'ab'.repeat(20)}/ohlcv/hour?aggregate=1&limit=100&currency=token&token=0x${'cd'.repeat(20)}`;
  const fake = (status: number, calls: string[]): FetchFn => async (url) => { calls.push(url); return { ok: status === 200, status, json: async () => ({ data: { n: calls.length } }) }; };

  it('relays candle URLs only, serves a repeat from the cache, and asks copies to wait while the scan runs', async () => {
    const calls: string[] = [];
    let busy = false, t = 1e12;
    const relay = new GeckoRelay(new GeckoSource(fake(200, calls), { minIntervalMs: 0, sleep: async () => undefined }), { busy: () => busy, now: () => t });
    expect(await relay.get('https://example.com/steal')).toMatchObject({ status: 400 });
    expect(await relay.get(URL_OK)).toEqual({ status: 200, body: { data: { n: 1 } } });
    expect(await relay.get(URL_OK)).toEqual({ status: 200, body: { data: { n: 1 } } });
    expect(calls).toHaveLength(1);
    t += 61_000;
    busy = true;
    expect(await relay.get(URL_OK)).toMatchObject({ status: 429 });
    busy = false;
    expect(await relay.get(URL_OK)).toEqual({ status: 200, body: { data: { n: 2 } } });
  });

  it("a copy's candles come through the host app's relay route", async () => {
    const calls: string[] = [];
    const upstream: FetchFn = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[3600, 1, 2, 0.5, 1.5, 10], [0, 1, 1, 1, 1, 1]] } } }) };
    };
    const bot = new MultiBot({ net: NET, reader: new MockChain(1e-5), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    const relay = new GeckoRelay(new GeckoSource(upstream, { minIntervalMs: 0 }), { busy: () => false });
    const server = createApp({ bot, net: NET, relay }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const copyGecko = new GeckoSource(relayFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), { minIntervalMs: 0 });
      const k = await copyGecko.ohlcv(`0x${'ab'.repeat(20)}`, `0x${'cd'.repeat(20)}`, '1h', undefined, 100, { network: 'eth', feeBps: 0 });
      expect(k.map((c) => c.t)).toEqual([0, 3600]);
      expect(calls[0]).toMatch(/^https:\/\/api\.geckoterminal\.com\/api\/v2\/networks\/eth\/pools\/0xabab.*\/ohlcv\/hour\?aggregate=1&limit=100/);
    } finally {
      server.close();
    }
  });

  it("passes GeckoTerminal's 429 on, then answers 429 straight away during the back-off", async () => {
    const calls: string[] = [];
    const relay = new GeckoRelay(new GeckoSource(fake(429, calls), { minIntervalMs: 0, sleep: async () => undefined }), { busy: () => false });
    expect(await relay.get(URL_OK)).toMatchObject({ status: 429 });
    expect(await relay.get(URL_OK.replace('limit=100', 'limit=99'))).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });
});
