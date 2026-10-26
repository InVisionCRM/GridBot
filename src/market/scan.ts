/**
 * Opportunity scan (pure). Two steps:
 *  1. pickTokens: GeckoTerminal "top pools by 24h volume" rows → tokens worth testing. Volume alone is misleading
 *     (verified 2026-10-17: $53M "volume" on $45 of liquidity, stablecoin/stablecoin pools that never move), so a
 *     pool must pair the token with something the bot can spend (the chain's native coin or a stablecoin), hold real
 *     liquidity, show real trades, and have volume in proportion to its liquidity.
 *  2. bestSetup: replay the last days of hourly candles through the grid backtester (fees, impact, gas) for a set
 *     of ranges × level counts and keep the one whose completed trades earned the most. The price move is left out:
 *     it isn't the grid's doing, and last week's total return didn't predict the next week at all (walk-forward in
 *     the README: rank correlation −0.08 over 90 pools).
 *  3. Ranking (gridRank, lpRank), from that walk-forward: grids by how much the price swings, liquidity by what the
 *     position earned after costs.
 */
import { runGridBacktest } from './backtest';
import type { Candle } from './candles';
import type { CostModel } from './costs';
import type { SafetyReport } from '../live/markets';

/**
 * Default test size: every setup is tested with this much of the spend coin (in USD) so gas weighs the same on every
 * chain. You can set your own (Scan now) so price impact and your share of a pool match the money you'll put in.
 */
export const TEST_USD = 1000;
export const MIN_TEST_USD = 10;
export const MAX_TEST_USD = 10_000_000;

/** A test size in USD, or an error saying what's allowed. */
export function checkTestUsd(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_TEST_USD || n > MAX_TEST_USD) {
    throw new Error(`Test size must be a dollar amount from $${MIN_TEST_USD} to $${MAX_TEST_USD.toLocaleString('en-US')}.`);
  }
  return n;
}
export const SCAN_EVERY_MS = 24 * 3600_000;
/** GeckoTerminal pages of top pools read per DEX (20 pools a page, busiest first) */
export const SCAN_PAGES = 5;
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
  minLiquidityUsd: 10_000,
  /** Buys + sells in 24 h */
  minTx24: 50,
  /** 24 h volume ÷ liquidity above this is wash trading */
  maxVolumeToLiquidity: 20,
  /** Tokens tested per chain (each costs one candle request) */
  maxTokens: 100,
};

export interface TokenCandidate { token: string; spend: string; pool: TopPool }
export interface Skipped { name: string; why: string }

/** Uniswap V4 pools name the native coin by the zero address (verified on Ethereum and Robinhood, 2026-10-17). */
export const NATIVE_ZERO = '0x0000000000000000000000000000000000000000';
/** Some Ethereum pools use the 0xEeee… placeholder for native ETH instead (verified 2026-10-17). */
export const NATIVE_EEEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * Tokens to test, best volume first, one pool per token. `spendable` = native wrapper + stablecoins; `wrapped` = the
 * native wrapper, which also stands for the native coin (zero / 0xEeee… address) since the app trades through it.
 */
export function pickTokens(pools: TopPool[], spendable: string[], wrapped: string, rules = SCAN_RULES): { picked: TokenCandidate[]; skipped: Skipped[] } {
  const sp = new Set(spendable.map((a) => a.toLowerCase()));
  const native = (a: string) => (a === NATIVE_ZERO || a === NATIVE_EEEE ? wrapped.toLowerCase() : a);
  const picked: TokenCandidate[] = [], skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const p0 of [...pools].sort((a, b) => b.volume24Usd - a.volume24Usd)) {
    const p = { ...p0, base: native(p0.base), quote: native(p0.quote) };
    const b = sp.has(p.base), q = sp.has(p.quote);
    const why = b && q ? 'both sides are the native coin or stablecoins'
      : !b && !q ? 'neither side is the native coin or a stablecoin'
        : p.liquidityUsd < rules.minLiquidityUsd ? `liquidity $${Math.round(p.liquidityUsd).toLocaleString('en-US')} is below $${rules.minLiquidityUsd.toLocaleString('en-US')}`
          : p.tx24 < rules.minTx24 ? `only ${p.tx24} trades in 24h`
            : p.volume24Usd / p.liquidityUsd > rules.maxVolumeToLiquidity ? `volume is ${Math.round(p.volume24Usd / p.liquidityUsd)}× its liquidity (likely wash trading)`
              : null;
    if (why) { skipped.push({ name: p.name, why }); continue; }
    const token = b ? p.quote : p.base, spend = b ? p.base : p.quote;
    if (seen.has(token)) continue;
    seen.add(token);
    if (picked.length < rules.maxTokens) picked.push({ token, spend, pool: p });
  }
  return { picked, skipped };
}

