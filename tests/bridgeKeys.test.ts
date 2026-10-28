/**
 * Optional bridge quote keys and the Across integrator id.
 * Reads only process.env values this file sets. It does not load a .env file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Interface } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeProviders, type HttpClient } from '../src/server/bridge';
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

  it('refuses an invalid integrator id without printing the value', () => {
    for (const bad of ['zz', '0xabc', '0xdeadbeef', 'not-a-secret-id']) {
      clearBridgeEnv();
      process.env.ACROSS_INTEGRATOR_ID = bad;
      try {
        takeBridgeKeys();
        throw new Error('expected a refusal');
      } catch (e) {
        const message = (e as Error).message;
        expect(message).toMatch(/exactly 2 bytes/);
        expect(message).not.toContain(bad.replace(/^0x/i, ''));
        expect(message).not.toContain('not-a-secret');
      }
    }
  });

  it('sends integratorId on /swap/approval and the 1dc0de suffix only on depositV3', async () => {
    clearBridgeEnv();
    process.env.ACROSS_INTEGRATOR_ID = '0xabcd';
    const { clients, calls } = clientsFromEnv();
    const direct = await clients.across.quote(requestOf(LEGS[0]));
    expect(direct.deposit.data.endsWith('1dc0deabcd')).toBe(true);
    const req = requestOf(LEGS[0]);
    const decoded = decodeDeposit('across', direct.deposit.data, req, direct.deposit.to);
    const [, amount] = APPROVE.decodeFunctionData('approve', direct.approval!.data);
    expect(amount).toBe(decoded.pullAmount);
    expect(decoded.pullAmount).toBe(req.amountIn);

    const swap = await clients.across.quote(requestOf(LEGS[2]));
    const url = new URL(calls.at(-1)!.url);
    expect(url.pathname.endsWith('/swap/approval')).toBe(true);
    expect(url.searchParams.get('integratorId')).toBe('0xabcd');
    expect(swap.deposit.data).not.toContain('1dc0de');
  });
});
