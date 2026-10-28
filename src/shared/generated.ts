/**
 * Generated token units and the pace built from them.
 * Framework-free. The engine is not modified. v2 and the main desk both import this.
 *
 * An LP's pnl.net is one number in the quote coin. pnl.feeCoins is gross (collected + still owed),
 * per coin. The engine does not publish a net amount per coin, so the quote leg is gross quote
 * minus gas, swap cost, and range-move loss, which are themselves quote-coin amounts.
 */

export interface TokenAmount {
  symbol: string;
  amount: number;
}

export interface CoinPair {
  base: number | null;
  quote: number | null;
}

export interface GeneratedBot {
  kind: 'lp' | 'grid' | 'trend' | 'token' | 'trader' | 'sniper';
  base?: string;
  quote?: string;
  /** Grid and trend pnl.realized, already in the quote coin. */
  realized?: number | null;
  /** LP pnl.feeCoins. Gross fees, not net of costs. */
  feeCoins?: CoinPair | null;
  /** LP pnl.gas, quote coin. */
  gas?: number | null;
  /** LP pnl.swapCost, quote coin. */
  swapCost?: number | null;
  /** LP pnl.moveLoss, quote coin. */
  moveLoss?: number | null;
  /**
   * LP pnl.net, quote coin. Used only when feeCoins is missing, so a net still has a token amount.
   * Not a per-coin field.
   */
  netQuote?: number | null;
}

export interface LpParts {
  gross: TokenAmount[];
  feesPaid: TokenAmount[];
  moveLoss: TokenAmount[];
  generated: TokenAmount[];
}

export interface EstimateSet {
  /** Generated ÷ age in days. Same amounts as h24. Null until the bot has run one day. */
  perDay: TokenAmount[] | null;
  h24: TokenAmount[] | null;
  d7: TokenAmount[] | null;
  d365: TokenAmount[] | null;
}

/** Estimates stay hidden until the bot has run one day. */
export const ESTIMATE_MIN_AGE_SEC = 86_400;

function finite(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function row(symbol: string | undefined, amount: number | null): TokenAmount | null {
  if (!symbol || amount == null || amount === 0) return null;
  return { symbol, amount };
}

function keep(rows: (TokenAmount | null)[]): TokenAmount[] {
  return rows.filter((r): r is TokenAmount => r != null);
}

/** Quote-coin costs the engine already reports separately. They are not a second net field. */
export function lpQuoteCosts(bot: Pick<GeneratedBot, 'gas' | 'swapCost' | 'moveLoss'>): number {
  return (finite(bot.gas) ?? 0) + (finite(bot.swapCost) ?? 0) + (finite(bot.moveLoss) ?? 0);
}

/** Gross fees, fees paid, range-move loss, and the generated coins those three explain. */
export function lpParts(bot: GeneratedBot): LpParts {
  const base = bot.base || '';
  const quote = bot.quote || '';
  const fees = bot.feeCoins;
  const gross = fees ? keep([row(base, finite(fees.base)), row(quote, finite(fees.quote))]) : [];
  const paid = finite(bot.gas) != null || finite(bot.swapCost) != null
    ? (finite(bot.gas) ?? 0) + (finite(bot.swapCost) ?? 0)
    : null;
  const move = finite(bot.moveLoss);
  const feesPaid = keep([row(quote, paid)]);
  const moveLoss = keep([row(quote, move)]);
  let generated: TokenAmount[];
  if (fees) {
    const quoteNet = finite(fees.quote) == null ? null : (finite(fees.quote) as number) - lpQuoteCosts(bot);
    generated = keep([row(base, finite(fees.base)), row(quote, quoteNet)]);
  } else {
    generated = keep([row(quote, finite(bot.netQuote))]);
  }
  return { gross, feesPaid, moveLoss, generated };
}

/**
 * Token units generated, net of gas, swap fees, and range-move loss.
 * Grid and trend use pnl.realized (quote coin). A token trader has no token-unit generated field here, so it is empty.
 */
export function generatedTokens(bot: GeneratedBot): TokenAmount[] {
  if (bot.kind === 'lp') return lpParts(bot).generated;
  if (bot.kind === 'grid' || bot.kind === 'trend') return keep([row(bot.quote, finite(bot.realized))]);
  return [];
}

/** Scale for a window. Null until the bot has run one day. */
export function estimateFactor(ageSec: number | null, days: number): number | null {
  if (ageSec == null || !(ageSec >= ESTIMATE_MIN_AGE_SEC) || !(days > 0)) return null;
  return (days * ESTIMATE_MIN_AGE_SEC) / ageSec;
}

function scale(tokens: TokenAmount[], factor: number): TokenAmount[] {
  return tokens
    .filter((t) => t.amount !== 0)
    .map((t) => ({ symbol: t.symbol, amount: t.amount * factor }));
}

/**
 * Pace and the three estimate windows. Each token is scaled on its own: amount / ageDays × days.
 * perDay and h24 are the same figures. A screen shows only one of them.
 * Null until age is at least one day.
 */
export function estimates(generated: TokenAmount[], ageSec: number | null): EstimateSet {
  if (ageSec == null || !(ageSec >= ESTIMATE_MIN_AGE_SEC)) {
    return { perDay: null, h24: null, d7: null, d365: null };
  }
  const day = estimateFactor(ageSec, 1) as number;
  const perDay = scale(generated, day);
  return {
    perDay,
    h24: perDay.map((t) => ({ ...t })),
    d7: scale(generated, estimateFactor(ageSec, 7) as number),
    d365: scale(generated, estimateFactor(ageSec, 365) as number),
  };
}
