import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { Autopilot, DEFAULT_OPTIONS, type AutopilotState, type ScanView } from '../src/server/bot/autopilot';
import { HOLD_MS, poolId } from '../src/market/autopilot';
import type { Opportunity } from '../src/market/scan';
import type { Mode } from '../src/server/bot/engine';
import { DAI, MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
const USDC = NET.quotes.find((q) => q.symbol === 'USDC')!;

/** A legacy market (PLS/<quote>) as the scan would show it: a grid that earned, swinging `swing` a day */
function opp(key: string, swing: number, o: Partial<Opportunity> = {}): Opportunity {
  const q = NET.quotes.find((x) => x.symbol === key)!;
  return {
    chainId: NET.chainId, key, ref: { address: NET.pulsex.wpls, quote: q.address, pool: '' }, label: `PLS/${key}`, spend: key, stack: 'PLS', dex: 'pulsex-v2', kind: 'v2', feeBps: 29,
    risk: null, riskWhy: null, liveAllowed: true, price: P0, movePct: 0, swingPct: swing, activity: null, capital: 1e6, usd: 1e6,
    grid: { bandPct: 0.12, gridCount: 10, earnedPct: 0.02, roundTrips: 8, returnPct: 0, maxDrawdownPct: 0 }, gridWhy: null, lp: null, lpWhy: 'v2', ...o,
  };
}
const daiOpp = (swing: number, o: Partial<Opportunity> = {}) => opp('DAI', swing, o);
/** The same pool tested again and not earning */
const notEarning = (o: Opportunity): Opportunity => ({ ...o, grid: null, gridWhy: 'no grid earned from its trades this week' });
const HEX_PLS = { key: 'HEX~', label: 'HEX/PLS', spend: 'PLS', stack: 'HEX', capital: 1e8 }; // tested with 100M PLS (1,000 DAI)
const view = (at: number, items: Opportunity[], o: { error?: string; partial?: boolean } = {}): ScanView => ({ at, chains: [{ chainId: NET.chainId, items, error: o.error ?? null, ...(o.partial ? { partial: true } : {}) }] });

function setup(o: { mode?: Mode; amount?: number; slots?: number; scan?: ScanView; receiptTimeoutMs?: number; start?: number } = {}) {
  let now = o.start ?? 1_800_000_000_000;
  const chain = new MockChain(P0);
  const bot = new MultiBot({ net: NET, reader: chain, signer: chain, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0, now: () => now, receiptTimeoutMs: o.receiptTimeoutMs });
  let scan: ScanView | (() => Promise<ScanView>) = o.scan ?? view(1, [daiOpp(0.3)]);
  const store = new MemoryStore<AutopilotState>();
  const ap = new Autopilot({ bot, store, emit: () => undefined, scan: async () => (typeof scan === 'function' ? scan() : scan), now: () => now, receiptTimeoutMs: o.receiptTimeoutMs });
  ap.configure({ mode: o.mode ?? 'paper', options: { ...DEFAULT_OPTIONS, slots: o.slots ?? 1 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: o.amount ?? 300 }] });
  const log = () => ap.status().log.map((l) => l.msg).join('\n');
  const acct = () => ap.state.accounts[0];
  return { chain, bot, ap, store, log, acct, setScan: (s: typeof scan) => { scan = s; }, later: (ms: number) => { now += ms; }, now: () => now };
}

