/**
 * Capital-router settings (data/router.json). Everything is off and paper by default.
 * Out-of-range numbers are clamped to the hard caps (limits.ts rejects instead; a router PUT must not be able to raise a ceiling).
 * canonical-slow is never stored: it is not an auto bridge.
 * maxEtaMin is judged against a route's p90 ETA (etaP90Sec <= maxEtaMin × 60). Trust 'canonical-slow' is excluded regardless of ETA.
 */
import { HARD_CAPS } from '../../live/limits';
import { isHalt, type Halt } from '../bot/audit';

export const BRIDGES = ['across', 'relay', 'omnibridge', 'lifi'] as const;
export type BridgeId = (typeof BRIDGES)[number];
/** Never an auto route. Dropped if a client sends it. */
export const NEVER_AUTO = 'canonical-slow';

export const TX_KINDS = ['approve', 'swap', 'bridge', 'claim'] as const;
export type TxKind = (typeof TX_KINDS)[number];

/** Initial ceilings, not measurements. Bridge deposit 300k and claim 500k are the design's starting points. */
export const DEFAULT_GAS_CAPS: Record<TxKind, number> = {
  approve: 80_000,
  swap: 350_000,
  bridge: 300_000,
  claim: 500_000,
};

export const ROUTER_HARD_CAPS = {
  maxPerMoveUsd: 50_000,
  maxPerDayUsd: 100_000,
  /** Fraction of the amount (0.5 = 50%). */
  minNetGainPct: 0.5,
  minNetGainTok: 1e12,
  maxSlippageBps: HARD_CAPS.slippageBps,
  /** One day. A 7-day canonical exit cannot be admitted by raising the ETA cap. */
  maxEtaMin: 24 * 60,
  cooldownMin: 14 * 24 * 60,
  maxMovesPerDay: 24,
  minConfidence: 1,
  gasUnits: 1_500_000,
} as const;

/** p90, not p50. Equal to the cap is allowed; over it is not. */
export const MAX_ETA_BASIS = 'p90' as const;

export function etaP90Within(etaP90Sec: number, maxEtaMin: number): boolean {
  return Number.isFinite(etaP90Sec) && etaP90Sec >= 0 && etaP90Sec <= maxEtaMin * 60;
}

/** Token units of the budget coin, after fees and gas. Examples from the design: 5 USDG, 0.002 ETH, 50k PLS. */
export const DEFAULT_MIN_NET_GAIN_TOK: Record<string, number> = {
  USDG: 5, USDC: 5, USDT: 5, DAI: 5, ETH: 0.002, WETH: 0.002, PLS: 50_000, WPLS: 50_000,
};

export interface RouterHalt {
  subject: 'router';
  halt: Halt;
}

export interface RouterSettings {
  on: boolean;
  mode: 'paper' | 'live';
  maxPerMoveUsd: number;
  maxPerDayUsd: number;
  /** chain id → USD. A per-chain value only lowers the global cap. */
  maxPerMoveUsdByChain: Record<string, number>;
  maxPerDayUsdByChain: Record<string, number>;
  allowedChains: number[];
  allowedBridges: BridgeId[];
  minNetGainTok: Record<string, number>;
  /** Fraction of the amount. 0.005 = 0.5%. */
  minNetGainPct: number;
  maxSlippageBps: number;
  /** Minutes. Compared with the route's p90 ETA. */
  maxEtaMin: number;
  cooldownMin: number;
  maxMovesPerDay: number;
  /**
   * 0–1. The ROI Strategist does not publish a number yet (design open question 1).
   * 0.5 is the floor until it does.
   */
  minConfidence: number;
  /** chain id → tx kind → gas units. */
  gasCaps: Record<string, Partial<Record<TxKind, number>>>;
  autoClaim: boolean;
  halt: RouterHalt | null;
}

export const HOST_ONLY = 'The capital router runs on the host app only.';

