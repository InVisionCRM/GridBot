/**
 * Range-move loss of a closed LP whose moves were never counted (the v5 upgrade zeroed the tally). Pure, shared by the
 * engine's load-time rebuild (lpEngine backfillMoveLoss) and botMetrics, so a payload from a server that never ran the
 * rebuild (saved before it, or an older build) still shows the same Generated.
 *
 * It put in config.capital (quote) + config.baseAmount (base) and holds `idle` at the end: the principal plus every fee
 * collected (fees are reinvested, so they all come back at the close). At the exit price, the shortfall of principal
 * against the coins put in is what the moves locked in. Counted in the quote coin at the exit price.
 * Null when it can't be exact or isn't needed: still open, fees sent out, coins set aside, no exit price, a loss or
 * swap cost already counted, a rebuild already applied, no range move.
 */
type Coins = { base: number; quote: number };
export interface MoveLossInput {
  status?: string | null; position?: unknown; step?: unknown; reranges?: number | null;
  config?: { capital: number; baseAmount?: number } | null; idle?: Coins | null; aside?: Coins | null;
  totals?: { moveLoss?: number; swapCost?: number; sent?: number; feeCoins?: Coins; moveLossBackfill?: unknown } | null;
}

export function zeroedMoveLoss(s: MoveLossInput, exitPrice: number | null | undefined): number | null {
  const t = s.totals, c = s.config, idle = s.idle, price = exitPrice;
  if (!t || t.moveLossBackfill || (t.moveLoss ?? 0) !== 0 || (t.swapCost ?? 0) !== 0 || !((s.reranges ?? 0) > 0)) return null;
  if (s.status !== 'closed' || s.position || s.step || !c || !idle || !t.feeCoins || !(price != null && price > 0)) return null;
  if ((t.sent ?? 0) > 0 || (s.aside && (s.aside.base > 0 || s.aside.quote > 0))) return null;
  const principal = { base: idle.base - t.feeCoins.base, quote: idle.quote - t.feeCoins.quote };
  const loss = ((c.baseAmount ?? 0) - principal.base) * price + (c.capital - principal.quote);
  return Number.isFinite(loss) && loss > 0 ? loss : null;
}
