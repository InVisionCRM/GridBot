import { describe, expect, it } from 'vitest';
import { checkGasReserve, DEFAULT_GAS_RESERVE } from '../src/live/gasReserve';
import { floorSig, spendFunds } from '../src/ui/model';

const WPLS = '0xa1077a294dde1b09bb078844df40758a5d0f9a27';
const DAI = '0xefd766ccb38eaf1dfd701853bfce31359239f305';
const status = (allocations: unknown[] = []) => ({
  legacyChainId: 369,
  marketList: [
    { key: 'HEX~', label: 'HEX/PLS', chainId: 369, base: 'HEX', quote: 'PLS', quoteNative: true, quoteAddress: WPLS, flipped: true },
    { key: 'DAI', label: 'PLS/DAI', chainId: 369, base: 'PLS', quote: 'DAI', quoteNative: false, quoteAddress: DAI },
  ],
  wallets: [{ chainId: 369, address: '0xabc', error: null, coins: [{ symbol: 'PLS', address: null, native: true, amount: 10_749_500 }, { symbol: 'DAI', address: DAI, native: false, amount: 40 }] }],
  allocations: { rows: allocations },
});

describe('spendFunds (New bot wallet line, Max and live check)', () => {
  it('the reported case: 16.23M PLS + 2% gas set-aside does not fit in 10.75M PLS', () => {
    const f = spendFunds(status(), 'HEX~', 16_226_700, DEFAULT_GAS_RESERVE);
    expect(f).toMatchObject({ symbol: 'PLS', have: 10_749_500, inUse: 0, ok: false });
    expect(f.reserve).toBeCloseTo(324_534, 0);
    expect(f.need).toBeCloseTo(16_551_234, 0);
    // Same verdict as the server's live-start check
    expect(checkGasReserve({ capital: 16_226_700, balance: 10_749_500, symbol: 'PLS' }).ok).toBe(f.ok);
  });

  it('Max is the most PLS that fits after the gas set-aside, and the server accepts it', () => {
    const f = spendFunds(status(), 'HEX~', 0, DEFAULT_GAS_RESERVE);
    expect(f.max).toBeCloseTo(10_749_500 / 1.02, 3);
    const max = floorSig(f.max!);
    expect(max).toBe(10_538_700);
    expect(checkGasReserve({ capital: max, balance: 10_749_500, symbol: 'PLS' }).ok).toBe(true);
    expect(spendFunds(status(), 'HEX~', max, DEFAULT_GAS_RESERVE).ok).toBe(true);
  });

  it('tokens have no gas set-aside; running live bots reduce what is free', () => {
    const f = spendFunds(status([{ chainId: 369, address: '0xEFD766cCb38EaF1dfd701853BFCe31359239F305', native: false, allocated: 25 }]), 'DAI', 20, DEFAULT_GAS_RESERVE);
    expect(f).toMatchObject({ symbol: 'DAI', have: 40, inUse: 25, reserve: 0, need: 45, max: 15, ok: false });
  });

  it('no signing key → balance unknown, nothing blocked', () => {
    const s = { ...status(), wallets: [] };
    expect(spendFunds(s, 'DAI', 1e9, DEFAULT_GAS_RESERVE)).toMatchObject({ have: null, max: null, ok: null });
  });
});
