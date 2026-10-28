import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { Autopilot, DEFAULT_OPTIONS, type AutopilotState, type ScanView } from '../src/server/bot/autopilot';
import { HOLD_MS } from '../src/market/autopilot';
import type { Opportunity } from '../src/market/scan';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
function daiOpp(swing: number): Opportunity {
  return {
    chainId: NET.chainId, key: 'DAI', ref: { address: NET.pulsex.wpls, quote: NET.quotes.find((x) => x.symbol === 'DAI')!.address, pool: '' }, label: 'PLS/DAI', spend: 'DAI', stack: 'PLS', dex: 'pulsex-v2', kind: 'v2', feeBps: 29,
    risk: null, riskWhy: null, liveAllowed: true, price: P0, movePct: 0, swingPct: swing, activity: null, capital: 1000, usd: 1000,
    grid: { bandPct: 0.12, gridCount: 10, earnedPct: 0.02, roundTrips: 8, returnPct: 0, maxDrawdownPct: 0 }, gridWhy: null, lp: null, lpWhy: 'v2',
  };
}

function setup() {
  let now = 1_800_000_000_000;
  const chain = new MockChain(P0);
  let hold: Promise<void> | null = null;
  let release = () => {};
  let waiting = 0;
  const call = chain.call.bind(chain);
  chain.call = async (tx) => { if (hold) { waiting++; await hold; } return call(tx); };
  const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => now });
  let scan: ScanView = { at: 1, chains: [{ chainId: NET.chainId, items: [daiOpp(0.3)], error: null }] };
  const store = new MemoryStore<AutopilotState>();
  const ap = new Autopilot({ bot, store, emit: () => undefined, scan: async () => scan, now: () => now });
  ap.configure({ mode: 'paper', options: { ...DEFAULT_OPTIONS, slots: 1 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] });
  return {
    chain, bot, ap, store,
    setScan: (s: ScanView) => { scan = s; }, later: (ms: number) => { now += ms; },
    holdReads: () => { waiting = 0; hold = new Promise<void>((r) => { release = () => { hold = null; r(); }; }); },
    untilWaiting: async () => { for (let i = 0; i < 200 && !waiting; i++) await new Promise((r) => setImmediate(r)); expect(waiting).toBeGreaterThan(0); },
    release: () => release(),
  };
}

describe('Stop all and the smart trader', () => {
  it('after Stop all it opens nothing until Carry on, and the press is recorded', async () => {
    const t = setup();
    t.holdReads();
    const on = t.ap.turnOn();
    await t.untilWaiting();
    t.bot.stopAll();
    t.release();
    await on;
    const a = t.ap.status().accounts[0];
    expect(a.killed).toBe('Stop all');
    expect(a.killHalt).toMatchObject({ what: 'stop-all' });
    await t.ap.review(true);
    await t.ap.tick();
    expect(t.ap.status().accounts[0].bots).toHaveLength(0);
    expect(t.bot.status().grids.filter((g) => g.status === 'running')).toHaveLength(0);
    // persisted
    const again = new Autopilot({ bot: new MultiBot({ net: NET, reader: t.chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) }), store: t.store, emit: () => undefined, scan: async () => null });
    expect(again.status().accounts[0].killed).toBe('Stop all');
    t.ap.carryOn(NET.chainId);
    expect(t.ap.status().accounts[0].killed).toBeNull();
    await t.ap.review(true);
    await t.ap.tick();
    expect(t.ap.status().accounts[0].bots).toHaveLength(1);
    expect(t.bot.status().grids.filter((g) => g.status === 'running')).toHaveLength(1);
  });

  it('a Stop all that lands while it is opening a bot wins: the bot is not started', async () => {
    const s = setup();
    s.holdReads();
    const on = s.ap.turnOn();
    await s.untilWaiting();
    s.bot.stopAll();
    s.release();
    await on;
    expect(s.bot.status().grids.filter((g) => g.status === 'running')).toHaveLength(0);
    expect(s.ap.status().accounts[0].bots).toHaveLength(0);
    expect(s.ap.status().accounts[0].killed).toBe('Stop all');
  });

  it('while stopped it does not start closing a retiring bot (a close would start the stopped bot again)', async () => {
    const s = setup();
    await s.ap.turnOn();
    await s.bot.tickAll();
    const id = s.ap.status().accounts[0].bots[0].id;
    s.bot.stopAll();
    s.later(HOLD_MS + 1);
    s.setScan({ at: 3, chains: [{ chainId: NET.chainId, items: [], error: null }] });
    await s.ap.tick();
    // one already marked to retire before the press (its close not yet started) waits too
    s.ap.state.accounts[0].bots[0].retiring = { why: 'its pool no longer earns', started: false, alt: null };
    await s.ap.tick();
    const g = s.bot.status().grids.find((x) => x.id === id)!;
    expect(g.status).toBe('stopped');
    expect(g.archivedAt).toBeNull();
  });

  it('STOP chain stops only that chain\'s budget', async () => {
    const s = setup();
    await s.ap.turnOn();
    s.bot.stopChain(NET.chainId);
    expect(s.ap.status().accounts[0].killed).toMatch(/^STOP /);
    expect(() => s.ap.carryOn(999)).toThrow();
  });

  it('one stop hook system: Stop all and STOP chain each fire every hook once, with the same audit record the bots and the smart trader keep', async () => {
    const s = setup();
    const events: { type: string; data?: unknown }[] = [];
    const ap = new Autopilot({ bot: s.bot, store: new MemoryStore<AutopilotState>(), emit: (e) => { events.push(e as { type: string; data?: unknown }); }, scan: async () => null, now: () => 1_800_000_000_000 });
    ap.configure({ mode: 'paper', options: { ...DEFAULT_OPTIONS, slots: 1 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] });
    await ap.turnOn();
    const calls: [number | null, unknown][] = [];
    s.bot.stopHooks.push((c, h) => calls.push([c, h]));
    expect('onStop' in s.bot).toBe(false); // the old single-callback hook is gone
    // setup()'s smart trader + this one + the spy: all on the same list
    expect(s.bot.stopHooks).toHaveLength(3);
    const spot = (await s.bot.prices(['DAI'])).DAI;
    const id = await s.bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: spot * 0.9, upperPrice: spot * 1.1, gridCount: 6, totalCapitalUsd: 50 });
    s.bot.stopAll();
    expect(calls).toHaveLength(1);
    const [chain, halt] = calls[0];
    expect(chain).toBeNull();
    expect(halt).toMatchObject({ what: 'stop-all' });
    expect(s.bot.status().grids.find((g) => g.id === id)!.halt).toEqual(halt);
    expect(ap.status().accounts[0]).toMatchObject({ killed: 'Stop all', killHalt: halt });
    expect(events.find((e) => e.type === 'stopped')?.data).toEqual({ halt });
    ap.carryOn(NET.chainId);
    expect(ap.status().accounts[0]).toMatchObject({ killed: null, killHalt: null });
    s.bot.stopChain(NET.chainId);
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(NET.chainId);
    expect(ap.status().accounts[0].killHalt).toEqual(calls[1][1]);
  });
});
