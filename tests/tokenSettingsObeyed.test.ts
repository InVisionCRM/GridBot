/**
 * The token trader does what its settings say (Kyle, 2026-10-30: "it still searches through chains i clicked off and
 * is blocking tokens that are within the rules", and "remove the owner can mint rule").
 */
import { describe, expect, it } from 'vitest';
import { CHAINS } from '../src/live/chains';
import type { MarketDef } from '../src/live/markets';
import { gateToken, type GateInput } from '../src/market/tokenTrader';
import { POWER_SIGS } from '../src/market/ownerPowers';
import { discover, discoverEveryMs, quoteImpactOf } from '../src/server/market/tokenFeed';
import { PoolSniper } from '../src/server/market/sniper';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { FreshPool } from '../src/market/tokenTrader';
import { setEthUsdSource } from '../src/lib/ethUnits';

setEthUsdSource(() => 2500);

describe('chains switched off are not read', () => {
  it('discovery asks GeckoTerminal only for the chains it trades', async () => {
    const asked: string[] = [];
    const rts = CHAINS.map((cfg) => ({ tradable: true, cfg, reader: { call: async () => '0x' } }));
    const hub = { runtimes: () => rts, rt: (id: number) => rts.find((r) => r.cfg.id === id)! };
    const gecko = { newPools: async (slug: string) => { asked.push(`new:${slug}`); return []; }, trendingPools: async (slug: string) => { asked.push(`hot:${slug}`); return []; } };
    await discover(hub as never, gecko as never, (id) => id === 4663);
    expect(asked).toEqual(['new:robinhood', 'hot:robinhood']);
  });

  it("the sniper doesn't read a chain the trader doesn't trade", async () => {
    const heads: number[] = [];
    const source = { head: async (id: number) => { heads.push(id); return 100; }, getLogs: async () => [], getCode: async () => '0x' };
    const chains = [1, 4663].map((id) => ({ id, name: `c${id}`, spendable: [], dexes: [], logChunk: 1000 }));
    const sn = new PoolSniper({ chains, source } as never);
    await sn.tick({}, { wants: (id) => id === 4663 });
    expect(heads).toEqual([4663]);
  });

  it('discovery runs more often the fewer chains it reads: 30 s for up to three, 80 s for all eight', () => {
    expect(discoverEveryMs(1)).toBe(30_000);
    expect(discoverEveryMs(3)).toBe(30_000);
    expect(discoverEveryMs(8)).toBe(80_000);
  });
});

describe('tokens inside the rules are not blocked', () => {
  it("the impact check quotes the market the safety check built (a GeckoTerminal label used to name no adapter, so every non-PulseChain pool failed it)", async () => {
    const draft = { key: 'robinhood:NEW/WETH', pool: { dex: 'uniswap-v3', kind: 'v3', address: '0xpool', feeBps: 100 } } as unknown as MarketDef;
    let quoted: unknown = null;
    const hub = { draftQuoter: (d: MarketDef) => ({ quote: async (side: string, amount: number) => { quoted = { d, side, amount }; return { priceImpact: 0.004 }; } }) };
    expect(await quoteImpactOf(hub as never, draft, 0.05)).toBe(0.004);
    expect(quoted).toEqual({ d: draft, side: 'buy', amount: 0.05 });
    await expect(quoteImpactOf(hub as never, null, 0.05)).rejects.toThrow(/no safety check result/);
  });

  it('a mint function blocks nothing: not in the gate, not in owner powers', () => {
    const g: GateInput = {
      mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
      liquidityUsd: 80_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
      holderConcentration: null, recentLiqPull: false, liveAllowed: true,
    };
    expect(gateToken({ ...g, canMint: true } as GateInput).ok).toBe(true);
    expect(POWER_SIGS.filter((p) => p.kind === 'mint').every((p) => !p.blocks)).toBe(true);
  });
});

describe('the minimum pool age is part of the wash and pool age check', () => {
  // GeckoTerminal's new-pools lists on 2026-10-30: 20 of 20 pools under 24 h old on Robinhood, Ethereum and Base. The
  // age applied in every style, so that half of discovery never reached the safety check, in Wild too.
  const NOW = 1_800_000_000_000;
  const young: FreshPool = {
    chainId: 1, pool: '0x' + 'ab'.repeat(20), dex: 'uni-v3', kind: 'v3', token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20),
    tokenSymbol: 'NEW', spendSymbol: 'WETH', liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 600_000, source: 'new',
    quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
  };
  const clean: GateInput = {
    mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
    liquidityUsd: 80_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
    holderConcentration: null, recentLiqPull: false, liveAllowed: true,
  };
  const run = async (enforceWashAndAge: boolean) => {
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => NOW,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => [young], assess: async () => clean, resolve: async () => null,
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 24 * 3600, risk: 'any', enforceWashAndAge });
    t.turnOn();
    await t.tick();
    return t.status();
  };

  it('off (Wild): a 10-minute-old pool is looked at and bought', async () => {
    expect((await run(false)).positions).toHaveLength(1);
  });
  it('on: the same pool is skipped by the age rule, and its feed row names the chain and the coin', async () => {
    const s = await run(true);
    expect(s.positions).toHaveLength(0);
    expect(s.feed[0]).toMatchObject({ chainId: 1, label: 'NEW/WETH', stage: 'rules', why: expect.stringMatching(/minimum 24h/) });
  });
});

