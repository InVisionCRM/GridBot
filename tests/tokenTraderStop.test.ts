import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper, SnipeHit } from '../src/server/market/sniper';
import { systemHalt } from '../src/server/bot/audit';
import type { ActivityInput as BotEvent } from '../src/server/bot/activity';

const NOW = 1_700_000_000_000;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 1, pool: '0x' + (n++).toString(16).padStart(40, 'b'), dex: 'uni-v3', kind: 'v3',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000, ...o,
});
const hitOf = (p: FreshPool): SnipeHit => ({ chainId: p.chainId, dex: 'uni', kind: 'v3', pool: p.pool, token0: p.token, token1: p.spend, fee: null, blockNumber: 1, at: NOW, skip: null });

function make(o: { pools?: () => FreshPool[]; hits?: () => SnipeHit[]; snipes?: FreshPool[]; assess?: () => Promise<GateInput>; store?: MemoryStore<TraderState> } = {}) {
  const store = o.store ?? new MemoryStore<TraderState>();
  const events: BotEvent[] = [];
  const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: o.hits?.() ?? [], notes: [] }) } as unknown as PoolSniper;
  const t = new TokenTrader({
    store, now: () => NOW, sniper, emit: (e) => { events.push(e as BotEvent); },
    discover: async () => o.pools?.() ?? [], assess: o.assess ?? (async () => clean()),
    resolve: async (h) => (o.snipes ?? []).find((p) => p.pool === h.pool) ?? null,
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe' });
  return { t, store, events };
}

describe('Stop all and the token trader', () => {
  it('stops new buys and snipes, keeps exits running, and records the press', async () => {
    let wave: FreshPool[] = [pool({ tokenSymbol: 'A' })];
    const s = make({ pools: () => { const w = wave; wave = []; return w; } });
    s.t.turnOn();
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(1);
    const halt = systemHalt('stop-all', 'Stop all button', NOW);
    s.t.stopEntries(null, halt);
    const st = s.t.status();
    expect(st.entriesHalt).toEqual({ halt, chains: null });
    expect(st.lastHalt).toEqual(halt);
    expect(st.exitsManaged).toBe(1);
    expect(st.on).toBe(true);
    const ev = s.events.find((e) => e.type === 'stopped');
    expect(ev?.msg).toMatch(/Exits still managed: 1/);
    expect((ev!.data as { halt: unknown }).halt).toEqual(halt);
    // a new pool shows up: no buy
    wave = [pool({ tokenSymbol: 'B' })];
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(1);
    // the held position still exits on its stop
    const p0 = s.t.status().positions[0];
    s.t.mark(p0.id, { price: p0.entryPrice * 0.7 });
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(0);
    expect(s.t.status().trades[0].why).toMatch(/hard stop/);
    // persisted across a restart
    const again = new TokenTrader({ store: s.store, now: () => NOW });
    expect(again.status().entriesHalt?.halt).toEqual(halt);
    // Resume new buys
    s.t.resumeEntries();
    wave = [pool({ tokenSymbol: 'C' })];
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(1);
  });

  it('a snipe after Stop all is skipped (and not bought later)', async () => {
    const fresh = pool({ tokenSymbol: 'SNIPE', source: 'snipe', liquidityUsd: 20_000 });
    let hits: SnipeHit[] = [hitOf(fresh)];
    const s = make({ hits: () => { const h = hits; hits = []; return h; }, snipes: [fresh] });
    s.t.configure({ sniper: { on: true, minLiquidityUsd: 5_000, delayBlocks: 0, delaySec: 0, maxPerHour: 3, chains: {}, mevRpc: null } });
    s.t.turnOn();
    s.t.stopEntries(null, systemHalt('stop-all', 'Stop all button', NOW));
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(0);
    expect(s.t.status().feed.map((f) => f.why).join(' | ')).toMatch(/stopped/);
    s.t.resumeEntries();
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(0);
  });

  it('STOP chain stops buys on that chain only', async () => {
    let wave: FreshPool[] = [];
    const s = make({ pools: () => { const w = wave; wave = []; return w; } });
    s.t.turnOn();
    s.t.stopEntries(1, systemHalt('chain-stop', 'Stop all button for one chain', NOW));
    expect(s.t.canBuy(1)).toBe(false);
    expect(s.t.canBuy(8453)).toBe(true);
    wave = [pool({ chainId: 1, tokenSymbol: 'ONE' }), pool({ chainId: 8453, tokenSymbol: 'BASE' })];
    await s.t.tick();
    expect(s.t.status().positions.map((p) => p.chainId)).toEqual([8453]);
    // a later Stop all widens it to every chain
    s.t.stopEntries(null, systemHalt('stop-all', 'Stop all button', NOW));
    expect(s.t.status().entriesHalt?.chains).toBeNull();
    s.t.stopEntries(1, systemHalt('chain-stop', 'x', NOW));
    expect(s.t.status().entriesHalt?.chains).toBeNull();
  });

  it('a Stop all that lands while a buy is being checked wins', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let wave: FreshPool[] = [pool({ tokenSymbol: 'SLOW' })];
    const s = make({ pools: () => { const w = wave; wave = []; return w; }, assess: async () => { await gate; return clean(); } });
    s.t.turnOn();
    const ticking = s.t.tick();
    await new Promise((r) => setImmediate(r));
    s.t.stopEntries(null, systemHalt('stop-all', 'Stop all button', NOW));
    release();
    await ticking;
    expect(s.t.status().positions).toHaveLength(0);
  });

  it('turning the token trader off is in the stop audit', () => {
    const s = make();
    s.t.turnOn();
    s.t.turnOff();
    expect(s.t.status().lastHalt).toMatchObject({ what: 'token-trader-off', origin: 'system' });
    expect(s.events.some((e) => e.type === 'stopped' && (e.data as { halt?: unknown })?.halt)).toBe(true);
  });
});
