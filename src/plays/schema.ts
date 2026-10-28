/**
 * Validators for the Plays JSONL rows. A bad row is a result, never a throw.
 *
 * Vetted rows accept the contract (camelCase) and the Risk Officer's older shape
 * (`candidate_id`, `timestamp`, nested `sizing` / `exits`, `status`, `lp_unlocked`).
 * Both normalize to the contract. Candidates stay on the contract keys.
 * Unknown extra keys are ignored so a later optional field does not quarantine the row.
 */
import {
  EXIT_REASONS, PAPER_TRADE_SCHEMA_VERSION, POOL_KINDS, SCOREKEEPER_FIELDS, SIGNALS,
  type Candidate, type FeeTier, type PaperCosts, type PaperTradeRow, type PoolKind, type ScorekeeperField,
  type Signal, type Vetted, type VettedTaxes,
} from './types';

export interface SchemaIssue { path: string; message: string }
export type SchemaResult<T> = { ok: true; value: T } | { ok: false; errors: SchemaIssue[] };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MS_MIN = 1_000_000_000_000;
const SEC_MIN = 1_000_000_000;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bag() {
  const errors: SchemaIssue[] = [];
  return {
    errors,
    add(path: string, message: string) { errors.push({ path, message }); },
    ok() { return errors.length === 0; },
    fail(path: string, message: string): SchemaResult<never> {
      this.add(path, message);
      return { ok: false, errors };
    },
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** First value when every present alias agrees. Undefined when none are present. */
function pick(sources: Record<string, unknown>[], keys: string[], path: string, errors: ReturnType<typeof bag>): unknown {
  const found: unknown[] = [];
  for (const src of sources) {
    for (const key of keys) if (src[key] !== undefined) found.push(src[key]);
  }
  if (found.length === 0) return undefined;
  if (found.some((v) => !same(v, found[0]))) {
    errors.add(path, 'contract and legacy values disagree');
    return undefined;
  }
  return found[0];
}

function reqString(v: unknown, path: string, errors: ReturnType<typeof bag>): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') {
    errors.add(path, 'expected a non-empty string');
    return undefined;
  }
  return v.trim();
}

function address(v: unknown, path: string, errors: ReturnType<typeof bag>): string | undefined {
  if (typeof v !== 'string' || !ADDRESS.test(v)) {
    errors.add(path, 'expected a 0x address');
    return undefined;
  }
  return v.toLowerCase();
}

function finite(v: unknown, path: string, errors: ReturnType<typeof bag>): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.add(path, 'expected a finite number');
    return undefined;
  }
  return v;
}

/** Contract `t` is epoch milliseconds. Legacy `timestamp` may also be seconds or an ISO string. */
function asMs(v: unknown, legacy: boolean, path: string, errors: ReturnType<typeof bag>): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (Number.isSafeInteger(v) && v >= MS_MIN) return v;
    if (legacy && v >= SEC_MIN && v < MS_MIN) return Math.round(v * 1000);
  } else if (legacy && typeof v === 'string') {
    if (/^\d+$/.test(v)) return asMs(Number(v), true, path, errors);
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed) && parsed >= MS_MIN) return parsed;
  }
  errors.add(path, legacy ? 'expected epoch milliseconds, epoch seconds, or an ISO time' : 'expected epoch milliseconds');
  return undefined;
}

function feeTier(v: unknown, path: string, errors: ReturnType<typeof bag>): FeeTier | undefined {
  if (typeof v === 'string' && v.trim().toLowerCase() === 'dynamic') return 'dynamic';
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 1_000) {
    errors.add(path, `feeTier is basis points (100 = 1%) or "dynamic". ${v} looks like a raw Uniswap fee(); divide by 100 first (10000 → 100). Refusing to assume 0.01%.`);
    return undefined;
  }
  errors.add(path, 'feeTier must be basis points (100 = 1%) or "dynamic"');
  return undefined;
}

function poolKind(v: unknown, path: string, errors: ReturnType<typeof bag>): PoolKind | undefined {
  if (typeof v !== 'string') {
    errors.add(path, 'expected V2, V3 or V4');
    return undefined;
  }
  const up = v.trim().toUpperCase();
  if ((POOL_KINDS as readonly string[]).includes(up)) return up as PoolKind;
  errors.add(path, 'expected V2, V3 or V4');
  return undefined;
}

