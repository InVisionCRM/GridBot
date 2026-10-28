import { getAddress, id } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';
import { chainByKey } from '../src/live/chains';
import { V4_POOL_MANAGER } from '../src/market/poolEvents';
import { DEFAULT_MAX_TOP10_SHARE, geckoTop10Share, holderBound, holderShares, isExcludedHolder, protocolExclusions } from '../src/market/holders';
import { ERC20, FACTORY } from '../src/server/dex/abis';
import { clearHolderCache, holderApiBase, readHolderConcentration, type HolderChain } from '../src/server/market/holderRead';

const pool = '0x' + 'ab'.repeat(20);
const dead = '0x000000000000000000000000000000000000dEaD';
const locker = '0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214';
const whale = '0x' + '11'.repeat(20);
const tag = '0x' + '22'.repeat(20);

function row(address: string, balance: bigint, name?: string) {
  return { address, balance, ...(name ? { name } : {}) };
}

describe('holder shares', () => {
  it('drops the pool, burn addresses, known lockers and a locker the explorer named', () => {
    expect(isExcludedHolder(pool, null, [pool])).toBe(true);
    expect(isExcludedHolder(dead, null, [])).toBe(true);
    expect(isExcludedHolder(locker, null, [])).toBe(true);
    expect(isExcludedHolder(tag, 'PinkLock: Liquidity Locker', [])).toBe(true);
    expect(isExcludedHolder(whale, 'Clock Token', [pool])).toBe(false);

    const supply = 1_000n;
    const r = holderShares({
      totalSupply: supply,
      exclude: [pool],
      moreHolders: false,
      holders: [
        row(pool, 500n),
        row(dead, 100n),
        row(locker, 50n),
        row(tag, 40n, 'Team Finance lock'),
        row(whale, 200n),
        ...Array.from({ length: 9 }, (_, i) => row('0x' + (i + 1).toString(16).padStart(40, 'a'), 10n)),
      ],
    });
    // Circulating = 1000 − (500 + 100 + 50 + 40) = 310. Largest 200. Top 10 = 200 + 9×10 = 290.
    expect(r.unverified).toBe(false);
    expect(r.largest).toBeCloseTo(200 / 310, 5);
    expect(r.top10).toBeCloseTo(290 / 310, 5);
    expect(r.top10!).toBeGreaterThan(DEFAULT_MAX_TOP10_SHARE);
  });

  it('is unverified when another page might still hide a real holder, and verified when the list is complete', () => {
    const few = [row(whale, 10n), row('0x' + '44'.repeat(20), 10n)];
    expect(holderShares({ totalSupply: 100n, holders: few, exclude: [], moreHolders: true }).unverified).toBe(true);
    const full = holderShares({ totalSupply: 100n, holders: few, exclude: [], moreHolders: false });
    expect(full.unverified).toBe(false);
    expect(full.largest).toBeCloseTo(0.1, 5);
    expect(full.top10).toBeCloseTo(0.2, 5);
    expect(holderShares({ totalSupply: 0n, holders: few, exclude: [], moreHolders: false }).unverified).toBe(true);
  });

  it('drops every pool, the position manager, the V4 pool manager and burn addresses', () => {
    const pool2 = '0x' + '33'.repeat(20);
    const npm = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
    const zero = '0x' + '00'.repeat(20);
    expect(protocolExclusions([{ positionManager: npm }])).toEqual([V4_POOL_MANAGER, npm]);
    const r = holderShares({
      totalSupply: 1_000n, exclude: [pool, pool2, npm, V4_POOL_MANAGER], moreHolders: false,
      holders: [
        row(pool, 100n), row(pool2, 100n), row(npm, 50n), row(V4_POOL_MANAGER, 40n),
        row(dead, 50n), row(zero, 20n), row(whale, 200n),
        ...Array.from({ length: 9 }, (_, i) => row('0x' + (i + 1).toString(16).padStart(40, 'b'), 10n)),
      ],
    });
    // 1000 − (100+100+50+40+50+20) = 640. Largest 200. Top 10 = 200 + 9×10 = 290.
    expect(r.unverified).toBe(false);
    expect(r.largest).toBeCloseTo(200 / 640, 5);
    expect(r.top10).toBeCloseTo(290 / 640, 5);
    expect(r.unseen).toBe(0);
  });

  it('reads GeckoTerminal top-10 percent and bounds a partial sample', () => {
    expect(geckoTop10Share({ data: { attributes: { holders: { distribution_percentage: { top_10: '36.4203' } } } } })).toBeCloseTo(0.364203, 6);
    expect(geckoTop10Share({})).toBeNull();
    expect(holderBound({ largest: 0.23, top10: 0.27, unseen: 0.7, maxHolder: 0.1, maxTop10: 0.4 })).toBe('largest');
    expect(holderBound({ largest: 0.05, top10: 0.2, unseen: 0.5, maxHolder: 0.1, maxTop10: 0.4 })).toBe('unread');
    expect(holderBound({ largest: 0.04, top10: 0.2, unseen: 0.05, maxHolder: 0.1, maxTop10: 0.4 })).toBeNull();
    expect(holderBound({ largest: 0.04, top10: 0.5, unseen: 0.6, top10Exact: true, maxHolder: 0.1, maxTop10: 0.4 })).toBe('top10');
  });
});

