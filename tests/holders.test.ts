import { beforeEach, describe, expect, it } from 'vitest';
import { chainByKey } from '../src/live/chains';
import { TOP10_MAX_SHARE, holderShares, isExcludedHolder } from '../src/market/holders';
import { clearHolderCache, holderApiBase, readHolderConcentration } from '../src/server/market/holderRead';

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
        ...Array.from({ length: 9 }, (_, i) => row('0x' + (i + 1).toString(16).padStart(40, '3'), 10n)),
      ],
    });
    // Circulating = 1000 − (500 + 100 + 50 + 40) = 310. Largest 200. Top 10 = 200 + 9×10 = 290.
    expect(r.unverified).toBe(false);
    expect(r.largest).toBeCloseTo(200 / 310, 5);
    expect(r.top10).toBeCloseTo(290 / 310, 5);
    expect(r.top10!).toBeGreaterThan(TOP10_MAX_SHARE);
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
      { chainId: 1, token, api: 'https://eth.blockscout.com/api/v2', exclude: [] },
      { fetchJson: async () => { throw new Error('HTTP 403'); }, paceMs: 0 },
    );
    expect(down).toMatchObject({ unverified: true, largest: null, top10: null });

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
    expect(noApi.unverified).toBe(true);

    const supplyDown = await readHolderConcentration(
      { chainId: 1, token: '0x' + 'ee'.repeat(20), api: 'https://eth.blockscout.com/api/v2', exclude: [] },
      {
        paceMs: 0,
        fetchJson: async (url) => (url.includes('/holders') ? { items: [{ address: { hash: whale }, value: '1' }], next_page_params: null } : {}),
        totalSupply: async () => { throw new Error('rpc down'); },
      },
    );
    expect(supplyDown.unverified).toBe(true);
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
});