function signal(v: unknown, path: string, errors: ReturnType<typeof bag>): Signal | undefined {
  if (typeof v === 'string' && (SIGNALS as readonly string[]).includes(v)) return v as Signal;
  errors.add(path, `signal must be one of ${SIGNALS.join(', ')}`);
  return undefined;
}

function fraction(v: unknown, path: string, errors: ReturnType<typeof bag>, label: string): number | undefined {
  const n = finite(v, path, errors);
  if (n == null) return undefined;
  if (n < 0 || n > 1) {
    errors.add(path, `${label} is a fraction from 0 to 1, not a percent`);
    return undefined;
  }
  return n;
}

const PASS_STATUS = new Set(['pass', 'passed', 'approved']);
const FAIL_STATUS = new Set(['fail', 'failed', 'reject', 'rejected', 'veto']);

function passFromStatus(status: string): boolean | undefined {
  const s = status.trim().toLowerCase();
  if (PASS_STATUS.has(s)) return true;
  if (FAIL_STATUS.has(s)) return false;
  return undefined;
}

function nested(v: unknown, path: string, errors: ReturnType<typeof bag>): Record<string, unknown> | null {
  if (v === undefined) return null;
  if (!isObj(v)) {
    errors.add(path, 'expected an object');
    return null;
  }
  return v;
}

function pctList(v: unknown, path: string, errors: ReturnType<typeof bag>): number[] | undefined {
  const items = typeof v === 'number' ? [v] : v;
  if (!Array.isArray(items) || items.some((item) => typeof item !== 'number' || !Number.isFinite(item) || !(item > 0))) {
    errors.add(path, 'expected percent numbers above 0 (1 = 1%, net of fees)');
    return undefined;
  }
  return items;
}

export function parseCandidate(row: unknown): SchemaResult<Candidate> {
  const errors = bag();
  if (!isObj(row)) return errors.fail('', 'expected an object');
  const id = reqString(row.id, 'id', errors);
  const t = asMs(row.t, false, 't', errors);
  const chainId = finite(row.chainId, 'chainId', errors);
  if (chainId != null && (!Number.isInteger(chainId) || chainId <= 0)) errors.add('chainId', 'expected a positive integer');
  const pool = address(row.pool, 'pool', errors);
  const dex = reqString(row.dex, 'dex', errors);
  const token = address(row.token, 'token', errors);
  const quote = address(row.quote, 'quote', errors);
  const sig = signal(row.signal, 'signal', errors);
  const strength = fraction(row.strength, 'strength', errors, 'strength');
  const priceAtFlag = finite(row.priceAtFlag, 'priceAtFlag', errors);
  if (priceAtFlag != null && !(priceAtFlag > 0)) errors.add('priceAtFlag', 'expected a price above 0');
  const priceSource = reqString(row.priceSource, 'priceSource', errors);
  const liqUsd = finite(row.liqUsd, 'liqUsd', errors);
  if (liqUsd != null && liqUsd < 0) errors.add('liqUsd', 'expected 0 or more');
  const vol24hUsd = finite(row.vol24hUsd, 'vol24hUsd', errors);
  if (vol24hUsd != null && vol24hUsd < 0) errors.add('vol24hUsd', 'expected 0 or more');
  const poolAgeH = finite(row.poolAgeH, 'poolAgeH', errors);
  if (poolAgeH != null && poolAgeH < 0) errors.add('poolAgeH', 'expected 0 or more');
  if (typeof row.thesis !== 'string') errors.add('thesis', 'expected a string');
  const tier = feeTier(row.feeTier, 'feeTier', errors);
  const kind = poolKind(row.poolKind, 'poolKind', errors);
  const xMentions = optionalCount(row.xMentions, 'xMentions', errors);
  const xUniqueAuthors = optionalCount(row.xUniqueAuthors, 'xUniqueAuthors', errors);
  const xSentiment = optionalSentiment(row.xSentiment, errors);
  const redFlags = optionalStrings(row.redFlags, 'redFlags', errors) ?? (row.redFlags === undefined ? [] : undefined);
  const launchpad = optionalName(row.launchpad, 'launchpad', errors);
  const curveProgress = optionalUnit(row.curveProgress, 'curveProgress', errors);
  const status = optionalName(row.status, 'status', errors);
  const rejectReason = optionalName(row.rejectReason, 'rejectReason', errors);
  if (!errors.ok() || id == null || t == null || chainId == null || pool == null || dex == null || token == null || quote == null
    || sig == null || strength == null || priceAtFlag == null || priceSource == null || liqUsd == null || vol24hUsd == null
    || poolAgeH == null || typeof row.thesis !== 'string' || tier == null || kind == null || redFlags == null) {
    return { ok: false, errors: errors.errors };
  }
  const value: Candidate = {
    id, t, chainId, pool, dex, token, quote, signal: sig, strength, priceAtFlag, priceSource,
    liqUsd, vol24hUsd, poolAgeH, thesis: row.thesis, feeTier: tier, poolKind: kind, redFlags,
  };
  if (xMentions != null) value.xMentions = xMentions;
  if (xUniqueAuthors != null) value.xUniqueAuthors = xUniqueAuthors;
  if (xSentiment != null) value.xSentiment = xSentiment;
  if (launchpad != null) value.launchpad = launchpad;
  if (curveProgress != null) value.curveProgress = curveProgress;
  if (status != null) value.status = status;
  if (rejectReason != null) value.rejectReason = rejectReason;
  return { ok: true, value };
}