export function liveEnableError(s: Pick<RouterSettings, 'mode' | 'maxPerMoveUsd' | 'maxPerDayUsd' | 'allowedChains' | 'allowedBridges'>): string | null {
  if (s.mode !== 'live') return null;
  if (!(s.maxPerMoveUsd > 0) || !(s.maxPerDayUsd > 0)) return 'Live mode needs maxPerMoveUsd and maxPerDayUsd above 0. Zero blocks live.';
  if (s.allowedChains.length === 0 || s.allowedBridges.length === 0) return 'Live mode needs at least one allowed chain and one allowed bridge.';
  return null;
}

export function defaultSettings(chainIds: readonly number[]): RouterSettings {
  return {
    on: false,
    mode: 'paper',
    maxPerMoveUsd: 0,
    maxPerDayUsd: 0,
    maxPerMoveUsdByChain: {},
    maxPerDayUsdByChain: {},
    allowedChains: [],
    allowedBridges: [],
    minNetGainTok: { ...DEFAULT_MIN_NET_GAIN_TOK },
    minNetGainPct: 0.005,
    maxSlippageBps: 50,
    maxEtaMin: 60,
    cooldownMin: 360,
    maxMovesPerDay: 2,
    minConfidence: 0.5,
    gasCaps: gasDefaults(chainIds),
    autoClaim: false,
    halt: null,
  };
}

