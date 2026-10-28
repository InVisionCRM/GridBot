import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import { Logger, REDACT_FLOOR, redact, registerSecret } from '../src/server/bot/logger';
import { bridgeConfigured, bridgeProviderConfig, bridgeQuoteRequest, shortQuoteKeyWarnings, takeBridgeKeys } from '../src/server/env';
import { Router, type RouterFile } from '../src/server/router/router';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain } from './helpers/mockChain';

const root = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}
const src = files(join(root, 'src')).map((f) => [relative(root, f), readFileSync(f, 'utf8')] as const);

describe('private key handling', () => {
  it('only src/server/env.ts reads PRIVATE_KEY or constructs a Wallet', () => {
    for (const [f, code] of src) {
      if (f === join('src', 'server', 'env.ts')) continue;
      expect(/process\.env\.PRIVATE_KEY|new\s+Wallet\s*\(/.test(code), f).toBe(false);
    }
  });
  it('only src/server/env.ts reads bridge quote keys', () => {
    for (const [f, code] of src) {
      if (f === join('src', 'server', 'env.ts')) continue;
      expect(/ACROSS_API_KEY|RELAY_API_KEY|LIFI_API_KEY/.test(code), f).toBe(false);
    }
    const env = src.find(([f]) => f.endsWith(join('server', 'env.ts')))![1];
    expect(env).toMatch(/ACROSS_API_KEY/);
    expect(env).toMatch(/delete process\.env\[name\]/);
  });
  it('frontend code never touches keys or signing', () => {
    for (const [f, code] of src) {
      if (f.startsWith(join('src', 'server'))) continue;
      // The word "Wallet" in a sentence is a balance. A signer is `new Wallet` or an import of Wallet.
      expect(/privateKey|PRIVATE_KEY|mnemonic|sendTransaction|eth_sign|signMessage/i.test(code), f).toBe(false);
      expect(/new\s+Wallet\b|import\s*\{[^}]*\bWallet\b/.test(code), f).toBe(false);
    }
  });
  it('env.ts deletes the key from process.env and never logs it', () => {
    const env = src.find(([f]) => f.endsWith(join('server', 'env.ts')))![1];
    expect(env).toMatch(/delete process\.env\.PRIVATE_KEY/);
    expect(/console\.|log\.(info|warn|error)/.test(env)).toBe(false);
  });
  it('createSigner: removes env var, redacts key from logs, never exposes it in state/status', async () => {
    const { createSigner } = await import('../src/server/env');
    const key = Wallet.createRandom().privateKey;
    process.env.PRIVATE_KEY = key;
    const wallet = createSigner({} as never)!;
    expect(process.env.PRIVATE_KEY).toBeUndefined();
    expect(redact(`oops ${key} and ${key.slice(2)}`)).toBe('oops [REDACTED] and [REDACTED]');
    const log = new Logger(true);
    log.error(`leak ${key}`);
    expect(log.entries[0].msg).not.toContain(key.slice(2));

    const chain = new MockChain();
    const store = new MemoryStore<BotState>();
    const signer = { getAddress: () => wallet.getAddress(), sendTransaction: chain.sendTransaction.bind(chain) };
    const engine = new GridEngine({ net: NET, reader: chain, signer, store, log });
    await engine.start({ mode: 'paper', lowerPrice: 0.000009, upperPrice: 0.000011, gridCount: 10, totalCapitalUsd: 10 });
    await engine.tick();
    const blob = JSON.stringify(engine.status()) + JSON.stringify(store.data) + JSON.stringify(log.entries);
    expect(blob).not.toContain(key.slice(2).toLowerCase());
    expect(blob).not.toContain(key.slice(2));
    expect(await engine.walletAddress()).toBe(wallet.address);
  });
  it('rejects a malformed key without echoing it', async () => {
    const { createSigner } = await import('../src/server/env');
    process.env.PRIVATE_KEY = 'not-a-key-SECRETVALUE';
    expect(() => createSigner({} as never)).toThrow(/^PRIVATE_KEY in \.env is not/);
    try { process.env.PRIVATE_KEY = 'not-a-key-SECRETVALUE'; createSigner({} as never); } catch (e) { expect((e as Error).message).not.toContain('SECRETVALUE'); }
  });
  it('bridge quote keys are registered so redact masks them', async () => {
    const { createBridgeProviders } = await import('../src/server/bridge');
    const key = 'BridgeQuoteKey0123456789abcdEF';
    createBridgeProviders({
      keys: { across: key, relay: key, lifi: key },
      http: async () => ({ status: 200, body: {}, retryAfterMs: null }),
    });
    expect(redact(`leak ${key}`)).toBe('leak [REDACTED]');
    expect(redact(`header ${key}`)).not.toContain(key);
  });
  it('.env is gitignored and .env.example holds only a placeholder', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\.env$/m);
    expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
  it('vite define does not inject quote keys or private keys into the client bundle', () => {
    const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(vite).not.toMatch(/ACROSS_API_KEY|RELAY_API_KEY|LIFI_API_KEY|PRIVATE_KEY/);
    const defineAt = vite.search(/\bdefine\s*:/);
    if (defineAt >= 0) expect(vite.slice(defineAt)).not.toMatch(/process\.env/);
  });
  it('quote keys are taken before the friend-copy environment is snapshotted', () => {
    const index = readFileSync(join(root, 'src', 'server', 'index.ts'), 'utf8');
    const take = index.lastIndexOf('takeBridgeKeys(');
    const snap = index.indexOf('...process.env');
    expect(take).toBeGreaterThanOrEqual(0);
    expect(snap).toBeGreaterThan(take);
    expect(index).toMatch(/for \(const msg of shortQuoteKeyWarnings\(\)\) log\.warn\(msg\)/);
  });
  it('a built client bundle does not contain quote key or private key names', () => {
    const dir = join(root, 'dist', 'client');
    if (!existsSync(dir)) return;
    const names = ['ACROSS_API_KEY', 'RELAY_API_KEY', 'LIFI_API_KEY', 'PRIVATE_KEY'];
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(js|css|html|map)$/.test(p) ? [p] : [];
    });
    for (const file of walk(dir)) {
      const text = readFileSync(file, 'utf8');
      for (const name of names) expect(text, file).not.toContain(name);
    }
  });
  it('redacts a configured quote key shorter than 16 characters', () => {
    const key = 'rk_short_1';
    expect(key.length).toBeLessThan(16);
    delete process.env.ACROSS_API_KEY;
    delete process.env.RELAY_API_KEY;
    delete process.env.LIFI_API_KEY;
    process.env.RELAY_API_KEY = key;
    try {
      expect(takeBridgeKeys()).toMatchObject({ relay: true });
      expect(redact(`leak ${key}`)).toBe('leak [REDACTED]');
      const log = new Logger(true);
      log.error(`leak ${key}`);
      expect(log.entries[0].msg).toContain('[REDACTED]');
      expect(log.entries[0].msg).not.toContain(key);
    } finally {
      delete process.env.ACROSS_API_KEY;
      delete process.env.RELAY_API_KEY;
      delete process.env.LIFI_API_KEY;
    }
  });
  it('does not redact a quote key shorter than the floor, and warns with the name only', () => {
    const one = '§';
    const five = 'qK7m2';
    const six = 'qK7m2p';
    expect(one).toHaveLength(1);
    expect(five).toHaveLength(REDACT_FLOOR - 1);
    expect(six).toHaveLength(REDACT_FLOOR);
    delete process.env.ACROSS_API_KEY;
    delete process.env.RELAY_API_KEY;
    delete process.env.LIFI_API_KEY;
    process.env.ACROSS_API_KEY = one;
    process.env.RELAY_API_KEY = five;
    process.env.LIFI_API_KEY = six;
    try {
      expect(takeBridgeKeys()).toEqual({ across: false, relay: false, lifi: true });
      expect(bridgeConfigured()).toEqual({ across: false, relay: false, lifi: true });
      expect(redact(`${one} ${five} ${six}`)).toBe(`${one} ${five} [REDACTED]`);
      registerSecret(one, 1);
      expect(redact(one)).toBe(one);
      const warnings = shortQuoteKeyWarnings();
      expect(warnings).toEqual(['ACROSS_API_KEY was refused', 'RELAY_API_KEY was refused']);
      const text = warnings.join('\n');
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain(one);
      expect(text).not.toContain(five);
      expect(text).not.toContain(six);
      const log = new Logger(true);
      for (const msg of warnings) log.warn(msg);
      const logged = log.entries.map((e) => e.msg).join('\n');
      expect(logged).toContain('ACROSS_API_KEY');
      expect(logged).not.toContain(one);
      expect(logged).not.toContain(five);
      expect(logged).not.toMatch(/\d/);
    } finally {
      delete process.env.ACROSS_API_KEY;
      delete process.env.RELAY_API_KEY;
      delete process.env.LIFI_API_KEY;
    }
  });
  it('a refused short quote key is absent from provider config, status, and every request', async () => {
    const one = '§';
    const five = 'Zm4qL';
    const six = 'pT8nQw';
    delete process.env.ACROSS_API_KEY;
    delete process.env.RELAY_API_KEY;
    delete process.env.LIFI_API_KEY;
    process.env.ACROSS_API_KEY = one;
    process.env.RELAY_API_KEY = five;
    process.env.LIFI_API_KEY = six;
    try {
      const configured = takeBridgeKeys();
      expect(configured).toEqual({ across: false, relay: false, lifi: true });
      expect(bridgeConfigured()).toEqual(configured);
      expect(process.env.ACROSS_API_KEY).toBeUndefined();
      expect(process.env.RELAY_API_KEY).toBeUndefined();
      expect(bridgeProviderConfig()).toEqual({ across: null, relay: null, lifi: { apiKey: six } });
      const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: [1], configured });
      expect(router.status().configured).toEqual({ across: false, relay: false, lifi: true });
      expect(router.status().on).toBe(false);
      expect(JSON.stringify(router.status())).not.toContain(one);
      expect(JSON.stringify(router.status())).not.toContain(five);

      const warnings = shortQuoteKeyWarnings();
      expect(warnings).toEqual(['ACROSS_API_KEY was refused', 'RELAY_API_KEY was refused']);
      const log = new Logger(true);
      for (const msg of warnings) log.warn(msg);
      const logged = log.entries.map((e) => e.msg).join('\n');
      expect(logged).toBe(warnings.join('\n'));
      expect(logged).not.toContain(one);
      expect(logged).not.toContain(five);
      expect(logged).not.toContain(six);
      expect(logged).not.toMatch(/\d/);

      const sent: string[] = [];
      for (const provider of ['across', 'relay', 'lifi'] as const) {
        const req = bridgeQuoteRequest(provider, 'https://quotes.example/route', {
          headers: { accept: 'application/json' },
          body: '{"amount":"1"}',
        });
        if (provider !== 'lifi') expect(req.headers).not.toHaveProperty('Authorization');
        const request = new Request(req.url, { method: 'POST', headers: req.headers, body: req.body });
        const headerText = [...request.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
        sent.push(`${request.url}\n${headerText}\n${await request.text()}`);
      }
      const wire = sent.join('\n');
      expect(wire).not.toContain(one);
      expect(wire).not.toContain(five);
      expect(sent[0]).not.toMatch(/authorization/i);
      expect(sent[1]).not.toMatch(/authorization/i);
    } finally {
      delete process.env.ACROSS_API_KEY;
      delete process.env.RELAY_API_KEY;
      delete process.env.LIFI_API_KEY;
    }
  });
});
