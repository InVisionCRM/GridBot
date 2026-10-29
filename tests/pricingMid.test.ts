/**
 * Dollar values use the pool's mid price (the sell-side spot with the pool fee taken back out), cached spots are read
 * again after PRICE_TTL_MS, a grid re-center counts as one move, and walletUsd means the same per chain and in total.
 * Redone on current main from the closed InVisionCRM/GridBot#49.
 */
import { describe, expect, it } from 'vitest';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets } from '../src/live/markets';
import { assemblePortfolio, type BotRef } from '../src/live/holdingsMath';
import { Hub, PRICE_TTL_MS } from '../src/server/chains/hub';
import { ChainRuntime } from '../src/server/chains/runtime';
import { NET, MockChain } from './helpers/mockChain';

function hubAt(chain = new MockChain(0.00001)) {
  let t = 1_800_000_000_000;
  const hub = new Hub({ runtimes: [new ChainRuntime(chainFromNetwork(NET), chain, null)], markets: legacyMarkets(NET), legacyNet: NET, now: () => t });
  return { hub, chain, tick: (ms: number) => { t += ms; } };
}

describe('mid prices for dollar values', () => {
  it('native USD and base USD take the pool fee back out of the sell-side spot; trading keeps the spot', () => {
    const { hub } = hubAt();
    const key = hub.usdRefKey(NET.chainId)!;
    const fee = hub.def(key).pool.feeBps / 10_000;
    expect(fee).toBeGreaterThan(0);
    hub.setSpot(key, 0.000005);
    expect(hub.spots[key]).toBe(0.000005);
    expect(hub.midSpot(key)).toBeCloseTo(0.000005 / (1 - fee), 15);
    expect(hub.nativeUsd(NET.chainId)).toBeCloseTo(0.000005 / (1 - fee), 15);
    expect(hub.baseUsd(key)).toBeCloseTo(0.000005 / (1 - fee), 15);
  });
  it("a flipped view's mid is the inverse of the original's (both spots are sell-side through the same pool)", () => {
    const { hub } = hubAt();
    const key = hub.usdRefKey(NET.chainId)!;
    const fee = hub.def(key).pool.feeBps / 10_000, mid = 0.000005;
    hub.setSpot(key, mid * (1 - fee));
    hub.setSpot(`${key}~`, (1 / mid) * (1 - fee));
    expect(hub.midSpot(key)!).toBeCloseTo(mid, 15);
    expect(hub.midSpot(`${key}~`)! * hub.midSpot(key)!).toBeCloseTo(1, 12);
  });
  it('no spot yet: no mid', () => {
    const { hub } = hubAt();
    expect(hub.midSpot(hub.usdRefKey(NET.chainId)!)).toBeNull();
  });
});

describe('price TTL', () => {
  it(`a cached spot is reused for ${PRICE_TTL_MS / 1000}s, then read again`, async () => {
    expect(PRICE_TTL_MS).toBe(60_000);
    const { hub, chain, tick } = hubAt();
    const key = hub.usdRefKey(NET.chainId)!;
    let reads = 0;
    const orig = chain.call.bind(chain);
    chain.call = async (tx) => { reads++; return orig(tx); };
    await hub.ensureSpot(key);
    const first = reads;
    expect(first).toBeGreaterThan(0);
    tick(PRICE_TTL_MS - 1000);
    await hub.ensureSpot(key);
    expect(reads).toBe(first);
    tick(2000);
    chain.setPrice(0.00002);
    const p = await hub.ensureSpot(key);
    expect(reads).toBeGreaterThan(first);
    expect(p).toBeGreaterThan(0.000015);
  });
});

describe('walletUsd means the same per chain and in total', () => {
  const grid: BotRef = { id: 'g1', kind: 'grid', name: 'Grid', status: 'running', mode: 'live' };
  const chain = { id: 369, name: 'PulseChain', short: 'PLS', color: '#e040fb', address: '0x1' };
  it("every wallet coin, bots' share included; freeUsd is what no bot claimed", () => {
    const snap = assemblePortfolio({
      address: '0x1', at: 1, hasSigner: true, chains: [chain], errors: [], positions: [],
      wallet: [{ chainId: 369, address: null, symbol: 'PLS', decimals: 18, amount: 100, usdEach: 1, bots: [{ bot: grid, amount: 40 }] }],
    });
    expect(snap.walletUsd).toBe(100);
    expect(snap.chains[0].walletUsd).toBe(snap.walletUsd);
    expect(snap.chains[0].freeUsd).toBe(snap.freeUsd);
    expect(snap.chains[0].freeUsd + snap.chains[0].botsUsd).toBe(snap.chains[0].walletUsd);
  });
});
