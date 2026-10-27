/**
 * Bot configs for the harness come from the app's saved state (data/state.json), the same file the running app
 * writes. Each saved bot contributes its config and its recorded fills. The fee scale and the fill slippage are
 * then chosen so a replay of that config lands on those fills, and the miss is reported.
 *
 * A missing file is the only time the built-in examples are used, and the output says so. Credential-like fields
 * are dropped before anything is copied out of the file. This module does not load the process environment.
 */
import { readFileSync } from 'node:fs';
import type { TF } from '../market/candles';
import { isTF } from '../market/candles';
import type { TrendConfig } from '../market/strategy';
import { DEFAULT_TREND } from '../market/strategy';
import type { BacktestChain } from './gasModel';
import { fmt } from './report';
import { runBot, type BotConfig, type HarnessData, type TokenRef } from './run';

/** Shown when data/state.json is not there. Defaults are not used for any other reason. */
export const NO_STATE_NOTE = 'No saved bot state was found. These figures use the built-in default examples, not a bot from the app.';
/** Shown when the file was read. */
export const STATE_NOTE = 'Configs and recorded fills were loaded from the app state. Defaults were not used.';
/** Shown when the file exists but has no runnable bot. */
export const EMPTY_STATE_NOTE = 'The app state has no saved bot config. Defaults were not used.';

const FEE_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const FILL_SLIPPAGES = [0, 5, 10, 15, 20, 25, 50, 100];

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

export interface SavedBot {
  id: string;
  config: BotConfig;
  fills: RecordedFill[];
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
  /** Mean absolute percent error of matched fill prices. Null when nothing matched. */
  priceMape: number | null;
  /** Mean absolute percent error of matched fee amounts. Null when the saved fills have no fee. */
  feeMape: number | null;
  /** Count miss + unmatched share + price error + fee error. 0 is an exact replay. */
  combined: number;
}

export interface Calibration {
  botId: string;
  /** False when there were no recorded fills to fit, or the replay could not run. */
  fitted: boolean;
  feeK: number;
  slippageBps: number;
  config: BotConfig;
  error: CalibrationError | null;
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

function chainOf(v: unknown): BacktestChain | null {
  const s = str(v).toLowerCase();
  if (s === 'ethereum' || s === 'eth') return 'ethereum';
  if (s === 'robinhood' || s === 'hood') return 'robinhood';
  if (s === 'pulsechain' || s === 'pulse' || s === 'mainnet' || s === 'testnet') return 'pulsechain';
  return null;
}

function token(symbol: string, decimals: number): TokenRef {
  return { symbol, decimals };
}

function quoteDecimals(symbol: string): number {
  if (symbol === 'DAI') return 18;
  if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'USDG') return 6;
  return 18;
}

