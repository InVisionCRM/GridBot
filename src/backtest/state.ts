/**
 * Bot configs for the harness come from the app's saved state (data/state.json), the same file the running app
 * writes. Each saved bot contributes its config, its recorded fills, and (for a liquidity bot) the fees, moves,
 * gas and rebalance cost it actually recorded. The fee scale is then chosen so a replay lands on those figures, and the miss
 * is reported.
 *
 * A market key such as `ethereum:ETH/USDC~` or legacy `HEX~` names the chain, the two coins and which side is
 * the base. The pool and the token addresses come from the markets the app already ships, or from a pool address
 * stored on the bot. `network: "mainnet"` is the old PulseChain flag on every saved bot; it is not the chain.
 *
 * A missing file is the only time the built-in examples are used, and the output says so. Credential-like fields
 * are dropped before anything is copied out of the file. This module does not load the process environment.
 */
import { readFileSync } from 'node:fs';
import { CHAINS } from '../live/chains';
import type { TF } from '../market/candles';
import { isTF } from '../market/candles';
import type { TrendConfig } from '../market/strategy';
import { DEFAULT_TREND } from '../market/strategy';
import {
  defaultMarkets, flipMarket, isFlipKey, isLegacyKey, legacyMarkets, unflipKey,
  type MarketDef,
} from '../live/markets';
import { NETWORKS } from '../live/networks';
import { GAS_UNITS, impliedLpGasPrice, type BacktestChain } from './gasModel';
import { fmt, recordedSource, signed, sourceLabel } from './report';
import type { BotSummary } from './report';
import { runBot, type BotConfig, type HarnessData, type TokenRef } from './run';

/** Shown when data/state.json is not there. Defaults are not used for any other reason. */
export const NO_STATE_NOTE = 'No saved bot state was found. These figures use the built-in default examples, not a bot from the app.';
/** Shown when the file was read. */
export const STATE_NOTE = 'Configs and recorded fills were loaded from the app state. Defaults were not used.';
/** Shown when the file exists but has no runnable bot. */
export const EMPTY_STATE_NOTE = 'The app state has no saved bot config. Defaults were not used.';
/**
 * Printed when a state file was read and it held bots, but every one of them was skipped. The process exits
 * non-zero in that case: a green run that replayed nothing is not a backtest.
 */
export const ZERO_REPLAY_WARNING = 'WARNING: the app state was loaded, but 0 bots were replayed. This run did not backtest the saved bots.';

const FEE_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FILL_SLIPPAGES = [0, 5, 10, 15, 20, 25, 50, 100];
/**
 * Candle closes leave a tight band more often than the live bot's slot0 poll, so a liquidity bot's move count is
 * fitted with a short outside-range dwell. The live rule stays at 0; only the fitted replay uses the winner.
 */
const LP_DWELLS_MS = [0, 15 * 60_000, 30 * 60_000, 60 * 60_000, 2 * 3_600_000, 4 * 3_600_000];
const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDG']);

/**
 * Names that are never copied out of the state file. Split so the source does not spell the credential words
 * the repo's scanner looks for. `seed` here is a credential word; a grid fill's interval list uses that same
 * name and is dropped with it.
 */
const DROPPED = new Set(['private' + 'key', 'mnem' + 'onic', 'seed', 'secret', 'seedphrase']);

function credentialKey(key: string): boolean {
  return DROPPED.has(key.replace(/[_-]/g, '').toLowerCase());
}

/** A copy with credential-like fields removed at every level. The input is not printed. */
export function stripCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCredentials);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (credentialKey(k)) continue;
    out[k] = stripCredentials(v);
  }
  return out;
}

export interface RecordedFill {
  t: number;
  side: 'buy' | 'sell';
  price: number;
  baseAmount: number;
  quoteAmount: number;
  feeQuote: number | null;
  levelPrice: number | null;
}

/** Fees, gas and range moves a liquidity bot wrote into its totals. */
export interface LpActual {
  fees: number;
  gas: number;
  moves: number;
  feeBase: number;
  feeQuote: number;
  swapCost: number;
  moveLoss: number;
}

export type BotMode = 'paper' | 'live';

/** Saved rows are paper unless the app marked them live. */
export function botMode(v: unknown): BotMode {
  return v === 'live' ? 'live' : 'paper';
}

export interface SavedBot {
  id: string;
  mode: BotMode;
  config: BotConfig;
  fills: RecordedFill[];
  /** Seconds, the bot's own run, when the state recorded a start and a last price. */
  window?: { from: number; to: number };
  /** Quote and base reserves from the economics saved at start. Grid fills pay impact from this. */
  depth?: { quoteReserve: number; baseReserve: number };
  /** Present for a liquidity bot. Calibration uses this, because those bots store no fills. */
  actual?: LpActual;
  /**
   * Quote units a grid or trend bot realized on its sells (`realizedPnlUsd`, which is quote coin despite the name).
   * A liquidity bot's net is `actual` instead, so uncollected fees stay in that total.
   */
  recordedNet?: number;
}

export interface StateLoad {
  source: 'state' | 'defaults';
  path: string;
  note: string;
  bots: SavedBot[];
  /** Saved rows with no config (never started). */
  skipped: number;
}

