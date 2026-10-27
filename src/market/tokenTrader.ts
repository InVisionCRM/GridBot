/**
 * Token trader decisions (pure). The server (server/bot/tokenTrader.ts) feeds it pools and fills;
 * paper and live share these rules.
 *
 * Discovery for the scan path keeps a pool only when it is old enough (default 24h, a setting) and pairs
 * the chain's native coin or a stablecoin. A sniper pool skips the age check on purpose and still has to
 * pass the safety gate.
 *
 * Exits, in order: sell simulation failed, tax appeared or rose, liquidity pulled, hard stop, trailing stop,
 * take-profit ladders, time stop, volume decay. A sell is split so each piece stays under the price-impact cap.
 */
import { HARD_CAPS } from '../live/limits';
import { MAX_TAX, TAX_TOLERANCE } from '../live/tax';
import { simBuy, simSell, type CostModel } from './costs';
import { capSwap, TOKEN_MAX_POOL_SHARE } from './poolSize';

export const DEFAULT_MIN_POOL_AGE_SEC = 24 * 3600;
export const DEFAULT_SNIPER_MIN_LIQ_USD = 5_000;

export const EXIT = {
  hardStop: 0.25,
  tp1: 0.5,
  tp1Frac: 1 / 3,
  tp2: 1,
  tp2Frac: 1 / 3,
  trailArm: 0.3,
  trailGap: 0.2,
  timeStopMs: 6 * 3600_000,
  timeStopMinGain: 0.1,
  volDecay: 0.25,
  liqPull: 0.4,
} as const;

export interface FreshPool {
  chainId: number;
  pool: string;
  dex: string;
  kind: 'v2' | 'v3' | 'v4';
  token: string;
  spend: string;
  tokenSymbol: string;
  spendSymbol: string;
  liquidityUsd: number;
  volumeUsd: number;
  /** ms; null when the source didn't say */
  createdAt: number | null;
  source: 'new' | 'trending' | 'snipe';
  /** Spend-side depth, human units */
  quoteReserve: number;
  /** Token-side depth, human units (sell impact) */
  tokenReserve: number;
  feeBps: number;
  /** Spend per token */
  price: number;
  usdPerSpend: number;
}

/** Scan discovery. Snipes are not passed here: min age does not apply to them. */
export function filterFresh(pools: FreshPool[], o: { now: number; minAgeMs: number; minLiquidityUsd?: number }): { keep: FreshPool[]; skipped: { pool: string; why: string }[] } {
  const keep: FreshPool[] = [], skipped: { pool: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const p of pools) {
    const id = `${p.chainId}:${p.pool.toLowerCase()}`;
    if (seen.has(id)) { skipped.push({ pool: p.pool, why: 'already seen' }); continue; }
    seen.add(id);
    if (p.kind === 'v4') { skipped.push({ pool: p.pool, why: "this app doesn't swap V4" }); continue; }
    if (!(p.price > 0) || !(p.quoteReserve > 0)) { skipped.push({ pool: p.pool, why: 'no price or depth' }); continue; }
    const minL = o.minLiquidityUsd ?? 0;
    if (p.liquidityUsd < minL) { skipped.push({ pool: p.pool, why: `liquidity $${Math.round(p.liquidityUsd).toLocaleString('en-US')} is below $${minL.toLocaleString('en-US')}` }); continue; }
    if (p.createdAt != null && o.minAgeMs > 0 && o.now - p.createdAt < o.minAgeMs) {
      const h = Math.max(0, Math.round((o.now - p.createdAt) / 3600_000));
      skipped.push({ pool: p.pool, why: `pool is ${h}h old (minimum ${Math.round(o.minAgeMs / 3600_000)}h for scan discovery)` });
      continue;
    }
    keep.push(p);
  }
  return { keep, skipped };
}

