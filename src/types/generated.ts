/**
 * "Generated": what a bot made, in coins (no USD, no price conversion), for screens that show crypto units only.
 * Shared by the server (token trader, smart trader) and the UI.
 *
 * Counted only from what actually happened: coins received from closed sells (or bots closed back to cash) less the
 * coins paid for them, less the gas paid. Swap fees and token taxes are already inside those amounts (they are the
 * coins that did not arrive), so they are not subtracted a second time; they are reported apart for reference.
 * Open positions are not marked to the market (that would be a price move): they add nothing until sold, except
 * the costs they already paid (buy fee, gas).
 */
export interface GeneratedCoin {
  chainId: number;
  /** Token address (lower case); the chain's own coin of the smart trader may have none (null) */
  address: string | null;
  symbol: string;
  /** The chain's own coin or its wrapped form: its gas is taken out of `amount` */
  native: boolean;
}

export interface Generated {
  /** The coin the money was funded with (the token trader's spend coin; the smart trader's budget coin) */
  coin: GeneratedCoin;
  /** The headline: net generated, in `coin` units */
  amount: number;
  /** Coins received from closed sells (after fees, taxes, impact) */
  proceeds: number;
  /** Coins paid for what was sold, plus buy fees already paid on positions still open */
  cost: number;
  /** For reference only, already inside proceeds / cost: pool fees, in `coin` (sell side estimated live). null = not broken out. */
  fees: number | null;
  /** For reference only, already inside proceeds: sell taxes, in `coin` (estimated). null = not broken out. */
  taxes: number | null;
  /** Gas paid, in the chain's own coin. Taken out of `amount` only when `gasInAmount` (coin is native or wrapped native). */
  gasNative: number;
  gasSymbol: string | null;
  gasInAmount: boolean;
  /** Closed sells counted. null = not counted (smart trader). */
  closed: number | null;
  /** Only closed positions are realized; open ones count only the costs they already paid */
  basis: 'closed';
}