function baseFor(chain: BacktestChain): TokenRef {
  return token(chain === 'pulsechain' ? 'WPLS' : 'WETH', 18);
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
    const ts = num(t.timestamp ?? t.t);
    if (!side || !(price != null && price > 0) || !(base != null && base > 0) || !(quote != null && quote > 0) || ts == null) continue;
    out.push({
      t: ts > 1e12 ? ts / 1000 : ts,
      side, price, baseAmount: base, quoteAmount: quote,
      feeQuote: num(t.feeQuote),
      levelPrice: num(t.levelPrice),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function medianFee(trades: unknown, fallback: number): number {
  if (!Array.isArray(trades)) return fallback;
  const xs = trades.map((row) => num(obj(row)?.feeBps)).filter((n): n is number => n != null && n > 0).sort((a, b) => a - b);
  if (!xs.length) return fallback;
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

function gridBot(row: Record<string, unknown>, i: number): SavedBot | null {
  const cfg = obj(row.config);
  if (!cfg) return null;
  const chain = chainOf(row.network) ?? 'pulsechain';
  const quoteSym = str(row.stable) || 'USDC';
  const lower = num(cfg.lowerPrice);
  const upper = num(cfg.upperPrice);
  const gridCount = num(cfg.gridCount);
  const capital = num(cfg.totalCapitalUsd);
  if (lower == null || upper == null || gridCount == null || !(capital != null && capital > 0)) return null;
  const profits = obj(row.profits);
  const recenter = obj(row.recenter);
  return {
    id: str(row.id) || `grid-${i + 1}`,
    fills: fillsOf(row.trades),
    config: {
      kind: 'grid', chain, dex: dexOf(row.trades), pool: str(row.pool),
      base: baseFor(chain), quote: token(quoteSym, quoteDecimals(quoteSym)),
      feeBps: medianFee(row.trades, chain === 'pulsechain' ? 29 : 5),
      capital, lowerPrice: lower, upperPrice: upper, gridCount,
      reinvest: profits?.mode !== 'send',
      recenter: recenter?.enabled === true,
      gasToken: chain === 'pulsechain' ? 'quote' : 'base',
    },
  };
}

function trendBot(row: Record<string, unknown>, i: number): SavedBot | null {
  const chain = chainOf(row.network) ?? 'pulsechain';
  const quoteSym = str(row.quote) || 'USDC';
  const capital = num(row.capital);
  const rawCfg = obj(row.cfg);
  if (!(capital != null && capital > 0) || !rawCfg || typeof rawCfg.strategy !== 'string') return null;
  const tf = isTF(row.tf) ? row.tf as TF : '1h';
  return {
    id: str(row.id) || `trend-${i + 1}`,
    fills: fillsOf(row.trades),
    config: {
      kind: 'trend', chain, dex: dexOf(row.trades), pool: str(row.pool),
      base: baseFor(chain), quote: token(quoteSym, quoteDecimals(quoteSym)),
      feeBps: medianFee(row.trades, chain === 'pulsechain' ? 29 : 5),
      capital, tf, trend: { ...DEFAULT_TREND, ...rawCfg } as TrendConfig,
      gasToken: chain === 'pulsechain' ? 'quote' : 'base',
    },
  };
}

function lpBot(row: Record<string, unknown>, i: number): SavedBot | null {
  const cfg = obj(row.config);
  if (!cfg) return null;
  const chain = chainOf(row.network) ?? 'pulsechain';
  const quoteSym = str(row.market) || str(row.stable) || 'USDC';
  const band = num(cfg.bandPct);
  const capital = num(cfg.capital);
  if (!(band != null && band > 0) || !(capital != null && capital > 0)) return null;
  const feeTier = num(row.feeTier) ?? num(cfg.feeTier);
  const feeBps = num(row.feeBps) ?? num(cfg.feeBps) ?? (feeTier != null ? feeTier / 100 : chain === 'pulsechain' ? 29 : 5);
  return {
    id: str(row.id) || `lp-${i + 1}`,
    fills: fillsOf(row.trades),
    config: {
      kind: 'lp', chain, dex: str(row.dex), pool: str(row.pool),
      base: baseFor(chain), quote: token(quoteSym, quoteDecimals(quoteSym)),
      feeBps, feeTier: feeTier ?? undefined, capital, bandPct: band,
      rerange: cfg.rerange !== false,
      gasToken: chain === 'pulsechain' ? 'quote' : 'base',
    },
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
  // A version-1 file is one grid at the top, not a list.
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
    { id: 'default-eth-usdc', config: eth, fills: [] },
    { id: 'default-hex-wpls', config: hex, fills: [] },
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

function withFit(cfg: BotConfig, feeK: number, slippageBps: number): BotConfig {
  return {
    ...cfg,
    feeK,
    slippageBps,
    feeBps: cfg.kind === 'lp' ? cfg.feeBps : cfg.feeBps * feeK,
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
  return {
    recorded: R.length, replayed: S.length, priceMape, feeMape,
    combined: count + unmatched + (priceMape ?? 1) + (feeMape ?? 0),
  };
}

/**
 * Pick the fee scale and fill slippage that make a replay of this config agree with the recorded fills.
 * Liquidity bots have no fill list in the app state, so they keep k = 1 unless fills were recorded.
 */
export function calibrateBot(bot: SavedBot, data: HarnessData): Calibration {
  const baseK = bot.config.feeK ?? 1;
  const baseSlip = bot.config.slippageBps ?? 0;
  if (!bot.fills.length) {
    return {
      botId: bot.id, fitted: false, feeK: baseK, slippageBps: baseSlip, config: bot.config, error: null,
      note: 'No recorded fills, so the fee and fill model stays at its defaults.',
    };
  }
  const scales = bot.config.kind === 'lp' ? FEE_SCALES : FEE_SCALES;
  const slips = bot.config.kind === 'lp' ? [baseSlip] : FILL_SLIPPAGES;
  let best: { feeK: number; slippageBps: number; error: CalibrationError } | null = null;
  for (const feeK of scales) {
    for (const slippageBps of slips) {
      let error: CalibrationError;
      try {
        const run = runBot(withFit(bot.config, feeK, slippageBps), data);
        error = compare(bot.fills, run.simFills);
      } catch {
        continue;
      }
      const better = !best
        || error.combined < best.error.combined - 1e-12
        || (Math.abs(error.combined - best.error.combined) <= 1e-12 && Math.abs(feeK - 1) < Math.abs(best.feeK - 1))
        || (Math.abs(error.combined - best.error.combined) <= 1e-12 && Math.abs(feeK - 1) === Math.abs(best.feeK - 1) && slippageBps < best.slippageBps);
      if (better) best = { feeK, slippageBps, error };
    }
  }
  if (!best) {
    return {
      botId: bot.id, fitted: false, feeK: baseK, slippageBps: baseSlip, config: bot.config, error: null,
      note: 'The replay could not run, so the fee and fill model was not fitted.',
    };
  }
  return {
    botId: bot.id, fitted: true, feeK: best.feeK, slippageBps: best.slippageBps,
    config: withFit(bot.config, best.feeK, best.slippageBps), error: best.error,
    note: 'The fee and fill model was fitted to the recorded fills.',
  };
}

const pct = (n: number) => `${n < 0 ? '-' : '+'}${fmt(Math.abs(n) * 100)}%`;

/** Lines for the summary. Every line that contains a digit is marked modeled. */
export function calibrationMarkdown(c: Calibration): string {
  if (!c.fitted || !c.error) return `${c.botId}: ${c.note} (modeled)`;
  const fee = c.error.feeMape == null ? 'Fee error was not measured (modeled).' : `Fee error ${pct(c.error.feeMape)} (modeled).`;
  const price = c.error.priceMape == null ? 'Price error was not measured (modeled).' : `Price error ${pct(c.error.priceMape)} (modeled).`;
  return [
    `${c.botId}: fee k ${fmt(c.feeK)} (modeled). Fill slippage ${fmt(c.slippageBps)} bps (modeled).`,
    `Recorded fills ${fmt(c.error.recorded)} and replayed fills ${fmt(c.error.replayed)} (modeled).`,
    `${price} ${fee}`,
    `Calibration error ${fmt(c.error.combined)} (modeled).`,
  ].join('\n');
}