export interface GateInput {
  mode: 'paper' | 'live';
  risk: 'safe' | 'medium' | 'any';
  honeypot: boolean | null;
  sellSimOk: boolean | null;
  paused: boolean | null;
  decimals: number | null;
  buyTax: number | null;
  sellTax: number | null;
  maxTax?: number;
  liquidityUsd: number;
  minLiquidityUsd: number;
  /** Owner can mint, when the token exposes it. null = not detectable. */
  canMint: boolean | null;
  canPause: boolean | null;
  canBlacklist: boolean | null;
  proxy: boolean | null;
  /** LP can be pulled by the owner (not burned / not locked). null = not detectable. */
  lpUnlocked: boolean | null;
  /** Largest holder as a share of supply. null = unknown, and unknown is not a block. */
  holderConcentration: number | null;
  recentLiqPull: boolean;
  /** The existing safety classifier. Live still requires this. */
  liveAllowed: boolean;
  /**
   * Owner, EIP-1967 admin, and setter scan. Ignored unless this is true, so a gate call that
   * leaves it off matches the gate from before this check existed.
   */
  enforceOwnerPowers?: boolean;
  /** A read we needed failed. Safe and medium skip when the flag is on. */
  ownerPowersUnverified?: boolean;
  /** Skip text when a non-renounced owner holds a blocking power, or a live admin can upgrade. */
  ownerPowersWhy?: string | null;
}

export interface GateResult { ok: boolean; liveOk: boolean; reason: string | null }

/**
 * Extra gate in front of the existing classifier. It does not weaken it: live still needs liveAllowed,
 * and a honeypot, a failed sell, a pause, or a tax over the cap is blocked in both modes.
 */
export function gateToken(g: GateInput): GateResult {
  const maxTax = g.maxTax ?? MAX_TAX;
  const hard = (reason: string): GateResult => ({ ok: false, liveOk: false, reason });
  if (g.honeypot === true) return hard('honeypot: the sell simulation was blocked');
  if (g.sellSimOk === false) return hard('sell simulation failed');
  if (g.paused === true) return hard('token is paused');
  if (g.decimals == null || !(g.decimals >= 0 && g.decimals <= 36)) return hard('decimals unreadable');
  if (g.liquidityUsd < g.minLiquidityUsd) return hard(`liquidity $${Math.round(g.liquidityUsd).toLocaleString('en-US')} is under the $${g.minLiquidityUsd.toLocaleString('en-US')} minimum`);
  if (g.canMint === true) return hard('owner can mint');
  if (g.recentLiqPull) return hard('liquidity was pulled');
  const tax = Math.max(g.buyTax ?? 0, g.sellTax ?? 0);
  if (g.mode === 'live' && tax > maxTax) return hard(`tax ${(tax * 100).toFixed(1)}% is over the ${(maxTax * 100).toFixed(0)}% live cap`);
  if (g.mode === 'live' && !g.liveAllowed) return hard('safety check does not allow live trading');
  if (g.risk === 'safe' || g.risk === 'medium') {
    if (g.canPause === true) return hard('owner can pause');
    if (g.lpUnlocked === true) return hard('liquidity is unlocked');
    if (tax > maxTax) return hard(`tax ${(tax * 100).toFixed(1)}% is over the ${(maxTax * 100).toFixed(0)}% cap`);
  }
  if (g.risk === 'safe') {
    if (g.proxy === true) return hard('contract is upgradeable');
    if (g.canBlacklist === true) return hard('owner can blacklist');
    if (tax > TAX_TOLERANCE) return hard(`tax ${(tax * 100).toFixed(2)}% (safe allows none)`);
    if (g.holderConcentration != null && g.holderConcentration > 0.5) return hard(`one holder has ${(g.holderConcentration * 100).toFixed(0)}%`);
  }
  if ((g.risk === 'safe' || g.risk === 'medium') && g.enforceOwnerPowers) {
    if (g.ownerPowersUnverified) return hard(g.ownerPowersWhy || 'owner powers could not be verified');
    if (g.ownerPowersWhy) return hard(g.ownerPowersWhy);
  }
  // Honeypot and a failed sell already returned above, so live only still needs the classifier and the tax cap.
  return { ok: true, liveOk: g.liveAllowed && tax <= maxTax, reason: null };
}

export interface BuySize {
  spend: number;
  usd: number;
  tokens: number;
  impact: number;
  why: string;
}

