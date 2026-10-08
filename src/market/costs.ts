/**
 * Swap cost model on a PulseX V2 constant-product pool, used by the trend cost gate and the backtester.
 * Prices are the grid's sell-side units (quote per PLS after one LP fee): pool mid = price / (1 − f).
 * Depth k = quoteReserve × plsReserve is taken from CURRENT reserves and re-centred at each price
 * (an approximation for historical backtests: real depth then may have differed).
 */
import { GAS_UNITS_RT } from '../live/economics';

export interface CostModel {
  feeBps: number;
  /** Current pool reserves (human units); null = ignore impact */
  pool: { quoteReserve: number; plsReserve: number } | null;
  /** PLS per gas unit */
  gasPricePls: number;
  approval: 'exact' | 'max';
  /** Extra adverse fill assumed on every swap (bps) — models slippage vs quote */
  slippageBps: number;
  /** Chain gas units (default PulseChain) */
  gasUnits?: { approve: number; swap: number };
  /** Extra base units per swap (L2 L1-data fee) */
  extraPlsPerSwap?: number;
  /** Fraction taken on a BUY (base buy-tax × quote sell-tax). Default 0. */
  buyTaxPct?: number;
  /** Fraction taken on a SELL (base sell-tax × quote buy-tax). Default 0. */
  sellTaxPct?: number;
}

const gu = (m: CostModel) => m.gasUnits ?? GAS_UNITS_RT;

export const DEFAULT_COSTS: CostModel = { feeBps: 29, pool: null, gasPricePls: 0, approval: 'exact', slippageBps: 10 };

function reservesAt(price: number, m: CostModel) {
  const f = m.feeBps / 10_000;
  const mid = price / (1 - f);
  if (!m.pool) return { mid, rq: Infinity, rp: Infinity };
  const k = m.pool.quoteReserve * m.pool.plsReserve;
  return { mid, rq: Math.sqrt(k * mid), rp: Math.sqrt(k / mid) };
}
const out = (a: number, rIn: number, rOut: number, f: number) => {
  const inF = a * (1 - f);
  return Number.isFinite(rIn) ? (inF * rOut) / (rIn + inF) : null;
};

/** Spend quoteIn at a market whose sell-side price is `price`. Tax reduces what the wallet keeps of the pool output. */
export function simBuy(quoteIn: number, price: number, m: CostModel) {
  const f = m.feeBps / 10_000, slip = m.slippageBps / 10_000, tax = Math.max(0, Math.min(m.buyTaxPct ?? 0, 0.99));
  const { mid, rq, rp } = reservesAt(price, m);
  const ideal = (quoteIn * (1 - f)) / mid;
  const raw = out(quoteIn, rq, rp, f) ?? ideal;
  const pls = raw * (1 - slip) * (1 - tax);
  const gasPls = ((m.approval === 'exact' ? gu(m).approve : 0) + gu(m).swap) * m.gasPricePls + (m.extraPlsPerSwap ?? 0);
  return { pls, fee: quoteIn * f, tax: raw * tax, impactPct: 1 - raw / ideal, slipQuote: raw * slip * mid, gasQuote: gasPls * price, execPrice: quoteIn / pls };
}

/** Sell pls at a market whose sell-side price is `price`. Tax reduces what the pool receives of the input. */
export function simSell(pls: number, price: number, m: CostModel) {
  const f = m.feeBps / 10_000, slip = m.slippageBps / 10_000, tax = Math.max(0, Math.min(m.sellTaxPct ?? 0, 0.99));
  const { mid, rq, rp } = reservesAt(price, m);
  const poolIn = pls * (1 - tax);
  const ideal = poolIn * (1 - f) * mid;
  const raw = out(poolIn, rp, rq, f) ?? ideal;
  const quote = raw * (1 - slip);
  return { quote, fee: poolIn * f * mid, tax: pls * tax * mid, impactPct: 1 - raw / ideal, slipQuote: raw * slip, gasQuote: (gu(m).swap * m.gasPricePls + (m.extraPlsPerSwap ?? 0)) * price, execPrice: quote / pls };
}

/** Full round-trip cost at `price` for a position of sizeQuote, as fractions of size. */
export function roundTripCost(sizeQuote: number, price: number, m: CostModel) {
  const b = simBuy(sizeQuote, price, m);
  const s = simSell(b.pls, price, m);
  const f = m.feeBps / 10_000;
  const tb = Math.max(0, Math.min(m.buyTaxPct ?? 0, 0.99)), ts = Math.max(0, Math.min(m.sellTaxPct ?? 0, 0.99));
  const feePct = 1 - (1 - f) ** 2;
  const taxPct = 1 - (1 - tb) * (1 - ts);
  const impactPct = b.impactPct + s.impactPct;
  const slipPct = 2 * (m.slippageBps / 10_000);
  const gasPct = (b.gasQuote + s.gasQuote) / sizeQuote;
  return { feePct, taxPct, impactPct, slipPct, gasPct, totalPct: 1 - (s.quote - b.gasQuote - s.gasQuote) / sizeQuote };
}

/** Block entries whose expected move doesn't clear round-trip costs + margin. */
export function costGate(expectedPct: number, sizeQuote: number, price: number, m: CostModel, minEdgePct: number) {
  if (!(sizeQuote > 0)) return { ok: false, costPct: Infinity, expectedPct, reason: 'size is 0', feePct: 0, taxPct: 0, impactPct: 0, slipPct: 0, gasPct: 0, totalPct: Infinity };
  const c = roundTripCost(sizeQuote, price, m);
  const need = c.totalPct + minEdgePct;
  const ok = expectedPct >= need;
  return {
    ok, costPct: c.totalPct, expectedPct, ...c,
    reason: ok ? '' : `expected move ${(expectedPct * 100).toFixed(2)}% < costs ${(c.totalPct * 100).toFixed(2)}% (fee ${(c.feePct * 100).toFixed(3)}%${c.taxPct ? ` + tax ${(c.taxPct * 100).toFixed(2)}%` : ''} + impact ${(c.impactPct * 100).toFixed(3)}% + gas ${(c.gasPct * 100).toFixed(3)}% + slip ${(c.slipPct * 100).toFixed(2)}%) + margin ${(minEdgePct * 100).toFixed(2)}%`,
  };
}
