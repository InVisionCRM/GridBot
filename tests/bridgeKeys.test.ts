/**
 * Optional bridge quote keys and the Across integrator id.
 * Reads only process.env values this file sets. It does not load a .env file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Interface } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { bootBridgeClients, createBridgeProviders, sanitizeText, type HttpClient } from '../src/server/bridge';
import { Logger, REDACT_FLOOR, registerSecret } from '../src/server/bot/logger';
import { decodeDeposit } from '../src/server/bridge/allow';
import { acrossIntegratorId, bridgeConfigured, bridgeProviderConfig, shortQuoteKeyWarnings, takeBridgeKeys } from '../src/server/env';
import { acrossSuggested, acrossSwap, requestOf, LEGS, NOW_MS } from './fixtures/bridgeFixtures';

const NAMES = ['ACROSS_API_KEY', 'RELAY_API_KEY', 'LIFI_API_KEY', 'ACROSS_INTEGRATOR_ID'] as const;
const KEY = 'DummyBridgeKey0123456789abcd';
const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);

const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

function clearBridgeEnv() {
  for (const name of NAMES) delete process.env[name];
}

afterEach(() => {
  clearBridgeEnv();
  takeBridgeKeys();
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(path) ? [path] : [];
  });
}

function clientsFromEnv(logs: string[] = []) {
  takeBridgeKeys();
  const quoteKeys = bridgeProviderConfig();
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const http: HttpClient = async (req) => {
    calls.push({ url: req.url, headers: { ...req.headers } });
    const url = new URL(req.url);
    const body = url.pathname.endsWith('/swap/approval') ? acrossSwap(LEGS[2]) : acrossSuggested(LEGS[0]);
    return { status: 200, body, retryAfterMs: null };
  };
  const clients = createBridgeProviders({
    keys: {
      ...(quoteKeys.across ? { across: quoteKeys.across.apiKey } : {}),
      ...(quoteKeys.relay ? { relay: quoteKeys.relay.apiKey } : {}),
      ...(quoteKeys.lifi ? { lifi: quoteKeys.lifi.apiKey } : {}),
    },
    integratorId: acrossIntegratorId(),
    http,
    now: () => NOW_MS,
    sleep: async () => {},
    log: (_level, msg) => logs.push(msg),
  });
  return { clients, calls };
}

describe('bridge quote keys and integrator id', () => {
  it('keeps an unset key keyless and out of the client sources', () => {
    clearBridgeEnv();
    expect(takeBridgeKeys()).toEqual({ across: false, relay: false, lifi: false });
    expect(bridgeProviderConfig()).toEqual({ across: null, relay: null, lifi: null });
    expect(acrossIntegratorId()).toBeUndefined();
    expect(JSON.stringify(bridgeConfigured())).not.toMatch(/key/i);
    const root = join(__dirname, '..', 'src');
    for (const path of files(root)) {
      const rel = relative(root, path);
      if (rel === join('server', 'env.ts')) continue;
      const code = readFileSync(path, 'utf8');
      expect(code, rel).not.toMatch(/ACROSS_API_KEY|RELAY_API_KEY|LIFI_API_KEY|ACROSS_INTEGRATOR_ID/);
    }
  });

  it('refuses a key under 6 characters without echoing it', () => {
    clearBridgeEnv();
    process.env.ACROSS_API_KEY = 'abcde';
    expect(takeBridgeKeys()).toEqual({ across: false, relay: false, lifi: false });
    expect(bridgeProviderConfig().across).toBeNull();
    const warnings = shortQuoteKeyWarnings().join('\n');
    expect(warnings).toContain('ACROSS_API_KEY was refused');
    expect(warnings).not.toContain('abcde');
  });

  it('does not put a dummy key in a logged error or a serialized config', async () => {
    clearBridgeEnv();
    process.env.ACROSS_API_KEY = KEY;
    process.env.RELAY_API_KEY = KEY;
    process.env.LIFI_API_KEY = KEY;
    expect(takeBridgeKeys()).toEqual({ across: true, relay: true, lifi: true });
    expect(process.env.ACROSS_API_KEY).toBeUndefined();
    expect(JSON.stringify(bridgeConfigured())).not.toContain(KEY);
    const logs: string[] = [];
    const http: HttpClient = async () => { throw new Error(`connect failed ${KEY}`); };
    const quoteKeys = bridgeProviderConfig();
    const clients = createBridgeProviders({
      keys: {
        across: quoteKeys.across!.apiKey,
        relay: quoteKeys.relay!.apiKey,
        lifi: quoteKeys.lifi!.apiKey,
      },
      http,
      now: () => NOW_MS,
      sleep: async () => {},
      log: (_level, msg) => logs.push(msg),
    });
    const thrown = await clients.across.quote(requestOf(LEGS[0])).then(() => '', (e: unknown) => String(e));
    expect(logs.join('\n')).not.toContain(KEY);
    expect(thrown).not.toContain(KEY);
    expect(JSON.stringify({ configured: bridgeConfigured() })).not.toContain(KEY);
  });

  it('sends each key as that provider documents, and not on the URL', async () => {
    clearBridgeEnv();
    process.env.ACROSS_API_KEY = KEY;
    process.env.RELAY_API_KEY = KEY;
    process.env.LIFI_API_KEY = KEY;
    const { clients, calls } = clientsFromEnv();
    await clients.across.quote(requestOf(LEGS[0]));
    await clients.relay.quote(requestOf(LEGS[2])).catch(() => undefined);
    await clients.lifi.quote(requestOf(LEGS[2])).catch(() => undefined);
    const across = calls.find((c) => c.url.includes('across.to'))!;
    const relay = calls.find((c) => c.url.includes('relay.link'))!;
    const lifi = calls.find((c) => c.url.includes('li.quest'))!;
    expect(across.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(relay.headers['x-api-key']).toBe(KEY);
    expect(lifi.headers['x-lifi-api-key']).toBe(KEY);
    for (const call of calls) expect(call.url).not.toContain(KEY);
  });

  it('leaves the integrator id off when it is unset', async () => {
    clearBridgeEnv();
    const { clients, calls } = clientsFromEnv();
    const quote = await clients.across.quote(requestOf(LEGS[0]));
    expect(calls[0].url).not.toContain('integratorId');
    expect(quote.deposit.data).not.toContain('1dc0de');
    await clients.across.quote(requestOf(LEGS[2]));
    expect(calls.at(-1)!.url).not.toContain('integratorId');
  });

  it('accepts a 2-byte integrator id with or without 0x', () => {
    clearBridgeEnv();
    process.env.ACROSS_INTEGRATOR_ID = '0xAbCd';
    takeBridgeKeys();
    expect(acrossIntegratorId()).toBe('abcd');
    clearBridgeEnv();
    process.env.ACROSS_INTEGRATOR_ID = 'abcd';
    takeBridgeKeys();
    expect(acrossIntegratorId()).toBe('abcd');
  });

  it('refuses an invalid integrator id without printing the value', async () => {
    for (const bad of ['zz', '0xabc', '0xdeadbeef', 'not-a-secret-id', 'dead1']) {
      clearBridgeEnv();
      process.env.ACROSS_API_KEY = KEY;
      process.env.ACROSS_INTEGRATOR_ID = bad;
      expect(takeBridgeKeys()).toEqual({ across: true, relay: false, lifi: false });
      expect(acrossIntegratorId()).toBeUndefined();
      const warnings = shortQuoteKeyWarnings().join('\n');
      expect(warnings).toContain('ACROSS_INTEGRATOR_ID was refused');
      expect(warnings).not.toContain(bad);
      expect(warnings).not.toContain('not-a-secret');
    }
    clearBridgeEnv();
    process.env.ACROSS_API_KEY = KEY;
    process.env.ACROSS_INTEGRATOR_ID = 'dead1';
    const { clients, calls } = clientsFromEnv();
    expect(acrossIntegratorId()).toBeUndefined();
    expect(shortQuoteKeyWarnings().join('\n')).toContain('ACROSS_INTEGRATOR_ID was refused');
    expect(shortQuoteKeyWarnings().join('\n')).not.toContain('dead1');
    const quote = await clients.across.quote(requestOf(LEGS[0]));
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(quote.deposit.data).not.toContain('1dc0de');
    const req = requestOf(LEGS[0]);
    for (const suffix of ['1dc0deabcd', '1dc0dedead', '1dc0de1234', '1dc0de']) {
      expect(() => decodeDeposit('across', `${quote.deposit.data}${suffix}`, req, quote.deposit.to, acrossIntegratorId())).toThrow(/not canonical/);
    }
  });

  it('a typo in optional ACROSS_INTEGRATOR_ID does not stop boot', () => {
    const log = new Logger(true);
    for (const id of ['dead1', '0xdea', 'f00l', '0x0xdead']) {
      clearBridgeEnv();
      process.env.ACROSS_API_KEY = KEY;
      process.env.ACROSS_INTEGRATOR_ID = id;
      let r = 'ok';
      try { takeBridgeKeys(); } catch (e) { r = `THROWS ${(e as Error).message}`; }
      expect(r).toBe('ok');
      expect(acrossIntegratorId()).toBeUndefined();
      expect(bridgeProviderConfig().across).toEqual({ apiKey: KEY });
      for (const msg of shortQuoteKeyWarnings()) log.warn(msg);
      const logged = log.entries.map((e) => e.msg).join('\n');
      expect(logged).toContain('ACROSS_INTEGRATOR_ID was refused');
      expect(logged).not.toContain(id);
    }
  });

  it('sends integratorId on /swap/approval and the 1dc0de suffix only on depositV3', async () => {
    clearBridgeEnv();
    process.env.ACROSS_INTEGRATOR_ID = '0xabcd';
    const { clients, calls } = clientsFromEnv();
    const direct = await clients.across.quote(requestOf(LEGS[0]));
    expect(direct.deposit.data.endsWith('1dc0deabcd')).toBe(true);
    const req = requestOf(LEGS[0]);
    const decoded = decodeDeposit('across', direct.deposit.data, req, direct.deposit.to, 'abcd');
    const [, amount] = APPROVE.decodeFunctionData('approve', direct.approval!.data);
    expect(amount).toBe(decoded.pullAmount);
    expect(decoded.pullAmount).toBe(req.amountIn);

    const swap = await clients.across.quote(requestOf(LEGS[2]));
    const url = new URL(calls.at(-1)!.url);
    expect(url.pathname.endsWith('/swap/approval')).toBe(true);
    expect(url.searchParams.get('integratorId')).toBe('0xabcd');
    expect(swap.deposit.data).not.toContain('1dc0de');
  });

  it('accepts a 6-character key and refuses one of 5', () => {
    clearBridgeEnv();
    process.env.ACROSS_API_KEY = 'Ab3_x9';
    expect('Ab3_x9').toHaveLength(6);
    expect(takeBridgeKeys().across).toBe(true);
    expect(bridgeProviderConfig().across).toEqual({ apiKey: 'Ab3_x9' });
    clearBridgeEnv();
    process.env.RELAY_API_KEY = 'qK7m2';
    expect('qK7m2').toHaveLength(5);
    expect(takeBridgeKeys().relay).toBe(false);
    expect(shortQuoteKeyWarnings()).toEqual(['RELAY_API_KEY was refused']);
  });

  it('redacts a 6-character key echoed in a 401 body, the thrown error, and the log', async () => {
    const key = 'Ab3_x9';
    expect(key).toHaveLength(REDACT_FLOOR);
    const logs: string[] = [];
    const http: HttpClient = async () => ({ status: 401, body: { message: `Invalid API key ${key}` }, retryAfterMs: null });
    const clients = createBridgeProviders({
      keys: { across: key },
      http,
      now: () => NOW_MS,
      sleep: async () => {},
      log: (_level, msg) => logs.push(msg),
    });
    const thrown = await clients.across.quote(requestOf(LEGS[0])).then(() => '', (e: unknown) => String(e));
    expect(thrown).toContain('[REDACTED]');
    expect(thrown).not.toContain(key);
    expect(logs.join('\n')).toContain('[REDACTED]');
    expect(logs.join('\n')).not.toContain(key);
    expect(sanitizeText(`Invalid API key ${key}`, [key])).toBe('Invalid API key [REDACTED]');
    const log = new Logger(true);
    registerSecret(key, REDACT_FLOOR);
    log.error(`Invalid API key ${key}`);
    expect(log.entries.map((e) => e.msg).join('\n')).toBe('Invalid API key [REDACTED]');
  });

  it('refuses a spaced, punctuated, or oversized key without echoing it', () => {
    clearBridgeEnv();
    const spaced = 'abc def gh';
    const punctuated = 'key!with@chars';
    const oversized = 'A'.repeat(300);
    process.env.ACROSS_API_KEY = spaced;
    process.env.RELAY_API_KEY = punctuated;
    process.env.LIFI_API_KEY = oversized;
    expect(takeBridgeKeys()).toEqual({ across: false, relay: false, lifi: false });
    const warnings = shortQuoteKeyWarnings();
    expect(warnings).toEqual(['ACROSS_API_KEY was refused', 'RELAY_API_KEY was refused', 'LIFI_API_KEY was refused']);
    const text = warnings.join('\n');
    expect(text).not.toContain(spaced);
    expect(text).not.toContain(punctuated);
    expect(text).not.toContain(oversized.slice(0, 12));
    expect(text).not.toMatch(/\d/);
  });

  it('starts keyless when a bad key is handed to client construction', async () => {
    const bad = 'abc def gh';
    const logs: string[] = [];
    const calls: string[] = [];
    const http: HttpClient = async (req) => {
      calls.push(req.url);
      expect(req.headers.Authorization).toBeUndefined();
      expect(JSON.stringify(req.headers)).not.toContain(bad);
      return { status: 200, body: acrossSuggested(LEGS[0]), retryAfterMs: null };
    };
    const clients = bootBridgeClients({
      keys: { across: bad },
      http,
      now: () => NOW_MS,
      sleep: async () => {},
      log: (_level, msg) => logs.push(msg),
    });
    expect(logs).toEqual(['bridge quote clients were not started']);
    expect(logs.join('\n')).not.toContain(bad);
    const quote = await clients.across.quote(requestOf(LEGS[0]));
    expect(quote.amountIn).toBe(LEGS[0].amountIn);
    expect(calls).toHaveLength(1);
    const index = readFileSync(join(__dirname, '..', 'src', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('bootBridgeClients(');
    expect(index).not.toContain('createBridgeProviders(');
  });

  it('rejects an integrator id that is not 4 hex characters, and lowercases a valid one', async () => {
    expect(() => createBridgeProviders({ integratorId: 'zzzz' })).toThrow(/^across: integrator id was rejected$/);
    try {
      createBridgeProviders({ integratorId: 'zzzz' });
    } catch (e) {
      expect(String(e)).not.toContain('zzzz');
    }
    const calls: string[] = [];
    const http: HttpClient = async (req) => {
      calls.push(req.url);
      const url = new URL(req.url);
      const body = url.pathname.endsWith('/swap/approval') ? acrossSwap(LEGS[2]) : acrossSuggested(LEGS[0]);
      return { status: 200, body, retryAfterMs: null };
    };
    const clients = createBridgeProviders({
      integratorId: '0xABCD',
      http,
      now: () => NOW_MS,
      sleep: async () => {},
    });
    const direct = await clients.across.quote(requestOf(LEGS[0]));
    expect(direct.deposit.data.endsWith('1dc0deabcd')).toBe(true);
    expect(direct.deposit.data).not.toContain('ABCD');
    const swap = await clients.across.quote(requestOf(LEGS[2]));
    expect(new URL(calls.at(-1)!).searchParams.get('integratorId')).toBe('0xabcd');
    expect(swap.deposit.data).not.toContain('1dc0de');
  });
});