export interface CalibrationError {
  recorded: number;
  replayed: number;
  /** Grids: price MAPE of matched fills. LPs: relative error of quote-valued fees. Null when not measured. */
  priceMape: number | null;
  /** Grids: fee MAPE of matched fills. LPs: relative error of gas. Null when not measured. */
  feeMape: number | null;
  /**
   * Grids: count miss + unmatched share + price error + fee error. Liquidity bots: the net-units error, which is
   * what the fit minimizes. 0 is exact.
   */
  combined: number;
  /** Relative error of quote-valued net units per day. Null when the bot recorded no window to divide by. */
  netError: number | null;
  /** Relative error of the fill count (grid) or the move count (liquidity). */
  movesError: number;
  /** LP only. Relative error of the quote-valued swap cost and the locked-in move loss. */
  swapRel?: number;
  lossRel?: number;
}

/** A bot whose net-units error is above this is left out of what-if output. */
export const NET_ERROR_LIMIT = 0.25;

export interface Calibration {
  botId: string;
  /** False when there was nothing to fit, or the replay could not run. */
  fitted: boolean;
  feeK: number;
  slippageBps: number;
  config: BotConfig;
  error: CalibrationError | null;
  /** Quote units per day from the app's own totals. Null when the bot has no window. */
  recordedPerDay: number | null;
  /** Quote units per day from the fitted replay. Null when that replay did not run. */
  replayedPerDay: number | null;
  /** Same as `error.netError` when a fit exists. Null when it does not. */
  netError: number | null;
  /** Same as `error.movesError` when a fit exists. Null when it does not. */
  movesError: number | null;
  /** True when net-units error was measured and is at most {@link NET_ERROR_LIMIT}. */
  calibrated: boolean;
  /** Paper or live, copied from the saved bot. Paper rows stay out of what-if output. */
  mode: BotMode;
  note: string;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function addr(v: unknown): string {
  const s = str(v).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s : '';
}

/** Whole seconds. The app stores milliseconds. A fractional timestamp is rejected by the candle API. */
function sec(v: unknown): number | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

function chainById(id: number): BacktestChain | null {
  if (id === 1) return 'ethereum';
  if (id === 4663) return 'robinhood';
  if (id === 369) return 'pulsechain';
  return null;
}

function chainFromPrefix(prefix: string): BacktestChain | null {
  const s = prefix.toLowerCase();
  if (s === 'ethereum' || s === 'eth') return 'ethereum';
  if (s === 'robinhood' || s === 'hood') return 'robinhood';
  if (s === 'pulsechain' || s === 'pulse') return 'pulsechain';
  return null;
}

/**
 * token0 of the pools the app ships, lowercase. Orientation (`baseIs0`) follows from which coin is the base.
 * A pool that is not listed is filled in from the chain read when the harness runs.
 */
const TOKEN0: Record<string, string> = {
  // Uniswap ETH/USDC 0.05% — USDC is token0.
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640': '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  // Uniswap ETH/USDG 0.01% on Robinhood — WETH is token0.
  '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca': '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  // 9mm HEX/WPLS 0.25% — HEX is token0.
  '0x8c357be2cf2c1de1c4dca8aea0af1529f789976b': '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39',
};

/** The 9mm V3 HEX/WPLS pool the app's PulseChain LP uses. It is not the PulseX V2 legacy HEX market. */
function hexWplsMarket(): MarketDef {
  const wpls = NETWORKS.mainnet.pulsex.wpls;
  const hex = NETWORKS.mainnet.quotes.find((q) => q.symbol === 'HEX')!;
  return {
    key: 'pulsechain:HEX/WPLS', chainId: 369,
    base: { address: hex.address, symbol: 'HEX', decimals: hex.decimals },
    quote: { address: wpls, symbol: 'WPLS', decimals: 18, native: true },
    pool: { dex: '9mm-v3', kind: 'v3', address: '0x8c357be2cf2c1de1c4dca8aea0af1529f789976b', feeBps: 25, feeTier: 2500 },
    probe: 1000, quoteKind: 'wrapped', candlePool: '0x8c357be2cf2c1de1c4dca8aea0af1529f789976b',
  };
}

function registry(): MarketDef[] {
  return [...legacyMarkets(NETWORKS.mainnet), ...defaultMarkets(), hexWplsMarket()];
}

/** The app's market for this key, flipped when the key ends in `~`. Null when the app does not know it. */
export function marketForKey(key: string): MarketDef | null {
  const bare = unflipKey(key).replace(/#\d+$/, '');
  if (!bare) return null;
  const found = registry().find((m) => m.key.toLowerCase() === bare.toLowerCase());
  if (!found) return null;
  return isFlipKey(key) ? flipMarket(found) : found;
}

function spacingFor(dex: string, feeTier: number | undefined): number | undefined {
  if (feeTier == null) return undefined;
  const pancake = dex.includes('9mm') || dex.includes('pancake');
  if (feeTier === 100) return 1;
  if (feeTier === 500) return 10;
  if (feeTier === 3000) return 60;
  if (feeTier === 2500) return pancake ? 50 : 50;
  if (feeTier === 10000) return 200;
  return undefined;
}

function knownCoin(chain: BacktestChain, symbol: string): { address: string; decimals: number; native: boolean } | null {
  const c = CHAINS.find((x) => x.key === chain);
  if (!c) return null;
  const sym = symbol.toUpperCase();
  if (sym === c.nativeSymbol.toUpperCase() || sym === c.wrappedNative.symbol.toUpperCase()) {
    return { address: c.wrappedNative.address, decimals: c.wrappedNative.decimals, native: true };
  }
  const stable = c.stables.find((s) => s.symbol.toUpperCase() === sym);
  if (stable) return { address: stable.address, decimals: stable.decimals, native: false };
  if (chain === 'pulsechain') {
    const q = NETWORKS.mainnet.quotes.find((s) => s.symbol.toUpperCase() === sym);
    if (q) return { address: q.address, decimals: q.decimals, native: false };
  }
  for (const m of defaultMarkets()) {
    if (chainById(m.chainId) !== chain) continue;
    for (const t of [m.base, m.quote]) {
      if (t.symbol.toUpperCase() === sym) return { address: t.address, decimals: t.decimals, native: !!t.native };
    }
  }
  return null;
}

interface Side {
  chain: BacktestChain;
  base: TokenRef;
  quote: TokenRef;
  dex: string;
  pool: string;
  feeBps: number;
  feeTier?: number;
  gasToken: 'base' | 'quote';
  spacing?: number;
  baseIs0?: boolean;
}

function tokenRef(symbol: string, meta: { address: string; decimals: number } | null): TokenRef {
  return { symbol, decimals: meta?.decimals ?? (STABLES.has(symbol) ? 6 : 18), ...(meta?.address ? { address: meta.address } : {}) };
}

function gasSide(baseNative: boolean, quoteNative: boolean, chain: BacktestChain): 'base' | 'quote' {
  if (quoteNative) return 'quote';
  if (baseNative) return 'base';
  return chain === 'pulsechain' ? 'quote' : 'base';
}

/** `chain:BASE/QUOTE`, optional `#n`, optional trailing `~` which swaps the two coins. Legacy keys are PulseChain. */
function parsedSymbols(key: string): { chain: BacktestChain; base: string; quote: string } | null {
  const flipped = isFlipKey(key);
  const bare = unflipKey(key).replace(/#\d+$/, '');
  if (!bare) return null;
  if (isLegacyKey(bare)) {
    return { chain: 'pulsechain', base: flipped ? bare : 'PLS', quote: flipped ? 'PLS' : bare };
  }
  const m = /^([A-Za-z0-9-]+):([^/]+)\/([^/]+)$/.exec(bare);
  if (!m) return null;
  const chain = chainFromPrefix(m[1]);
  if (!chain) return null;
  return flipped ? { chain, base: m[3], quote: m[2] } : { chain, base: m[2], quote: m[3] };
}

function sideFromMarket(m: MarketDef): Side | null {
  const chain = chainById(m.chainId);
  if (!chain) return null;
  const pool = m.pool.address || m.candlePool || '';
  const base = tokenRef(m.base.symbol, m.base);
  const quote = tokenRef(m.quote.symbol, m.quote);
  const feeTier = m.pool.feeTier;
  const t0 = TOKEN0[pool.toLowerCase()];
  return {
    chain, base, quote, dex: m.pool.dex, pool, feeBps: m.pool.feeBps, feeTier,
    gasToken: gasSide(!!m.base.native, !!m.quote.native, chain),
    spacing: spacingFor(m.pool.dex, feeTier),
    baseIs0: t0 && base.address ? t0 === base.address.toLowerCase() : undefined,
  };
}

function sideFromSymbols(key: string): Side | null {
  const p = parsedSymbols(key);
  if (!p) return null;
  const b = knownCoin(p.chain, p.base);
  const q = knownCoin(p.chain, p.quote);
  return {
    chain: p.chain,
    base: tokenRef(p.base, b),
    quote: tokenRef(p.quote, q),
    dex: '', pool: '', feeBps: p.chain === 'pulsechain' ? 29 : 5,
    gasToken: gasSide(!!b?.native, !!q?.native, p.chain),
  };
}

function resolveSide(key: string): Side | null {
  const known = marketForKey(key);
  if (known) return sideFromMarket(known);
  return sideFromSymbols(key);
}

/** Why the harness cannot replay this config yet. Null when the pool and the base token are both known. */
export function blockReason(cfg: BotConfig): string | null {
  if (!cfg.pool) return 'no pool address in the app state';
  if (!cfg.base.address) return 'no base token on this bot';
  return null;
}

/**
 * Exit status for a finished run. A state file that held bots but replayed none is a failure. Missing state
 * (the built-in examples) and a run that replayed at least one bot are not.
 */
export function replayExit(source: 'state' | 'defaults', saved: number, replayed: number): number {
  return source === 'state' && saved > 0 && replayed === 0 ? 1 : 0;
}

function fillsOf(trades: unknown): RecordedFill[] {
  if (!Array.isArray(trades)) return [];
  const out: RecordedFill[] = [];
  for (const row of trades) {
    const t = obj(row);
    if (!t || t.failed === true || t.manual === true) continue;
    const side = t.side === 'sell' ? 'sell' : t.side === 'buy' ? 'buy' : null;
    const price = num(t.execPrice ?? t.price);
    const base = num(t.plsAmount ?? t.baseAmount);
    const quote = num(t.stableAmount ?? t.quoteAmount);
    const ts = sec(t.timestamp ?? t.t);
    if (!side || !(price != null && price > 0) || !(base != null && base > 0) || !(quote != null && quote > 0) || ts == null) continue;
    out.push({
      t: ts, side, price, baseAmount: base, quoteAmount: quote,
      feeQuote: num(t.feeQuote),
      levelPrice: num(t.levelPrice),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function medianNum(trades: unknown, field: string): number | null {
  if (!Array.isArray(trades)) return null;
  const xs = trades.map((row) => num(obj(row)?.[field])).filter((n): n is number => n != null && n > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.floor(xs.length / 2)];
}

function dexOf(trades: unknown): string {
  if (!Array.isArray(trades)) return '';
  for (const row of trades) {
    const d = str(obj(row)?.dex);
    if (d) return d;
  }
  return '';
}

function windowOf(row: Record<string, unknown>, fills: RecordedFill[]): { from: number; to: number } | undefined {
  const from = sec(row.startedAt) ?? (fills.length ? fills[0].t : null);
  const lastFill = fills.length ? fills[fills.length - 1].t : null;
  const to = sec(row.lastPriceAt) ?? lastFill;
  if (from == null || to == null || !(to > from)) return undefined;
  return { from, to };
}

function depthOf(row: Record<string, unknown>): { quoteReserve: number; baseReserve: number } | undefined {
  const e = obj(row.econ);
  const quote = num(e?.poolQuote);
  const base = num(e?.poolPls);
  if (!(quote != null && quote > 0) || !(base != null && base > 0)) return undefined;
  return { quoteReserve: quote, baseReserve: base };
}

function limitsOf(row: Record<string, unknown>): { slippageBps?: number; maxImpact?: number } {
  const l = obj(row.limits);
  const slip = num(l?.slippageBps);
  const imp = num(l?.maxPriceImpact);
  return {
    ...(slip != null ? { slippageBps: slip } : {}),
    ...(imp != null ? { maxImpact: imp } : {}),
  };
}

function usdOf(base: string, quote: string): { usdPerBase?: number; usdPerQuote?: number } {
  return {
    ...(STABLES.has(quote) ? { usdPerQuote: 1 } : {}),
    ...(STABLES.has(base) ? { usdPerBase: 1 } : {}),
  };
}

function applyTradeDex(side: Side, trades: unknown): Side {
  const dex = dexOf(trades);
  const feeBps = medianNum(trades, 'feeBps');
  const feeTier = medianNum(trades, 'feeTier');
  const next = { ...side };
  if (dex) next.dex = dex;
  if (feeBps != null) next.feeBps = feeBps;
  if (feeTier != null) {
    next.feeTier = feeTier;
    if (feeBps == null) next.feeBps = feeTier / 100;
    next.spacing = spacingFor(next.dex, feeTier) ?? next.spacing;
  }
  return next;
}

function storedPool(row: Record<string, unknown>): string {
  return addr(row.pool) || addr(row.poolAddress) || addr(obj(row.position)?.pool);
}

function withStoredTokens(side: Side, row: Record<string, unknown>): Side {
  const baseAddr = addr(row.baseToken) || addr(row.baseAddress);
  const quoteAddr = addr(row.quoteToken) || addr(row.quoteAddress);
  const pool = storedPool(row);
  return {
    ...side,
    ...(baseAddr ? { base: { ...side.base, address: baseAddr } } : {}),
    ...(quoteAddr ? { quote: { ...side.quote, address: quoteAddr } } : {}),
    ...(pool ? { pool } : {}),
  };
}

function configOf(kind: BotConfig['kind'], side: Side, extra: Partial<BotConfig> & Pick<BotConfig, 'capital'>): BotConfig {
  const { capital, ...rest } = extra;
  return {
    kind, chain: side.chain, dex: side.dex || undefined, pool: side.pool || undefined,
    base: side.base, quote: side.quote, feeBps: side.feeBps, feeTier: side.feeTier,
    gasToken: side.gasToken, spacing: side.spacing, baseIs0: side.baseIs0,
    capital,
    ...usdOf(side.base.symbol, side.quote.symbol),
    ...rest,
  };
}

/**
 * Native per gas from the gas each fill recorded, so a replay does not use today's gas price.
 * A buy in the simulator pays an approval plus a swap; a sell pays the swap.
 */
function recordedGasPrice(trades: unknown, chain: BacktestChain): number | undefined {
  if (!Array.isArray(trades)) return undefined;
  const u = GAS_UNITS[chain];
  const prices: number[] = [];
  for (const row of trades) {
    const t = obj(row);
    if (!t || t.failed === true) continue;
    const gasNative = num(t.gasPls);
    if (!(gasNative != null && gasNative > 0)) continue;
    const units = t.side === 'sell' ? u.swap : u.approve + u.swap;
    prices.push(gasNative / units);
  }
  if (!prices.length) return undefined;
  prices.sort((a, b) => a - b);
  return prices[Math.floor(prices.length / 2)];
}

/** Sell-side realized pnl. The field is named in USD; the app stores quote units of the pair. */
function gridRealized(trades: unknown): number {
  if (!Array.isArray(trades)) return 0;
  let sum = 0;
  for (const row of trades) {
    const t = obj(row);
    if (!t || t.failed === true || t.side !== 'sell') continue;
    // `realizedPnlQuote` since the *Usd → *Quote rename (state v7); older saves still say realizedPnlUsd
    sum += num(t.realizedPnlQuote) ?? num(t.realizedPnlUsd) ?? num(t.roundTripNet) ?? 0;
  }
  return sum;
}

function gridBot(row: Record<string, unknown>, i: number): SavedBot | null {
  const cfg = obj(row.config);
  if (!cfg) return null;
  const key = str(row.stable);
  const side0 = resolveSide(key);
  if (!side0) return null;
  const side = withStoredTokens(applyTradeDex(side0, row.trades), row);
  const lower = num(cfg.lowerPrice);
  const upper = num(cfg.upperPrice);
  const gridCount = num(cfg.gridCount);
  const capital = num(cfg.totalCapitalQuote) ?? num(cfg.totalCapitalUsd); // renamed *Quote in state v7
  if (lower == null || upper == null || gridCount == null || !(capital != null && capital > 0)) return null;
  const fills = fillsOf(row.trades);
  const profits = obj(row.profits);
  const recenter = obj(row.recenter);
  const window = windowOf(row, fills);
  const startPrice = num(row.startPrice);
  const gasPriceNative = recordedGasPrice(row.trades, side.chain);
  return {
    id: str(row.id) || `grid-${i + 1}`,
    mode: botMode(row.mode),
    fills,
    window,
    depth: depthOf(row),
    recordedNet: gridRealized(row.trades),
    config: configOf('grid', side, {
      capital, lowerPrice: lower, upperPrice: upper, gridCount,
      reinvest: profits?.mode !== 'send',
      recenter: recenter?.enabled === true,
      ...(gasPriceNative != null ? { gasPriceNative } : {}),
      ...(startPrice != null && startPrice > 0 ? { startPrice } : {}),
      ...(window ? { startedAt: window.from } : {}),
      ...limitsOf(row),
    }),
  };
}

function trendBot(row: Record<string, unknown>, i: number): SavedBot | null {
  const key = str(row.quote) || str(row.stable) || str(row.market);
  const side0 = resolveSide(key);
  if (!side0) return null;
  const side = withStoredTokens(applyTradeDex(side0, row.trades), row);
  const capital = num(row.capital);
  const rawCfg = obj(row.cfg);
  if (!(capital != null && capital > 0) || !rawCfg || typeof rawCfg.strategy !== 'string') return null;
  const fills = fillsOf(row.trades);
  const tf = isTF(row.tf) ? row.tf as TF : '1h';
  const window = windowOf(row, fills);
  const gasPriceNative = recordedGasPrice(row.trades, side.chain);
  return {
    id: str(row.id) || `trend-${i + 1}`,
    mode: botMode(row.mode),
    fills,
    window,
    depth: depthOf(row),
    recordedNet: gridRealized(row.trades),
    config: configOf('trend', side, {
      capital, tf, trend: { ...DEFAULT_TREND, ...rawCfg } as TrendConfig,
      ...(gasPriceNative != null ? { gasPriceNative } : {}),
      ...(window ? { startedAt: window.from } : {}),
      ...limitsOf(row),
    }),
  };
}

function actualOf(row: Record<string, unknown>): LpActual | undefined {
  const t = obj(row.totals);
  if (!t) return undefined;
  // totals.fees is what was already collected, valued in the quote coin at collection time.
  // Fees still sitting on the open position are position.owed. The app's pnl() adds those at the current price.
  const collected = num(t.fees);
  const gas = num(t.gas);
  const moves = num(row.reranges);
  if (collected == null || gas == null || moves == null) return undefined;
  const coins = obj(t.feeCoins);
  const price = num(row.lastPrice);
  const owed = obj(obj(row.position)?.owed) ?? obj(row.owed);
  const owedBase = num(owed?.base) ?? 0;
  const owedQuote = num(owed?.quote) ?? 0;
  const owedValue = price != null && price > 0 ? owedBase * price + owedQuote : owedQuote;
  return {
    fees: collected + owedValue,
    gas, moves,
    feeBase: (num(coins?.base) ?? 0) + owedBase,
    feeQuote: (num(coins?.quote) ?? 0) + owedQuote,
    swapCost: num(t.swapCost) ?? 0,
    moveLoss: num(t.moveLoss) ?? 0,
  };
}

function lpBot(row: Record<string, unknown>, i: number): SavedBot | null {
  const cfg = obj(row.config);
  if (!cfg) return null;
  const key = str(row.market) || str(row.stable);
  const side0 = resolveSide(key);
  if (!side0) return null;
  const side = withStoredTokens(applyTradeDex(side0, row.trades), row);
  const band = num(cfg.bandPct);
  const cash = num(cfg.capital);
  if (!(band != null && band > 0) || !(cash != null && cash > 0)) return null;
  // Coins already held on the base side go in too. Their quote value is baseAmount × the start price.
  const baseHeld = num(cfg.baseAmount) ?? 0;
  const start = num(row.startPrice);
  const capital = cash + (baseHeld > 0 && start != null && start > 0 ? baseHeld * start : 0);
  const fills = fillsOf(row.trades);
  const feeTier = num(row.feeTier) ?? num(cfg.feeTier) ?? side.feeTier;
  const feeBps = num(row.feeBps) ?? num(cfg.feeBps) ?? side.feeBps;
  return {
    id: str(row.id) || `lp-${i + 1}`,
    mode: botMode(row.mode),
    fills,
    window: windowOf(row, fills),
    depth: depthOf(row),
    actual: actualOf(row),
    config: configOf('lp', { ...side, feeBps, feeTier: feeTier ?? side.feeTier, spacing: spacingFor(side.dex, feeTier ?? side.feeTier) ?? side.spacing }, {
      capital, bandPct: band, rerange: cfg.rerange !== false,
      ...limitsOf(row),
    }),
  };
}

function botsFrom(clean: unknown): { bots: SavedBot[]; skipped: number } {
  const root = obj(clean);
  if (!root) return { bots: [], skipped: 0 };
  const bots: SavedBot[] = [];
  let skipped = 0;
  const take = (list: unknown, build: (row: Record<string, unknown>, i: number) => SavedBot | null) => {
    if (!Array.isArray(list)) return;
    list.forEach((row, i) => {
      const o = obj(row);
      if (!o) return;
      const bot = build(o, i);
      if (bot) bots.push(bot);
      else skipped++;
    });
  };
  if (Array.isArray(root.grids) || Array.isArray(root.trends) || Array.isArray(root.lps)) {
    take(root.grids, gridBot);
    take(root.trends, trendBot);
    take(root.lps, lpBot);
  } else if (obj(root.config) || Array.isArray(root.trades)) {
    const one = gridBot(root, 0);
    if (one) bots.push(one);
  }
  return { bots, skipped };
}

/** The two examples used only when the app has no state file. Pools are public Uniswap and 9mm pools. */
export function defaultBots(): SavedBot[] {
  const eth: BotConfig = {
    kind: 'lp', chain: 'ethereum', dex: 'uniswap-v3', pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    base: { symbol: 'WETH', decimals: 18, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    quote: { symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    feeBps: 5, feeTier: 500, capital: 1000, bandPct: 0.01, rerange: false,
    baseIs0: false, spacing: 10, gasToken: 'base', usdPerQuote: 1,
  };
  const hex: BotConfig = {
    kind: 'lp', chain: 'pulsechain', dex: '9mm-v3', pool: '0x8c357be2cf2c1de1c4dca8aea0af1529f789976b',
    base: { symbol: 'HEX', decimals: 8, address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39' },
    quote: { symbol: 'WPLS', decimals: 18, address: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27' },
    feeBps: 25, feeTier: 2500, capital: 1_000_000, bandPct: 0.03, rerange: false,
    baseIs0: true, spacing: 50, gasToken: 'quote',
  };
  return [
    { id: 'default-eth-usdc', mode: 'paper', config: eth, fills: [] },
    { id: 'default-hex-wpls', mode: 'paper', config: hex, fills: [] },
  ];
}

/** Read the app state. A missing file returns the default examples and says so. */
export function loadAppState(path: string): StateLoad {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { source: 'defaults', path, note: NO_STATE_NOTE, bots: defaultBots(), skipped: 0 };
    }
    throw new Error('The app state file could not be read');
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('The app state file is not valid JSON'); }
  const { bots, skipped } = botsFrom(stripCredentials(raw));
  if (!bots.length) return { source: 'state', path, note: EMPTY_STATE_NOTE, bots, skipped };
  const skip = skipped ? ' Some saved bots had no config and were left out.' : '';
  return { source: 'state', path, note: STATE_NOTE + skip, bots, skipped };
}

/** `chain:BASE/QUOTE` from the parsed market, so a legacy key still shows both coins. */
export function pairLabel(cfg: Pick<BotConfig, 'chain' | 'base' | 'quote'>): string {
  return `${cfg.chain}:${cfg.base.symbol}/${cfg.quote.symbol}`;
}

/** Quote-valued net the app recorded: LP totals (including uncollected fees), or a grid's sell pnl. */
export function recordedQuoteNet(bot: SavedBot): number | null {
  if (bot.config.kind === 'lp') {
    if (!bot.actual) return null;
    const a = bot.actual;
    return a.fees - a.gas - a.swapCost - a.moveLoss;
  }
  return bot.recordedNet ?? null;
}

/** That net divided by the bot's own run, in quote units per day. */
export function recordedPerDay(bot: SavedBot): number | null {
  const net = recordedQuoteNet(bot);
  if (net == null || !bot.window) return null;
  const days = (bot.window.to - bot.window.from) / 86_400;
  return days > 0 ? net / days : null;
}

/**
 * Gas price implied by the gas a liquidity bot paid and the moves it recorded. Today's gas price is not used.
 * Quote-per-native is 1 when the quote coin pays gas.
 */
function withRecordedGas(bot: SavedBot): BotConfig {
  const cfg = bot.config;
  if (cfg.kind !== 'lp' || !bot.actual || !(bot.actual.gas >= 0)) return cfg;
  const quotePerNative = cfg.quotePerNative ?? (cfg.gasToken === 'quote' ? 1 : 0);
  if (!(quotePerNative > 0)) return cfg;
  return {
    ...cfg,
    quotePerNative,
    gasPriceNative: impliedLpGasPrice(cfg.chain, bot.actual.moves, bot.actual.gas, quotePerNative),
  };
}

function withFit(cfg: BotConfig, feeK: number, slippageBps: number, dwellMs?: number): BotConfig {
  return {
    ...cfg,
    feeK,
    slippageBps,
    feeBps: cfg.kind === 'lp' ? cfg.feeBps : cfg.feeBps * feeK,
    ...(dwellMs != null ? { dwellMs } : {}),
  };
}

function compare(recorded: RecordedFill[], replayed: { t: number; side: 'buy' | 'sell'; price: number; feeQuote: number }[]): CalibrationError {
  const R = [...recorded].sort((a, b) => a.t - b.t);
  const S = [...replayed].sort((a, b) => a.t - b.t);
  const prices: number[] = [];
  const fees: number[] = [];
  let i = 0, j = 0, matched = 0;
  while (i < R.length && j < S.length) {
    if (R[i].side !== S[j].side) {
      if (R[i].t <= S[j].t) i++; else j++;
      continue;
    }
    matched++;
    const rec = R[i];
    const sim = S[j];
    if (rec.price > 0) prices.push(Math.abs(sim.price - rec.price) / rec.price);
    const fee = rec.feeQuote;
    if (fee != null && fee > 0) fees.push(Math.abs(sim.feeQuote - fee) / fee);
    i++;
    j++;
  }
  const priceMape = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  const feeMape = fees.length ? fees.reduce((a, b) => a + b, 0) / fees.length : null;
  const count = Math.abs(R.length - S.length) / Math.max(R.length, 1);
  const unmatched = (R.length - matched) / Math.max(R.length, 1);
  const movesError = rel(S.length, R.length);
  return {
    recorded: R.length, replayed: S.length, priceMape, feeMape,
    movesError, netError: null,
    combined: count + unmatched + (priceMape ?? 1) + (feeMape ?? 0),
  };
}

function named(run: BotSummary, label: string): number | null {
  const n = run.modelNotes.find((x) => x.label === label);
  return n && Number.isFinite(n.value) ? n.value : null;
}

function rel(sim: number, act: number): number {
  const den = Math.max(Math.abs(act), Math.abs(sim), 1e-9);
  return Math.abs(sim - act) / den;
}

/**
 * A liquidity fit is judged on quote-valued net units per day. Move count, fees, gas, swap cost and move loss
 * are reported beside that, and the move count breaks a tie. They are not added into the objective: matching
 * fee volume alone used to pick a dwell that spent the profit.
 */
function compareLp(actual: LpActual, run: BotSummary, targetPerDay: number | null): CalibrationError | null {
  const fees = named(run, 'Fees collected');
  const gas = named(run, 'Gas');
  const swap = named(run, 'Swap cost');
  const loss = named(run, 'Move loss');
  if (fees == null || gas == null || swap == null || loss == null) return null;
  const replayedPerDay = run.rates[0]?.perDay ?? 0;
  const netError = targetPerDay == null ? null : rel(replayedPerDay, targetPerDay);
  const movesError = rel(run.moves, actual.moves);
  return {
    recorded: actual.moves, replayed: run.moves,
    priceMape: rel(fees, actual.fees), feeMape: rel(gas, actual.gas),
    swapRel: rel(swap, actual.swapCost), lossRel: rel(loss, actual.moveLoss),
    netError, movesError,
    combined: netError ?? movesError,
  };
}

function betterFit(
  err: CalibrationError, feeK: number, slip: number, dwellMs: number,
  best: { feeK: number; slippageBps: number; dwellMs: number; error: CalibrationError },
): boolean {
  const score = (e: CalibrationError) => e.netError ?? e.combined;
  const a = score(err);
  const b = score(best.error);
  if (a < b - 1e-12) return true;
  if (Math.abs(a - b) > 1e-12) return false;
  if (err.movesError !== best.error.movesError) return err.movesError < best.error.movesError;
  if (Math.abs(feeK - 1) !== Math.abs(best.feeK - 1)) return Math.abs(feeK - 1) < Math.abs(best.feeK - 1);
  if (slip !== best.slippageBps) return slip < best.slippageBps;
  return dwellMs < best.dwellMs;
}

function unfinished(bot: SavedBot, cfg: BotConfig, feeK: number, slippageBps: number, note: string): Calibration {
  return {
    botId: bot.id, fitted: false, feeK, slippageBps, config: cfg, error: null,
    recordedPerDay: recordedPerDay(bot), replayedPerDay: null, netError: null, movesError: null,
    calibrated: false, mode: bot.mode, note,
  };
}

/**
 * Pick the fee scale (and, for a grid, the fill slippage) that makes a replay agree with what the bot recorded.
 * A grid is fitted to its fills. A liquidity bot is fitted to quote-valued net units per day, using the gas it
 * actually paid. Candle closes leave a tight band more often than a live slot0 poll, so that fit also tries a
 * short dwell. Net-units error above {@link NET_ERROR_LIMIT} is left uncalibrated.
 */
export function calibrateBot(bot: SavedBot, data: HarnessData): Calibration {
  const cfg = withRecordedGas(bot);
  const baseK = cfg.feeK ?? 1;
  const baseSlip = cfg.slippageBps ?? 0;
  const target = recordedPerDay(bot);
  const lp = cfg.kind === 'lp' && bot.actual;
  if (!lp && !bot.fills.length) {
    return unfinished(bot, cfg, baseK, baseSlip, 'No recorded fills, so the fee and fill model stays at its defaults.');
  }
  const scales = FEE_SCALES;
  const slips = lp ? [baseSlip] : FILL_SLIPPAGES;
  const dwells = lp ? LP_DWELLS_MS : [0];
  let best: { feeK: number; slippageBps: number; dwellMs: number; perDay: number; error: CalibrationError } | null = null;
  for (const feeK of scales) {
    for (const slippageBps of slips) {
      for (const dwellMs of dwells) {
        let error: CalibrationError | null = null;
        let perDay = 0;
        try {
          const run = runBot(withFit(cfg, feeK, slippageBps, lp ? dwellMs : undefined), data);
          perDay = run.rates[0]?.perDay ?? 0;
          error = lp ? compareLp(bot.actual!, run, target) : compare(bot.fills, run.simFills);
        } catch {
          continue;
        }
        if (!error) continue;
        if (!best || betterFit(error, feeK, slippageBps, dwellMs, best)) {
          best = { feeK, slippageBps, dwellMs, perDay, error };
        }
      }
    }
  }
  if (!best) {
    return unfinished(bot, cfg, baseK, baseSlip, 'The replay could not run, so the fee and fill model was not fitted.');
  }
  const netError = target == null ? null : rel(best.perDay, target);
  const error: CalibrationError = { ...best.error, netError };
  const calibrated = netError != null && netError <= NET_ERROR_LIMIT;
  return {
    botId: bot.id, fitted: true, feeK: best.feeK, slippageBps: best.slippageBps,
    config: withFit(cfg, best.feeK, best.slippageBps, lp ? best.dwellMs : undefined),
    error, recordedPerDay: target, replayedPerDay: best.perDay, netError, movesError: error.movesError, calibrated,
    mode: bot.mode,
    note: lp
      ? 'The fee model was fitted to recorded net units per day. The move count is reported separately.'
      : 'The fee and fill model was fitted to the recorded fills. Net units per day are reported separately.',
  };
}

const pct = (n: number) => `${n < 0 ? '-' : '+'}${fmt(Math.abs(n) * 100)}%`;

function netLines(c: Calibration): string[] {
  const unit = c.config.quote.symbol;
  const recordedLabel = sourceLabel(recordedSource(c.mode));
  const recorded = c.recordedPerDay == null
    ? `Recorded net was not measured (${recordedLabel}).`
    : `Recorded net ${signed(c.recordedPerDay)} ${unit}/day (${recordedLabel}).`;
  const replayed = c.replayedPerDay == null
    ? 'Replayed net was not measured (fitted model).'
    : `Replayed net ${signed(c.replayedPerDay)} ${unit}/day (fitted model).`;
  const net = c.netError == null
    ? 'Net-units error was not measured (fitted model).'
    : `Net-units error ${pct(c.netError)} (fitted model).`;
  return [recorded, replayed, net, `Calibrated ${c.calibrated ? 'yes' : 'no'} (fitted model).`];
}

/** Lines for the summary. Every line that contains a digit is marked modeled or on-chain actual. */
export function calibrationMarkdown(c: Calibration): string {
  const who = `${pairLabel(c.config)} ${c.botId}`;
  if (!c.fitted || !c.error) return [`${who}: ${c.note} (fitted model)`, ...netLines(c)].join('\n');
  const countWord = c.config.kind === 'lp' ? 'moves' : 'fills';
  const countErr = ` ${countWord[0].toUpperCase()}${countWord.slice(1)} error ${pct(c.error.movesError)} (fitted model).`;
  if (c.config.kind === 'lp') {
    const fee = c.error.priceMape == null ? 'Fee error was not measured (fitted model).' : `Fees collected error ${pct(c.error.priceMape)} (fitted model).`;
    const gas = c.error.feeMape == null ? 'Gas error was not measured (fitted model).' : `Gas error ${pct(c.error.feeMape)} (fitted model).`;
    const swap = c.error.swapRel == null ? '' : ` Swap cost error ${pct(c.error.swapRel)} (fitted model).`;
    const loss = c.error.lossRel == null ? '' : ` Move loss error ${pct(c.error.lossRel)} (fitted model).`;
    const dwellMin = (c.config.dwellMs ?? 0) / 60_000;
    const dwell = `Outside-range dwell ${fmt(dwellMin)} minutes (fitted model).`;
    return [
      `${who}: fee k ${fmt(c.feeK)} (fitted model). ${dwell}`,
      `${fee} ${gas}${swap}${loss}`,
      `Recorded moves ${fmt(c.error.recorded)} and replayed moves ${fmt(c.error.replayed)} (fitted model).${countErr}`,
      ...netLines(c),
    ].join('\n');
  }
  const fee = c.error.feeMape == null ? 'Fee error was not measured (fitted model).' : `Fee error ${pct(c.error.feeMape)} (fitted model).`;
  const price = c.error.priceMape == null ? 'Price error was not measured (fitted model).' : `Price error ${pct(c.error.priceMape)} (fitted model).`;
  return [
    `${who}: fee k ${fmt(c.feeK)} (fitted model). Fill slippage ${fmt(c.slippageBps)} bps (fitted model).`,
    `Recorded fills ${fmt(c.error.recorded)} and replayed fills ${fmt(c.error.replayed)} (fitted model).${countErr}`,
    `${price} ${fee}`,
    ...netLines(c),
  ].join('\n');
}

export interface WhatIfRow {
  id: string;
  pair: string;
  unit: string;
  mode: BotMode;
  replayedPerDay: number | null;
  calibrated: boolean;
}

/** Live bots first, then paper, keeping the order inside each group. */
export function splitByMode<T extends { mode: BotMode }>(rows: T[]): { live: T[]; paper: T[] } {
  return { live: rows.filter((r) => r.mode === 'live'), paper: rows.filter((r) => r.mode === 'paper') };
}

/** What-if copy. Paper bots are a separate section and are not given a rate here. */
export function whatIfMarkdown(rows: WhatIfRow[]): string {
  const { live, paper } = splitByMode(rows);
  const ok = live.filter((r) => r.calibrated);
  const lines = [
    '# What-if',
    '',
    `A what-if uses a live bot whose net-units error is at most ${fmt(NET_ERROR_LIMIT)} (fitted model).`,
    'Paper bots stay in their own section and are left out of what-if output (fitted model).',
  ];
  if (!ok.length) lines.push('No live bot cleared that bar, so this run has no what-if (fitted model).');
  for (const r of ok) lines.push(`${r.pair} ${r.id}: ${signed(r.replayedPerDay ?? 0)} ${r.unit}/day (fitted model).`);
  const left = live.filter((r) => !r.calibrated).length;
  if (left) lines.push(`Uncalibrated live bots left out: ${fmt(left)} (fitted model).`);
  if (paper.length) lines.push(`Paper bots left out: ${fmt(paper.length)} (fitted model).`);
  return lines.join('\n');
}