/** Size a buy from the pool's depth, the impact cap, the pool-share cap, and the owner's per-trade and total limits. */
export function sizeBuy(p: {
  perTradeUsd: number; totalUsd: number; openUsd: number;
  quoteReserve: number; usdPerSpend: number; feeBps: number;
  buyTax?: number; price: number; maxImpact: number; maxPoolShare?: number;
}): BuySize | null {
  const impactCap = Math.min(p.maxImpact, HARD_CAPS.maxPriceImpact);
  if (!(p.perTradeUsd > 0) || !(p.usdPerSpend > 0) || !(p.price > 0)) return null;
  const roomUsd = Math.max(0, p.totalUsd - p.openUsd);
  const askUsd = Math.min(p.perTradeUsd, roomUsd);
  if (!(askUsd > 0)) return null;
  const askSpend = askUsd / p.usdPerSpend;
  const fit = capSwap({ quoteIn: askSpend, quoteReserve: p.quoteReserve, feeBps: p.feeBps, maxImpact: impactCap, maxPoolShare: p.maxPoolShare ?? TOKEN_MAX_POOL_SHARE });
  if (!(fit.amount > 0)) return null;
  const model: CostModel = {
    feeBps: p.feeBps, pool: { quoteReserve: p.quoteReserve, plsReserve: p.quoteReserve / p.price },
    gasPricePls: 0, approval: 'exact', slippageBps: 0, buyTaxPct: p.buyTax ?? 0,
  };
  const fill = simBuy(fit.amount, p.price, model);
  const usd = fit.amount * p.usdPerSpend;
  const why = fit.why
    ? `${fit.why}; ${usd.toFixed(2)} USD after fees and ${(((p.buyTax ?? 0) * 100).toFixed(1))}% buy tax`
    : `${usd.toFixed(2)} USD, price impact ${(fit.impact * 100).toFixed(2)}%`;
  return { spend: fit.amount, usd, tokens: fill.pls, impact: fit.impact, why };
}

export interface ExitPos {
  entryPrice: number;
  price: number;
  peak: number;
  openedAt: number;
  now: number;
  entryVolume: number;
  volume: number;
  entryLiq: number;
  liq: number;
  sellTax: number;
  entrySellTax: number;
  sellSimOk: boolean;
  tp1Done: boolean;
  tp2Done: boolean;
  remainingFrac: number;
}

export type ExitDecision = { action: 'hold' } | { action: 'sell'; frac: number; why: string };

/** What to do with an open position. `frac` is a share of the original size (the remainder on a full exit). */
export function decideExit(p: ExitPos): ExitDecision {
  const gain = p.entryPrice > 0 ? p.price / p.entryPrice - 1 : 0;
  const left = Math.max(0, Math.min(1, p.remainingFrac));
  if (!(left > 0)) return { action: 'hold' };
  const all = (why: string): ExitDecision => ({ action: 'sell', frac: left, why });
  if (!p.sellSimOk) return all('sell simulation failed');
  if (p.sellTax > p.entrySellTax + 0.005 || (p.entrySellTax <= TAX_TOLERANCE && p.sellTax > TAX_TOLERANCE)) return all(`sell tax rose to ${(p.sellTax * 100).toFixed(1)}%`);
  if (p.entryLiq > 0 && p.liq < p.entryLiq * (1 - EXIT.liqPull)) return all(`liquidity down ${((1 - p.liq / p.entryLiq) * 100).toFixed(0)}% from entry`);
  if (gain <= -EXIT.hardStop) return all(`hard stop ${(gain * 100).toFixed(1)}% from entry`);
  const armed = p.peak >= p.entryPrice * (1 + EXIT.trailArm);
  if (armed && p.price <= p.peak * (1 - EXIT.trailGap)) return all(`trailing stop ${((1 - p.price / p.peak) * 100).toFixed(0)}% off the peak`);
  if (!p.tp1Done && gain >= EXIT.tp1) return { action: 'sell', frac: Math.min(left, EXIT.tp1Frac), why: `take profit ${(gain * 100).toFixed(0)}% (sell a third)` };
  if (!p.tp2Done && gain >= EXIT.tp2) return { action: 'sell', frac: Math.min(left, EXIT.tp2Frac), why: `take profit ${(gain * 100).toFixed(0)}% (sell a third)` };
  if (p.now - p.openedAt >= EXIT.timeStopMs && gain < EXIT.timeStopMinGain) return all(`time stop after ${((p.now - p.openedAt) / 3600_000).toFixed(1)}h and only ${(gain * 100).toFixed(1)}% up`);
  if (p.entryVolume > 0 && p.volume < p.entryVolume * EXIT.volDecay && gain <= 0) return all(`volume fell to ${((p.volume / p.entryVolume) * 100).toFixed(0)}% of the entry window and price is not up`);
  return { action: 'hold' };
}

