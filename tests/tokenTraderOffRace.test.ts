/**
 * Paper token trader bought 4 positions ~3 min after "token trader off" (2026-10-27 3:24:53 PM on, 3:24:54 PM off ET;
 * buys 3:27:58–3:28:30 PM). POST /api/token-trader/on starts a tick at once (void tt().tick()); that tick passed the `on`
 * check, then sat in discover() (GeckoTerminal's paced, rate-limited queue) while the trader was turned off, and when
 * the pools came back it assessed and bought them: nothing after the entry check of tick() looked at `on` again.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper, SnipeHit } from '../src/server/market/sniper';
import type { ActivityInput as BotEvent } from '../src/server/bot/activity';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 369, pool: '0x' + (n++).toString(16).padStart(40, 'c'), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40_000_000, tokenReserve: 1_000_000, feeBps: 29, price: 40, usdPerSpend: 0.00003, ...o,
});
function deferred<T>() { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; }

function make(o: { discover?: () => Promise<FreshPool[]>; hits?: () => Promise<SnipeHit[]>; resolve?: (h: SnipeHit) => Promise<FreshPool | null> }) {
  const events: BotEvent[] = [];
  let assessed = 0;
  const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: (await o.hits?.()) ?? [], notes: [] }) } as unknown as PoolSniper;
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => NOW, sniper, emit: (e) => { events.push(e as BotEvent); },
    discover: o.discover ?? (async () => []), assess: async () => { assessed++; return clean(); },
    resolve: o.resolve ?? (async () => null),
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe' });
  return { t, events, assessed: () => assessed };
}

describe('token trader: off wins over a tick already in flight', () => {
  it('turned off while discovery is pending: no assess, no buy, no "skipped" noise', async () => {
    const d = deferred<FreshPool[]>();
    const s = make({ discover: () => d.p });
    s.t.turnOn();
    const tick = s.t.tick(); // what POST /api/token-trader/on does
    s.t.turnOff(); // 0.65 s later
    d.resolve([pool({ tokenSymbol: 'TEDDY' }), pool({ tokenSymbol: 'MOST' }), pool({ tokenSymbol: 'PTIGER' }), pool({ tokenSymbol: 'HEX' })]);
    await tick;
    expect(s.t.status().positions).toHaveLength(0);
    expect(s.t.status().trades).toHaveLength(0);
    expect(s.events.filter((e) => /^bought|^skipped/.test(e.msg))).toEqual([]);
    expect(s.assessed()).toBe(0);
  });

  it('turned off in the middle of the candidate loop: the rest are not bought', async () => {
    const s = make({ discover: async () => [pool({ tokenSymbol: 'A' }), pool({ tokenSymbol: 'B' }), pool({ tokenSymbol: 'C' })] });
    let k = 0;
    // turn off while the first candidate's safety check runs
    (s.t as unknown as { d: { assess: () => Promise<GateInput> } }).d.assess = async () => { if (k++ === 0) s.t.turnOff(); return clean(); };
    s.t.turnOn();
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(0);
    expect(s.t.status().trades).toHaveLength(0);
    // Main overlaps the safety reads (read-only), so all three started before the off landed; none of them buys.
    expect(k).toBe(3);
  });

  it('a snipe hit that arrives after off is not assessed or bought', async () => {
    const fresh = pool({ tokenSymbol: 'SNIPE', source: 'snipe' });
    const d = deferred<SnipeHit[]>();
    const s = make({ hits: () => d.p, resolve: async () => fresh });
    s.t.configure({ sniper: { on: true, minLiquidityUsd: 5_000, delayBlocks: 0, delaySec: 0, maxPerHour: 3, mevRpc: null } });
    s.t.turnOn();
    const tick = s.t.tick();
    s.t.turnOff();
    d.resolve([{ chainId: 369, dex: 'pulsex-v2', kind: 'v2', pool: fresh.pool, token0: fresh.token, token1: fresh.spend, fee: null, blockNumber: 1, at: NOW, skip: null }]);
    await tick;
    expect(s.t.status().positions).toHaveLength(0);
    expect(s.t.status().snipesAt).toHaveLength(0);
    expect(s.assessed()).toBe(0);
  });

  it('on → off → on: the next tick buys normally', async () => {
    const s = make({ discover: async () => [pool({ tokenSymbol: 'OK' })] });
    s.t.turnOn(); s.t.turnOff(); s.t.turnOn();
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(1);
  });
});
