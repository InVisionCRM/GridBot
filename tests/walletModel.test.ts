/** The Wallet's rows and line (src/ui/walletModel.ts), on the real holdings sample the screens tests use. */
import { describe, expect, it } from 'vitest';
import { walletModel, worthChange, worthLine } from '../src/ui/walletModel';
import type { HoldingsSnapshot } from '../src/live/holdingsMath';
import { HOLDINGS } from './helpers/unitsScreens';

const H = HOLDINGS as HoldingsSnapshot;

describe('wallet rows', () => {
  it('largest first; the headline is the server\'s dust-free total, or the picked chain\'s', () => {
    const m = walletModel(H, 'all', false);
    expect(m.assets.map((a) => a.usd)).toEqual([...m.assets.map((a) => a.usd)].sort((a, b) => (b ?? 0) - (a ?? 0)));
    expect(m.total).toBe(H.netWorthExDustUsd);
    const pls = walletModel(H, 369, false);
    expect(pls.assets.every((a) => a.chainId === 369)).toBe(true);
    expect(pls.total).toBe(H.chains.find((c) => c.chainId === 369)!.usd);
    expect(m.chains.map((c) => c.chainId)).toEqual([...H.chains].filter((c) => c.usd > 0).sort((a, b) => b.usd - a.usd).map((c) => c.chainId));
  });
  it('dust is folded away and counted, and shown on the switch', () => {
    const dusty: HoldingsSnapshot = { ...H, wallet: [...H.wallet, { coin: { chainId: 1, address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', decimals: 18, amount: 3, usdEach: 0.00001, usd: 0.00003 }, dust: true, bots: [] }] };
    expect(walletModel(dusty, 'all', false).hidden).toBe(1);
    expect(walletModel(dusty, 'all', false).assets.some((a) => a.symbol === 'PEPE')).toBe(false);
    expect(walletModel(dusty, 'all', true).assets.some((a) => a.symbol === 'PEPE')).toBe(true);
  });
});

describe('wallet line', () => {
  it('the recorded points, then the value now; a point at or after now is left to the read', () => {
    const pts = [{ t: 1, usd: 100 }, { t: 2, usd: 110 }, { t: 5, usd: 999 }];
    expect(worthLine(pts, { t: 5, usd: 120 })).toEqual([{ t: 1, usd: 100 }, { t: 2, usd: 110 }, { t: 5, usd: 120 }]);
    expect(worthLine(pts, { t: 5, usd: null })).toEqual([{ t: 1, usd: 100 }, { t: 2, usd: 110 }]);
  });
  it('the change runs from the first point to the last', () => {
    expect(worthChange([{ usd: 100 }, { usd: 90 }, { usd: 125 }])).toEqual({ usd: 25, pct: 0.25 });
    expect(worthChange([{ usd: 100 }])).toBeNull();
    expect(worthChange([{ usd: 0 }, { usd: 5 }])).toEqual({ usd: 5, pct: null });
  });
});
