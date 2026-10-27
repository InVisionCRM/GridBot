/**
 * Same-chain swap quotes. Building a transaction is as far as this module goes:
 * nothing here signs or broadcasts. A later sender (sendSafe) can take `SendableTx`.
 */
import type { PoolRef } from '../../live/markets';
import type { Taxes } from '../../live/tax';

/** What live bots already use of one coin (MultiBot.allocations rows). */
export interface SwapAllocation {
  chainId: number;
  address: string;
  native: boolean;
  allocated: number;
}

/**
 * Optional external aggregator. The default implementation returns nothing.
 * `amountOut` is the post-fee, post-tax amount the wallet would receive.
 * This module never submits `tx`.
 */
export interface AggregatorQuote {
  amountOut: bigint;
  /** Gas units, not wei. */
  gasUnits: bigint;
  priceImpact: number;
  feeBps: number;
  tx?: { to: string; data: string; value: bigint };
}

export interface AggregatorRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}

export interface SwapAggregator {
  readonly id: string;
  quote(req: AggregatorRequest): Promise<AggregatorQuote | null>;
}

/** Calldata a later sender would broadcast. This package never sends it. */
export interface SendableTx {
  chainId: number;
  to: string;
  data: string;
  value: bigint;
  method?: string;
}

export interface SwapRoute {
  id: string;
  kind: 'v2' | 'v3' | 'aggregator';
  /** Post-tax amount the wallet is expected to receive. */
  amountOut: bigint;
  /** Pool output before the output-token tax. Equals amountOut when that tax is 0. */
  routerOut: bigint;
  /** Wallet minimum after slippage (and after tax). */
  minOut: bigint;
  priceImpact: number;
  gasUnits: bigint;
  gasWei: bigint;
  /** gasWei priced in tokenOut raw units. 0 when it cannot be priced. */
  gasOut: bigint;
  /** amountOut − gasOut. Routes are ranked by this. */
  netOut: bigint;
  feeBps: number;
  taxIn: number;
  taxOut: number;
  feeOnTransfer: boolean;
  pool: PoolRef | null;
}

export interface SwapQuoteRequest {
  chainId: number;
  /** Token address, or 'native' for the chain's own coin. */
  tokenIn: string;
  tokenOut: string;
  /** Raw units (the token's own decimals). */
  amountIn: bigint;
  /** Wallet whose balance is checked against allocations. */
  owner: string;
  recipient?: string;
  /** Paper returns the quote and no transaction. Live builds calldata and still does not send it. */
  mode?: 'paper' | 'live';
  slippageBps?: number;
  deadlineMinutes?: number;
  /** Fraction. Routes above this are not selected. */
  maxPriceImpact?: number;
}

export interface SwapQuoteResult {
  paper: boolean;
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  decimalsIn: number;
  decimalsOut: number;
  expectedOut: bigint;
  minOut: bigint;
  priceImpact: number;
  gasEstimate: bigint;
  gasWei: bigint;
  fees: { lpBps: number; taxIn: number; taxOut: number };
  taxes: { in: Taxes; out: Taxes };
  feeOnTransfer: boolean;
  route: SwapRoute;
  /** Best net output first. */
  routes: SwapRoute[];
  /** Null in paper mode. Never broadcast by this service. */
  tx: SendableTx | null;
}
