/**
 * Normalized bridge quote and status. Amounts are raw bigint units (the token's decimals), never floats.
 *
 * A quote's `approval` and `deposit` are unsigned transactions. Callers may later pass `deposit`
 * to sendSafe as `{ from, to, data, value }`. This module does not sign or broadcast.
 */

export type BridgeId = 'across' | 'relay' | 'lifi';

export type BridgeStatusState = 'pending' | 'filled' | 'refunded' | 'expired' | 'failed' | 'partial';

export interface BridgeToken {
  chainId: number;
  address: string;
  decimals: number;
  symbol?: string;
}

export interface BridgeQuoteRequest {
  srcChain: number;
  dstChain: number;
  tokenIn: BridgeToken;
  tokenOut: BridgeToken;
  /** Positive raw amount. Must be a bigint so values above 2^53 stay exact. */
  amountIn: bigint;
  /** Address that receives the destination fill. */
  recipient: string;
  /** Address that would send the approve and the deposit. */
  sender: string;
  /**
   * True when both legs are the same coin (route-table relation `same-asset`).
   * Dollar pairs such as Ethereum USDC and Robinhood USDG are not the same coin.
   * Same-asset quotes are rejected when amountOut exceeds amountIn by more than 1 bp
   * after decimals are aligned.
   */
  sameAsset: boolean;
  /** Slippage in basis points. Default 50. Capped at 500. */
  slippageBps?: number;
}

/** One priced component. `amount` is raw units of `token` (decimals on that token, not necessarily tokenOut). */
export interface FeeComponent {
  amount: bigint;
  decimals: number;
  token: string;
  chainId: number;
  label: string;
}

export interface BridgeFees {
  /** Protocol / LP / aggregator fee (Li.Fi's 0.25% lives here). */
  bridge: FeeComponent;
  /** Relayer or solver fee, excluding destination gas when the provider splits it out. */
  relayer: FeeComponent;
  /** Gas the depositor pays on the source chain. Zero when the quote API does not price it. */
  sourceGas: FeeComponent;
  /** Destination fill gas, or a later claim cost. Null when the provider does not charge one. */
  destinationGas: FeeComponent | null;
}

export interface BridgeEta {
  /** Typical fill, seconds. */
  p50Sec: number;
  /** Slow fill, seconds. The ETA filter compares this, not p50. */
  p90Sec: number;
}

/** Unsigned EVM transaction. `value` is wei. Nothing in this package sends it. */
export interface UnsignedTx {
  chainId: number;
  to: string;
  data: string;
  value: bigint;
  gasLimit?: bigint;
}

export interface BridgeQuote {
  provider: BridgeId;
  srcChain: number;
  dstChain: number;
  tokenIn: BridgeToken;
  tokenOut: BridgeToken;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  fees: BridgeFees;
  eta: BridgeEta;
  /** Unix seconds. The quote must not be used at or after this time. */
  expiresAt: number;
  approval: UnsignedTx | null;
  deposit: UnsignedTx;
  /** Provider quote id (Across id, Relay request id, Li.Fi step id). Not a transaction hash. */
  quoteId: string;
  recipient: string;
  sender: string;
  /** Li.Fi is discovery-only and must not be auto-selected. */
  discoveryOnly: boolean;
  sameAsset: boolean;
}

export interface ReceivedFill {
  token: string;
  amount: bigint;
  chainId: number;
  decimals: number;
}

export interface BridgeStatus {
  provider: BridgeId;
  state: BridgeStatusState;
  /**
   * False while the provider may still move this deposit.
   * Across `expired` is not final: the fill deadline passed and a refund is still outstanding.
   * Relay `failure` is not final: the fill may be retried, or the deposit may later refund.
   */
  final: boolean;
  /** Across `expired`: funds are still escrowed and the refund has not landed. */
  awaitingRefund: boolean;
  /** Set when the status names what arrived. Partial fills always include it. */
  received: ReceivedFill | null;
  fillTx: string | null;
  refundTx: string | null;
  depositId: string | null;
  detail: string;
}

export interface BridgeStatusQuery {
  provider: BridgeId;
  txHash?: string;
  depositId?: string;
  /** Required. Across and Li.Fi put it on the query string; Relay ignores it. */
  originChainId: number;
  /** Required for Li.Fi. */
  destinationChainId?: number;
}

export interface BridgeProvider {
  readonly id: BridgeId;
  quote(req: BridgeQuoteRequest): Promise<BridgeQuote>;
  status(q: BridgeStatusQuery): Promise<BridgeStatus>;
}

export type BridgeLog = (level: 'info' | 'warn' | 'error', message: string) => void;
