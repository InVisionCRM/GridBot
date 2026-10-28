/**
 * RPC URLs can carry an API key (https://eth-mainnet.g.alchemy.com/v2/<key>, ?apikey=<key>, https://user:<key>@host).
 * Before this, the boot log printed the full URL and the status API returned it (chains[].rpc, rpcStatus.url,
 * rpcHealth.current / endpoints[].url), and ethers errors that embed the URL went to logs and the API as-is.
 * These pin: the key never appears in a log line or an API answer (also through the friends gateway), while the RPC
 * itself is still called with the full URL. Every key and URL here is fake and points at a local test server.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { allChains } from '../src/live/markets';
import { Logger, redact } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { buildHub } from '../src/server/chains/build';
import { makeRpc, rpcErrorText, type FallbackReader } from '../src/server/chains/fallback';
import { chainBootLine, registerRpcUrls, rpcHasSecretParts, rpcHost, rpcSecretParts } from '../src/server/chains/rpcUrl';
import { createApp } from '../src/server/app';
import { Friends, LoginGate, type FriendsFile } from '../src/server/friends/accounts';
import { hashPassword, HOST_ID, signSession } from '../src/server/friends/auth';
import { createGateway } from '../src/server/friends/gateway';
import { OwnerLogin } from '../src/server/friends/owner';
import { subKey } from '../src/server/friends/vault';
import { buildPayload } from '../src/server/push/payload';
import { NET } from './helpers/mockChain';

// Fake keys only. Each is long enough that any 8-character piece of it is distinctive.
const KEY_PATH = 'FAKEpathKEY0a1b2c3d4e5f6g7h8i9j';
const KEY_QUERY = 'FAKEqueryKEY9z8y7x6w5v4u3t2s1r';
const KEY_PASS = 'FAKEpassKEY5m4n3o2p1q0k9l8j7h6g';
const KEYS = [KEY_PATH, KEY_QUERY, KEY_PASS];

/** Any 8-character piece of a fake key: a message cut inside a key must not leave a piece either. */
function leaks(text: string): string[] {
  const out: string[] = [];
  for (const k of KEYS) for (let i = 0; i + 8 <= k.length; i++) if (text.includes(k.slice(i, i + 8))) { out.push(k.slice(i, i + 8)); break; }
  return out;
}

/** A tiny JSON-RPC node. It records every request path and the Authorization header; `fail` makes it answer 500. */
function rpcNode() {
  const seen: { url: string; auth: string | null }[] = [];
  const st = { fail: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? null });
      if (st.fail) { res.writeHead(500); res.end('node down'); return; }
      const j = JSON.parse(body || '{}') as { id: number; method: string };
      const result = j.method === 'eth_blockNumber' ? '0x10' : j.method === 'eth_chainId' ? '0x171' : j.method === 'eth_gasPrice' ? '0x3b9aca00'
        : j.method === 'eth_maxPriorityFeePerGas' ? '0x1' : j.method === 'eth_getBlockByNumber' ? null : undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'no such method' } } : { jsonrpc: '2.0', id: j.id, result }));
    });
  });
  return { server, seen, st };
}

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

// No public RPCs: every request goes to the local fake node.
const PLS = { ...allChains(NET).find((c) => c.id === NET.chainId)!, rpcs: [] as string[] };
let node: ReturnType<typeof rpcNode>;
let pathUrl: string, userUrl: string, origin: string;
let env: Record<string, string>;
let readers: Map<number, FallbackReader>;
let hub: ReturnType<typeof buildHub>['hub'];

beforeAll(async () => {
  node = rpcNode();
  servers.push(node.server);
  const port = await listen(node.server);
  origin = `http://127.0.0.1:${port}`;
  pathUrl = `${origin}/v2/${KEY_PATH}?apikey=${KEY_QUERY}`;
  userUrl = `http://rpcuser:${KEY_PASS}@127.0.0.1:${port}/`;
  env = { [`RPC_URL_${PLS.envSlug}`]: `${pathUrl},${userUrl}` };
  // What index.ts does at boot, in the same order: register from the environment, build the hub, register its URLs.
  registerRpcUrls(env);
  ({ hub, readers } = buildHub({ net: NET, env: { ...env, MULTICALL: '0' }, chains: [PLS] }));
  registerRpcUrls(env, readers.values());
});

