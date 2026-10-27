/**
 * Gas units per chain and per action. Open/close figures are medians of real transactions (2026-10-17, see lp.ts):
 * V3 open 9mm 480k, Ethereum 402k, Robinhood 410–510k; close 197–276k. V2 add 157k, remove 215k. Approve and swap
 * units are the chain's own (chains.ts). Robinhood is an Orbit L2: pass the L1 data fee as native on top.
 */
export type BacktestChain = 'pulsechain' | 'ethereum' | 'robinhood';
export type GasAction = 'approve' | 'swap' | 'v3Open' | 'v3Close' | 'v3Move' | 'v2Open' | 'v2Close';

export const GAS_UNITS: Record<BacktestChain, Record<GasAction, number>> = {
  pulsechain: { approve: 60_000, swap: 220_000, v3Open: 480_000, v3Close: 250_000, v3Move: 480_000 + 250_000 + 220_000, v2Open: 170_000, v2Close: 215_000 },
  ethereum: { approve: 60_000, swap: 180_000, v3Open: 402_000, v3Close: 250_000, v3Move: 402_000 + 250_000 + 180_000, v2Open: 170_000, v2Close: 215_000 },
  robinhood: { approve: 60_000, swap: 220_000, v3Open: 460_000, v3Close: 250_000, v3Move: 460_000 + 250_000 + 220_000, v2Open: 170_000, v2Close: 215_000 },
};

/** Native-token cost of one action. `gasPriceNative` is native per gas unit; `l1Native` is an L2's extra data fee. */
export function gasNative(chain: BacktestChain, action: GasAction, gasPriceNative: number, l1Native = 0): number {
  if (!(gasPriceNative >= 0)) throw new Error(`bad gas price ${gasPriceNative}`);
  return GAS_UNITS[chain][action] * gasPriceNative + Math.max(0, l1Native);
}

/** The same cost in the quote token. `quotePerNative` is quote units for one native unit (1 when the quote is the native coin). */
export function gasQuote(chain: BacktestChain, action: GasAction, gasPriceNative: number, quotePerNative: number, l1Native = 0): number {
  if (!(quotePerNative > 0)) throw new Error(`bad quote per native ${quotePerNative}`);
  return gasNative(chain, action, gasPriceNative, l1Native) * quotePerNative;
}
