/**
 * Symbols read from a market key, for a status whose market isn't loaded (no MarketDef): a unit on screen is never
 * the key itself. Key shapes (src/live/markets.ts): 'chain:BASE/QUOTE', '#2' for a second pool of the same pair, '~'
 * for the flipped orientation (base and quote swapped), and the legacy PulseChain keys ('DAI', 'HEX~') = PLS/<key>.
 * The loaded market's own symbols always win over this. Pure, no imports: shared by the server, metrics and UI.
 */
const FLIP = '~';

export function keySymbols(key: string | null | undefined): { base: string; quote: string } | null {
  if (typeof key !== 'string' || !key) return null;
  const flipped = key.endsWith(FLIP);
  const k = (flipped ? key.slice(0, -FLIP.length) : key).replace(/#.*$/, '');
  if (!k) return null;
  let base: string, quote: string;
  if (!k.includes(':') && !k.includes('/')) { base = 'PLS'; quote = k; }
  else {
    const pair = k.slice(k.indexOf(':') + 1);
    const i = pair.indexOf('/');
    if (i <= 0 || i === pair.length - 1) return null;
    base = pair.slice(0, i); quote = pair.slice(i + 1);
  }
  return flipped ? { base: quote, quote: base } : { base, quote };
}

/** A unit for display: a symbol stays as it is; a market key becomes its quote (or base) symbol. */
export function unitOf(v: unknown, side: 'base' | 'quote' = 'quote'): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (!v.includes(':') && !v.includes('/') && !v.endsWith(FLIP) && !v.includes('#')) return v;
  return keySymbols(v)?.[side] ?? null;
}