describe('smart trader (paper, mock chain)', () => {
  it('turned on, it opens the best pool with the budget and tracks what it is worth', async () => {
    const { bot, ap, log } = setup();
    await ap.turnOn();
    const [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(1);
    expect(a.bots[0]).toMatchObject({ kind: 'grid', label: 'PLS/DAI', market: 'DAI', capital: 300, pool: poolId({ chainId: NET.chainId, key: 'DAI', ref: daiOpp(0).ref }, 'grid') });
    expect(a.coins.DAI ?? 0).toBeCloseTo(0, 9);
    const g = bot.status().grids.find((x) => x.id === a.bots[0].id)!;
    expect(g).toMatchObject({ mode: 'paper', status: 'running', config: { totalCapitalUsd: 300, gridCount: 10 } });
    expect(g.config!.lowerPrice / g.config!.upperPrice).toBeCloseTo(0.88 / 1.12, 12); // ±12% around the price
    await bot.tickAll();
    expect(ap.status().accounts[0].value).toBeGreaterThan(290);
    expect(log()).toMatch(/opened PLS\/DAI as a grid ±12%, 10 levels with 300 DAI: #1 of 1/);
  });

  it('keeps a bot its first week; after it, a pool tested and not earning is closed to cash and the money comes back', async () => {
    const { bot, ap, setScan, later, log } = setup();
    await ap.turnOn();
    await bot.tickAll();
    const id = ap.status().accounts[0].bots[0].id;
    setScan(view(2, [notEarning(daiOpp(0.3))]));
    await ap.tick();
    expect(ap.status().accounts[0].bots[0].retiring).toBeNull(); // in its first week
    later(HOLD_MS + 1);
    setScan(view(3, [notEarning(daiOpp(0.3))]));
    await ap.tick();
    expect(ap.status().accounts[0].bots[0].retiring).toEqual({ why: 'no grid earned from its trades this week', started: true, alt: null });
    expect(bot.status().grids.find((x) => x.id === id)!.cashOut).not.toBeNull();
    for (let i = 0; i < 3; i++) await bot.tickAll(); // sells what it holds, then stops
    expect(bot.botCashedOut('grid', id)).toBe(true);
    const worth = bot.botValue('grid', id)!;
    await ap.tick();
    const [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(0);
    expect(bot.hasBot('grid', id)).toBe(false);
    expect(a.coins.DAI).toBeCloseTo(worth, 9);
    expect(log()).toMatch(/closed PLS\/DAI \(no grid earned from its trades this week\): .* DAI back/);
  });

  it("a failed or partial scan of the chain, or a pool missing from it (its test failed), retires nothing", async () => {
    const { bot, ap, setScan, later, log } = setup();
    await ap.turnOn();
    await bot.tickAll();
    later(HOLD_MS + 1);
    for (const [at, s] of [[2, view(2, [], { error: 'GeckoTerminal HTTP 429' })], [3, view(3, [], { partial: true })], [4, view(4, [])]] as const) {
      setScan(s);
      await ap.tick();
      expect(ap.status().accounts[0].bots[0].retiring).toBeNull();
      expect(ap.state.scanAt).toBe(at);
    }
    expect(log()).toMatch(/today's scan of it failed \(GeckoTerminal HTTP 429\); its bots stay as they are/);
    expect(log()).toMatch(/still being scanned; its bots stay as they are/);
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

  it('a bot removed by hand leaves the budget (and its loss limit): the other bots are not closed', async () => {
    const { bot, ap, log } = setup({ slots: 2, scan: view(1, [daiOpp(0.3), daiOpp(0.25, HEX_PLS)]) });
    await ap.turnOn();
    await bot.tickAll();
    await ap.tick();
    const [x, y] = ap.state.accounts[0].bots;
    expect(y).toBeDefined();
    bot.remove(x.id);
    await ap.tick();
    const a = ap.state.accounts[0];
    expect(a.halted).toBeNull();
    expect(a.withdrawn).toBeCloseTo(x.cost, 9);
    expect(a.bots.map((b) => [b.id, b.retiring])).toEqual([[y.id, null]]);
    expect(log()).toMatch(/was removed by hand: the 150 DAI it cost is out of this budget/);
  });

  it("a pool that spends another coin: swapped into it first, valued in the budget's coin, swapped back when it closes", async () => {
    const { bot, ap, setScan, later, log } = setup({ scan: view(5, [daiOpp(0.3, HEX_PLS)]) });
    // HEX/PLS spends PLS; the DAI budget reaches it through PLS/DAI (0.29% each way, so 0.58% is taken off its estimate)
    await ap.turnOn();
    const [a] = ap.status().accounts;
    expect(a.bots).toHaveLength(1);
    const b = a.bots[0];
    expect(b).toMatchObject({ market: 'HEX~', spend: 'PLS' });
    expect(b.capital).toBeGreaterThan(1e6); // 300 DAI is millions of PLS
    expect(b.reserve).toBeCloseTo(b.capital * 0.02, 6); // spending the chain's coin: its gas reserve goes with it
    expect(b.cost).toBeCloseTo(300, 4); // what the DAI bought, swap costs included
    expect(a.coins.DAI ?? 0).toBeCloseTo(0, 6);
    expect(a.gasNative).toBeGreaterThan(0); // the swap's gas came out of the PLS it got, before the bot was funded
    expect(a.coins.PLS ?? 0).toBeCloseTo(0, 6);
    await bot.tickAll();
    await ap.tick();
    const v = ap.status().accounts[0].value!;
    expect(v).toBeGreaterThan(280);
    expect(v).toBeLessThan(300);
    expect(log()).toMatch(/with \d+ PLS \(≈ 29\d(\.\d+)? DAI\).*after \+0\.6% for swapping into PLS and back/);
    // closed after its week: the PLS it gets back is swapped back to DAI
    setScan(view(6, [notEarning(daiOpp(0.3, HEX_PLS))]));
    later(HOLD_MS + 1);
    await ap.tick();
    for (let i = 0; i < 3; i++) await bot.tickAll();
    await ap.tick();
    const end = ap.status().accounts[0];
    expect(end.bots).toHaveLength(0);
    expect(end.coins.PLS).toBeLessThan(0); // what gas cost in PLS stays owed
    expect(end.coins.DAI).toBeGreaterThan(280);
    expect(log()).toMatch(/swapped \d+ PLS back to \d+(\.\d+)? DAI/);
  });

  it("a pool spending a coin it holds none of and that isn't the chain's (PLS/USDC for a DAI budget) is priced and opened", async () => {
    const { ap, acct } = setup({ scan: view(1, [opp('USDC', 0.3)]) });
    await ap.turnOn();
    expect(acct().bots.map((b) => [b.market, b.spend])).toEqual([['USDC', 'USDC']]);
    expect(acct().bots[0].capital).toBeGreaterThan(290); // ≈ 300 USDC through DAI → PLS → USDC
  });

  it('money back in another coin pays for the next bot (not only the budget coin)', async () => {
    const { ap, acct, setScan } = setup({ scan: view(1, []) });
    await ap.turnOn();
    // what a closed HEX/PLS bot left: PLS, no DAI
    acct().coins = { PLS: 300 / P0 };
    setScan(view(2, [daiOpp(0.3)]));
    await ap.tick();
    expect(acct().bots).toHaveLength(1);
    expect(acct().bots[0].capital).toBeGreaterThan(290);
    expect(acct().coins.PLS ?? 0).toBeLessThan(1);
  });

  it('a pool that fails to open fails before any swap, and is skipped until the next daily review', async () => {
    const { bot, ap, acct, setScan, log } = setup({ scan: view(1, [daiOpp(0.3, HEX_PLS)]) });
    bot.prices = async () => ({}); // HEX/PLS has no price right now
    await ap.turnOn();
    expect(acct().bots).toHaveLength(0);
    expect(acct().coins).toEqual({ DAI: 300 }); // nothing was swapped
    expect(log()).toMatch(/couldn't open HEX\/PLS: no price for it right now; it is skipped until the next daily review/);
    setScan(view(2, [daiOpp(0.3, HEX_PLS)]));
    await ap.tick();
    expect(log().match(/couldn't open HEX\/PLS/g)).toHaveLength(1);
  });

  it("turned off during a review, it opens nothing more, and a bot opened meanwhile closes too", async () => {
    const { bot, ap, acct } = setup({ slots: 2, scan: view(1, [daiOpp(0.3), opp('USDC', 0.25)]) });
    const add = bot.add.bind(bot);
    let n = 0;
    bot.add = async (p) => { const id = await add(p); if (++n === 1) ap.turnOff(true); return id; };
    await ap.turnOn();
    expect(acct().bots).toHaveLength(1); // the second open didn't happen
    await ap.tick();
    expect(acct().bots[0].retiring).toMatchObject({ why: 'turned off', started: true });
  });

  it("a bot stopped by hand keeps its slot and is left alone (no close starts on it); once resumed it is managed again", async () => {
    const { bot, ap, acct, setScan, later } = setup();
    await ap.turnOn();
    await bot.tickAll();
    const id = acct().bots[0].id;
    bot.stop(id);
    later(HOLD_MS + 1);
    setScan(view(2, [notEarning(daiOpp(0.3)), opp('USDC', 0.3)]));
    await ap.tick();
    expect(acct().bots).toHaveLength(1); // nothing opened in its place
    expect(acct().bots[0].retiring).toBeNull();
    expect(ap.status().accounts[0].bots[0]).toMatchObject({ status: 'stopped' });
    expect(bot.status().grids[0].status).toBe('stopped');
    bot.resume(id);
    setScan(view(3, [notEarning(daiOpp(0.3)), opp('USDC', 0.3)]));
    await ap.tick();
    expect(acct().bots[0].retiring).toMatchObject({ started: true, alt: expect.stringMatching(/USDC:grid$/) });
  });

  it('a retiring bot stopped part way through its close (KILL ALL, a safety pause) waits; resumed, it finishes and is credited', async () => {
    const { bot, ap, acct, setScan, later } = setup();
    await ap.turnOn();
    await bot.tickAll();
    const id = acct().bots[0].id;
    later(HOLD_MS + 1);
    setScan(view(2, [notEarning(daiOpp(0.3))]));
    await ap.tick();
    expect(acct().bots[0].retiring).toMatchObject({ started: true });
    bot.stop(id); // paused before any sale
    for (let i = 0; i < 2; i++) { await bot.tickAll(); await ap.tick(); }
    expect(bot.status().grids[0]).toMatchObject({ status: 'stopped', cashOut: { size: null } });
    expect(acct().bots).toHaveLength(1);
    bot.resume(id);
    for (let i = 0; i < 3; i++) await bot.tickAll();
    await ap.tick();
    expect(acct().bots).toHaveLength(0);
    expect(acct().coins.DAI).toBeGreaterThan(290);
  });

  it('turned off with Close, every bot goes back to cash; mode and budgets change only once nothing is left to settle', async () => {
    const { bot, ap } = setup();
    await ap.turnOn();
    await bot.tickAll();
    expect(() => ap.configure({ mode: 'live', options: DEFAULT_OPTIONS, budgets: [] })).toThrow(/Turn it off/);
    ap.turnOff(true);
    expect(() => ap.configure({ mode: 'live', options: DEFAULT_OPTIONS, budgets: [] })).toThrow(/still has bots/);
    await ap.tick();
    await expect(ap.turnOn()).rejects.toThrow(/still closing to cash/);
    for (let i = 0; i < 3; i++) await bot.tickAll();
    await ap.tick();
    expect(ap.status().accounts[0].bots).toHaveLength(0);
    expect(() => ap.configure({ mode: 'paper', options: {}, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 0 }] })).toThrow(/above 0/);
    expect(() => ap.configure({ mode: 'paper', options: {}, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: Infinity }] })).toThrow(/above 0/);
    // partial options merge over the current ones
    ap.configure({ mode: 'paper', options: { slots: 2 }, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 100 }] });
    expect(ap.state.options).toMatchObject({ slots: 2, grid: true, lp: true });
  });

  it("coins other than the budget's still to swap back keep the account: the page shows it and new budgets wait", async () => {
    const { ap, acct } = setup({ scan: view(1, []) });
    await ap.turnOn();
    acct().coins = { DAI: 100, PLS: 10 / P0 }; // 10 DAI of PLS the sweep couldn't swap back
    ap.turnOff(false);
    expect(ap.status().accounts[0].holds).toBe(true);
    expect(() => ap.configure({ mode: 'paper', options: {}, budgets: [{ chainId: NET.chainId, coin: 'DAI', amount: 300 }] })).toThrow(/coins other than DAI to settle/);
  });

  it('turned on while a check is running: no error, and the next check reviews', async () => {
    const { ap, acct, setScan } = setup({ scan: view(1, []) });
    let release!: () => void;
    setScan(() => new Promise<ScanView>((ok) => { release = () => ok(view(1, [daiOpp(0.3)])); }));
    ap.state.on = true; // a tick holds the trader while the scan is read
    const ticking = ap.tick();
    ap.state.on = false;
    await ap.turnOn();
    release();
    await ticking;
    setScan(view(1, [daiOpp(0.3)]));
    await ap.tick();
    expect(acct().bots).toHaveLength(1);
  });

  it('an error closing or swapping back stays shown after the check, and is said once while it repeats', async () => {
    const { ap, acct, log } = setup({ scan: view(1, []) });
    await ap.turnOn();
    acct().coins = { DAI: 0, PLS: 1e12 }; // far more PLS than the pool can take under the impact cap
    await ap.tick();
    expect(ap.lastError).toMatch(/couldn't swap .* PLS back to DAI: .* would move the price/);
    await ap.tick();
    expect(ap.lastError).toMatch(/couldn't swap/);
    expect(log().match(/couldn't swap/g)).toHaveLength(1);
  });

  it('a value read while a swap is being sent counts the coins on their way', async () => {
    const { bot, ap, acct } = setup({ scan: view(1, [daiOpp(0.3, HEX_PLS)]) });
    const gate = bot.hub.rt(NET.chainId).gate, run = gate.run.bind(gate);
    const seen: (number | null)[] = [];
    gate.run = (fn) => { seen.push(ap.value(acct())); return run(fn); };
    await ap.turnOn();
    expect(seen[0]).toBeCloseTo(300, 6);
  });
});

describe('smart trader (live, mock chain)', () => {
  it('a budget must be in the wallet beyond what live bots use; its money not in a bot is counted as in use', async () => {
    const t = setup({ mode: 'live', amount: 300, scan: view(1, []) });
    await t.bot.add({ mode: 'live', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 4, totalCapitalUsd: 800 }); // the wallet has 1000 DAI
    await expect(t.ap.turnOn()).rejects.toThrow(/Not enough DAI in your wallet\. This needs 1100 DAI \(300 for this bot \+ 800 already used/);
    const u = setup({ mode: 'live', amount: 300, scan: view(1, []) });
    await u.ap.turnOn();
    const row = u.bot.allocations().rows.find((r) => r.token === 'DAI')!;
    expect(row.bots).toEqual([{ id: 'smart trader', kind: 'trader', amount: 300 }]);
    // a bot started by hand can't take the trader's DAI
    await expect(u.bot.add({ mode: 'live', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 4, totalCapitalUsd: 800 })).rejects.toThrow(/the smart trader counts 300 DAI of it/);
  });

  it("a swap's input and hash are saved before it confirms; one that lands late opens its bot (not swapped back)", async () => {
    const t = setup({ mode: 'live', amount: 300, scan: view(1, [daiOpp(0.3, HEX_PLS)]), receiptTimeoutMs: 1 });
    const saved: string[] = [];
    t.chain.onSend = (m) => { if (/^swap/.test(m)) saved.push(JSON.stringify(t.store.load()!.accounts[0].pending)); };
    t.chain.faults = [undefined as never, 'timeout']; // the approve goes through; the swap waits
    await t.ap.turnOn();
    expect(JSON.parse(saved[0])).toEqual([expect.objectContaining({ from: 'DAI', to: 'PLS', amountIn: 300, hash: null })]);
    const pend = t.store.load()!.accounts[0].pending;
    expect(pend).toEqual([expect.objectContaining({ from: 'DAI', amountIn: 300, hash: expect.stringMatching(/^0x/) })]);
    expect(t.acct().bots).toHaveLength(0);
    t.chain.mine();
    await t.ap.tick();
    expect(t.acct().pending).toHaveLength(0);
    expect(t.acct().bots.map((b) => b.market)).toEqual(['HEX~']);
    expect(t.log()).not.toMatch(/swapped .* PLS back/);
  });

  it('a swap never mined is dropped after its deadline, and its input is back', async () => {
    // the router deadline is on the real clock (as the chain's)
    const t = setup({ mode: 'live', amount: 300, scan: view(1, [daiOpp(0.3, HEX_PLS)]), receiptTimeoutMs: 1, start: Date.now() });
    t.chain.faults = [undefined as never, 'timeout'];
    await t.ap.turnOn();
    expect(t.acct().pending).toHaveLength(1);
    t.chain.receipts.delete(t.acct().pending[0].hash!); // evicted: it never mines
    await t.ap.tick();
    expect(t.acct().pending).toHaveLength(1); // still within its deadline
    t.later(20 * 60_000); // past the 10-minute deadline and 5 minutes' grace
    await t.ap.tick();
    expect(t.acct().pending).toHaveLength(0);
    expect(t.acct().coins.DAI).toBeCloseTo(300, 9);
    expect(t.log()).toMatch(/never mined before its deadline; the DAI is back/);
  });

  it('KILL ALL stops the trader: nothing more is sent (no swap, no close) until it is turned on again', async () => {
    const t = setup({ mode: 'live', amount: 300, scan: view(1, []) });
    await t.ap.turnOn();
    t.acct().coins = { DAI: 0, PLS: 300 / P0 }; // PLS to swap back
    t.bot.stopAll();
    expect(t.ap.state.on).toBe(false);
    expect(t.acct().killed).toBe('KILL ALL');
    const sends = t.chain.sent.length;
    await t.ap.tick();
    expect(t.chain.sent.length).toBe(sends);
    await t.ap.turnOn();
    expect(t.acct().killed).toBeNull();
    await t.ap.tick();
    expect(t.chain.sent.length).toBeGreaterThan(sends); // the PLS is swapped back now
  });
});

describe('MultiBot for the smart trader: what a bot is worth, and removing one', () => {
  const PAYEE = '0x' + 'ab'.repeat(20);
  function make() {
    const chain = new MockChain(P0);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), maxRetries: 1, retryDelayMs: 0 });
    return { chain, bot };
  }

  it('a grid sending its profit to another address is worth what it still holds (what it sent is gone)', async () => {
    const { chain, bot } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.8, upperPrice: P0, gridCount: 10, totalCapitalUsd: 50, profits: { mode: 'send', to: PAYEE } });
    chain.setPrice(P0 * 0.975); await bot.tickAll();
    chain.setPrice(P0 * 1.005); await bot.tickAll();
    await bot.tickAll(); await bot.tickAll();
    const g = bot.status().grids.find((x) => x.id === id)!;
    expect(g.payout.sent).toBeGreaterThan(0);
    expect(bot.botValue('grid', id)).toBeCloseTo(50 + g.pnl.realized + g.pnl.unrealized - g.payout.sent, 9);
  });

  it("a grid removed while one of its ticks is still running doesn't come back (as a stopped ghost)", async () => {
    const { bot } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: P0 * 0.8, upperPrice: P0, gridCount: 10, totalCapitalUsd: 50 });
    const eng = (bot as unknown as { engines: Map<string, { executor: { getPrice: () => Promise<number> } }> }).engines.get(id)!;
    const price = eng.executor.getPrice.bind(eng.executor);
    let reading!: () => void;
    eng.executor.getPrice = async () => { await new Promise<void>((ok) => { reading = ok; }); return price(); };
    const ticking = bot.tickAll();
    await new Promise((ok) => setTimeout(ok, 10));
    bot.remove(id);
    reading();
    await ticking;
    expect(bot.hasBot('grid', id)).toBe(false);
    expect(bot.status().grids).toHaveLength(0);
  });
});

