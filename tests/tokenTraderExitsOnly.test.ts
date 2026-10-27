/**
 * Token trader off modes. "Off for new buys" (exits only, the default and what an old "off" file means): no discovery,
 * buys or snipes, but stop-loss / take-profit exits keep running, live sells included. "Off completely, no exits": nothing.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { HARD_CAPS, type SafetyLimits } from '../src/live/limits';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper, SnipeHit } from '../src/server/market/sniper';
import type { ActivityInput as BotEvent } from '../src/server/bot/activity';
import { systemHalt } from '../src/server/bot/audit';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 369, pool: '0x' + (n++).toString(16).padStart(4, '0') + 'd'.repeat(36), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40_000_000, tokenReserve: 1_000_000, feeBps: 29, price: 40, usdPerSpend: 0.00003, ...o,
});
function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }

interface Opts { pools?: () => Promise<FreshPool[]>; live?: boolean; store?: MemoryStore<TraderState>; hits?: () => SnipeHit[]; mark?: (p: Position) => Promise<Partial<Position> | null> }
function make(o: Opts = {}) {
  const store = o.store ?? new MemoryStore<TraderState>();
  const events: BotEvent[] = [];
  const calls = { discover: 0, assess: 0, sniper: 0, mark: 0, buys: 0 };
  const sells: { tokens: number; limits: SafetyLimits }[] = [];
  const sniper = { tick: async (cursors: Record<string, number>) => { calls.sniper++; return { cursors, hits: o.hits?.() ?? [], notes: [] }; } } as unknown as PoolSniper;
  const t = new TokenTrader({
    store, now: () => NOW, sniper, emit: (e) => { events.push(e as BotEvent); },
    discover: async () => { calls.discover++; return o.pools ? o.pools() : []; },
    assess: async () => { calls.assess++; return clean(); },
    resolve: async () => null,
    mark: async (p) => { calls.mark++; return o.mark ? o.mark(p) : null; },
    live: o.live ? {
      buy: async (p, spend) => { calls.buys++; return { tokens: spend / p.price, spent: spend, spentUsd: spend * p.usdPerSpend, price: p.price, impact: 0.001 }; },
      sell: async (_p, tokens, limits) => { sells.push({ tokens, limits }); return { quoteOut: tokens * 20, tokensIn: tokens, price: 20, impact: 0.01 }; },
    } : undefined,
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe', maxImpact: 0.02, ...(o.live ? { mode: 'live' as const } : {}) });
  return { t, store, events, calls, sells };
}
/** Buy `k` positions while on, then stop discovering. */
async function withPositions(k: number, o: Opts = {}) {
  let wave: FreshPool[] = Array.from({ length: k }, (_, i) => pool({ tokenSymbol: `P${i}` }));
  const s = make({ ...o, pools: async () => { const w = wave; wave = []; return w; } });
  s.t.turnOn();
  await s.t.tick();
  expect(s.t.status().positions).toHaveLength(k);
  return s;
}
const crash = (s: ReturnType<typeof make>) => { for (const p of s.t.status().positions) s.t.mark(p.id, { price: p.entryPrice * 0.7 }); };

describe('Off for new buys (exits only)', () => {
  it('runs stop-loss exits on open positions, but no discovery, safety checks or snipes', async () => {
    const s = await withPositions(2);
    s.t.configure({ sniper: { ...s.t.status().options.sniper, on: true } });
    s.t.turnOff();
    const st = s.t.status();
    expect(st.runMode).toBe('exits');
    expect(st.exitsManaged).toBe(2);
    expect(s.events.at(-1)?.msg).toBe('token trader off for new buys: no discovery, buys or snipes; exits running on 2 open position(s)');
    const before = { ...s.calls };
    crash(s);
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(0);
    expect(s.t.status().trades.filter((x) => x.side === 'sell').map((x) => x.why)).toEqual([expect.stringMatching(/hard stop/), expect.stringMatching(/hard stop/)]);
    expect(s.calls.discover).toBe(before.discover);
    expect(s.calls.assess).toBe(before.assess);
    expect(s.calls.sniper).toBe(before.sniper);
    expect(s.calls.mark).toBeGreaterThan(before.mark);
  });

  it('a held position that hasn\'t hit a rule is held (exits watched, nothing sold)', async () => {
    const s = await withPositions(1);
    s.t.turnOff('exits');
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(1);
    expect(s.t.status().positions[0].exitPlan).toBe('hold');
  });

  it('live: exits-only sells go out with the same slippage, impact cap and deadline as normal exits', async () => {
    // same scenario twice: once on, once off for new buys
    const on = await withPositions(1, { live: true });
    crash(on);
    for (const p of on.t.status().positions) on.t.mark(p.id, { tokenReserve: 50_000 }); // thin pool → split sells
    await on.t.tick();
    const off = await withPositions(1, { live: true });
    off.t.turnOff('exits');
    crash(off);
    for (const p of off.t.status().positions) off.t.mark(p.id, { tokenReserve: 50_000 });
    await off.t.tick();
    expect(off.sells.length).toBeGreaterThan(1); // split under the impact cap
    expect(off.sells).toEqual(on.sells);
    for (const x of off.sells) expect(x.limits).toEqual({ maxPriceImpact: Math.min(0.02, HARD_CAPS.maxPriceImpact), slippageBps: 100, deadlineMinutes: 10 });
    expect(off.t.status().positions).toHaveLength(0);
  });

  it('the send check allows sells, never buys', () => {
    const s = make({ live: true });
    s.t.turnOn();
    expect([s.t.canBuy(369), s.t.canSell()]).toEqual([true, true]);
    s.t.turnOff('exits');
    expect([s.t.canBuy(369), s.t.canSell()]).toEqual([false, true]);
    s.t.turnOff('full');
    expect([s.t.canBuy(369), s.t.canSell()]).toEqual([false, false]);
  });

  it('Stop all while on keeps exits and reports the watched count', async () => {
    const s = await withPositions(3);
    s.t.stopEntries(null, systemHalt('stop-all', 'Stop all button', NOW));
    expect(s.t.status().exitsManaged).toBe(3);
    expect(s.events.at(-1)?.msg).toMatch(/Exits still managed: 3$/);
  });
});

