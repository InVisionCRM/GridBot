import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import { Logger, redact } from '../src/server/bot/logger';
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
  it('frontend code never touches keys or signing', () => {
    for (const [f, code] of src) {
      if (f.startsWith(join('src', 'server'))) continue;
      expect(/privateKey|PRIVATE_KEY|mnemonic|sendTransaction|eth_sign|signMessage/i.test(code) || /\bWallet\b/.test(code), f).toBe(false);
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
  it('.env is gitignored and .env.example holds only a placeholder', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\.env$/m);
    expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