/** Split a token sell so each piece stays under the impact cap. Pieces are human token amounts. */
export function splitSell(tokens: number, tokenReserve: number, feeBps: number, maxImpact: number): number[] {
  if (!(tokens > 0)) return [];
  const cap = Math.min(maxImpact, HARD_CAPS.maxPriceImpact);
  const room = capSwap({ quoteIn: tokens, quoteReserve: tokenReserve, feeBps, maxImpact: cap, maxPoolShare: 1 }).amount;
  if (!(room > 0)) return [];
  if (tokens <= room * 1.001) return [tokens];
  const n = Math.ceil(tokens / room);
  const piece = tokens / n;
  return Array.from({ length: n }, () => piece);
}

export interface ReplayCandle { t: number; price: number; volume: number; liq: number }
export interface ReplayResult {
  pnlPct: number;
  exits: string[];
  held: boolean;
  buys: number;
  sells: number;
}

/**
 * One paper buy at the first candle, then the exit rules. Fills use the same simBuy / simSell as live paper,
 * with the pool's fee and a reserve implied by `liq` (quote depth ≈ liquidity / 2).
 */
export function replay(candles: ReplayCandle[], o: { feeBps?: number; maxImpact?: number; spend?: number } = {}): ReplayResult {
  if (candles.length < 2) return { pnlPct: 0, exits: [], held: false, buys: 0, sells: 0 };
  const feeBps = o.feeBps ?? 30;
  const maxImpact = o.maxImpact ?? 0.03;
  const c0 = candles[0];
  const quoteReserve = Math.max(1, c0.liq / 2);
  const spend = Math.min(o.spend ?? quoteReserve * 0.01, quoteReserve * TOKEN_MAX_POOL_SHARE);
  const model = (price: number, liq: number): CostModel => ({
    feeBps, pool: { quoteReserve: Math.max(1, liq / 2), plsReserve: Math.max(1, liq / 2) / price }, gasPricePls: 0, approval: 'exact', slippageBps: 10,
  });
  const buy = simBuy(spend, c0.price, model(c0.price, c0.liq));
  let tokens = buy.pls;
  const entryTokens = tokens;
  let quote = 0;
  let tp1Done = false, tp2Done = false;
  let peak = c0.price;
  const exits: string[] = [];
  let sells = 0;
  for (const c of candles.slice(1)) {
    if (c.price > peak) peak = c.price;
    const remainingFrac = entryTokens > 0 ? tokens / entryTokens : 0;
    const d = decideExit({
      entryPrice: c0.price, price: c.price, peak, openedAt: c0.t, now: c.t,
      entryVolume: c0.volume, volume: c.volume, entryLiq: c0.liq, liq: c.liq,
      sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done, tp2Done, remainingFrac,
    });
    if (d.action !== 'sell' || !(tokens > 0)) continue;
    const qty = Math.min(tokens, entryTokens * d.frac);
    const m = model(c.price, c.liq);
    for (const part of splitSell(qty, m.pool!.plsReserve, feeBps, maxImpact)) {
      const s = simSell(part, c.price, m);
      quote += s.quote;
      tokens -= part;
      sells++;
    }
    exits.push(d.why);
    if (d.why.includes('take profit') && !tp1Done) tp1Done = true;
    else if (d.why.includes('take profit')) tp2Done = true;
    if (tokens <= entryTokens * 1e-9) break;
  }
  const mark = tokens > 0 ? simSell(tokens, candles[candles.length - 1].price, model(candles[candles.length - 1].price, candles[candles.length - 1].liq)).quote : 0;
  const pnlPct = spend > 0 ? (quote + mark - spend) / spend : 0;
  return { pnlPct, exits, held: tokens > entryTokens * 1e-6, buys: 1, sells };
}

