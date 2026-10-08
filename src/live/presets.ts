/**
 * Named strategy presets. Ranges are ±bandPct around live spot (quote per PLS).
 *
 * Capital is defined in USD and converted to quote-token units from live prices
 * (usdPerQuote = DAI-per-PLS ÷ quote-per-PLS). The old presets sized HEX/eHEX/PLSX capital in raw token units
 * (200 HEX ≈ $0.44 total) so gas ate 4–15% of every round-trip.
 *
 * Every preset must be net-positive per completed round-trip after 2×0.29% LP fee, price impact at the level
 * size from current reserves, and gas; there is no tight-spacing override. Live starts are re-checked against
 * current reserves (see economics.ts) and blocked if not net-positive.
 *
 * Sizing (live mainnet reserves, Oct 2026, $100/leg):
 *   ±8%×12  → worst spacing 1.25%, ~0.57% net/RT on DAI
 *   ±12%×12 → worst spacing 1.82%, ~1.2% net/RT on HEX/eHEX/PLSX
 *   ±10%×12 → worst spacing 1.54%, ~0.7–0.9% net/RT on DAI/USDC
 * USDT is excluded from the ladder: its WPLS pool is ~$1.5k/side, so impact at $8–20 levels exceeds the edge.
 *
 * "Stack …" presets are FLIPPED (HEX/PLS, PLSX/PLS, eHEX/PLS): capital is native PLS, levels are PLS per token, buys
 * spend PLS for the token on dips and sells give each level's own lot back for PLS on bounces — start with PLS only.
 * Their preview/start uses the deepest pool (best quote across PulseX V1/V2 and 9mm V2/V3) unless the market has a
 * manual pool override.
 */
import { MIN_SPACING_PCT } from './economics';
import { isFlipKey, orientedKey } from './markets';
import { analyzeSpacing, type SpacingAnalysis } from './spacing';

export interface PresetLegDef {
  /** Quote symbol, or null = caller's selected pair */
  quote: string | null;
  /** Half-band as fraction: 0.08 → ±8% */
  bandPct: number;
  gridCount: number;
  /** Capital in USD (converted to quote units at start) */
  capitalUsd: number;
  /** Flipped orientation: token/PLS (spend PLS, stack the token) */
  flip?: boolean;
}