export function parseVetted(row: unknown): SchemaResult<Vetted> {
  const errors = bag();
  if (!isObj(row)) return errors.fail('', 'expected an object');
  const sizing = nested(row.sizing, 'sizing', errors);
  const exits = nested(row.exits, 'exits', errors);
  const sizeSrc = [row, sizing ?? {}];
  const exitSrc = [row, exits ?? {}];
  const candidateId = reqString(pick([row], ['candidateId', 'candidate_id'], 'candidateId', errors), 'candidateId', errors);
  const tRaw = pick([row], ['t', 'timestamp'], 't', errors);
  const t = tRaw === undefined ? undefined : asMs(tRaw, row.timestamp !== undefined && row.t === undefined, 't', errors);
  if (tRaw === undefined) errors.add('t', 'expected epoch milliseconds');
  const pass = readPass(row, errors);
  const reasons = readReasons(row, errors);
  const sizeUsd = readPositive(pick(sizeSrc, ['sizeUsd', 'size_usd'], 'sizeUsd', errors), 'sizeUsd', errors);
  const maxImpactPct = readImpact(pick(sizeSrc, ['maxImpactPct', 'max_impact_pct'], 'maxImpactPct', errors), errors);
  const stopLossPct = readStop(pick(exitSrc, ['stopLossPct', 'stop_loss_pct'], 'stopLossPct', errors), errors);
  const tpRaw = pick(exitSrc, ['tpPct', 'tp_pct'], 'tpPct', errors);
  const tpPct = tpRaw === undefined ? undefined : pctList(tpRaw, 'tpPct', errors);
  if (tpRaw === undefined) errors.add('tpPct', 'expected percent numbers above 0 (1 = 1%, net of fees)');
  const timeStopH = readPositive(pick(exitSrc, ['timeStopH', 'time_stop_h'], 'timeStopH', errors), 'timeStopH', errors);
  const taxes = readTaxes(row, errors);
  const launchpad = optionalName(pick([row], ['launchpad'], 'launchpad', errors), 'launchpad', errors);
  const lpUnlocked = readLpUnlocked(row, errors);
  if (row.netOfFees === false) errors.add('netOfFees', 'stop, take-profit and impact percents are net of fees');
  if (!errors.ok() || candidateId == null || t == null || pass == null || reasons == null || sizeUsd == null
    || maxImpactPct == null || stopLossPct == null || tpPct == null || timeStopH == null || taxes == null) {
    return { ok: false, errors: errors.errors };
  }
  const value: Vetted = { candidateId, t, pass, reasons, sizeUsd, maxImpactPct, stopLossPct, tpPct, timeStopH, taxes };
  if (launchpad != null) value.launchpad = launchpad;
  if (lpUnlocked != null) value.lpUnlocked = lpUnlocked;
  return { ok: true, value };
}

function readPass(row: Record<string, unknown>, errors: ReturnType<typeof bag>): boolean | undefined {
  const hasPass = typeof row.pass === 'boolean';
  const statusRaw = row.status;
  if (statusRaw !== undefined && typeof statusRaw !== 'string') {
    errors.add('status', 'expected a string');
    return undefined;
  }
  const fromStatus = typeof statusRaw === 'string' ? passFromStatus(statusRaw) : undefined;
  if (typeof statusRaw === 'string' && fromStatus === undefined) {
    errors.add('status', 'status must be pass or fail');
    return undefined;
  }
  if (hasPass && fromStatus !== undefined && row.pass !== fromStatus) {
    errors.add('pass', 'pass and status disagree');
    return undefined;
  }
  if (hasPass) return row.pass as boolean;
  if (fromStatus !== undefined) return fromStatus;
  errors.add('pass', 'expected pass, or a legacy status of pass or fail');
  return undefined;
}