function gasDefaults(chainIds: readonly number[]): RouterSettings['gasCaps'] {
  const out: RouterSettings['gasCaps'] = {};
  for (const id of chainIds) out[String(id)] = { ...DEFAULT_GAS_CAPS };
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function entries(v: unknown): [string, unknown][] {
  if (!isObj(v)) return [];
  return Object.entries(v).filter(([k]) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype');
}

function chainKey(id: number, known: ReadonlySet<number>): string | null {
  return Number.isInteger(id) && id > 0 && known.has(id) ? String(id) : null;
}

function knownSet(chainIds: readonly number[]): Set<number> {
  return new Set(chainIds.filter((id) => Number.isInteger(id) && id > 0));
}

function readSymbol(k: string): string | null {
  const s = k.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{1,11}$/.test(s) ? s : null;
}

function num(v: unknown, fallback: number, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return clamp(fallback, min, max);
  return clamp(integer ? Math.round(v) : v, min, max);
}

function strictNum(v: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number.`);
  return clamp(integer ? Math.round(v) : v, min, max);
}

function usdMap(v: unknown, known: ReadonlySet<number>, ceiling: number, strict: boolean): Record<string, number> {
  if (v == null) return {};
  if (!isObj(v)) { if (strict) throw new Error('Per-chain USD caps must be an object of chain id → amount.'); return {}; }
  const out: Record<string, number> = {};
  for (const [k, raw] of entries(v)) {
    const id = Number(k);
    const key = chainKey(id, known);
    if (!key) { if (strict && k.trim()) throw new Error(`Unknown chain ${k}.`); continue; }
    if (raw == null) continue;
    out[key] = strict ? strictNum(raw, `cap for chain ${key}`, 0, ceiling) : num(raw, 0, 0, ceiling);
    if (out[key] > ceiling) out[key] = ceiling;
  }
  return out;
}

function bridgesOf(v: unknown, strict: boolean): BridgeId[] {
  if (v == null) return [];
  if (!Array.isArray(v)) { if (strict) throw new Error('allowedBridges must be a list.'); return []; }
  const out: BridgeId[] = [];
  for (const item of v) {
    const name = String(item ?? '').trim().toLowerCase();
    if (!name || name === NEVER_AUTO) continue;
    if ((BRIDGES as readonly string[]).includes(name)) {
      const id = name as BridgeId;
      if (!out.includes(id)) out.push(id);
    } else if (strict) throw new Error(`Unknown bridge ${name}.`);
  }
  return out;
}

function chainsOf(v: unknown, known: ReadonlySet<number>, strict: boolean): number[] {
  if (v == null) return [];
  if (!Array.isArray(v)) { if (strict) throw new Error('allowedChains must be a list of chain ids.'); return []; }
  const out: number[] = [];
  for (const item of v) {
    const id = typeof item === 'number' ? item : Number(item);
    const key = chainKey(id, known);
    if (!key) { if (strict) throw new Error(`Chain ${String(item)} is not loaded.`); continue; }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function gainMap(v: unknown, base: Record<string, number>, strict: boolean): Record<string, number> {
  const out = { ...base };
  if (v == null) return out;
  if (!isObj(v)) { if (strict) throw new Error('minNetGainTok must be an object of symbol → token units.'); return out; }
  for (const [k, raw] of entries(v)) {
    const sym = readSymbol(k);
    if (!sym) { if (strict) throw new Error(`Bad coin symbol ${k}.`); continue; }
    if (raw == null) { delete out[sym]; continue; }
    out[sym] = strict ? strictNum(raw, `minNetGainTok ${sym}`, 0, ROUTER_HARD_CAPS.minNetGainTok) : num(raw, base[sym] ?? 0, 0, ROUTER_HARD_CAPS.minNetGainTok);
  }
  const keys = Object.keys(out);
  if (keys.length > 32) for (const k of keys.slice(32)) delete out[k];
  return out;
}

function kindsOf(v: unknown, strict: boolean): Partial<Record<TxKind, number>> {
  const out: Partial<Record<TxKind, number>> = {};
  if (!isObj(v)) { if (strict) throw new Error('gasCaps for a chain must be an object of tx kind → gas units.'); return out; }
  for (const [k, raw] of entries(v)) {
    if (!(TX_KINDS as readonly string[]).includes(k)) { if (strict) throw new Error(`Unknown tx kind ${k}.`); continue; }
    if (raw == null) continue;
    out[k as TxKind] = strict
      ? strictNum(raw, `gas cap ${k}`, 0, ROUTER_HARD_CAPS.gasUnits, true)
      : num(raw, DEFAULT_GAS_CAPS[k as TxKind], 0, ROUTER_HARD_CAPS.gasUnits, true);
  }
  return out;
}

function fillGas(caps: RouterSettings['gasCaps'], known: ReadonlySet<number>): RouterSettings['gasCaps'] {
  const out: RouterSettings['gasCaps'] = {};
  for (const id of known) {
    const cur = caps[String(id)] ?? {};
    const row: Partial<Record<TxKind, number>> = {};
    for (const kind of TX_KINDS) row[kind] = num(cur[kind], DEFAULT_GAS_CAPS[kind], 0, ROUTER_HARD_CAPS.gasUnits, true);
    out[String(id)] = row;
  }
  return out;
}

function capMap(map: Record<string, number>, ceiling: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(map)) out[k] = clamp(n, 0, ceiling);
  return out;
}

function readHalt(v: unknown): RouterHalt | null {
  if (!isObj(v) || v.subject !== 'router' || !isHalt(v.halt)) return null;
  const h = v.halt;
  return {
    subject: 'router',
    halt: { at: h.at, what: h.what, detail: h.detail, origin: h.origin, endpoint: typeof h.endpoint === 'string' ? h.endpoint : null, ua: typeof h.ua === 'string' ? h.ua : null },
  };
}

function finish(s: RouterSettings, chainIds: readonly number[]): RouterSettings {
  const known = knownSet(chainIds);
  const maxPerMoveUsd = clamp(s.maxPerMoveUsd, 0, ROUTER_HARD_CAPS.maxPerMoveUsd);
  const maxPerDayUsd = clamp(s.maxPerDayUsd, 0, ROUTER_HARD_CAPS.maxPerDayUsd);
  return {
    ...s,
    maxPerMoveUsd,
    maxPerDayUsd,
    maxPerMoveUsdByChain: capMap(s.maxPerMoveUsdByChain, maxPerMoveUsd),
    maxPerDayUsdByChain: capMap(s.maxPerDayUsdByChain, maxPerDayUsd),
    allowedChains: s.allowedChains.filter((id) => known.has(id)),
    allowedBridges: s.allowedBridges.filter((b) => (BRIDGES as readonly string[]).includes(b)),
    minNetGainPct: clamp(s.minNetGainPct, 0, ROUTER_HARD_CAPS.minNetGainPct),
    maxSlippageBps: clamp(Math.round(s.maxSlippageBps), 1, ROUTER_HARD_CAPS.maxSlippageBps),
    maxEtaMin: clamp(Math.round(s.maxEtaMin), 1, ROUTER_HARD_CAPS.maxEtaMin),
    cooldownMin: clamp(Math.round(s.cooldownMin), 0, ROUTER_HARD_CAPS.cooldownMin),
    maxMovesPerDay: clamp(Math.round(s.maxMovesPerDay), 0, ROUTER_HARD_CAPS.maxMovesPerDay),
    minConfidence: clamp(s.minConfidence, 0, ROUTER_HARD_CAPS.minConfidence),
    gasCaps: fillGas(s.gasCaps, known),
    autoClaim: s.autoClaim === true,
  };
}

/** Lenient: a bad file becomes defaults rather than crashing the process. */
export function settingsFromFile(raw: unknown, chainIds: readonly number[]): RouterSettings {
  const base = defaultSettings(chainIds);
  if (!isObj(raw)) return base;
  const known = knownSet(chainIds);
  const mode = raw.mode === 'live' ? 'live' : 'paper';
  const gasCaps: RouterSettings['gasCaps'] = { ...base.gasCaps };
  if (isObj(raw.gasCaps)) {
    for (const [k, v] of entries(raw.gasCaps)) {
      const key = chainKey(Number(k), known);
      if (!key || !isObj(v)) continue;
      gasCaps[key] = { ...gasCaps[key], ...kindsOf(v, false) };
    }
  }
  return finish({
    on: raw.on === true,
    mode,
    maxPerMoveUsd: num(raw.maxPerMoveUsd, 0, 0, ROUTER_HARD_CAPS.maxPerMoveUsd),
    maxPerDayUsd: num(raw.maxPerDayUsd, 0, 0, ROUTER_HARD_CAPS.maxPerDayUsd),
    maxPerMoveUsdByChain: usdMap(raw.maxPerMoveUsdByChain, known, ROUTER_HARD_CAPS.maxPerMoveUsd, false),
    maxPerDayUsdByChain: usdMap(raw.maxPerDayUsdByChain, known, ROUTER_HARD_CAPS.maxPerDayUsd, false),
    allowedChains: chainsOf(raw.allowedChains, known, false),
    allowedBridges: bridgesOf(raw.allowedBridges, false),
    minNetGainTok: gainMap(raw.minNetGainTok, base.minNetGainTok, false),
    minNetGainPct: num(raw.minNetGainPct, base.minNetGainPct, 0, ROUTER_HARD_CAPS.minNetGainPct),
    maxSlippageBps: num(raw.maxSlippageBps, base.maxSlippageBps, 1, ROUTER_HARD_CAPS.maxSlippageBps, true),
    maxEtaMin: num(raw.maxEtaMin, base.maxEtaMin, 1, ROUTER_HARD_CAPS.maxEtaMin, true),
    cooldownMin: num(raw.cooldownMin, base.cooldownMin, 0, ROUTER_HARD_CAPS.cooldownMin, true),
    maxMovesPerDay: num(raw.maxMovesPerDay, base.maxMovesPerDay, 0, ROUTER_HARD_CAPS.maxMovesPerDay, true),
    minConfidence: num(raw.minConfidence, base.minConfidence, 0, ROUTER_HARD_CAPS.minConfidence),
    gasCaps,
    autoClaim: raw.autoClaim === true,
    halt: readHalt(raw.halt),
  }, chainIds);
}

const SKIP = new Set(['host', 'configured', 'halt', 'version', 'maxEtaBasis']);

/** Strict: wrong types are errors. Numbers outside the hard caps are clamped. */
export function patchSettings(current: RouterSettings, body: unknown, chainIds: readonly number[]): RouterSettings {
  if (!isObj(body)) throw new Error('Router settings must be a JSON object.');
  const known = knownSet(chainIds);
  const next: RouterSettings = {
    ...current,
    maxPerMoveUsdByChain: { ...current.maxPerMoveUsdByChain },
    maxPerDayUsdByChain: { ...current.maxPerDayUsdByChain },
    allowedChains: [...current.allowedChains],
    allowedBridges: [...current.allowedBridges],
    minNetGainTok: { ...current.minNetGainTok },
    gasCaps: Object.fromEntries(Object.entries(current.gasCaps).map(([id, row]) => [id, { ...row }])),
    halt: current.halt,
  };
  for (const key of Object.keys(body)) {
    if (SKIP.has(key)) continue;
    switch (key) {
      case 'on':
        if (typeof body.on !== 'boolean') throw new Error('on must be true or false.');
        next.on = body.on;
        break;
      case 'mode':
        if (body.mode !== 'paper' && body.mode !== 'live') throw new Error('mode must be paper or live.');
        next.mode = body.mode;
        break;
      case 'maxPerMoveUsd':
        next.maxPerMoveUsd = strictNum(body.maxPerMoveUsd, 'maxPerMoveUsd', 0, ROUTER_HARD_CAPS.maxPerMoveUsd);
        break;
      case 'maxPerDayUsd':
        next.maxPerDayUsd = strictNum(body.maxPerDayUsd, 'maxPerDayUsd', 0, ROUTER_HARD_CAPS.maxPerDayUsd);
        break;
      case 'maxPerMoveUsdByChain':
        next.maxPerMoveUsdByChain = usdMap(body.maxPerMoveUsdByChain, known, ROUTER_HARD_CAPS.maxPerMoveUsd, true);
        break;
      case 'maxPerDayUsdByChain':
        next.maxPerDayUsdByChain = usdMap(body.maxPerDayUsdByChain, known, ROUTER_HARD_CAPS.maxPerDayUsd, true);
        break;
      case 'allowedChains':
        next.allowedChains = chainsOf(body.allowedChains, known, true);
        break;
      case 'allowedBridges':
        next.allowedBridges = bridgesOf(body.allowedBridges, true);
        break;
      case 'minNetGainTok':
        next.minNetGainTok = gainMap(body.minNetGainTok, current.minNetGainTok, true);
        break;
      case 'minNetGainPct':
        next.minNetGainPct = strictNum(body.minNetGainPct, 'minNetGainPct', 0, ROUTER_HARD_CAPS.minNetGainPct);
        break;
      case 'maxSlippageBps':
        next.maxSlippageBps = strictNum(body.maxSlippageBps, 'maxSlippageBps', 1, ROUTER_HARD_CAPS.maxSlippageBps, true);
        break;
      case 'maxEtaMin':
        next.maxEtaMin = strictNum(body.maxEtaMin, 'maxEtaMin', 1, ROUTER_HARD_CAPS.maxEtaMin, true);
        break;
      case 'cooldownMin':
        next.cooldownMin = strictNum(body.cooldownMin, 'cooldownMin', 0, ROUTER_HARD_CAPS.cooldownMin, true);
        break;
      case 'maxMovesPerDay':
        next.maxMovesPerDay = strictNum(body.maxMovesPerDay, 'maxMovesPerDay', 0, ROUTER_HARD_CAPS.maxMovesPerDay, true);
        break;
      case 'minConfidence':
        next.minConfidence = strictNum(body.minConfidence, 'minConfidence', 0, ROUTER_HARD_CAPS.minConfidence);
        break;
      case 'gasCaps':
        if (!isObj(body.gasCaps)) throw new Error('gasCaps must be an object of chain id → tx kind → gas units.');
        for (const [k, v] of entries(body.gasCaps)) {
          const id = chainKey(Number(k), known);
          if (!id) throw new Error(`Unknown chain ${k}.`);
          if (v == null) { delete next.gasCaps[id]; continue; }
          next.gasCaps[id] = { ...next.gasCaps[id], ...kindsOf(v, true) };
        }
        break;
      case 'autoClaim':
        if (typeof body.autoClaim !== 'boolean') throw new Error('autoClaim must be true or false.');
        next.autoClaim = body.autoClaim;
        break;
      default:
        break;
    }
  }
  return finish(next, chainIds);
}

/** A saved `on: true` that live rules or a friend's copy cannot keep. */
export function guardOn(s: RouterSettings, host: boolean): RouterSettings {
  if (s.on && (!host || liveEnableError(s))) return { ...s, on: false };
  return s;
}