export interface StrategyPreset {
  id: string;
  name: string;
  blurb: string;
  legs: PresetLegDef[];
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'tight-scalp',
    name: 'Tight scalp',
    blurb: '±8% · 12 · ≥1.25% step · $100',
    legs: [{ quote: null, bandPct: 0.08, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'hex',
    name: 'HEX',
    blurb: 'PLS/HEX · ±12% · 12 · $100',
    legs: [{ quote: 'HEX', bandPct: 0.12, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'ehex',
    name: 'eHEX',
    blurb: 'PLS/eHEX · ±12% · 12 · $100',
    legs: [{ quote: 'eHEX', bandPct: 0.12, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'plsx',
    name: 'PLSX',
    blurb: 'PLS/PLSX · ±12% · 12 · $100',
    legs: [{ quote: 'PLSX', bandPct: 0.12, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'pulse-pack',
    name: 'HEX+eHEX+PLSX',
    blurb: 'All three · ±12% · 12 · $100 each',
    legs: [
      { quote: 'HEX', bandPct: 0.12, gridCount: 12, capitalUsd: 100 },
      { quote: 'eHEX', bandPct: 0.12, gridCount: 12, capitalUsd: 100 },
      { quote: 'PLSX', bandPct: 0.12, gridCount: 12, capitalUsd: 100 },
    ],
  },
  {
    id: 'stack-hex',
    name: 'Stack HEX with PLS',
    blurb: 'HEX/PLS · spends PLS · stacks HEX · ±12% · 12 · $100',
    legs: [{ quote: 'HEX', flip: true, bandPct: 0.12, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'stack-plsx',
    name: 'Stack PLSX with PLS',
    blurb: 'PLSX/PLS · spends PLS · stacks PLSX · ±12% · 12 · $100',
    legs: [{ quote: 'PLSX', flip: true, bandPct: 0.12, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'stack-ehex',
    name: 'Stack eHEX with PLS',
    blurb: 'eHEX/PLS · spends PLS · stacks eHEX · ±12% · 12 · $100',
    legs: [{ quote: 'eHEX', flip: true, bandPct: 0.12, gridCount: 12, capitalUsd: 100 }],
  },
  {
    id: 'stable-ladder',
    name: 'Stable ladder',
    blurb: 'DAI+USDC · ±10% · 12 · $50 each',
    legs: [
      { quote: 'DAI', bandPct: 0.10, gridCount: 12, capitalUsd: 50 },
      { quote: 'USDC', bandPct: 0.10, gridCount: 12, capitalUsd: 50 },
    ],
  },
];

export function getPreset(id: string): StrategyPreset {
  const p = STRATEGY_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset ${id}`);
  return p;
}

export interface ResolvedLeg {
  /** Market key in the leg's orientation ('HEX' = PLS/HEX, 'HEX~' = HEX/PLS) */
  quote: string;
  flipped?: boolean;
  spot: number;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  /** Capital in quote-token units (what the engine trades) */
  totalCapitalUsd: number;
  capitalUsd: number;
  usdPerQuote: number;
  spacing: SpacingAnalysis;
  bandPct: number;
}

/** Market key of a leg in its orientation. */
export const legKey = (leg: PresetLegDef, selected: string) => orientedKey(leg.quote ?? selected, !!leg.flip);

/**
 * USD value of one quote token from live spots (DAI/PLS ÷ quote/PLS). A flipped legacy market's quote is PLS
 * itself, so its USD value is the DAI/PLS spot.
 */
export function usdPerQuote(spots: Record<string, number>, quote: string, usdRef = 'DAI'): number {
  if (isFlipKey(quote)) {
    const ref = spots[usdRef];
    if (!(ref > 0)) throw new Error(`Missing live price for ${usdRef}`);
    return ref;
  }
  const ref = spots[usdRef], q = spots[quote];
  if (!(ref > 0) || !(q > 0)) throw new Error(`Missing live price for ${!(ref > 0) ? usdRef : quote}`);
  return ref / q;
}

export function resolveLeg(
  def: PresetLegDef,
  spot: number,
  selectedQuote: string,
  usdPerQ: number,
  opts: { capitalUsd?: number } = {},
): ResolvedLeg {
  const quote = legKey(def, selectedQuote);
  if (!(spot > 0)) throw new Error(`No spot for ${quote}`);
  if (!(usdPerQ > 0)) throw new Error(`No USD price for ${quote}`);
  const lowerPrice = Number((spot * (1 - def.bandPct)).toPrecision(12));
  const upperPrice = Number((spot * (1 + def.bandPct)).toPrecision(12));
  const spacing = analyzeSpacing(lowerPrice, upperPrice, def.gridCount);
  if (spacing.worstSpacingFrac < MIN_SPACING_PCT) {
    throw new Error(`Preset spacing ${(spacing.worstSpacingFrac * 100).toFixed(3)}% < ${(MIN_SPACING_PCT * 100).toFixed(1)}% floor (round-trip fee ${(spacing.roundTripFee * 100).toFixed(3)}%)`);
  }
  const capitalUsd = opts.capitalUsd && opts.capitalUsd > 0 ? opts.capitalUsd : def.capitalUsd;
  return {
    quote, ...(def.flip ? { flipped: true } : {}), spot, lowerPrice, upperPrice, gridCount: def.gridCount,
    totalCapitalUsd: Number((capitalUsd / usdPerQ).toPrecision(10)),
    capitalUsd, usdPerQuote: usdPerQ, spacing, bandPct: def.bandPct,
  };
}

export function resolvePreset(
  preset: StrategyPreset,
  spots: Record<string, number>,
  selectedQuote: string,
  opts: { capitalUsd?: number } = {},
): ResolvedLeg[] {
  return preset.legs.map((leg) => {
    const quote = legKey(leg, selectedQuote);
    const spot = spots[quote];
    if (!(spot > 0)) throw new Error(`Missing live price for ${quote}`);
    return resolveLeg(leg, spot, selectedQuote, usdPerQuote(spots, quote), opts);
  });
}

export function listPresets() {
  return STRATEGY_PRESETS.map(({ id, name, blurb, legs }) => ({
    id,
    name,
    blurb,
    legCount: legs.length,
    quotes: legs.map((l) => l.quote),
    flipped: legs.some((l) => l.flip),
    keys: legs.map((l) => (l.quote ? legKey(l, l.quote) : null)),
    gridCount: legs[0]?.gridCount,
    bandPct: legs[0]?.bandPct,
    defaultCapitalUsd: legs.length === 1 ? legs[0].capitalUsd : undefined,
  }));
}