describe('Off completely, no exits', () => {
  it('runs nothing: no marks, no exits, no discovery, no buys', async () => {
    const s = await withPositions(2);
    s.t.turnOff('full');
    expect(s.t.status()).toMatchObject({ runMode: 'full', exitsManaged: 0 });
    expect(s.events.at(-1)?.msg).toBe('token trader off completely: no buys, no snipes and no exits; the stops and take-profits of its 2 open position(s) are not watched');
    const before = { ...s.calls };
    crash(s);
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(2);
    expect(s.calls).toEqual(before);
  });

  it('turned off completely while an exit pass is under way: the rest is left alone', async () => {
    const gate = deferred<null>();
    let gated = false;
    const s = await withPositions(2, { mark: async () => { if (!gated) { gated = true; await gate.p; } return null; } });
    s.t.turnOff('exits');
    crash(s);
    const marks = s.calls.mark;
    const tick = s.t.tick();
    s.t.turnOff('full'); // lands while the first position's mark is awaited
    gate.resolve(null);
    await tick;
    expect(s.calls.mark - marks).toBe(1); // the second position was not even read
    expect(s.t.status().positions).toHaveLength(2); // and the first, whose read was in flight, was not sold
    expect(s.t.status().trades.filter((x) => x.side === 'sell')).toHaveLength(0);
  });
});

describe('never a buy while off, in either mode', () => {
  for (const mode of ['exits', 'full'] as const) {
    it(`${mode}: the tick already in flight (POST /on starts one) buys nothing after off`, async () => {
      const d = deferred<FreshPool[]>();
      const s = make({ pools: () => d.p, live: true });
      s.t.turnOn();
      const tick = s.t.tick();
      s.t.turnOff(mode);
      d.resolve([pool(), pool(), pool(), pool()]);
      await tick;
      expect(s.t.status().positions).toHaveLength(0);
      expect(s.calls.buys).toBe(0);
      expect(s.calls.assess).toBe(0);
    });
    it(`${mode}: later ticks never discover or buy`, async () => {
      const s = make({ pools: async () => [pool()] });
      s.t.turnOn(); s.t.turnOff(mode);
      for (let i = 0; i < 3; i++) await s.t.tick();
      expect(s.t.status().positions).toHaveLength(0);
      expect(s.calls.discover).toBe(0);
    });
  }
});

describe('mode persistence and audit', () => {
  it('the mode survives a restart', async () => {
    const s = await withPositions(1);
    s.t.turnOff('full');
    const again = new TokenTrader({ store: s.store, now: () => NOW });
    expect(again.status()).toMatchObject({ runMode: 'full', offMode: 'full', on: false, exitsManaged: 0 });
    s.t.turnOff('exits');
    const third = new TokenTrader({ store: s.store, now: () => NOW });
    expect(third.status()).toMatchObject({ runMode: 'exits', exitsManaged: 1 });
  });

  it('an old file with on: false and no offMode loads as off for new buys (exits running)', async () => {
    const s = await withPositions(1);
    const raw = structuredClone(s.store.load()!) as TraderState;
    raw.on = false;
    delete raw.offMode; delete raw.modeLog;
    const store = new MemoryStore<TraderState>();
    store.save(raw);
    const t = new TokenTrader({ store, now: () => NOW });
    expect(t.status()).toMatchObject({ runMode: 'exits', exitsManaged: 1 });
    t.mark(t.status().positions[0].id, { price: t.status().positions[0].entryPrice * 0.7 });
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
  });

  it('every mode change is in the stop audit, newest first', () => {
    const s = make();
    s.t.turnOn(); s.t.turnOff('exits'); s.t.turnOff('full'); s.t.turnOn();
    expect(s.t.status().modeLog.map((m) => [m.mode, m.halt.what])).toEqual([
      ['on', 'token-trader-on'], ['full', 'token-trader-off'], ['exits', 'token-trader-off'], ['on', 'token-trader-on'],
    ]);
    expect(s.t.status().modeLog[1].halt.detail).toMatch(/off completely/);
    expect(s.t.status().lastHalt).toMatchObject({ what: 'token-trader-off', detail: expect.stringMatching(/off completely/) });
  });
});
