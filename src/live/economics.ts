/**
 * Per-round-trip economics for a <base>/<quote> grid (PulseX/Uniswap V2 pools; V3 via active-range virtual reserves).
 *
 * Units: prices are QUOTE per PLS, the same units as Quoter.getPrice() and the grid levels
 * (stables, HEX, eHEX, PLSX alike). Amounts are human units of the quote token.
 *
 * Model for interval (b → s) with level size Q (quote):
 *   - Buy triggers when getPrice() (sell-side, fee-inclusive) ≤ b → pool mid m_b = b / (1 − f).
 *   - Sell triggers when getPrice() ≥ s → mid m_s = s / (1 − f).
 *   - Pool depth k = quoteReserve · plsReserve is held constant and re-centred at each mid.
 *   - Both swaps pay the LP fee f (29 bps) and price impact from k; gas is converted to quote at the level.
 */
import { calculateGridLevels } from '../engine/gridEngine';

export const FEE_BPS = 29;
/** Gross spacing floor (worst interval). */
export const MIN_SPACING_PCT = 0.01;
/** Required net edge per completed round-trip, as a fraction of level size, after fee + impact + gas. */
export const MIN_NET_PCT = 0.0025;
export const GAS_UNITS_RT = { approve: 60_000, swap: 220_000 };

export interface PoolDepth {
  /** Quote token reserve (human units) */
  quoteReserve: number;
  /** WPLS reserve (human units) */
  plsReserve: number;
}

export interface EconInput {
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  /** Total capital in quote units */
  capital: number;
  /** Current getPrice() (quote per PLS) */
  spot: number;
  pool: PoolDepth;
  /** Gas price in PLS per gas unit (wei/1e18) */
  gasPricePls: number;
  /** 'exact' approval pays an approve tx on every buy */
  approval: 'exact' | 'max';
  /** LP fee of the market's pool (bps; PulseX V2 29, Uniswap V3 tier/100 …) */
  feeBps?: number;
  /** Chain gas units (default PulseChain 60k approve / 220k swap) */
  gasUnits?: { approve: number; swap: number };
  /** Extra base units per swap (L2 L1-data fee) */
  extraPlsPerSwap?: number;
  /** Fraction of the output taken on a BUY (base buy-tax × quote sell-tax). Default 0. */
  buyTaxPct?: number;
  /** Fraction of the input taken on a SELL (base sell-tax × quote buy-tax). Default 0. */
  sellTaxPct?: number;
}

export interface IntervalEcon {
  index: number;
  buyPrice: number;
  sellPrice: number;
  spacingPct: number;
  plsBought: number;
  quoteOut: number;
  grossQuote: number;
  feeQuote: number;
  impactPct: number;
  gasQuote: number;
  netQuote: number;
  netPct: number;
  buyExecPrice: number;
  sellExecPrice: number;
  taxQuote: number;
}

export interface EconReport {
  ok: boolean;
  reasons: string[];
  levelSize: number;
  buyLevels: number;
  roundTripFeePct: number;
  gasPlsPerRoundTrip: number;
  /** Worst (least profitable) interval */
  worst: IntervalEcon | null;
  /** Best interval */
  best: IntervalEcon | null;
  /** Worst-interval figures, flattened for display */
  spacingPct: number;
  impactPct: number;
  gasQuote: number;
  feeQuote: number;
  taxQuote: number;
  buyTaxPct: number;
  sellTaxPct: number;
  netPerRoundTrip: number;
  netPct: number;
  intervals: IntervalEcon[];
}

function swapOut(amountIn: number, rIn: number, rOut: number, f: number) {
  const inF = amountIn * (1 - f);
  return (inF * rOut) / (rIn + inF);
}

