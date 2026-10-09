import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain } from './helpers/mockChain';

const P0 = 0.00001;
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 };

function make(chain = new MockChain(P0), store = new MemoryStore<MultiState>(), signer: MockChain | null = chain) {
  const log = new Logger(true);
  const bot = new MultiBot({ net: NET, reader: chain, signer, store, log, maxRetries: 1, retryDelayMs: 0 });
  return { chain, store, log, bot };
}

describe('MultiBot', () => {
  it('runs independent grids on different stables with global nonce order', async () => {
    const { chain, bot } = make();
    const dai = await bot.add({ mode: 'live', stable: 'DAI', ...base });
    const usdc = await bot.add({ mode: 'live', stable: 'USDC', ...base, lowerPrice: P0 * 0.88, upperPrice: P0 * 1.12 });
    expect(bot.status().grids).toHaveLength(2);

    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    // both may trigger; all nonces sequential, no gaps/dupes
    const nonces = chain.sent.map((s) => s.nonce);
    expect(nonces).toEqual([...nonces].sort((a, b) => a - b));
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(nonces[0]).toBe(0);
    expect(chain.sent.length).toBeGreaterThanOrEqual(2);

    const st = bot.status();
    const fills = st.grids.flatMap((g) => g.trades.filter((t: { failed?: boolean }) => !t.failed));
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(st.grids.map((g) => g.id).sort()).toEqual([dai, usdc].sort());
  });

  it('per-grid STOP leaves the other running; KILL ALL stops both', async () => {
    const { chain, bot } = make();
    const a = await bot.add({ mode: 'live', stable: 'DAI', ...base });
    const b = await bot.add({ mode: 'live', stable: 'USDT', ...base });
    bot.stop(a);
    expect(bot.status().grids.find((g) => g.id === a)!.status).toBe('stopped');
    expect(bot.status().grids.find((g) => g.id === b)!.status).toBe('running');
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    // only USDT grid should trade
    const traded = bot.status().grids.filter((g) => g.trades.length > 0).map((g) => g.stable);
    expect(traded.every((s) => s === 'USDT')).toBe(true);
    bot.stopAll();
    expect(bot.status().grids.every((g) => g.status === 'stopped')).toBe(true);
  });

  it('persists all grids and resumes after restart', async () => {
    const store = new MemoryStore<MultiState>();
    const chain = new MockChain(P0);
    const a = make(chain, store);
    await a.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    await a.bot.add({ mode: 'paper', stable: 'USDC', ...base });
    chain.setPrice(P0 * 0.975);
    await a.bot.tickAll();
    expect(store.data?.version).toBe(3);
    expect(store.data?.grids).toHaveLength(2);

    const b = make(chain, store);
    expect(b.bot.status().grids).toHaveLength(2);
    expect(b.bot.status().grids.every((g) => g.status === 'running')).toBe(true);
    const before = chain.sent.length;
    chain.setPrice(P0 * 1.005);
    await b.bot.tickAll();
    expect(chain.sent.length).toBe(before); // paper
    expect(b.bot.status().aggregate.realized).toBeGreaterThanOrEqual(0);
  });

  it('migrates v1 single-grid state', () => {
    const store = new MemoryStore<MultiState>();
    (store as unknown as { data: unknown }).data = {
      version: 1, mode: 'paper', network: 'mainnet', stable: 'DAI', status: 'stopped',
      config: { ...base }, limits: { maxPriceImpact: 0.03, slippageBps: 100, deadlineMinutes: 10 },
      levels: [], intervals: [], usdPerBuy: 5, queue: [], inFlight: null, trades: [],
      paperStartStable: 30, lastPrice: P0, lastPriceAt: Date.now(),
    };
    const { bot } = make(new MockChain(P0), store, null);
    expect(bot.status().grids).toHaveLength(1);
    expect(bot.status().grids[0].stable).toBe('DAI');
    expect(bot.status().grids[0].status).toBe('stopped');
  });

  it('rejects tight spacing unless allowTightSpacing', async () => {
    const { bot } = make(new MockChain(P0), undefined, null);
    await expect(bot.add({
      mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.98, upperPrice: P0 * 1.02, gridCount: 40, totalCapitalUsd: 50,
    })).rejects.toThrow(/round-trip/);
    const id = await bot.add({
      mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.98, upperPrice: P0 * 1.02, gridCount: 40, totalCapitalUsd: 50,
      allowTightSpacing: true,
    });
    expect(bot.status().grids.find((g) => g.id === id)!.spacingWarn).toMatch(/round-trip/);
  });

  it('restart keeps the grid on its own pair', async () => {
    const { bot } = make(new MockChain(P0), undefined, null);
    const id = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    bot.stop(id);
    await expect(bot.start(id, { mode: 'paper', stable: 'USDC', ...base })).rejects.toThrow(/pair can't change/);
    expect(bot.status().grids.find((g) => g.id === id)!.stable).toBe('DAI');
    await bot.start(id, { mode: 'paper', stable: 'DAI', ...base, lowerPrice: P0 * 0.88 });
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('running');
    expect(g.config!.lowerPrice).toBeCloseTo(P0 * 0.88);
  });

  it('restarting as live checks that the wallet covers the capital', async () => {
    const { chain, bot } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    bot.stop(id);
    chain.setBal('DAI', 10);
    await expect(bot.start(id, { mode: 'live', stable: 'DAI', ...base, totalCapitalUsd: 30 })).rejects.toThrow(/does not cover/);
    chain.setBal('DAI', 1000);
    await bot.start(id, { mode: 'live', stable: 'DAI', ...base, totalCapitalUsd: 30 });
    expect(bot.status().grids.find((g) => g.id === id)!.mode).toBe('live');
  });
});

  it('can run a PLS/HEX paper grid alongside DAI', async () => {
    const { chain, bot } = make(new MockChain(P0), undefined, null);
    await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    await bot.add({ mode: 'paper', stable: 'HEX', ...base, totalCapitalUsd: 20 });
    chain.setPrice(P0 * 0.975);
    await bot.tickAll();
    const hex = bot.status().grids.find((g) => g.stable === 'HEX')!;
    expect(hex.status).toBe('running');
    expect(hex.trades.some((t: { side: string }) => t.side === 'buy')).toBe(true);
    expect(bot.status().quotes).toEqual(expect.arrayContaining(['HEX', 'eHEX', 'PLSX', 'DAI']));
  });