describe('holder read', () => {
  beforeEach(() => clearHolderCache());

  it('uses the chain token API, and Robinhood’s Blockscout API without setting tokenApi', () => {
    const hood = chainByKey('robinhood')!;
    const eth = chainByKey('ethereum')!;
    expect(hood.tokenApi).toBeUndefined();
    expect(holderApiBase(hood)).toBe('https://robinhoodchain.blockscout.com/api/v2');
    expect(holderApiBase(eth)).toBe('https://eth.blockscout.com/api/v2');
    expect(holderApiBase({ explorer: 'https://etherscan.io' })).toBeNull();
  });

  it('reads a descending holder page, caches it, and does not call again inside the ttl', async () => {
    let now = 1_000;
    const calls: string[] = [];
    const token = '0x' + 'aa'.repeat(20);
    const fetchJson = async (url: string) => {
      calls.push(url);
      if (url.endsWith(`/tokens/${token}`)) return { total_supply: '1000' };
      if (url.includes('/holders')) {
        return {
          items: [
            { address: { hash: pool }, value: '400' },
            { address: { hash: whale }, value: '300' },
            { address: { hash: dead, name: 'Dead address' }, value: '100' },
            ...Array.from({ length: 9 }, (_, i) => ({ address: { hash: '0x' + (i + 1).toString(16).padStart(40, '5') }, value: '10' })),
          ],
          next_page_params: { items_count: 50 },
        };
      }
      throw new Error(url);
    };
    const q = { chainId: 4663, token, api: 'https://robinhoodchain.blockscout.com/api/v2', exclude: [pool] };
    const first = await readHolderConcentration(q, { fetchJson, now: () => now, paceMs: 0 });
    expect(first.unverified).toBe(false);
    expect(first.largest).toBeCloseTo(300 / 500, 5);
    expect(calls).toHaveLength(2);
    await readHolderConcentration(q, { fetchJson, now: () => now, paceMs: 0 });
    expect(calls).toHaveLength(2);
    now += 11 * 60_000;
    await readHolderConcentration(q, { fetchJson, now: () => now, paceMs: 0 });
    expect(calls).toHaveLength(4);
  });

  it('paces explorer calls', async () => {
    const token = '0x' + 'bb'.repeat(20);
    const fetchJson = async (url: string) => url.includes('/holders') ? { items: [], next_page_params: null } : { total_supply: '10' };
    const t0 = Date.now();
    await readHolderConcentration(
      { chainId: 1, token, api: 'https://eth.blockscout.com/api/v2', exclude: [] },
      { fetchJson, paceMs: 40 },
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });

  it('is unverified when the explorer fails, and falls back to one totalSupply() call', async () => {
    const token = '0x' + 'cc'.repeat(20);
    const down = await readHolderConcentration(
      { chainId: 4663, token, api: 'https://robinhoodchain.blockscout.com/api/v2', exclude: [] },
      { fetchJson: async () => { throw new Error('HTTP 403 from robinhoodchain.blockscout.com'); }, paceMs: 0 },
    );
    expect(down).toMatchObject({ unverified: true, largest: null, top10: null, unavailable: 'read-failed', chainName: 'chain 4663' });

    let supplyCalls = 0;
    const fetched = await readHolderConcentration(
      { chainId: 1, token: '0x' + 'dd'.repeat(20), api: 'https://eth.blockscout.com/api/v2', exclude: [pool] },
      {
        paceMs: 0,
        fetchJson: async (url) => {
          if (url.includes('/holders')) return { items: [{ address: { hash: whale }, value: '40' }, { address: { hash: pool }, value: '60' }], next_page_params: null };
          return {};
        },
        totalSupply: async () => { supplyCalls++; return 100n; },
      },
    );
    expect(supplyCalls).toBe(1);
    expect(fetched.unverified).toBe(false);
    expect(fetched.largest).toBeCloseTo(1, 5);

    const noApi = await readHolderConcentration(
      { chainId: 1, token, api: null, exclude: [] },
      { fetchJson: async () => { throw new Error('should not be called'); }, paceMs: 0 },
    );
    expect(noApi).toMatchObject({ unverified: true, unavailable: 'no-source', chainName: 'chain 1' });

    const supplyDown = await readHolderConcentration(
      { chainId: 1, token: '0x' + 'ee'.repeat(20), api: 'https://eth.blockscout.com/api/v2', exclude: [] },
      {
        paceMs: 0,
        fetchJson: async (url) => (url.includes('/holders') ? { items: [{ address: { hash: whale }, value: '1' }], next_page_params: null } : {}),
        totalSupply: async () => { throw new Error('rpc down'); },
      },
    );
    expect(supplyDown).toMatchObject({ unverified: true, unavailable: 'read-failed' });
  });

  it('is unverified when three pages still don’t show 10 real holders', async () => {
    const token = '0x' + 'ff'.repeat(20);
    let page = 0;
    const r = await readHolderConcentration(
      { chainId: 1, token, api: 'https://eth.blockscout.com/api/v2', exclude: [pool] },
      {
        paceMs: 0,
        fetchJson: async (url) => {
          if (!url.includes('/holders')) return { total_supply: '100' };
          page++;
          return { items: [{ address: { hash: pool }, value: String(50 - page) }, { address: { hash: whale }, value: '1' }], next_page_params: { page } };
        },
      },
    );
    expect(page).toBe(3);
    expect(r.unverified).toBe(true);
  });

  it('paces each chain on its own clock', async () => {
    const stamp: Record<number, number[]> = { 1: [], 2: [] };
    const fetchJson = async (url: string) => {
      const chain = url.includes('chain-1') ? 1 : 2;
      stamp[chain].push(Date.now());
      if (url.includes('/holders')) return { items: [], next_page_params: null };
      return { total_supply: '10' };
    };
    const one = { chainId: 1, token: '0x' + 'a1'.repeat(20), api: 'https://chain-1.example/api/v2', exclude: [] as string[] };
    const two = { chainId: 2, token: '0x' + 'b2'.repeat(20), api: 'https://chain-2.example/api/v2', exclude: [] as string[] };
    await Promise.all([
      readHolderConcentration(one, { fetchJson, paceMs: 80 }),
      readHolderConcentration(two, { fetchJson, paceMs: 80 }),
    ]);
    expect(stamp[1][1] - stamp[1][0]).toBeGreaterThanOrEqual(70);
    expect(stamp[2][1] - stamp[2][0]).toBeGreaterThanOrEqual(70);
    expect(Math.abs(stamp[1][0] - stamp[2][0])).toBeLessThan(50);
  });

  it('after a 403, reads holders from Transfer logs and balanceOf and ignores every pool', async () => {
    const token = getAddress('0x' + 'ab'.repeat(20));
    const traded = getAddress('0x' + '11'.repeat(20));
    const otherPool = getAddress('0x' + '22'.repeat(20));
    const whale = getAddress('0x' + '33'.repeat(20));
    const small = getAddress('0x' + '44'.repeat(20));
    const spend = getAddress('0x' + '55'.repeat(20));
    const factory = getAddress('0x' + '66'.repeat(20));
    const supplySel = ERC20.getFunction('totalSupply')!.selector;
    const balSel = ERC20.getFunction('balanceOf')!.selector;
    const pairSel = FACTORY.getFunction('getPair')!.selector;
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
    const topic = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
    const bals: Record<string, bigint> = {
      [whale.toLowerCase()]: 200n, [small.toLowerCase()]: 50n,
      [traded.toLowerCase()]: 100n, [otherPool.toLowerCase()]: 300n,
    };
    const chain: HolderChain = {
      getBlockNumber: async () => 5_000,
      getLogs: async () => [{
        topics: [id('Transfer(address,address,uint256)'), topic(whale), topic(small)],
        data: word(10n),
      }, {
        topics: [id('Transfer(address,address,uint256)'), topic(otherPool), topic(whale)],
        data: word(50n),
      }],
      call: async ({ data }) => {
        if (data.startsWith(supplySel)) return word(1_000n);
        if (data.startsWith(pairSel)) return word(BigInt(otherPool));
        if (data.startsWith(balSel)) {
          const who = getAddress(`0x${data.slice(-40)}`).toLowerCase();
          return word(bals[who] ?? 0n);
        }
        throw new Error(data.slice(0, 10));
      },
    };
    const r = await readHolderConcentration({
      chainId: 4663, chainName: 'Robinhood Chain', token, api: 'https://robinhoodchain.blockscout.com/api/v2',
      exclude: [traded], spends: [spend], dexes: [{ kind: 'v2', factory }],
    }, {
      paceMs: 0, logChunks: 1, logSpan: 1_000, chain,
      fetchJson: async () => { throw new Error('HTTP 403 from robinhoodchain.blockscout.com'); },
    });
    // Circulating = 1000 − pools 400 = 600. Largest 200. The other pool came from getPair, not the traded pool alone.
    expect(r.unverified).toBe(false);
    expect(r.largest).toBeCloseTo(200 / 600, 5);
    expect(r.top10).toBeCloseTo(250 / 600, 5);
    expect(r.unseen).toBeCloseTo(350 / 600, 5);
    expect(holderBound({ largest: r.largest!, top10: r.top10!, unseen: r.unseen ?? 0, maxHolder: 0.1, maxTop10: 0.4 })).toBe('largest');
  });
});
