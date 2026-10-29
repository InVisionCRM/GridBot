/**
 * Audit a040: a live turn-on with "every chain" (no list) checks the signing key on every chain it would trade, and
 * one buy that fails does not stop the other pools of that tick.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
const pool = (chainId: number, n: number): FreshPool => ({
  chainId, pool: '0x' + String(n).padStart(4, '0') + 'e'.repeat(36), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + String(n).padStart(2, '0') + '3'.repeat(38), spend: '0x' + '22'.repeat(20), tokenSymbol: `T${n}`, spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40_000_000, tokenReserve: 1_000_000, feeBps: 29, price: 40, usdPerSpend: 0.00003,
});
const CHAINS = [{ id: 369, name: 'PulseChain', signer: true }, { id: 46630, name: 'Robinhood Chain', signer: false }];

function trader(chains: typeof CHAINS) {
  let wave = [pool(46630, 1), pool(369, 2)];
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => NOW, emit: () => {},
    sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => { const w = wave; wave = []; return w; }, assess: async () => clean(), resolve: async () => null, mark: async () => null,
    liveChains: () => chains,
    live: {
      buy: async (p, spend) => {
        if (p.chainId !== 369) throw new Error('no signing key');
        return { tokens: spend / p.price, spent: spend, spentUsd: spend * p.usdPerSpend, price: p.price, impact: 0.001 };
      },
      sell: async () => { throw new Error('unused'); },
      recover: async () => null,
    },
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe', maxImpact: 0.05, mode: 'live' });
  return t;
}

describe('token trader: signing keys on live chains', () => {
  it('"every chain" live turn-on names the chain without a key', () => {
    expect(() => trader(CHAINS).turnOn()).toThrow(/Robinhood Chain/);
  });
  it('picking only the chain with a key turns on', () => {
    const t = trader(CHAINS);
    t.configure({ chains: [369] });
    expect(() => t.turnOn()).not.toThrow();
  });
  it('one buy that fails does not stop the other pools of the tick', async () => {
    const t = trader(CHAINS.map((c) => ({ ...c, signer: true }))); // keys everywhere, but one chain's send fails
    t.turnOn();
    await t.tick();
    expect(t.status().positions.map((p) => p.chainId)).toEqual([369]);
    expect(t.status().lastError).toMatch(/no signing key/);
  });
});
