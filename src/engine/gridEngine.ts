import type {
  BotState,
  Fill,
  GridConfig,
  GridLevel,
  GridOrder,
  PortfolioSnapshot,
  ValidationResult,
} from '../types/grid.js';

let orderSeq = 0;
let fillSeq = 0;

function nextOrderId(): string {
  orderSeq += 1;
  return `ord-${orderSeq}`;
}

function nextFillId(): string {
  fillSeq += 1;
  return `fill-${fillSeq}`;
}

/** Reset ID counters — useful in tests. */
export function resetIdCounters(): void {
  orderSeq = 0;
  fillSeq = 0;
}

/**
 * Calculate evenly spaced grid price levels between lower and upper (inclusive).
 * gridCount is the number of intervals, so there are gridCount + 1 price levels.
 * Example: lower=100, upper=110, gridCount=2 → [100, 105, 110]
 */
export function calculateGridLevels(
  lowerPrice: number,
  upperPrice: number,
  gridCount: number,
): GridLevel[] {
  if (gridCount < 1) {
    throw new Error('gridCount must be at least 1');
  }
  if (!(lowerPrice > 0) || !(upperPrice > 0)) {
    throw new Error('prices must be positive');
  }
  if (upperPrice <= lowerPrice) {
    throw new Error('upperPrice must be greater than lowerPrice');
  }

  const levels: GridLevel[] = [];
  const step = (upperPrice - lowerPrice) / gridCount;
  for (let i = 0; i <= gridCount; i++) {
    const raw = lowerPrice + step * i;
    // Round to reduce floating-point noise for display/matching
    const price = Number(raw.toPrecision(12));
    levels.push({ index: i, price });
  }
  return levels;
}

/** Spacing between adjacent levels (arithmetic). */
export function gridSpacing(config: GridConfig): number {
  return (config.upperPrice - config.lowerPrice) / config.gridCount;
}

/**
 * Estimate profit per completed buy→sell cycle using grid spacing.
 * Buy at level i, sell at level i+1 → profit ≈ spacing * amount.
 */
export function estimateProfitPerCycle(
  config: GridConfig,
  amountPerOrder: number,
): number {
  return gridSpacing(config) * amountPerOrder;
}

/**
 * Validate a grid config with beginner-friendly error messages.
 */
