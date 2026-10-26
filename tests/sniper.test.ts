import { describe, expect, it } from 'vitest';
import { encodePairCreated, encodePoolCreated, encodeV2Mint, encodeV2Sync, encodeV4Init, TOPIC, V4_POOL_MANAGER, type RawLog } from '../src/market/poolEvents';
import { PoolSniper, type LogSource, type SniperChain } from '../src/server/market/sniper';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x5555555555555555555555555555555555555555';
const PAIR = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const V3FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const V3ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

const chain = (id = 1, dexes: SniperChain['dexes'] = [{ id: 'uni-v2', kind: 'v2', factory: FACTORY, router: ROUTER }]): SniperChain => ({
  id, name: id === 1 ? 'Ethereum' : 'PulseChain', spendable: [WETH, USDC].map((a) => a.toLowerCase()), dexes, logChunk: 50,
});

function logsOf(rows: RawLog[]): LogSource & { calls: { address: string; from: number; to: number; topics: string[] }[] } {
  const calls: { address: string; from: number; to: number; topics: string[] }[] = [];
  return {
    calls,
    head: async () => 1000,
    getCode: async (_c, address) => address.toLowerCase() === '0x' + '00'.repeat(20) ? '0x' : '0x60016000',
    factoryOf: async (_c, address) => {
      const a = address.toLowerCase();
      if (a === ROUTER.toLowerCase()) return FACTORY;
      if (a === V3ROUTER.toLowerCase()) return V3FACTORY;
      return null;
    },
    getLogs: async (_c, from, to, address, topics) => {
      calls.push({ address: address.toLowerCase(), from, to, topics });
      if (topics.includes('boom')) throw new Error('429');
      return rows.filter((l) => l.address.toLowerCase() === address.toLowerCase() && topics.map((t) => t.toLowerCase()).includes((l.topics[0] ?? '').toLowerCase()));
    },
  };
}

const log = (address: string, enc: { topics: string[]; data: string }, blockNumber: number): RawLog => ({ address, topics: enc.topics, data: enc.data, blockNumber });