function readReasons(row: Record<string, unknown>, errors: ReturnType<typeof bag>): string[] | undefined {
  const raw = row.reasons !== undefined ? row.reasons : row.reason;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) return raw;
  errors.add('reasons', 'expected a list of strings');
  return undefined;
}

function readPositive(v: unknown, path: string, errors: ReturnType<typeof bag>): number | undefined {
  if (v === undefined) {
    errors.add(path, 'expected a number above 0');
    return undefined;
  }
  const n = finite(v, path, errors);
  if (n == null) return undefined;
  if (!(n > 0)) errors.add(path, 'expected a number above 0');
  return n > 0 ? n : undefined;
}

function readImpact(v: unknown, errors: ReturnType<typeof bag>): number | undefined {
  if (v === undefined) {
    errors.add('maxImpactPct', 'expected a percent number, net of fees (1 = 1%)');
    return undefined;
  }
  const n = finite(v, 'maxImpactPct', errors);
  if (n == null) return undefined;
  if (n < 0 || n > 100) {
    errors.add('maxImpactPct', 'expected a percent from 0 to 100, net of fees');
    return undefined;
  }
  return n;
}

function readStop(v: unknown, errors: ReturnType<typeof bag>): number | undefined {
  if (v === undefined) {
    errors.add('stopLossPct', 'expected a percent number above 0, net of fees');
    return undefined;
  }
  const n = finite(v, 'stopLossPct', errors);
  if (n == null) return undefined;
  if (!(n > 0) || n > 100) {
    errors.add('stopLossPct', 'expected a percent from above 0 to 100, net of fees');
    return undefined;
  }
  return n;
}

function readTaxes(row: Record<string, unknown>, errors: ReturnType<typeof bag>): VettedTaxes | undefined {
  if (!isObj(row.taxes)) {
    errors.add('taxes', 'expected buy, sell and transfer fractions from 0 to 1');
    return undefined;
  }
  const buy = fraction(pick([row.taxes], ['buy', 'buy_tax'], 'taxes.buy', errors), 'taxes.buy', errors, 'buy tax');
  const sell = fraction(pick([row.taxes], ['sell', 'sell_tax'], 'taxes.sell', errors), 'taxes.sell', errors, 'sell tax');
  const transfer = fraction(pick([row.taxes], ['transfer', 'transfer_tax'], 'taxes.transfer', errors), 'taxes.transfer', errors, 'transfer tax');
  if (buy == null || sell == null || transfer == null) return undefined;
  return { buy, sell, transfer };
}

function readLpUnlocked(row: Record<string, unknown>, errors: ReturnType<typeof bag>): boolean | undefined {
  const raw = pick([row], ['lpUnlocked', 'lp_unlocked'], 'lpUnlocked', errors);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    errors.add('lpUnlocked', 'expected a boolean');
    return undefined;
  }
  return raw;
}

const SCOREKEEPER_ALIASES: Record<ScorekeeperField, string[]> = {
  playId: ['playId', 'play_id'],
  signalType: ['signalType', 'signal_type'],
  source: ['source'],
  token: ['token'],
  pool: ['pool'],
  entryTs: ['entryTs', 'entry_ts', 'entry_timestamp'],
  exitTs: ['exitTs', 'exit_ts', 'exit_timestamp'],
  feeTierEntry: ['feeTierEntry', 'fee_tier_entry'],
  feeTierExit: ['feeTierExit', 'fee_tier_exit'],
  impactEntry: ['impactEntry', 'impact_entry'],
  impactExit: ['impactExit', 'impact_exit'],
  gasUsed: ['gasUsed', 'gas_used'],
  gasPrice: ['gasPrice', 'gas_price'],
  sizeSpent: ['sizeSpent', 'size_spent'],
  targetPct: ['targetPct', 'target_pct'],
  stopPct: ['stopPct', 'stop_pct'],
  sellTaxTaken: ['sellTaxTaken', 'sell_tax_taken'],
  schemaVersion: ['schemaVersion', 'schema_version'],
};

