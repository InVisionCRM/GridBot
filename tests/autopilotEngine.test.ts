import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { Autopilot, DEFAULT_OPTIONS, type AutopilotState, type ScanView } from '../src/server/bot/autopilot';
import { HOLD_MS } from '../src/market/autopilot';
import type { Opportunity } from '../src/market/scan';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;

/** PLS/DAI as the scan would show it: a grid that earned, swinging `swing` a day */
function daiOpp(swing: number, o: Partial<Opportunity> = {}): Opportunity {
  return {
    chainId: NET.chainId, key: 'DAI', add: null, label: 'PLS/DAI', spend: 'DAI', stack: 'PLS', dex: 'pulsex-v2', kind: 'v2', feeBps: 29, ...o,
    risk: null, riskWhy: null, liveAllowed: true, price: P0, movePct: 0, swingPct: swing, activity: null, capital: 1000, usd: 1000,
    grid: { bandPct: 0.12, gridCount: 10, earnedPct: 0.02, roundTrips: 8, returnPct: 0, maxDrawdownPct: 0 }, gridWhy: null, lp: null, lpWhy: 'v2',
  };
}

function setup() {
  let now = 1_800_000_000_000;
  const chain = new MockChain(P0);
  const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => now });
  let scan: ScanView = { at: 1, chains: [{ chainId: NET.chainId, items: [daiOpp(0.3)] }] };
  const store = new MemoryStore<AutopilotState>();
  const ap = new Autopilot({ bot, store, emit: () => undefined, scan: async () => scan, now: () => now });
  ap.configure({ mode: 'paper', options: { ...DEFAULT_OPTIONS, slots: 1 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] });
  return { chain, bot, ap, store, setScan: (s: ScanView) => { scan = s; }, later: (ms: number) => { now += ms; } };
}

