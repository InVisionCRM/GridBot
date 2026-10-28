/**
 * Crypto units only, server side: reasons, feed items, activity messages, safety notes and errors that reach a screen
 * or a push notification never print a dollar amount. Dollar-only figures (pool liquidity, floors, trade sizes) read
 * "≈ N ETH" from the hub's native/stable ETH price, or "—" without one; the gates themselves still compare dollars.
 * Scans the server-side sources for dollar formatting in string literals; the internal-only helpers are listed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ethUsdFromChains, ethUsdNow, registerHubEthUsd, setEthUsdSource, usdAsEth } from '../src/lib/ethUnits';

const ROOT = new URL('../src/', import.meta.url).pathname;
const SCOPES = ['server', 'market', 'plays', 'live', 'metrics', 'bot', 'lib'];
/** Never shown to a user: kept, and listed in the PR. */
const INTERNAL = new Set([
  'lib/format.ts', // formatUsd: unused by any screen
  'live/holdingsMath.ts', // formatUsdAmount / formatUsdChip: API-side helpers, no screen uses them
  'backtest/report.ts', // CLI backtest report ("USD/day" secondary line)
  'market/lpCandleReplay.ts', // range replay report, written only by scripts/lpRangeReplay.ts (not served or shown)
]);
const DOLLAR = /\$\$\{|['"`]\$\d|[\s(]\$\d|≈\s?\$(?!\{)|\d\s?USD\b|\}\s?USD\b|\bUSD (a|open|after|test)\b/;

function files(dir: string): string[] {
  let out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

afterEach(() => setEthUsdSource(null));

describe('dollar-only figures in screen text', () => {
  it('read "≈ N ETH" at the ETH price, "—" without one', () => {
    expect(usdAsEth(80_000, 2500)).toBe('≈ 32 ETH');
    expect(usdAsEth(45, 2500)).toBe('≈ 0.018 ETH');
    expect(usdAsEth(80_000, null)).toBe('—');
    setEthUsdSource(null);
    registerHubEthUsd(() => null);
    expect(usdAsEth(80_000)).toBe('—');
    registerHubEthUsd(() => 2341.0064);
    expect(ethUsdNow()).toBeCloseTo(2341.0064, 4);
    setEthUsdSource(() => 2500); // a pinned price wins over the hub's
    expect(usdAsEth(10_000)).toBe('≈ 4 ETH');
  });
  it('ETH price: Ethereum first, then any ETH-native chain; PLS alone has none', () => {
    const cs = [{ id: 369, nativeSymbol: 'PLS', nativeUsd: 0.000005 }, { id: 4663, nativeSymbol: 'ETH', nativeUsd: 2341.179 }, { id: 1, nativeSymbol: 'ETH', nativeUsd: 2341.0064 }];
    expect(ethUsdFromChains(cs)).toBe(2341.0064);
    expect(ethUsdFromChains(cs.filter((c) => c.id !== 1))).toBe(2341.179);
    expect(ethUsdFromChains(cs.slice(0, 1))).toBeNull();
  });
});

describe('no dollar formatting in server-side strings', () => {
  it(`${SCOPES.join(', ')}: only the listed internal helpers`, () => {
    const hits: string[] = [];
    for (const scope of SCOPES) {
      let list: string[] = [];
      try { list = files(join(ROOT, scope)); } catch { continue; }
      for (const f of list) {
        const rel = f.slice(ROOT.length);
        if (INTERNAL.has(rel)) continue;
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          // a bare '$1' literal is a regex replacement back-reference, not money
          const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/(['"`])\$\d\1/g, '');
          if (/^\s*\*/.test(line)) return;
          if (DOLLAR.test(code)) hits.push(`${rel}:${i + 1}: ${code.trim().slice(0, 140)}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