describe('pool sniper', () => {
  it('waits for a mint, then emits the pool once the delay has passed, and does not emit it again', async () => {
    const created = log(FACTORY, encodePairCreated(TOKEN, WETH, PAIR), 980);
    const mint = log(PAIR, encodeV2Mint(ROUTER, 10n ** 18n, 10n ** 18n), 990);
    const src = logsOf([created, mint]);
    let now = 1_000_000;
    const sniper = new PoolSniper({ chains: [chain()], source: src, now: () => now, lookback: 80 });
    const first = await sniper.tick({}, { delayBlocks: 20, delaySec: 0 });
    expect(first.hits).toHaveLength(0);
    expect(sniper.has(1, PAIR)).toBe(false);
    now += 1000;
    const second = await sniper.tick(first.cursors, { delayBlocks: 0, delaySec: 0 });
    expect(second.hits).toHaveLength(1);
    expect(second.hits[0]).toMatchObject({ chainId: 1, dex: 'uni-v2', kind: 'v2', pool: PAIR.toLowerCase(), skip: null, blockNumber: 990 });
    const third = await sniper.tick(second.cursors, { delayBlocks: 0, delaySec: 0 });
    expect(third.hits).toHaveLength(0);
    expect(src.calls.some((c) => c.address === FACTORY.toLowerCase() && c.from === 920)).toBe(true);
  });

  it('an empty sync is not liquidity, and a later sync with reserves is', async () => {
    const created = log(FACTORY, encodePairCreated(TOKEN, WETH, PAIR), 980);
    const empty = log(PAIR, encodeV2Sync(0n, 0n), 981);
    const src = logsOf([created, empty]);
    const sniper = new PoolSniper({ chains: [chain()], source: src, now: () => 5_000, lookback: 80 });
    expect((await sniper.tick({}, { delayBlocks: 0, delaySec: 0 })).hits).toHaveLength(0);
    src.calls.length = 0;
    const full = logsOf([created, log(PAIR, encodeV2Sync(5n, 5n), 995)]);
    const again = new PoolSniper({ chains: [chain()], source: full, now: () => 9_000, lookback: 80 });
    expect((await again.tick({}, { delayBlocks: 0, delaySec: 0 })).hits).toHaveLength(1);
  });

  it('does not watch a factory whose factory() disagrees, and skips pairs that are not token/spend', async () => {
    const bad = logsOf([]);
    bad.factoryOf = async () => '0x' + '99'.repeat(20);
    const sniper = new PoolSniper({ chains: [chain(369)], source: bad, lookback: 10 });
    const r = await sniper.tick({}, { delayBlocks: 0, delaySec: 0 });
    expect(r.notes.map((n) => n.msg).join(' ')).toMatch(/not watching/);
    expect(r.hits).toHaveLength(0);
    expect(bad.calls).toHaveLength(0);

    const both = log(FACTORY, encodePairCreated(WETH, USDC, PAIR), 990);
    const neither = log(FACTORY, encodePairCreated(TOKEN, OTHER, POOL), 991);
    const src = logsOf([both, neither]);
    const ok = new PoolSniper({ chains: [chain()], source: src, now: () => 1, lookback: 80 });
    expect((await ok.tick({}, { delayBlocks: 0, delaySec: 0 })).hits).toHaveLength(0);
  });

  it('a 429 stops the rest of the backfill and keeps the cursor on the last block that was read', async () => {
    let n = 0;
    const src = logsOf([]);
    src.getLogs = async (_c, from, to, address, topics) => {
      src.calls.push({ address: address.toLowerCase(), from, to, topics });
      n++;
      if (n > 1) throw new Error('429');
      return [];
    };
    const sniper = new PoolSniper({ chains: [chain(369)], source: src, lookback: 80 });
    const r = await sniper.tick({}, { delayBlocks: 0, delaySec: 0 });
    expect(r.notes.map((n) => n.msg).join(' ')).toMatch(/429/);
    expect(r.cursors[`369:${FACTORY.toLowerCase()}`]).toBe(969);
  });

  it('reports an Ethereum V4 pool and skips it, and ignores V4 on other chains', async () => {
    const id = '0x' + 'cd'.repeat(32);
    const init = log(V4_POOL_MANAGER, encodeV4Init(id, TOKEN, WETH, 3000), 990);
    const src = logsOf([init]);
    const eth = new PoolSniper({ chains: [chain(1, [{ id: 'uni-v3', kind: 'v3', factory: V3FACTORY, router: V3ROUTER }])], source: src, now: () => 1, lookback: 80 });
    const hit = (await eth.tick({}, { delayBlocks: 0, delaySec: 0 })).hits.find((h) => h.kind === 'v4');
    expect(hit).toMatchObject({ skip: "this app doesn't swap V4", pool: id });
    const pulse = new PoolSniper({ chains: [chain(369)], source: src, now: () => 1, lookback: 80 });
    expect((await pulse.tick({}, { delayBlocks: 0, delaySec: 0 })).hits.filter((h) => h.kind === 'v4')).toHaveLength(0);
  });

  it('parses a V3 pool creation the same way', async () => {
    const created = log(V3FACTORY, encodePoolCreated(TOKEN, WETH, 10000, POOL), 970);
    const src = logsOf([created]);
    const sniper = new PoolSniper({
      chains: [chain(1, [{ id: 'uni-v3', kind: 'v3', factory: V3FACTORY, router: V3ROUTER }])],
      source: src, now: () => 1, lookback: 80,
    });
    await sniper.tick({}, { delayBlocks: 0, delaySec: 0 });
    expect(src.calls.some((c) => c.topics.includes(TOPIC.poolCreated) && c.address === V3FACTORY.toLowerCase())).toBe(true);
    expect(sniper.has(1, POOL)).toBe(false);
  });
});