/** DexScreener pair row → a fresh pool, or null when it isn't a token/native or token/stable pair. */
export function fromDexPair(row: {
  chainId: string; dexId: string; pairAddress: string;
  baseToken: { address: string; symbol: string }; quoteToken: { address: string; symbol: string };
  priceNative?: string; priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number };
  pairCreatedAt?: number;
}, chain: { id: number; dexId: string; spend: Set<string>; wrapped: string }): FreshPool | null {
  if (row.chainId !== chain.dexId) return null;
  const b = row.baseToken.address.toLowerCase(), q = row.quoteToken.address.toLowerCase();
  const bs = chain.spend.has(b), qs = chain.spend.has(q);
  if (bs === qs) return null;
  const token = bs ? q : b, spend = bs ? b : q;
  const priceUsd = Number(row.priceUsd);
  const nativePx = Number(row.priceNative);
  // priceNative is the token's price in the chain's native coin. Orient as spend per token.
  const usdPerSpend = qs && nativePx > 0 && priceUsd > 0 ? priceUsd / nativePx : priceUsd > 0 && !qs ? priceUsd : 1;
  const spendPerToken = qs ? nativePx : nativePx > 0 ? 1 / nativePx : 0;
  const liq = row.liquidity?.usd ?? 0;
  return {
    chainId: chain.id, pool: row.pairAddress.toLowerCase(), dex: row.dexId, kind: 'v2',
    token, spend, tokenSymbol: (bs ? row.quoteToken : row.baseToken).symbol, spendSymbol: (bs ? row.baseToken : row.quoteToken).symbol,
    liquidityUsd: liq, volumeUsd: row.volume?.h24 ?? 0,
    createdAt: row.pairCreatedAt != null ? row.pairCreatedAt : null,
    source: 'new', quoteReserve: usdPerSpend > 0 ? (liq / 2) / usdPerSpend : 0,
    tokenReserve: spendPerToken > 0 && usdPerSpend > 0 ? (liq / 2) / usdPerSpend / spendPerToken : 0,
    feeBps: 30, price: spendPerToken, usdPerSpend: usdPerSpend || 1,
  };
}

/** A GeckoTerminal pool row with USD prices on both sides → a token/spend pool, or null. */
export function fromTopPool(p: { address: string; name: string; dex: string; base: string; quote: string; liquidityUsd: number; volume24Usd: number; createdAt: number | null; basePriceUsd: number | null; quotePriceUsd: number | null }, chain: { id: number; spend: string[]; kind?: 'v2' | 'v3'; feeBps?: number }, source: FreshPool['source'] = 'new'): FreshPool | null {
  const spendable = new Set(chain.spend.map((a) => a.toLowerCase()));
  const b = p.base.toLowerCase(), q = p.quote.toLowerCase();
  const bs = spendable.has(b), qs = spendable.has(q);
  if (bs === qs) return null;
  const tokenUsd = bs ? p.quotePriceUsd : p.basePriceUsd;
  const spendUsd = bs ? p.basePriceUsd : p.quotePriceUsd;
  if (!(tokenUsd && spendUsd && spendUsd > 0)) return null;
  const price = tokenUsd / spendUsd;
  if (!(price > 0)) return null;
  const [left, right] = p.name.split('/').map((s) => s.trim());
  const tokenSymbol = (bs ? right : left) || 'TOKEN';
  const spendSymbol = (bs ? left : right) || 'QUOTE';
  const quoteReserve = (p.liquidityUsd / 2) / spendUsd;
  return {
    chainId: chain.id, pool: p.address.toLowerCase(), dex: p.dex, kind: chain.kind ?? 'v3',
    token: bs ? q : b, spend: bs ? b : q, tokenSymbol, spendSymbol,
    liquidityUsd: p.liquidityUsd, volumeUsd: p.volume24Usd, createdAt: p.createdAt, source,
    quoteReserve, tokenReserve: quoteReserve / price, feeBps: chain.feeBps ?? 30, price, usdPerSpend: spendUsd,
  };
}
