/**
 * Named strategy presets: a range (±bandPct around live spot) and a level count per pair. Presets carry no
 * amount: the caller supplies how much of each pair's spend coin to use (`amounts`, keyed by market key in the
 * leg's orientation), so sizing is always in coin units, never dollars.
 *
 * Range checks (live mainnet reserves, Oct 2026): ±8%×12 → worst spacing 1.25%; ±12%×12 → 1.82%; ±10%×12 → 1.54%.
 * USDT is left out of the ladder: it was chosen when USDT traded on a ~$1.5k/side PulseX V2 pool, where impact at small
 * levels exceeded the edge. Built-in stables trade on PulseX V1 since 2026-10-18 (~$228k USDT/side), so it could return.
 *
 * "Stack …" presets are FLIPPED (HEX/PLS, PLSX/PLS, eHEX/PLS): they spend native PLS, levels are PLS per token,
 * buys spend PLS for the token on dips and sells give each level's own lot back for PLS on bounces. Their
 * preview/start uses the deepest pool (best quote across PulseX V1/V2 and 9mm V2/V3) unless the market has a
 * manual pool override.
 */
import { orientedKey } from './markets';
import { analyzeSpacing, type SpacingAnalysis } from './spacing';

export interface PresetLegDef {
  /** Quote symbol, or null = caller's selected pair */
  quote: string | null;
  /** Half-band as fraction: 0.08 → ±8% */
  bandPct: number;
  gridCount: number;
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
    blurb: '±8% · 12 · ≥1.25% step',
    legs: [{ quote: null, bandPct: 0.08, gridCount: 12 }],
  },
  {
    id: 'hex',
    name: 'HEX',
    blurb: 'PLS/HEX · ±12% · 12',
    legs: [{ quote: 'HEX', bandPct: 0.12, gridCount: 12 }],
  },
  {
    id: 'ehex',
    name: 'eHEX',
    blurb: 'PLS/eHEX · ±12% · 12',
    legs: [{ quote: 'eHEX', bandPct: 0.12, gridCount: 12 }],
  },
  {
    id: 'plsx',
    name: 'PLSX',
    blurb: 'PLS/PLSX · ±12% · 12',
    legs: [{ quote: 'PLSX', bandPct: 0.12, gridCount: 12 }],
  },
  {
    id: 'pulse-pack',
    name: 'HEX+eHEX+PLSX',
    blurb: 'All three · ±12% · 12',
    legs: [
      { quote: 'HEX', bandPct: 0.12, gridCount: 12 },
      { quote: 'eHEX', bandPct: 0.12, gridCount: 12 },
      { quote: 'PLSX', bandPct: 0.12, gridCount: 12 },
    ],
  },
  {
    id: 'stack-hex',
    name: 'Stack HEX with PLS',
    blurb: 'HEX/PLS · spends PLS · stacks HEX · ±12% · 12',
    legs: [{ quote: 'HEX', flip: true, bandPct: 0.12, gridCount: 12 }],
  },
  {
    id: 'stack-plsx',
    name: 'Stack PLSX with PLS',
    blurb: 'PLSX/PLS · spends PLS · stacks PLSX · ±12% · 12',
    legs: [{ quote: 'PLSX', flip: true, bandPct: 0.12, gridCount: 12 }],
  },
  {
    id: 'stack-ehex',
    name: 'Stack eHEX with PLS',
    blurb: 'eHEX/PLS · spends PLS · stacks eHEX · ±12% · 12',
    legs: [{ quote: 'eHEX', flip: true, bandPct: 0.12, gridCount: 12 }],
  },
  {
    id: 'stable-ladder',
    name: 'Stable ladder',
    blurb: 'DAI+USDC · ±10% · 12',
    legs: [
      { quote: 'DAI', bandPct: 0.10, gridCount: 12 },
      { quote: 'USDC', bandPct: 0.10, gridCount: 12 },
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
  /** Amount of the spend (quote) coin to use, or null when the caller hasn't chosen one yet */
  capital: number | null;
  spacing: SpacingAnalysis;
  bandPct: number;
}

/** Market key of a leg in its orientation. */
export const legKey = (leg: PresetLegDef, selected: string) => orientedKey(leg.quote ?? selected, !!leg.flip);

export function resolveLeg(def: PresetLegDef, spot: number, selectedQuote: string, capital: number | null): ResolvedLeg {
  const quote = legKey(def, selectedQuote);
  if (!(spot > 0)) throw new Error(`No spot for ${quote}`);
  const lowerPrice = Number((spot * (1 - def.bandPct)).toPrecision(12));
  const upperPrice = Number((spot * (1 + def.bandPct)).toPrecision(12));
  return {
    quote, ...(def.flip ? { flipped: true } : {}), spot, lowerPrice, upperPrice, gridCount: def.gridCount,
    capital: capital != null && capital > 0 ? capital : null,
    spacing: analyzeSpacing(lowerPrice, upperPrice, def.gridCount), bandPct: def.bandPct,
  };
}

/** `amounts`: spend-coin amount per leg market key; legs without one resolve with capital null. */
export function resolvePreset(preset: StrategyPreset, spots: Record<string, number>, selectedQuote: string, amounts: Record<string, number> = {}): ResolvedLeg[] {
  return preset.legs.map((leg) => {
    const quote = legKey(leg, selectedQuote);
    const spot = spots[quote];
    if (!(spot > 0)) throw new Error(`Missing live price for ${quote}`);
    return resolveLeg(leg, spot, selectedQuote, amounts[quote] ?? null);
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
  }));
}