export function analyzeEconomics(i: EconInput): EconReport {
  const f = (i.feeBps ?? FEE_BPS) / 10_000;
  const tb = Math.max(0, Math.min(i.buyTaxPct ?? 0, 0.99));
  const ts = Math.max(0, Math.min(i.sellTaxPct ?? 0, 0.99));
  const reasons: string[] = [];
  const levels = calculateGridLevels(i.lowerPrice, i.upperPrice, i.gridCount);
  const buyLevels = levels.slice(0, -1).filter((l) => l.price < i.spot).length;
  const levelSize = buyLevels > 0 ? i.capital / buyLevels : 0;
  const gu = i.gasUnits ?? GAS_UNITS_RT;
  const gasPlsPerRoundTrip =
    ((i.approval === 'exact' ? gu.approve : 0) + 2 * gu.swap) * i.gasPricePls + 2 * (i.extraPlsPerSwap ?? 0);
  const k = i.pool.quoteReserve * i.pool.plsReserve;
  // Round-trip frictions: LP fee twice + buy tax (on base received) + sell tax (on base sent into the pool).
  const rtFee = 1 - (1 - f) ** 2 * (1 - tb) * (1 - ts);

  const intervals: IntervalEcon[] = [];
  if (levelSize > 0 && k > 0) {
    for (let j = 0; j < levels.length - 1; j++) {
      const b = levels[j].price, s = levels[j + 1].price;
      const mb = b / (1 - f), ms = s / (1 - f);
      const rqB = Math.sqrt(k * mb), rpB = Math.sqrt(k / mb);
      const rqS = Math.sqrt(k * ms), rpS = Math.sqrt(k / ms);
      // Buy: pool gives plsRaw of base; wallet keeps plsRaw × (1 − buyTax). Sell: only pls × (1 − sellTax) reaches the pool.
      const plsRaw = swapOut(levelSize, rqB, rpB, f);
      const pls = plsRaw * (1 - tb);
      const out = swapOut(pls * (1 - ts), rpS, rqS, f);
      const idealPls = (levelSize * (1 - f)) / mb;
      const impactPct = (1 - plsRaw / idealPls) + (1 - out / (pls * (1 - ts) * (1 - f) * ms || 1));
      const gasQuote = gasPlsPerRoundTrip * ((b + s) / 2);
      const feeQuote = levelSize * f + pls * (1 - ts) * f * ms;
      // Tax cost ≈ what the round-trip would have returned without taxes minus what it returns with them.
      const outNoTax = swapOut(plsRaw, rpS, rqS, f);
      const taxQuote = outNoTax - out;
      const gross = out - levelSize;
      const net = gross - gasQuote;
      intervals.push({
        index: j, buyPrice: b, sellPrice: s, spacingPct: (s - b) / b,
        plsBought: pls, quoteOut: out, grossQuote: gross, feeQuote, impactPct, gasQuote,
        taxQuote, netQuote: net, netPct: net / levelSize,
        buyExecPrice: levelSize / pls, sellExecPrice: out / pls,
      });
    }
  }

  const worst = intervals.reduce<IntervalEcon | null>((w, x) => (!w || x.netPct < w.netPct ? x : w), null);
  const best = intervals.reduce<IntervalEcon | null>((w, x) => (!w || x.netPct > w.netPct ? x : w), null);
  const minSpacing = intervals.reduce((m, x) => Math.min(m, x.spacingPct), Infinity);

  if (buyLevels === 0) reasons.push('No grid levels below spot.');
  if (!(k > 0)) reasons.push('Pool has no liquidity.');
  if (worst) {
    // Spacing must clear the floor PLUS the round-trip tax (a 5%/5% token needs > 10% between levels to net anything).
    const rtTax = 1 - (1 - tb) * (1 - ts);
    if (minSpacing < MIN_SPACING_PCT + rtTax) {
      reasons.push(`Spacing ${(minSpacing * 100).toFixed(3)}% < ${(MIN_SPACING_PCT * 100).toFixed(1)}% floor${rtTax > 0 ? ` + ${(rtTax * 100).toFixed(2)}% round-trip tax (buy ${(tb * 100).toFixed(2)}% / sell ${(ts * 100).toFixed(2)}%)` : ''} (round-trip fee${rtTax > 0 ? ' + tax' : ''} ${(rtFee * 100).toFixed(3)}%).`);
    }
    if (worst.netQuote <= 0) {
      reasons.push(`Net per round-trip ≤ 0 (${worst.netQuote.toPrecision(4)}) after round-trip fee${rtTax > 0 ? ', token tax' : ''}, impact and gas.`);
    } else if (worst.netPct < MIN_NET_PCT) {
      reasons.push(`Net ${(worst.netPct * 100).toFixed(3)}% per round-trip < ${(MIN_NET_PCT * 100).toFixed(2)}% margin.`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    levelSize,
    buyLevels,
    roundTripFeePct: rtFee,
    gasPlsPerRoundTrip,
    worst,
    best,
    spacingPct: worst ? minSpacing : 0,
    impactPct: worst?.impactPct ?? 0,
    gasQuote: worst?.gasQuote ?? 0,
    feeQuote: worst?.feeQuote ?? 0,
    taxQuote: worst?.taxQuote ?? 0,
    buyTaxPct: tb, sellTaxPct: ts,
    netPerRoundTrip: worst?.netQuote ?? 0,
    netPct: worst?.netPct ?? 0,
    intervals,
  };
}
