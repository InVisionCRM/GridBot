import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MockChain, NET } from './helpers/mockChain';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper, SnipeHit } from '../src/server/market/sniper';

const clean = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true, ...o,
});

let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 1, pool: '0x' + (n++).toString(16).padStart(40, 'a'), dex: 'uni-v3', kind: 'v3',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: 0, source: 'new',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000, ...o,
});

function trader(o: {
  now?: () => number; discover?: () => Promise<FreshPool[]>;
  assess?: (p: FreshPool) => Promise<GateInput>;
  holders?: (p: FreshPool) => Promise<{ largest: number | null; top10: number | null; unverified: boolean }>;
  hits?: SnipeHit[]; resolve?: (h: SnipeHit) => Promise<FreshPool | null>;
  store?: MemoryStore<TraderState>;
} = {}) {
  const store = o.store ?? new MemoryStore<TraderState>();
  const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: o.hits ?? [], notes: [] }) } as unknown as PoolSniper;
  const t = new TokenTrader({
    store, now: o.now ?? (() => 1_700_000_000_000), sniper,
    discover: o.discover, assess: async (p) => (o.assess ? o.assess(p) : clean()),
    holders: o.holders,
    resolve: o.resolve ?? (async () => null),
  });
  return { t, store };
}

describe('token trader engine', () => {
  it('paper-buys a pool that passes the gate, sized under the limits, and sells on the hard stop', async () => {
    const p = pool({ createdAt: 1_700_000_000_000 - 48 * 3600_000 });
    let fresh = true;
    const { t, store } = trader({ discover: async () => (fresh ? (fresh = false, [p]) : []) });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600, risk: 'safe' });
    t.turnOn();
    await t.tick();
    const open = t.status();
    expect(open.positions).toHaveLength(1);
    expect(open.positions[0].spentUsd).toBeLessThanOrEqual(100.01);
    expect(open.positions[0].spentUsd).toBeGreaterThan(90);
    expect(open.feed[0].verdict).toBe('bought');
    expect(open.trades[0].why).toMatch(/buy/);
    const id = open.positions[0].id;
    t.mark(id, { price: open.positions[0].entryPrice * 0.7 });
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().trades[0].why).toMatch(/hard stop/);
    expect(store.load()!.positions).toHaveLength(0);
    const resumed = new TokenTrader({ store, now: () => 1_700_000_000_000 });
    expect(resumed.status().on).toBe(true);
    expect(resumed.status().trades[0].side).toBe('sell');
  });

  it('skips a young pool on the scan and a honeypot, and a snipe ignores the age', async () => {
    const now = 1_700_000_000_000;
    const young = pool({ createdAt: now - 3600_000, tokenSymbol: 'YOUNG' });
    const bad = pool({ createdAt: now - 48 * 3600_000, tokenSymbol: 'BAD' });
    const { t } = trader({
      now: () => now,
      discover: async () => [young, bad],
      assess: async (p) => clean({ honeypot: p.tokenSymbol === 'BAD' }),
    });
    t.turnOn();
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    expect(t.status().feed.map((f) => f.why).join(' | ')).toMatch(/minimum 24h/);
    expect(t.status().feed.map((f) => f.why).join(' | ')).toMatch(/honeypot/);

    const fresh = pool({ createdAt: now - 1000, liquidityUsd: 20_000, tokenSymbol: 'SNIPE', source: 'snipe' });
    const hit: SnipeHit = { chainId: 1, dex: 'uni-v3', kind: 'v3', pool: fresh.pool, token0: fresh.token, token1: fresh.spend, fee: 3000, blockNumber: 10, at: now, skip: null };
    const sn = trader({
      now: () => now, hits: [hit], resolve: async () => fresh,
    });
    sn.t.configure({ sniper: { on: true, minLiquidityUsd: 5_000, delayBlocks: 0, delaySec: 0, maxPerHour: 3, chains: {}, mevRpc: null } });
    sn.t.turnOn();
    await sn.t.tick();
    expect(sn.t.status().positions).toHaveLength(1);
    expect(sn.t.status().positions[0].source).toBe('snipe');
  });

  it('stops after the hourly snipe cap and skips a pool under the liquidity minimum', async () => {
    const now = 1_700_000_000_000;
    const a = pool({ liquidityUsd: 20_000, tokenSymbol: 'A' });
    const b = pool({ liquidityUsd: 20_000, tokenSymbol: 'B' });
    const thin = pool({ liquidityUsd: 100, tokenSymbol: 'THIN' });
    const hit = (p: FreshPool): SnipeHit => ({ chainId: 1, dex: 'uni', kind: 'v3', pool: p.pool, token0: p.token, token1: p.spend, fee: null, blockNumber: 1, at: now, skip: null });
    const { t } = trader({ now: () => now, hits: [hit(a), hit(b), hit(thin)], resolve: async (h) => [a, b, thin].find((p) => p.pool === h.pool) ?? null });
    t.configure({ sniper: { on: true, minLiquidityUsd: 5_000, delayBlocks: 0, delaySec: 0, maxPerHour: 1, chains: {}, mevRpc: null } });
    t.turnOn();
    await t.tick();
    expect(t.status().positions).toHaveLength(1);
    const why = t.status().feed.map((f) => f.why).join(' | ');
    expect(why).toMatch(/an hour already/);
    expect(why).toMatch(/liquidity under/);
  });

  it('the local API saves the limits and turns paper mode on', async () => {
    const store = new MemoryStore<TraderState>();
    const { t } = trader({ store, discover: async () => [] });
    const bot = new MultiBot({ net: NET, reader: new MockChain(), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), now: () => 1_800_000_000_000 });
    const server = createApp({ bot, net: NET, tokenTrader: t }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: TraderState & { on: boolean } }>((resolve, reject) => {
      const data = JSON.stringify(body ?? {});
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
      });
      req.on('error', reject); req.end(data);
    });
    try {
      expect((await call('GET', '/api/token-trader')).body.on).toBe(false);
      const saved = await call('PUT', '/api/token-trader', { perTradeUsd: 40, totalUsd: 80, sniper: { on: true, minLiquidityUsd: 5000, delayBlocks: 2, delaySec: 15, maxPerHour: 3, chains: { 1: false }, mevRpc: null } });
      expect(saved.status).toBe(200);
      expect(saved.body.options.perTradeUsd).toBe(40);
      expect(saved.body.options.sniper.on).toBe(true);
      expect(saved.body.options.sniper.chains[1]).toBe(false);
      expect(saved.body.options.enforceHolderCheck).toBe(false);
      const ui = readFileSync(new URL('../src/ui/TokenTrader.tsx', import.meta.url), 'utf8');
      expect(ui).toMatch(/Holder concentration/);
      expect(ui).toMatch(/enforceHolderCheck/);
      expect((await call('POST', '/api/token-trader/on')).body.on).toBe(true);
      expect((await call('POST', '/api/token-trader/off')).body.on).toBe(false);
      expect(store.load()!.options.perTradeUsd).toBe(40);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('refuses a live start without a signer and an https-only MEV URL', () => {
    const { t } = trader();
    t.configure({ mode: 'live', chains: [1] });
    expect(() => t.turnOn()).toThrow(/not wired/);
    expect(() => t.configure({ sniper: { on: false, minLiquidityUsd: 1, delayBlocks: 0, delaySec: 0, maxPerHour: 1, chains: {}, mevRpc: 'http://rpc.example' } })).toThrow(/https/);
    expect(() => t.configure({ maxImpact: 0.2 })).toThrow(/5%/);
  });

  it('leaves concentration unread when the check is off, and blocks from it when the check is on', async () => {
    const p = pool({ tokenSymbol: 'HELD' });
    let calls = 0;
    const off = trader({
      discover: async () => [p],
      holders: async () => { calls++; throw new Error('explorer down'); },
    });
    off.t.configure({ minPoolAgeSec: 0, risk: 'safe' });
    off.t.turnOn();
    await off.t.tick();
    expect(calls).toBe(0);
    expect(off.t.status().positions).toHaveLength(1);
    expect(off.t.status().options.enforceHolderCheck).toBe(false);

    const on = trader({
      discover: async () => [pool({ tokenSymbol: 'WHALE' })],
      holders: async () => ({ largest: 0.6, top10: 0.7, unverified: false }),
    });
    on.t.configure({ minPoolAgeSec: 0, risk: 'safe', enforceHolderCheck: true });
    on.t.turnOn();
    await on.t.tick();
    expect(on.t.status().positions).toHaveLength(0);
    expect(on.t.status().feed.map((f) => f.why).join(' | ')).toMatch(/one holder has 60%/);

    const top = trader({
      discover: async () => [pool({ tokenSymbol: 'TEN' })],
      holders: async () => ({ largest: 0.05, top10: 0.41, unverified: false }),
    });
    top.t.configure({ minPoolAgeSec: 0, risk: 'medium', enforceHolderCheck: true });
    top.t.turnOn();
    await top.t.tick();
    expect(top.t.status().positions).toHaveLength(0);
    expect(top.t.status().feed.map((f) => f.why).join(' | ')).toMatch(/top 10 holders have 41%/);

    const one = trader({
      discover: async () => [pool({ tokenSymbol: 'ONE' })],
      holders: async () => ({ largest: 0.11, top10: 0.2, unverified: false }),
    });
    one.t.configure({ minPoolAgeSec: 0, risk: 'medium', enforceHolderCheck: true });
    one.t.turnOn();
    await one.t.tick();
    expect(one.t.status().positions).toHaveLength(0);
    expect(one.t.status().feed.map((f) => f.why).join(' | ')).toBe('one holder has 11% (maximum 10%)');
    expect(one.t.status().options.maxHolderShare).toBe(0.1);
    expect(one.t.status().options.maxTop10Share).toBe(0.4);

    const custom = trader({
      discover: async () => [pool({ tokenSymbol: 'CUSTOM' })],
      holders: async () => ({ largest: 0.2, top10: 0.5, unverified: false }),
    });
    custom.t.configure({ minPoolAgeSec: 0, risk: 'safe', enforceHolderCheck: true, maxHolderShare: 2, maxTop10Share: 0 });
    expect(custom.t.status().options.maxHolderShare).toBe(1);
    expect(custom.t.status().options.maxTop10Share).toBe(0.01);
    custom.t.configure({ maxHolderShare: 0.25, maxTop10Share: 0.55 });
    custom.t.turnOn();
    await custom.t.tick();
    expect(custom.t.status().positions).toHaveLength(1);
  });

  it('fails closed for safe and medium when the holder read throws, and still buys on risk any', async () => {
    const boom = async () => { throw new Error('rpc down'); };
    for (const risk of ['safe', 'medium'] as const) {
      const { t } = trader({ discover: async () => [pool()], holders: boom });
      t.configure({ minPoolAgeSec: 0, risk, enforceHolderCheck: true });
      t.turnOn();
      await t.tick();
      expect(t.status().positions).toHaveLength(0);
      expect(t.status().feed.map((f) => f.why).join(' | ')).toMatch(/holder read failed for Ethereum/);
    }
    const any = trader({ discover: async () => [pool()], holders: boom });
    any.t.configure({ minPoolAgeSec: 0, risk: 'any', enforceHolderCheck: true });
    any.t.turnOn();
    await any.t.tick();
    expect(any.t.status().positions).toHaveLength(1);

    const none = trader({
      discover: async () => [pool({ chainId: 369, tokenSymbol: 'NOSRC' })],
      holders: async () => ({ largest: null, top10: null, unverified: true, unavailable: 'no-source', chainName: 'PulseChain' }),
    });
    none.t.configure({ minPoolAgeSec: 0, risk: 'safe', enforceHolderCheck: true });
    none.t.turnOn();
    await none.t.tick();
    expect(none.t.status().positions).toHaveLength(0);
    expect(none.t.status().feed.map((f) => f.why).join(' | ')).toBe('holder concentration unavailable: no holder data source for PulseChain');
  });

  it('keeps the holder check off for a saved file that predates it, and the API can turn it on', async () => {
    const store = new MemoryStore<TraderState>();
    const old = {
      version: 1 as const, on: false,
      options: {
        mode: 'paper' as const, perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, chains: [] as number[],
        risk: 'safe' as const, maxImpact: 0.03, maxPoolShare: 0.02,
        sniper: { on: false, minLiquidityUsd: 5_000, delayBlocks: 2, delaySec: 15, maxPerHour: 3, chains: {}, mevRpc: null },
      },
      positions: [], trades: [], feed: [], cursors: {}, snipesAt: [],
    };
    store.save(old as TraderState);
    let calls = 0;
    const { t } = trader({
      store, discover: async () => [pool()],
      holders: async () => { calls++; throw new Error('should not be called'); },
    });
    expect(t.status().options.enforceHolderCheck).toBe(false);
    t.turnOn();
    await t.tick();
    expect(calls).toBe(0);
    expect(t.status().positions).toHaveLength(1);

    const bot = new MultiBot({ net: NET, reader: new MockChain(), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), now: () => 1_800_000_000_000 });
    const server = createApp({ bot, net: NET, tokenTrader: t }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: TraderState & { on: boolean } }>((resolve, reject) => {
      const data = JSON.stringify(body ?? {});
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
      });
      req.on('error', reject); req.end(data);
    });
    try {
      const saved = await call('PUT', '/api/token-trader', { enforceHolderCheck: true });
      expect(saved.status).toBe(200);
      expect(saved.body.options.enforceHolderCheck).toBe(true);
      expect(saved.body.options.maxImpact).toBe(0.03);
      await t.tick();
      expect(calls).toBe(1);
      expect(t.status().positions).toHaveLength(1);
      expect(t.status().feed.map((f) => f.why).join(' | ')).toMatch(/holder read failed for Ethereum/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