/** One pool, tested both ways over the same week at the same test size. */
export interface Opportunity {
  chainId: number;
  /** Market key when the pair is already in the app (may be a flipped key such as 'HEX~') */
  key: string | null;
  /** How to add it otherwise (POST /api/opportunities/use) */
  add: { address: string; quote: string; pool: string } | null;
  label: string;
  spend: string;
  stack: string;
  dex: string;
  kind: 'v2' | 'v3';
  feeBps: number;
  risk: SafetyReport['risk'] | null;
  /** Why the safety check gave that risk */
  riskWhy: string | null;
  /** false: it failed the safety check, so it can only be paper traded */
  liveAllowed: boolean;
  /** Spot when scanned */
  price: number;
  /** The pair's price change over the test week: shown, never ranked */
  movePct: number;
  /** How far the price swung back and forth: the hourly high-low ranges added up, per day (dailySwing) */
  swingPct: number;
  activity: { volume24Usd: number; liquidityUsd: number; tx24: number } | null;
  /** The test amount in the spend coin, and in USD */
  capital: number;
  usd: number;
  /** Best grid by what its completed trades earned (null: none earned, see gridWhy) */
  grid: { bandPct: number; gridCount: number; earnedPct: number; roundTrips: number; returnPct: number; maxDrawdownPct: number } | null;
  gridWhy: string | null;
  /** Best liquidity range by fees − costs (null: not tested, see lpWhy). Only where a liquidity bot can run: a V3 pool on a DEX with a verified position manager */
  lp: { bandPct: number; earnedPct: number; feesPct: number; inRangePct: number; poolSharePct: number; returnPct: number } | null;
  lpWhy: string | null;
}

/** The hourly high-low ranges (log) added up, per day: how far the price went back and forth, whichever way it ended. */
export function dailySwing(k: Candle[]): number {
  if (!k.length) throw new Error('no candles');
  return k.reduce((a, c) => a + Math.log(c.h / c.l), 0) / (k.length / 24);
}

/**
 * Grid ranking: pools where a grid earned from its trades last week, by how much the price swings. Walk-forward over
 * 90 pools × 4 weeks (Oct 2026, README): the swing predicted next week's grid earnings best (rank correlation 0.53;
 * last week's own grid earnings 0.36, last week's total return −0.08), and came out ahead on each half of the pools
 * separately (0.50 / 0.54 against 0.34 / 0.37).
 */
export const gridRank = (o: Pick<Opportunity, 'grid' | 'swingPct'>): number | null => (o.grid ? o.swingPct : null);
/** Liquidity ranking: what the position earned after costs last week (walk-forward: rank correlation 0.85 with the next week). */
export const lpRank = (o: Pick<Opportunity, 'lp'>): number | null => o.lp?.earnedPct ?? null;

/** Ranges (± around the start price) and level counts tried for every pair. */
export const SETUP_BANDS = [0.05, 0.08, 0.12, 0.18, 0.25];
export const SETUP_LEVELS = [6, 10, 14, 20, 30, 40];
/** Hourly candles needed before a pair is ranked (3 days) */
export const MIN_SCAN_CANDLES = 72;
/**
 * Different hours in which a setup must complete a buy-then-sell. One spike is not a pattern: on 2026-10-17 the real
 * scan ranked USDG/USDC first at +1.99% from a single stablecoin wick, and one wick through several levels completes
 * several round trips inside the same candle, so round trips alone don't count.
 */
export const MIN_SELL_HOURS = 3;

export interface Setup {
  bandPct: number;
  gridCount: number;
  /** Net result over the test window (fees, impact, gas; open lots marked to the last close) */
  returnPct: number;
  /** What the completed buy → sell trades made after every cost ÷ the amount (coins still held aren't in it) */
  earnedPct: number;
  roundTrips: number;
  maxDrawdownPct: number;
  days: number;
}

/**
 * Best range × level count over `k` (hourly candles, oldest first), each started at the first candle's open, by what
 * its completed trades earned. Null when no setup earned money with sells in at least MIN_SELL_HOURS different hours.
 */
export function bestSetup(k: Candle[], costs: CostModel, capital: number): Setup | null {
  if (k.length < MIN_SCAN_CANDLES) throw new Error(`only ${k.length} hourly candles (need ${MIN_SCAN_CANDLES})`);
  const p0 = k[0].o;
  let best: Setup | null = null;
  for (const bandPct of SETUP_BANDS) {
    for (const gridCount of SETUP_LEVELS) {
      const r = runGridBacktest(k, { lowerPrice: p0 * (1 - bandPct), upperPrice: p0 * (1 + bandPct), gridCount, capital }, '1h', costs);
      const m = r.metrics;
      if (new Set(r.trades.map((t) => t.exitT)).size < MIN_SELL_HOURS || !(m.earned > 0)) continue;
      const s: Setup = { bandPct, gridCount, returnPct: m.totalReturn, earnedPct: m.earned / capital, roundTrips: m.trades, maxDrawdownPct: m.maxDrawdown, days: m.days };
      if (!best || s.earnedPct > best.earnedPct || (s.earnedPct === best.earnedPct && s.roundTrips > best.roundTrips)) best = s;
    }
  }
  return best;
}