export function parsePaperTrade(row: unknown): SchemaResult<PaperTradeRow> {
  const errors = bag();
  if (!isObj(row)) return errors.fail('', 'expected an object');
  const id = reqString(row.id, 'id', errors);
  const candidateId = reqString(row.candidateId, 'candidateId', errors);
  const t = asMs(row.t, false, 't', errors);
  const side = row.side === 'buy' || row.side === 'sell' ? row.side : undefined;
  if (side == null) errors.add('side', 'expected buy or sell');
  const price = finite(row.price, 'price', errors);
  if (price != null && !(price > 0)) errors.add('price', 'expected a price above 0');
  const tokens = finite(row.tokens, 'tokens', errors);
  if (tokens != null && !(tokens > 0)) errors.add('tokens', 'expected a token amount above 0');
  const costs = readCosts(row.costs, errors);
  const exitReason = side == null ? undefined : readExitReason(side, row.exitReason, errors);
  const netTokens = finite(row.netTokens, 'netTokens', errors);
  const extra = readScorekeeper(row, errors);
  if (!errors.ok() || id == null || candidateId == null || t == null || side == null || price == null || tokens == null
    || costs == null || exitReason === undefined || netTokens == null || extra == null) {
    return { ok: false, errors: errors.errors };
  }
  return { ok: true, value: { id, candidateId, t, side, price, tokens, costs, exitReason, netTokens, ...extra } };
}

/** A paper-trade row that also carries every Scorekeeper column. */
export function parseScorekeeperTrade(row: unknown): SchemaResult<PaperTradeRow> {
  const parsed = parsePaperTrade(row);
  if (!parsed.ok) return parsed;
  const missing = SCOREKEEPER_FIELDS.filter((field) => parsed.value[field] === undefined);
  if (missing.length) return { ok: false, errors: missing.map((path) => ({ path, message: 'scorekeeper field is missing' })) };
  if (parsed.value.schemaVersion !== PAPER_TRADE_SCHEMA_VERSION) {
    return { ok: false, errors: [{ path: 'schemaVersion', message: `schemaVersion must be ${PAPER_TRADE_SCHEMA_VERSION}` }] };
  }
  const entryTs = parsed.value.entryTs;
  const exitTs = parsed.value.exitTs;
  if (entryTs != null && exitTs != null && exitTs < entryTs) {
    return { ok: false, errors: [{ path: 'exitTs', message: 'exit is before entry' }] };
  }
  return parsed;
}

function readCosts(v: unknown, errors: ReturnType<typeof bag>): PaperCosts | undefined {
  if (!isObj(v)) {
    errors.add('costs', 'expected swapFee, gasNative, tax and impact');
    return undefined;
  }
  const swapFee = finite(v.swapFee, 'costs.swapFee', errors);
  const gasNative = finite(v.gasNative, 'costs.gasNative', errors);
  const tax = finite(v.tax, 'costs.tax', errors);
  const impact = fraction(v.impact, 'costs.impact', errors, 'impact');
  if (swapFee == null || gasNative == null || tax == null || impact == null) return undefined;
  if (swapFee < 0 || gasNative < 0 || tax < 0) {
    errors.add('costs', 'costs cannot be negative');
    return undefined;
  }
  return { swapFee, gasNative, tax, impact };
}

function readExitReason(side: 'buy' | 'sell', v: unknown, errors: ReturnType<typeof bag>): string | null | undefined {
  if (side === 'buy') {
    if (v !== null) errors.add('exitReason', 'exitReason is null on a buy');
    return v === null ? null : undefined;
  }
  if (typeof v !== 'string' || !((EXIT_REASONS as readonly string[]).includes(v) || /^tp_\d+$/.test(v))) {
    errors.add('exitReason', 'exitReason on a sell is stop_loss, tp_<k>, trailing_tp, time_stop, signal_decay, sell_sim_failed, tax_rose, liq_pulled, manual or migration');
    return undefined;
  }
  return v;
}