describe('smart trader (paper, mock chain)', () => {
  it('turned on, it opens the best pool with the budget and tracks what it is worth', async () => {
    const { bot, ap } = setup();
    await ap.turnOn();
    const [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(1);
    expect(a.bots[0]).toMatchObject({ kind: 'grid', label: 'PLS/DAI', market: 'DAI', capital: 300 });
    expect(a.coins.DAI ?? 0).toBeCloseTo(0, 9);
    const g = bot.status().grids.find((x) => x.id === a.bots[0].id)!;
    expect(g).toMatchObject({ mode: 'paper', status: 'running', config: { totalCapitalUsd: 300, gridCount: 10 } });
    expect(g.config!.lowerPrice / g.config!.upperPrice).toBeCloseTo(0.88 / 1.12, 12); // ±12% around the price
    await bot.tickAll();
    expect(ap.status().accounts[0].value).toBeGreaterThan(290);
    expect(ap.status().log.map((l) => l.msg).join('\n')).toMatch(/opened PLS\/DAI as a grid ±12%, 10 levels with 300 DAI: #1 of 1/);
  });

  it('keeps a bot its first week; after it, a pool that stopped earning is closed to cash and the money comes back', async () => {
    const { bot, ap, setScan, later } = setup();
    await ap.turnOn();
    await bot.tickAll();
    const id = ap.status().accounts[0].bots[0].id;
    setScan({ at: 2, chains: [{ chainId: NET.chainId, items: [] }] }); // PLS/DAI no longer earns
    await ap.tick();
    expect(ap.status().accounts[0].bots[0].retiring).toBeNull(); // in its first week
    later(HOLD_MS + 1);
    setScan({ at: 3, chains: [{ chainId: NET.chainId, items: [] }] });
    await ap.tick();
    expect(ap.status().accounts[0].bots[0].retiring).toEqual({ why: 'its pool no longer earns', started: true });
    expect(bot.status().grids.find((x) => x.id === id)!.cashOut).not.toBeNull();
    for (let i = 0; i < 3; i++) await bot.tickAll(); // sells what it holds, then stops
    expect(bot.botCashedOut('grid', id)).toBe(true);
    const worth = bot.botValue('grid', id)!;
    await ap.tick();
    const [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(0);
    expect(bot.hasBot('grid', id)).toBe(false);
    expect(a.coins.DAI).toBeCloseTo(worth, 9);
    expect(ap.status().log.map((l) => l.msg).join('\n')).toMatch(/closed PLS\/DAI \(its pool no longer earns\): .* DAI back/);
  });

  it('the loss limit closes the budget to cash and stops it', async () => {
    const { chain, bot, ap } = setup();
    ap.setOptions({ stopLossPct: 0.05 });
    await ap.turnOn();
    await bot.tickAll();
    chain.setPrice(P0 * 0.8); // the grid buys all the way down and holds PLS worth less
    await bot.tickAll();
    await ap.tick();
    const [a] = ap.status().accounts;
    expect(a.halted).toMatch(/under the 300 it started with \(limit 5%\)/);
    expect(a.bots[0].retiring).toMatchObject({ why: 'loss limit', started: true });
  });

  it("a pool that spends another coin: swapped into it first, valued in the budget's coin, swapped back when it closes", async () => {
    const { bot, ap, setScan, later } = setup();
    // HEX/PLS spends PLS; the DAI budget reaches it through PLS/DAI (0.29% each way, so 0.58% is taken off its estimate)
    setScan({ at: 5, chains: [{ chainId: NET.chainId, items: [daiOpp(0.3, { key: 'HEX~', label: 'HEX/PLS', spend: 'PLS', stack: 'HEX' })] }] });
    await ap.turnOn();
    const [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(1);
    expect(a.bots[0]).toMatchObject({ market: 'HEX~', spend: 'PLS' });
    expect(a.bots[0].capital).toBeGreaterThan(1e6); // 300 DAI is millions of PLS
    expect(a.bots[0].cost).toBeGreaterThan(295); // what it cost in DAI, less the swap
    expect(a.coins.DAI ?? 0).toBeCloseTo(0, 6);
    expect(a.coins.PLS ?? 0).toBeCloseTo(0, 6);
    await bot.tickAll();
    await ap.tick();
    const v = ap.status().accounts[0].value!;
    expect(v).toBeGreaterThan(280);
    expect(v).toBeLessThan(300);
    expect(ap.status().log.map((l) => l.msg).join('\n')).toMatch(/with \d+ PLS \(≈ 29\d(\.\d+)? DAI\).*after \+0\.6% for swapping into PLS and back/);
    // closed after its week: the PLS it gets back is swapped back to DAI
    setScan({ at: 6, chains: [{ chainId: NET.chainId, items: [] }] });
    later(HOLD_MS + 1);
    await ap.tick();
    for (let i = 0; i < 3; i++) await bot.tickAll();
    await ap.tick();
    const end = ap.status().accounts[0];
    expect(end.bots).toHaveLength(0);
    expect(end.coins.PLS ?? 0).toBeCloseTo(0, 6);
    expect(end.coins.DAI).toBeGreaterThan(280);
    expect(ap.status().log.map((l) => l.msg).join('\n')).toMatch(/swapped \d+ PLS back to \d+(\.\d+)? DAI/);
  });

  it('turned off with Close, every bot goes back to cash; mode and budgets change only once it runs nothing', async () => {
    const { bot, ap } = setup();
    await ap.turnOn();
    await bot.tickAll();
    expect(() => ap.configure({ mode: 'live', options: DEFAULT_OPTIONS, budgets: [] })).toThrow(/Turn it off/);
    ap.turnOff(true);
    await ap.tick();
    for (let i = 0; i < 3; i++) await bot.tickAll();
    await ap.tick();
    expect(ap.status().accounts[0].bots).toHaveLength(0);
    expect(() => ap.configure({ mode: 'paper', options: DEFAULT_OPTIONS, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 0 }] })).toThrow(/more than 0/);
  });
});
