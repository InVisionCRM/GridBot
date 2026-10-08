/** Trading mode — paper is the safe default. */
export type TradingMode = 'paper' | 'live';

/** Bot lifecycle states. */
export type BotStatus = 'idle' | 'running' | 'paused' | 'stopped';

/** Side of a grid order. */
export type OrderSide = 'buy' | 'sell';

/** Lifecycle of an individual grid order. */
export type OrderStatus = 'open' | 'filled' | 'cancelled';

export interface GridConfig {
  /** Human-readable pair, e.g. PLS/USDC */
  pair: string;
  /** Base token symbol (what you buy/sell), e.g. PLS */
  baseToken: string;
  /** Quote token symbol (pricing currency), e.g. USDC */
  quoteToken: string;
  /** Lower bound of the grid price range (in quote per base) */
  lowerPrice: number;
  /** Upper bound of the grid price range (in quote per base) */
  upperPrice: number;
  /** Number of price levels (grids). Must be >= 2 */
  gridCount: number;
  /** Total capital allocated in quote currency */
  totalCapital: number;
  /**
   * Target profit fraction per completed buy→sell cycle.
   * Example: 0.01 = 1% profit per grid cycle.
   * Used for display / educational estimates; fills use arithmetic grid spacing.
   */
  profitPerGrid: number;
  mode: TradingMode;
}

export interface GridLevel {
  index: number;
  price: number;
}

export interface GridOrder {
  id: string;
  levelIndex: number;
  side: OrderSide;
  price: number;
  /** Amount of base token */
  amount: number;
  /** Amount of quote token (price * amount for buys) */
  quoteAmount: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
}

export interface Fill {
  id: string;
  orderId: string;
  levelIndex: number;
  side: OrderSide;
  price: number;
  amount: number;
  quoteAmount: number;
  timestamp: number;
  /** Realized PnL contributed by this fill (sells that close a buy cycle) */
  realizedPnl: number;
}

export interface PortfolioSnapshot {
  /** Base token balance */
  baseBalance: number;
  /** Quote token balance */
  quoteBalance: number;
  /** Starting quote capital */
  initialCapital: number;
  /** Sum of closed-cycle profits */
  realizedPnl: number;
  /** Mark-to-market unrealized PnL vs initial */
  unrealizedPnl: number;
  /** Total equity = quote + base * currentPrice */
  equity: number;
}

export interface BotState {
  config: GridConfig | null;
  status: BotStatus;
  levels: GridLevel[];
  orders: GridOrder[];
  fills: Fill[];
  portfolio: PortfolioSnapshot;
  currentPrice: number | null;
  priceSource: 'live' | 'mock' | 'manual' | 'none';
  startedAt: number | null;
  lastTickAt: number | null;
  message: string | null;
}

export interface PriceQuote {
  symbol: string;
  priceUsd: number;
  source: 'coingecko' | 'mock';
  fetchedAt: number;
  note?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