describe('the page can show when discovery runs', () => {
  it('status reports the last run, what it found, and how often it runs; a run that is not due records nothing', async () => {
    let due = false;
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => 5_000,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => (due ? [] : null), lookEveryMs: () => 30_000, assess: async () => { throw new Error('unused'); }, resolve: async () => null,
    });
    t.turnOn();
    await t.tick();
    expect(t.status().look).toEqual({ last: null, everyMs: 30_000 });
    due = true;
    await t.tick();
    expect(t.status().look).toEqual({ last: { at: 5_000, found: 0 }, everyMs: 30_000 });
  });
});

describe('discovery does not wait behind the scan and the candle history', () => {
  it('new and trending pool reads go ahead of every waiting GeckoTerminal request; each lane keeps its order', async () => {
    const { GeckoSource } = await import('../src/server/market/gecko');
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const fetchFn = async (url: string) => {
      if (first) { first = false; await gate; } // the call in flight when the others queue up
      order.push(url.replace('https://api.geckoterminal.com/api/v2/networks/', ''));
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    };
    const g = new GeckoSource(fetchFn, { minIntervalMs: 0, sleep: async () => undefined });
    const done = [
      g.getJson('https://api.geckoterminal.com/api/v2/networks/scan/1'),
      g.getJson('https://api.geckoterminal.com/api/v2/networks/scan/2'),
      g.getJson('https://api.geckoterminal.com/api/v2/networks/candles/1'),
      g.newPools('robinhood'),
      g.trendingPools('robinhood'),
    ];
    expect(g.waiting).toBe(4);
    release();
    await Promise.all(done);
    expect(order).toEqual(['scan/1', 'robinhood/new_pools?page=1', 'robinhood/trending_pools?page=1', 'scan/2', 'candles/1']);
  });
});

describe('one GeckoTerminal rate limit does not cost a chain its discovery', () => {
  it('a 429 on the new-pools read is retried once after the back-off', async () => {
    const { RateLimited } = await import('../src/server/market/gecko');
    const asked: string[] = [];
    let limited = true;
    const rts = CHAINS.map((cfg) => ({ tradable: true, cfg, reader: { call: async () => '0x' } }));
    const hub = { runtimes: () => rts, rt: (id: number) => rts.find((r) => r.cfg.id === id)! };
    const gecko = {
      newPools: async (slug: string) => { asked.push(`new:${slug}`); if (limited) { limited = false; throw new RateLimited(0); } return []; },
      trendingPools: async (slug: string) => { asked.push(`hot:${slug}`); return []; },
    };
    await discover(hub as never, gecko as never, (id) => id === 4663);
    expect(asked).toEqual(['new:robinhood', 'new:robinhood', 'hot:robinhood']);
  });
});

describe('safety checks report as they finish', () => {
  const NOW = 1_800_000_000_000;
  const pool = (n: number): FreshPool => ({
    chainId: 1, pool: '0x' + String(n).repeat(40).slice(0, 40), dex: 'uni-v3', kind: 'v3', token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20),
    tokenSymbol: `T${n}`, spendSymbol: 'WETH', liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'trending',
    quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
  });
  const clean: GateInput = {
    mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
    liquidityUsd: 80_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
    holderConcentration: null, recentLiqPull: false, liveAllowed: true,
  };
  const make = (pools: FreshPool[], assess: (p: FreshPool) => Promise<GateInput>) => {
    const t = new TokenTrader({
      store: new MemoryStore<TraderState>(), now: () => NOW,
      sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => pools, assess, resolve: async () => null,
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, risk: 'any' });
    t.turnOn();
    return t;
  };

  it("a slow check doesn't hold back a pool whose check is done (a batch used to wait for its slowest)", async () => {
    const slow = pool(3), fast = pool(5);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const t = make([slow, fast], async (p) => { if (p === slow) await gate; return clean; });
    const ticking = t.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.status().positions.map((p) => p.pool)).toEqual([fast.pool]);
    release();
    await ticking;
    expect(t.status().positions).toHaveLength(2);
  });

  it('a full "Total open" says so instead of "the pool is too thin"', async () => {
    const pools = [1, 2, 3, 4, 5, 6].map(pool);
    const t = make(pools, async () => clean);
    await t.tick();
    expect(t.status().positions).toHaveLength(5); // 5 × 100 of 500
    expect(t.status().feed[0]).toMatchObject({ stage: 'buy', why: 'Total open is used up (≈ 0.2 ETH open of ≈ 0.2 ETH); buys start again as positions close' });
  });
});