describe('rpcHost: scheme://host[:port] only', () => {
  it('drops the path, query, fragment and userinfo, and keeps a port', () => {
    expect(rpcHost('https://eth-mainnet.g.alchemy.com/v2/abc123')).toBe('https://eth-mainnet.g.alchemy.com');
    expect(rpcHost('https://rpc.example.org/?apikey=abc123#x')).toBe('https://rpc.example.org');
    expect(rpcHost('https://me:pw123456@rpc.example.org:8545/path')).toBe('https://rpc.example.org:8545');
    expect(rpcHost('wss://ws.example.org/ws/v3/abc')).toBe('wss://ws.example.org');
    expect(rpcHost('https://rpc.pulsechain.com')).toBe('https://rpc.pulsechain.com');
    expect(rpcHost('not a url')).toBe('[rpc]');
    expect(rpcHost(null)).toBeNull();
  });
  it('a public URL with no path has nothing to register; a keyed one registers the key parts', () => {
    expect(rpcHasSecretParts('https://rpc.pulsechain.com')).toBe(false);
    expect(rpcHasSecretParts('https://rpc.pulsechain.com/')).toBe(false);
    expect(rpcSecretParts('https://ethereum-rpc.publicnode.com')).toEqual([]);
    const parts = rpcSecretParts(pathUrl);
    expect(parts).toEqual(expect.arrayContaining([pathUrl, KEY_PATH, KEY_QUERY]));
    expect(parts).not.toContain('v2');
    expect(rpcSecretParts(userUrl)).toEqual(expect.arrayContaining([KEY_PASS]));
  });
  it('userinfo in any URL is dropped from log text, registered or not', () => {
    expect(redact('see https://bob:FAKEother1234pass@other.example/x')).not.toContain('FAKEother1234pass');
  });
});

describe('the RPC still gets the full URL', () => {
  it('requests go to the keyed path and query, and userinfo still reaches the node', async () => {
    const r = readers.get(PLS.id)!;
    expect(r.urls).toEqual([pathUrl, userUrl]);
    node.seen.length = 0;
    expect(await r.getBlockNumber()).toBe(16);
    expect(node.seen.at(-1)!.url).toBe(`/v2/${KEY_PATH}?apikey=${KEY_QUERY}`);
    expect(r.currentUrl).toBe(pathUrl);
    // The userinfo endpoint, through the same provider factory the readers use.
    await makeRpc(userUrl, PLS.id).send('eth_blockNumber', []);
    expect(node.seen.at(-1)).toEqual({ url: '/', auth: `Basic ${Buffer.from(`rpcuser:${KEY_PASS}`).toString('base64')}` });
  });
});

describe('logs', () => {
  it('the boot lines, an ethers error with the URL, and a cut error never show a key; the log file is appended to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gridbot-rpc-'));
    const file = join(dir, 'server.log');
    writeFileSync(file, '{"t":1,"level":"info","msg":"from the last run"}\n');
    const printed: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { printed.push(a.join(' ')); }));
    try {
      const log = new Logger(false, 200, undefined);
      log.attach(file);
      for (const rt of hub.runtimes()) {
        const line = chainBootLine(rt, null);
        expect(line).toContain(`RPC ${origin} · paper only`); // host only before the logger sees it
        expect(leaks(line)).toEqual([]);
        log.info(line);
      }
      // A real ethers error from the node: SERVER_ERROR with info.requestUrl = the full keyed URL.
      node.st.fail = true;
      const err = await readers.get(PLS.id)!.send('eth_blockNumber', []).then(() => null, (e: Error) => e);
      node.st.fail = false;
      expect(err).toBeTruthy();
      expect(err!.message).toContain(KEY_PATH); // the raw error does carry the key: what this protects against
      log.error(`price DAI: ${err!.message}`);
      log.warn(err!.message.slice(0, err!.message.indexOf(KEY_PATH) + 10)); // cut inside the key, like .slice(0, 160)
      log.warn(`connect to ${userUrl.slice(0, userUrl.indexOf(KEY_PASS) + 12)}`); // cut inside the password
      log.warn(`direct ${pathUrl} and ${userUrl}`);
      const all = [...printed, ...log.entries.map((e) => e.msg), readFileSync(file, 'utf8')].join('\n');
      expect(leaks(all)).toEqual([]);
      expect(log.entries[0].msg).toContain(`RPC ${origin} `);
      expect(all).toContain(origin);
      expect(readFileSync(file, 'utf8').startsWith('{"t":1,"level":"info","msg":"from the last run"}\n')).toBe(true);
    } finally { for (const s of spies) s.mockRestore(); }
  });

  it('rpcErrorText redacts before it cuts to 160 characters', () => {
    // The key starts at character 150, so a cut at 160 keeps 10 characters of it.
    const head = `server response 500 (requestUrl=${origin}/v2/`;
    const msg = `server response 500 (${'x'.repeat(150 - head.length)}requestUrl=${pathUrl})`;
    expect(msg.indexOf(KEY_PATH)).toBe(150);
    const text = rpcErrorText(Object.assign(new Error(msg), { code: 'SERVER_ERROR' }));
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toContain(origin);
    expect(leaks(text)).toEqual([]);
  });

  it('an iPhone push built from an Activity message carries no key', () => {
    const p = buildPayload('tx_failed', `Grid DAI: couldn't send (server response 500 requestUrl=${pathUrl} via ${userUrl})`, { title: `GridBot · ${pathUrl}` });
    expect(leaks(JSON.stringify(p))).toEqual([]);
    expect(p.body).toContain(origin);
  });

  it('index.ts registers RPC URLs right after loadEnv and logs chains through chainBootLine', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'server', 'index.ts'), 'utf8');
    expect(src).toMatch(/loadEnv\(\);\n(?:\/\/.*\n)*registerRpcUrls\(process\.env\);/);
    expect(src).toMatch(/registerRpcUrls\(process\.env, readers\.values\(\)\);/);
    expect(src).toMatch(/log\.info\(chainBootLine\(rt, addr\)\)/);
    expect(src).not.toMatch(/currentUrl \?\? '\?'/);
  });
});