export function validateConfig(config: Partial<GridConfig>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.pair?.trim()) errors.push('Choose a trading pair (e.g. PLS/USDC).');
  if (!config.baseToken?.trim()) errors.push('Base token is required.');
  if (!config.quoteToken?.trim()) errors.push('Quote token is required.');

  const lower = config.lowerPrice;
  const upper = config.upperPrice;
  const grids = config.gridCount;
  const capital = config.totalCapital;
  const profit = config.profitPerGrid;

  if (lower === undefined || Number.isNaN(lower)) {
    errors.push('Lower price is required.');
  } else if (lower <= 0) {
    errors.push('Lower price must be greater than zero.');
  }

  if (upper === undefined || Number.isNaN(upper)) {
    errors.push('Upper price is required.');
  } else if (upper <= 0) {
    errors.push('Upper price must be greater than zero.');
  }

  if (
    lower !== undefined &&
    upper !== undefined &&
    !Number.isNaN(lower) &&
    !Number.isNaN(upper)
  ) {
    if (upper <= lower) {
      errors.push('Upper price must be higher than lower price.');
    } else if (upper / lower < 1.01) {
      warnings.push(
        'Your range is very tight (<1%). Grids may fill rarely or feel noisy.',
      );
    } else if (upper / lower > 5) {
      warnings.push(
        'Your range is very wide (>5×). Consider a narrower band around current price when learning.',
      );
    }
  }

  if (grids === undefined || Number.isNaN(grids)) {
    errors.push('Number of grids is required.');
  } else if (!Number.isInteger(grids) || grids < 2) {
    errors.push('Use at least 2 grids (more levels = finer steps).');
  } else if (grids > 100) {
    errors.push('Keep grids at 100 or fewer for clarity in paper mode.');
  }

  if (capital === undefined || Number.isNaN(capital)) {
    errors.push('Total capital is required.');
  } else if (capital <= 0) {
    errors.push('Total capital must be greater than zero.');
  } else if (capital > 1_000_000) {
    warnings.push('Large capital is fine in paper mode, but start small while learning.');
  }

  if (profit === undefined || Number.isNaN(profit)) {
    errors.push('Profit per grid is required (e.g. 0.01 for 1%).');
  } else if (profit <= 0) {
    errors.push('Profit per grid must be greater than zero.');
  } else if (profit > 0.2) {
    warnings.push('Profit target >20% per grid is unusually high for a tight range.');
  }

  if (config.mode === 'live') {
    warnings.push(
      'The paper engine only simulates. Use the Live setup screen for real PulseX trades.',
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

function emptyPortfolio(initialCapital = 0): PortfolioSnapshot {
  return {
    baseBalance: 0,
    quoteBalance: initialCapital,
    initialCapital,
    realizedPnl: 0,
    unrealizedPnl: 0,
    equity: initialCapital,
  };
}

export function createInitialState(): BotState {
  return {
    config: null,
    status: 'idle',
    levels: [],
    orders: [],
    fills: [],
    portfolio: emptyPortfolio(),
    currentPrice: null,
    priceSource: 'none',
    startedAt: null,
    lastTickAt: null,
    message: null,
  };
}

/**
 * Split capital across buy levels below current price.
 * Levels at/above price get sell orders only after buys fill (classic geometric/arithmetic grid).
 * Initial placement: buys below price, sells above if we already hold base (bootstrap: quote only → buys below).
 */
export function bootstrapOrders(
  config: GridConfig,
  levels: GridLevel[],
  currentPrice: number,
): { orders: GridOrder[]; portfolio: PortfolioSnapshot } {
  const buyLevels = levels.filter((l) => l.price < currentPrice);
  const sellLevels = levels.filter((l) => l.price > currentPrice);

  // Reserve capital for buy side. If no buys (price at bottom), hold quote.
  const buyBudget = config.totalCapital;
  const nBuys = Math.max(buyLevels.length, 1);
  const quotePerBuy = buyBudget / nBuys;

  const orders: GridOrder[] = [];
  let quoteSpent = 0;

  for (const level of buyLevels) {
    const quoteAmount = quotePerBuy;
    const amount = quoteAmount / level.price;
    quoteSpent += quoteAmount;
    orders.push({
      id: nextOrderId(),
      levelIndex: level.index,
      side: 'buy',
      price: level.price,
      amount,
      quoteAmount,
      status: 'open',
      createdAt: Date.now(),
    });
  }

  // If price is below the whole grid, place buys on all levels except top (will become sells after fills).
  // If price is above whole grid, we can't buy — leave a message via empty buys.
  // Sell levels are placed only after inventory exists; for educational bootstrap we place
  // "pending sell slots" as open sells only when we seed a tiny base inventory for demo symmetry.
  // Default beginner path: quote-only → buy walls below market.

  void sellLevels; // reserved for future inventory seeding

  const portfolio = emptyPortfolio(config.totalCapital);
  portfolio.quoteBalance = config.totalCapital; // orders are virtual reservations in paper mode
  // In paper mode we keep full quote until fills; open buy orders are reservations for UI.
  void quoteSpent;

  return { orders, portfolio };
}

/**
 * After a buy fills, place a sell one level higher (if that level exists).
 * After a sell fills, place a buy one level lower.
 */
export function createOppositeOrder(
  filled: GridOrder,
  levels: GridLevel[],
  amount: number,
): GridOrder | null {
  if (filled.side === 'buy') {
    const next = levels.find((l) => l.index === filled.levelIndex + 1);
    if (!next) return null;
    return {
      id: nextOrderId(),
      levelIndex: next.index,
      side: 'sell',
      price: next.price,
      amount,
      quoteAmount: next.price * amount,
      status: 'open',
      createdAt: Date.now(),
    };
  }

  const prev = levels.find((l) => l.index === filled.levelIndex - 1);
  if (!prev) return null;
  const quoteAmount = prev.price * amount;
  return {
    id: nextOrderId(),
    levelIndex: prev.index,
    side: 'buy',
    price: prev.price,
    amount,
    quoteAmount,
    status: 'open',
    createdAt: Date.now(),
  };
}

export interface TickResult {
  state: BotState;
  newFills: Fill[];
}

/**
 * Process a price tick: fill any open orders whose price is crossed.
 * Buy fills when price <= order price; sell fills when price >= order price.
 */
export function processTick(state: BotState, price: number, now = Date.now()): TickResult {
  if (state.status !== 'running' || !state.config) {
    return {
      state: {
        ...state,
        currentPrice: price,
        lastTickAt: now,
      },
      newFills: [],
    };
  }

  const levels = state.levels;
  let orders = [...state.orders];
  const fills = [...state.fills];
  const newFills: Fill[] = [];
  let portfolio = { ...state.portfolio };
  // Track average cost of base for realized PnL on sells
  let costBasis = portfolio.baseBalance > 0
    ? (portfolio.initialCapital - portfolio.quoteBalance + portfolio.realizedPnl) /
      Math.max(portfolio.baseBalance, 1e-18)
    : 0;

  // Process in price-priority order for determinism
  const openBuys = orders
    .filter((o) => o.status === 'open' && o.side === 'buy' && price <= o.price)
    .sort((a, b) => b.price - a.price); // highest buy first
  const openSells = orders
    .filter((o) => o.status === 'open' && o.side === 'sell' && price >= o.price)
    .sort((a, b) => a.price - b.price); // lowest sell first

  const toFill = [...openBuys, ...openSells];

  for (const order of toFill) {
    const idx = orders.findIndex((o) => o.id === order.id);
    if (idx < 0 || orders[idx].status !== 'open') continue;

    const fillPrice = order.price; // limit fill at order price
    const filledOrder: GridOrder = {
      ...orders[idx],
      status: 'filled',
      filledAt: now,
      fillPrice,
    };
    orders[idx] = filledOrder;

    let realized = 0;
    if (order.side === 'buy') {
      const cost = fillPrice * order.amount;
      if (portfolio.quoteBalance + 1e-12 < cost) {
        // Insufficient quote — skip (shouldn't happen with proper bootstrap)
        orders[idx] = { ...orders[idx], status: 'open', filledAt: undefined, fillPrice: undefined };
        continue;
      }
      const prevBase = portfolio.baseBalance;
      const prevCostTotal = costBasis * prevBase;
      portfolio = {
        ...portfolio,
        quoteBalance: portfolio.quoteBalance - cost,
        baseBalance: portfolio.baseBalance + order.amount,
      };
      costBasis =
        portfolio.baseBalance > 0
          ? (prevCostTotal + cost) / portfolio.baseBalance
          : 0;
    } else {
      if (portfolio.baseBalance + 1e-12 < order.amount) {
        orders[idx] = { ...orders[idx], status: 'open', filledAt: undefined, fillPrice: undefined };
        continue;
      }
      const proceeds = fillPrice * order.amount;
      const cost = costBasis * order.amount;
      realized = proceeds - cost;
      portfolio = {
        ...portfolio,
        quoteBalance: portfolio.quoteBalance + proceeds,
        baseBalance: portfolio.baseBalance - order.amount,
        realizedPnl: portfolio.realizedPnl + realized,
      };
    }

    const fill: Fill = {
      id: nextFillId(),
      orderId: order.id,
      levelIndex: order.levelIndex,
      side: order.side,
      price: fillPrice,
      amount: order.amount,
      quoteAmount: fillPrice * order.amount,
      timestamp: now,
      realizedPnl: realized,
    };
    fills.push(fill);
    newFills.push(fill);

    const opposite = createOppositeOrder(filledOrder, levels, order.amount);
    if (opposite) {
      // Avoid duplicate open order at same level+side
      const dup = orders.some(
        (o) =>
          o.status === 'open' &&
          o.side === opposite.side &&
          o.levelIndex === opposite.levelIndex,
      );
      if (!dup) orders.push(opposite);
    }
  }

  const equity = portfolio.quoteBalance + portfolio.baseBalance * price;
  portfolio = {
    ...portfolio,
    equity,
    unrealizedPnl: equity - portfolio.initialCapital - portfolio.realizedPnl,
  };
  // Simpler beginner view: unrealized = equity - initial - realized... actually
  // total PnL = equity - initial; unrealized = total - realized
  const totalPnl = equity - portfolio.initialCapital;
  portfolio.unrealizedPnl = totalPnl - portfolio.realizedPnl;

  return {
    state: {
      ...state,
      orders,
      fills,
      portfolio,
      currentPrice: price,
      lastTickAt: now,
    },
    newFills,
  };
}

/**
 * Start a paper (or stub live) bot from a validated config and current price.
 */
export function startBot(
  config: GridConfig,
  currentPrice: number,
  priceSource: BotState['priceSource'],
): BotState {
  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(validation.errors.join(' '));
  }
  if (!(currentPrice > 0)) {
    throw new Error('Current price must be positive to start the bot.');
  }

  const levels = calculateGridLevels(
    config.lowerPrice,
    config.upperPrice,
    config.gridCount,
  );
  const { orders, portfolio } = bootstrapOrders(config, levels, currentPrice);

  let message: string | null = null;
  if (orders.length === 0) {
    message =
      'No buy levels below the current price. Lower the range or wait for price to enter the grid.';
  } else if (currentPrice < config.lowerPrice) {
    message = 'Price is below your grid. Buys will fill if price rises into the range.';
  } else if (currentPrice > config.upperPrice) {
    message =
      'Price is above your grid. No buys placed — widen/raise the upper bound or wait for a dip.';
  }

  const equity = portfolio.quoteBalance + portfolio.baseBalance * currentPrice;

  return {
    config,
    status: 'running',
    levels,
    orders,
    fills: [],
    portfolio: {
      ...portfolio,
      equity,
      unrealizedPnl: 0,
      realizedPnl: 0,
    },
    currentPrice,
    priceSource,
    startedAt: Date.now(),
    lastTickAt: Date.now(),
    message,
  };
}

export function pauseBot(state: BotState): BotState {
  if (state.status !== 'running') return state;
  return { ...state, status: 'paused', message: 'Bot paused — open orders held, no new fills.' };
}

export function resumeBot(state: BotState): BotState {
  if (state.status !== 'paused') return state;
  return { ...state, status: 'running', message: 'Bot resumed.' };
}

export function stopBot(state: BotState): BotState {
  return {
    ...state,
    status: 'stopped',
    orders: state.orders.map((o) =>
      o.status === 'open' ? { ...o, status: 'cancelled' as const } : o,
    ),
    message: 'Bot stopped. Open orders cancelled (paper mode).',
  };
}

/** Human-readable summary of expected grid economics for the wizard. */
export function summarizeGrid(config: GridConfig, currentPrice?: number | null): string[] {
  const lines: string[] = [];
  const spacing = gridSpacing(config);
  lines.push(
    `Range: ${config.lowerPrice} → ${config.upperPrice} ${config.quoteToken} per ${config.baseToken}`,
  );
  lines.push(
    `${config.gridCount} grids → spacing ≈ ${spacing.toPrecision(6)} ${config.quoteToken}`,
  );
  const buySlots = Math.max(1, Math.floor(config.gridCount / 2));
  const quotePer = config.totalCapital / buySlots;
  lines.push(
    `Rough size per buy level ≈ ${quotePer.toFixed(4)} ${config.quoteToken} (depends on where price sits)`,
  );
  lines.push(
    `Target profit hint: ${(config.profitPerGrid * 100).toFixed(2)}% per completed cycle (educational)`,
  );
  if (currentPrice) {
    lines.push(`Current reference price: ${currentPrice}`);
  }
  return lines;
}