function readScorekeeper(row: Record<string, unknown>, errors: ReturnType<typeof bag>): Partial<PaperTradeRow> | undefined {
  const out: Partial<PaperTradeRow> = {};
  const present = (field: ScorekeeperField) => pick([row], SCOREKEEPER_ALIASES[field], field, errors);
  const playId = present('playId');
  if (playId !== undefined) {
    const id = reqString(playId, 'playId', errors);
    if (id != null) out.playId = id;
  }
  const signalType = present('signalType');
  if (signalType !== undefined) {
    const sig = signal(signalType, 'signalType', errors);
    if (sig != null) out.signalType = sig;
  }
  const source = present('source');
  if (source !== undefined) {
    const text = reqString(source, 'source', errors);
    if (text != null) out.source = text;
  }
  const token = present('token');
  if (token !== undefined) {
    const addr = address(token, 'token', errors);
    if (addr != null) out.token = addr;
  }
  const pool = present('pool');
  if (pool !== undefined) {
    const addr = address(pool, 'pool', errors);
    if (addr != null) out.pool = addr;
  }
  for (const field of ['entryTs', 'exitTs'] as const) {
    const raw = present(field);
    if (raw !== undefined) {
      const ms = asMs(raw, true, field, errors);
      if (ms != null) out[field] = ms;
    }
  }
  for (const field of ['feeTierEntry', 'feeTierExit'] as const) {
    const raw = present(field);
    if (raw !== undefined) {
      const tier = feeTier(raw, field, errors);
      if (tier != null) out[field] = tier;
    }
  }
  for (const field of ['impactEntry', 'impactExit'] as const) {
    const raw = present(field);
    if (raw !== undefined) {
      const n = fraction(raw, field, errors, 'impact');
      if (n != null) out[field] = n;
    }
  }
  for (const field of ['gasUsed', 'gasPrice'] as const) {
    const raw = present(field);
    if (raw !== undefined) {
      const n = finite(raw, field, errors);
      if (n != null && n < 0) errors.add(field, 'expected 0 or more');
      else if (n != null) out[field] = n;
    }
  }
  const sizeSpent = present('sizeSpent');
  if (sizeSpent !== undefined) {
    const n = readPositive(sizeSpent, 'sizeSpent', errors);
    if (n != null) out.sizeSpent = n;
  }
  for (const field of ['targetPct', 'stopPct'] as const) {
    const raw = present(field);
    if (raw !== undefined) {
      const n = finite(raw, field, errors);
      if (n != null && !(n > 0)) errors.add(field, 'expected a percent above 0, net of fees');
      else if (n != null) out[field] = n;
    }
  }
  const sellTaxTaken = present('sellTaxTaken');
  if (sellTaxTaken !== undefined) {
    const n = fraction(sellTaxTaken, 'sellTaxTaken', errors, 'sell tax taken');
    if (n != null) out.sellTaxTaken = n;
  }
  const schemaVersion = present('schemaVersion');
  if (schemaVersion !== undefined) {
    const n = finite(schemaVersion, 'schemaVersion', errors);
    if (n != null && (!Number.isInteger(n) || n < 1)) errors.add('schemaVersion', 'expected a positive integer');
    else if (n != null) out.schemaVersion = n;
  }
  if (!errors.ok()) return undefined;
  return out;
}

function optionalCount(v: unknown, path: string, errors: ReturnType<typeof bag>): number | undefined {
  if (v === undefined) return undefined;
  const n = finite(v, path, errors);
  if (n == null) return undefined;
  if (!Number.isInteger(n) || n < 0) {
    errors.add(path, 'expected a whole number, 0 or more');
    return undefined;
  }
  return n;
}

function optionalSentiment(v: unknown, errors: ReturnType<typeof bag>): number | undefined {
  if (v === undefined) return undefined;
  const n = finite(v, 'xSentiment', errors);
  if (n == null) return undefined;
  if (n < -1 || n > 1) {
    errors.add('xSentiment', 'expected a number from -1 to 1');
    return undefined;
  }
  return n;
}

function optionalStrings(v: unknown, path: string, errors: ReturnType<typeof bag>): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v) && v.every((item) => typeof item === 'string')) return v;
  errors.add(path, 'expected a list of strings');
  return undefined;
}

function optionalName(v: unknown, path: string, errors: ReturnType<typeof bag>): string | undefined {
  if (v === undefined) return undefined;
  return reqString(v, path, errors);
}

function optionalUnit(v: unknown, path: string, errors: ReturnType<typeof bag>): number | undefined {
  if (v === undefined) return undefined;
  const n = finite(v, path, errors);
  if (n == null) return undefined;
  if (n < 0 || n > 1) {
    errors.add(path, 'expected a fraction from 0 to 1');
    return undefined;
  }
  return n;
}

export function parseJsonlLine<T>(line: string, parse: (row: unknown) => SchemaResult<T>): SchemaResult<T> {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, errors: [{ path: '', message: 'empty line' }] };
  try {
    return parse(JSON.parse(trimmed) as unknown);
  } catch {
    return { ok: false, errors: [{ path: '', message: 'not JSON' }] };
  }
}