describe('status API', () => {
  let bot: MultiBot;
  let port: number;
  const get = (p: string, prt = port, headers: http.OutgoingHttpHeaders = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: prt, path: p, headers: { host: `127.0.0.1:${prt}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    }).on('error', reject);
  });

  beforeAll(async () => {
    bot = new MultiBot({ net: NET, reader: readers.get(PLS.id)!, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
    // One failed request on the keyed endpoint, so the status has an endpoint error that came from ethers.
    node.st.fail = true;
    await readers.get(PLS.id)!.send('eth_blockNumber', []).catch(() => undefined);
    node.st.fail = false;
    await readers.get(PLS.id)!.send('eth_blockNumber', []).catch(() => undefined);
    const app = createApp({ bot, net: NET, heartbeatMs: 60_000, statusThrottleMs: 60_000, system: { version: null, pollMs: 15_000 } });
    const srv = http.createServer(app);
    servers.push(srv);
    port = await listen(srv);
  });

  it('chainsStatus shows every RPC field as host only', () => {
    const c = bot.chainsStatus().find((x) => x.id === PLS.id)!;
    expect(c.rpc).toBe(origin);
    expect(c.rpcStatus!.url).toBe(rpcHost(readers.get(PLS.id)!.currentUrl));
    expect(c.rpcHealth!.current).toBe(c.rpcStatus!.url);
    expect(c.rpcHealth!.endpoints.map((e) => e.url)).toEqual([origin, origin]);
    expect(c.rpcHealth!.endpoints.some((e) => e.lastError)).toBe(true);
    const json = JSON.stringify(c);
    expect(leaks(json)).toEqual([]);
    expect(json).not.toContain('/v2/');
    expect(json).not.toContain('rpcuser');
  });

  it('/api/chains, /api/bot/status, /api/activity and the stream never carry a key', async () => {
    bot.activity.emitEvent({ type: 'error', kind: 'system', msg: `price read failed: GET ${pathUrl} ${userUrl}` });
    for (const p of ['/api/chains', '/api/bot/status', '/api/activity']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(leaks(r.body), p).toEqual([]);
    }
    const chains = JSON.parse((await get('/api/chains')).body).chains as { id: number; rpc: string }[];
    expect(chains.find((c) => c.id === PLS.id)!.rpc).toBe(origin);
    for (const v of ['', '?v=2']) {
      const body = await new Promise<string>((resolve, reject) => {
        let b = '';
        const req = http.get({ host: '127.0.0.1', port, path: `/api/bot/stream${v}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
          res.on('data', (c) => { b += c; if (b.includes('\n\n')) { req.destroy(); resolve(b); } });
        });
        req.on('error', (e) => { if (!b) reject(e); });
      });
      expect(body).toContain('event: hello');
      expect(body).toContain('price read failed');
      expect(leaks(body), `stream${v}`).toEqual([]);
    }
  });

  it('/api/system/check with every endpoint down: the ethers error is redacted', async () => {
    node.st.fail = true;
    try {
      const r = await get('/api/system/check');
      expect(r.status).toBe(200);
      expect(r.body).toMatch(/didn't answer/);
      expect(leaks(r.body)).toEqual([]);
    } finally { node.st.fail = false; }
  }, 30_000);

  it('the friends gateway passes the owner the same host-only answers', async () => {
    const secret = randomBytes(32), sessionKey = subKey(secret, 'session');
    const gate = new LoginGate();
    const owner = new OwnerLogin({ login: 'owner', pass: await hashPassword('correct horse battery'), session: 1 }, gate);
    const friends = new Friends(new MemoryStore<FriendsFile>(), secret, { gate, reserved: (n) => owner.isOwnerName(n) });
    friends.setHost({ name: 'Kyle', address: 'https://box.tail1.ts.net' });
    const gw = http.createServer(createGateway({
      friends, sessionKey, owner, hostPort: port, publicDir: null,
      copyState: () => 'running' as const, liveBots: async () => 0, signUp: async () => { throw new Error('unused'); }, setKey: async () => undefined,
      origins: () => ['https://box.tail1.ts.net'], publicHosts: () => ['box.tail1.ts.net'],
    }));
    servers.push(gw);
    const gwPort = await listen(gw);
    const cookie = `gb_session=${signSession(sessionKey, { f: HOST_ID, s: 1, e: Date.now() + 1e9, role: 'host' })}`;
    for (const p of ['/api/chains', '/api/bot/status']) {
      const r = await get(p, gwPort, { host: 'box.tail1.ts.net', cookie });
      expect(r.status, p).toBe(200);
      expect(r.body, p).toContain(origin);
      expect(leaks(r.body), p).toEqual([]);
    }
  });
});
