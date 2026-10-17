/**
 * Daily pair scan (pure). Two steps:
 *  1. pickTokens: GeckoTerminal "top pools by 24h volume" rows → tokens worth testing. Volume alone is misleading
 *     (verified 2026-10-17: $53M "volume" on $45 of liquidity, stablecoin/stablecoin pools that never move), so a
 *     pool must pair the token with something the bot can spend (the chain's native coin or a stablecoin), hold real
 *     liquidity, show real trades, and have volume in proportion to its liquidity.
 *  2. bestSetup: replay the last days of hourly candles through the grid backtester (fees, impact, gas) for a set
 *     of ranges × level counts and keep the one that made the most.
 */
import { runGridBacktest } from './backtest';
import type { Candle } from './candles';
import type { CostModel } from './costs';

/** Every setup is tested with this much of the spend coin (in USD) so gas weighs the same on every chain. */
export const TEST_USD = 1000;
export const SCAN_EVERY_MS = 24 * 3600_000;
export const PICKS_PER_CHAIN = 3;
/** 7 days of hourly candles */
export const SCAN_CANDLES = 168;

export interface TopPool {
  address: string;
  name: string;
  dex: string;
  /** Token addresses (lowercase) */
  base: string;
  quote: string;
  liquidityUsd: number;
  volume24Usd: number;
  tx24: number;
  change24Pct: number | null;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** 'pulsechain_0xabc…' → '0xabc…' */
const idAddr = (id: unknown) => { const s = String(id ?? ''); return s.slice(s.lastIndexOf('_') + 1).toLowerCase(); };

/** GET /networks/{slug}/pools?sort=h24_volume_usd_desc → rows. */
export function parseTopPools(json: unknown): TopPool[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) throw new Error('GeckoTerminal: unexpected top-pools response');
  return data.map((p) => {
    const r = p as { attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string } }> };
    const a = r.attributes ?? {};
    const tx = (a.transactions as Record<string, { buys?: number; sells?: number }> | undefined)?.h24;
    const chg = (a.price_change_percentage as Record<string, unknown> | undefined)?.h24;
    return {
      address: String(a.address ?? '').toLowerCase(),
      name: String(a.name ?? ''),
      dex: String(r.relationships?.dex?.data?.id ?? ''),
      base: idAddr(r.relationships?.base_token?.data?.id),
      quote: idAddr(r.relationships?.quote_token?.data?.id),
      liquidityUsd: num(a.reserve_in_usd),
      volume24Usd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      tx24: num(tx?.buys) + num(tx?.sells),
      change24Pct: chg == null || chg === '' ? null : num(chg),
    };
  });
}

export const SCAN_RULES = {
  /** Pool liquidity in USD */
  minLiquidityUsd: 50_000,
  /** Buys + sells in 24 h */
  minTx24: 100,
  /** 24 h volume ÷ liquidity above this is wash trading */
  maxVolumeToLiquidity: 20,
  /** Tokens tested per chain (each costs one candle request) */
  maxTokens: 8,
};

export interface TokenCandidate { token: string; spend: string; pool: TopPool }
export interface Skipped { name: string; why: string }

/** Uniswap V4 pools name the native coin by the zero address (verified on Ethereum and Robinhood, 2026-10-17). */
export const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Tokens to test, best volume first, one pool per token. `spendable` = native wrapper + stablecoins; `wrapped` = the
 * native wrapper, which also stands for the native coin (zero address) since the app trades through the wrapper.
 */
export function pickTokens(pools: TopPool[], spendable: string[], wrapped: string, rules = SCAN_RULES): { picked: TokenCandidate[]; skipped: Skipped[] } {
  const sp = new Set(spendable.map((a) => a.toLowerCase()));
  const native = (a: string) => (a === NATIVE_ZERO ? wrapped.toLowerCase() : a);
  const picked: TokenCandidate[] = [], skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const p0 of [...pools].sort((a, b) => b.volume24Usd - a.volume24Usd)) {
    const p = { ...p0, base: native(p0.base), quote: native(p0.quote) };
    const b = sp.has(p.base), q = sp.has(p.quote);
    const why = b && q ? 'both sides are the native coin or stablecoins'
      : !b && !q ? 'neither side is the native coin or a stablecoin'
        : p.liquidityUsd < rules.minLiquidityUsd ? `liquidity $${Math.round(p.liquidityUsd).toLocaleString('en-US')} is below $${rules.minLiquidityUsd.toLocaleString('en-US')}`
          : p.tx24 < rules.minTx24 ? `only ${p.tx24} trades in 24h`
            : p.volume24Usd / p.liquidityUsd > rules.maxVolumeToLiquidity ? `volume is ${Math.round(p.volume24Usd / p.liquidityUsd)}× its liquidity (looks fake)`
              : null;
    if (why) { skipped.push({ name: p.name, why }); continue; }
    const token = b ? p.quote : p.base, spend = b ? p.base : p.quote;
    if (seen.has(token)) continue;
    seen.add(token);
    if (picked.length < rules.maxTokens) picked.push({ token, spend, pool: p });
  }
  return { picked, skipped };
}

/** Ranges (± around the start price) and level counts tried for every pair. */
export const SETUP_BANDS = [0.05, 0.08, 0.12, 0.18, 0.25];
export const SETUP_LEVELS = [6, 10, 14, 20, 30, 40];
/** Hourly candles needed before a pair is ranked (3 days) */
export const MIN_SCAN_CANDLES = 72;

export interface Setup {
  bandPct: number;
  gridCount: number;
  /** Net result over the test window (fees, impact, gas; open lots marked to the last close) */
  returnPct: number;
  roundTrips: number;
  maxDrawdownPct: number;
  /** Buy-and-hold over the same window */
  holdPct: number;
  days: number;
}

/**
 * Best range × level count over `k` (hourly candles, oldest first), each started at the first candle's open.
 * Null when nothing completed a round trip with a positive net result.
 */
export function bestSetup(k: Candle[], costs: CostModel, capital: number): Setup | null {
  if (k.length < MIN_SCAN_CANDLES) throw new Error(`only ${k.length} hourly candles (need ${MIN_SCAN_CANDLES})`);
  const p0 = k[0].o;
  let best: Setup | null = null;
  for (const bandPct of SETUP_BANDS) {
    for (const gridCount of SETUP_LEVELS) {
      const m = runGridBacktest(k, { lowerPrice: p0 * (1 - bandPct), upperPrice: p0 * (1 + bandPct), gridCount, capital }, '1h', costs).metrics;
      if (m.trades < 1 || !(m.totalReturn > 0)) continue;
      const s: Setup = { bandPct, gridCount, returnPct: m.totalReturn, roundTrips: m.trades, maxDrawdownPct: m.maxDrawdown, holdPct: m.bhReturn, days: m.days };
      if (!best || s.returnPct > best.returnPct || (s.returnPct === best.returnPct && s.roundTrips > best.roundTrips)) best = s;
    }
  }
  return best;
}
