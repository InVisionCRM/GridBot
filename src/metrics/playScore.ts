/**
 * Grade of one short-term play. Candidate rows already carry `chain_id`, `pool_address`,
 * `token_contract`, `feeTier` (a Uniswap tier number, or `{ fee, feePct, dynamic, readAt, source }`),
 * `priceAtFlag`, `xMentions`, `xUniqueAuthors` and `xUniqueAuthorsBasis`. Those names are the
 * record's names, so `playFromCandidate` copies them straight across.
 *
 * `scorePlay` reports net units of the coin spent, after the entry swap fee, the exit swap fee,
 * price impact, gas and the sell tax. A fill's `quote_out` already has the swap fee, impact and
 * tax in it, so those are not subtracted again; gas is, because gas is paid in the native coin.
 * With no fill, the same costs are applied to the entry and exit prices. Entry and exit fees are
 * read separately: a dynamic pool does not keep the entry fee.
 *
 * An assumed figure (a default gas unit count, an exit fee that was not read again) is named on
 * the score and is not averaged with receipt-backed rows. A horizon stays null until a real print
 * is recorded. Nothing here is wired into BotMetrics; `PlayRecord[]` is the shape a later
 * `BotMetrics.plays` can hold.
 */
export const ROBINHOOD_CHAIN_ID = 4663;

export const PLAY_HORIZONS = ['+1h', '+4h', '+24h', '+72h'] as const;
export type PlayHorizon = (typeof PLAY_HORIZONS)[number];

/**
 * `fee` is the Uniswap fee tier (100 = 0.01%, the same unit as `fmtFeeTier`).
 * `feePct` is the fraction of the swap that fraction removes (tier 100 → 0.0001). Scoring uses `feePct`.
 * A bare number is that tier, and the fraction is `tier / 1_000_000`.
 */
export interface FeeTierDetail {
  fee: number;
  feePct: number;
  dynamic: boolean;
  readAt: number | null;
  source: string;
}
export type FeeTier = number | FeeTierDetail;

/** A real print. `net` is not stored here; `scorePlay` computes it, and leaves it pending when the fee or impact was not read. */
export interface HorizonMark {
  at: number;
  price: number;
  feeTier: FeeTier | null;
  impact: number | null;
}

export interface PlayRecord {
  play_id: string;
  kind: 'play' | 'launchpad';
  signal_type: string;
  source: string;
  passed: boolean;
  rejected: boolean;
  reason: string | null;

  chain_id: number;
  pool_address: string;
  token_contract: string;
  /** Price when the row was flagged. Scoring uses `entry_price`, not this. */
  priceAtFlag: number | null;

  entry_at: number | null;
  exit_at: number | null;
  /** Spend coin per token, the pool price at the fill, before this swap's fee and impact. */
  entry_price: number | null;
  exit_price: number | null;

  feeTierEntry: FeeTier | null;
  feeTierExit: FeeTier | null;

  /** Fraction. 0.001 = 0.1% worse than the pool price. */
  price_impact_entry: number | null;
  price_impact_exit: number | null;

  tx_entry: string | null;
  tx_exit: string | null;

  /** Swap gas units from receipts. Null when the two legs were not both on a receipt, or their prices differed (see `gas_native`). */
  gas_used: number | null;
  /** Wei per gas, when one price covers every unit in `gas_used`. */
  gas_price: number | null;
  /** True only when the units or the price were not on a receipt. */
  gas_assumed: boolean;
  gas_note: string | null;
  /** Native coin (ETH on Robinhood) paid in gas, summed from receipts. */
  gas_native: number | null;
  /** Spend-coin units for 1 native coin, from a real price. Null → gas is left out of the net, not taken as zero. */
  native_to_spend: number | null;

  /** Size in the coin spent. */
  size_spend: number;
  spend_symbol: string | null;
  /** Dollars per spend-coin unit. Null → `netUsd` stays null. */
  usd_per_spend: number | null;

  target_pct: number | null;
  stop_pct: number | null;
  /** Fraction taken on the sell. 0 is a real read; null means it was not read. */
  sell_tax: number | null;

  xMentions: number | null;
  /** Count of distinct authors. A number, or null when there is no count yet. */
  xUniqueAuthors: number | null;
  xUniqueAuthorsBasis: string | null;

  horizons: Record<PlayHorizon, HorizonMark | null>;

  /**
   * Spend-coin proceeds of the exit fill. Fee, impact and tax are already in this number.
   * Null until the position is flat (partial sells stay pending).
   */
  quote_out: number | null;
  /** Recorder notes. A fee or gas note here is an assumption only when the score actually uses that figure. */
  assumptions: string[];

  /** Bookkeeping for a ladder of sells. `scorePlay` does not read these. */
  sold_tokens?: number;
  exit_notional?: number;
  impact_notional?: number;
  impact_gap?: boolean;
  fee_reread?: boolean;
  entry_gas_native?: number | null;
  entry_gas_used?: number | null;
  entry_gas_price?: number | null;
  exit_gas_native?: number;
  exit_gas_used?: number;
  exit_gas_price?: number | null;
  exit_gas_mixed?: boolean;
  exit_gas_gap?: boolean;
}

/** Future slot. Not imported by BotMetrics until that branch lands. */
export type BotMetricsPlays = PlayRecord[];

export interface CandidateRow {
  chain_id?: number;
  chainId?: number;
  pool_address?: string;
  pool?: string;
  token_contract?: string;
  token?: string;
  feeTier?: FeeTier | null;
  priceAtFlag?: number | null;
  xMentions?: number | null;
  xUniqueAuthors?: number | null;
  xUniqueAuthorsBasis?: string | null;
  play_id?: string;
  kind?: 'play' | 'launchpad';
  signal_type?: string;
  source?: string;
  passed?: boolean;
  rejected?: boolean;
  reason?: string | null;
}

export function emptyHorizons(): Record<PlayHorizon, null> {
  return { '+1h': null, '+4h': null, '+24h': null, '+72h': null };
}

/** `bps` is this app's pool fee (Uniswap tier 100 → 1 bps). `source` starting with `assumed` is not a read. */
export function feeTierFromBps(bps: number, readAt: number | null, source: string, dynamic = false): FeeTierDetail {
  return { fee: Math.round(bps * 100), feePct: bps / 10_000, dynamic, readAt, source };
}

export function blankPlay(p: Pick<PlayRecord, 'play_id' | 'kind' | 'signal_type' | 'source' | 'passed' | 'rejected' | 'chain_id' | 'pool_address' | 'token_contract'> & Partial<PlayRecord>): PlayRecord {
  return {
    reason: null,
    priceAtFlag: null,
    entry_at: null, exit_at: null, entry_price: null, exit_price: null,
    feeTierEntry: null, feeTierExit: null,
    price_impact_entry: null, price_impact_exit: null,
    tx_entry: null, tx_exit: null,
    gas_used: null, gas_price: null, gas_assumed: false, gas_note: null, gas_native: null, native_to_spend: null,
    size_spend: 0, spend_symbol: null, usd_per_spend: null,
    target_pct: null, stop_pct: null, sell_tax: null,
    xMentions: null, xUniqueAuthors: null, xUniqueAuthorsBasis: null,
    quote_out: null,
    ...p,
    horizons: p.horizons ?? emptyHorizons(),
    assumptions: p.assumptions ? [...p.assumptions] : [],
  };
}

function copyFee(tier: FeeTier | null | undefined): FeeTier | null {
  if (tier == null) return null;
  if (typeof tier === 'number') return Number.isFinite(tier) ? tier : null;
  if (typeof tier.fee !== 'number' || typeof tier.feePct !== 'number') return null;
  return { fee: tier.fee, feePct: tier.feePct, dynamic: tier.dynamic === true, readAt: typeof tier.readAt === 'number' ? tier.readAt : null, source: typeof tier.source === 'string' ? tier.source : '' };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Copy a candidate row onto a play. Unknown sentiment stays null. The fee tier is kept as given. */
export function playFromCandidate(row: CandidateRow, id?: string): PlayRecord {
  const chain = row.chain_id ?? row.chainId;
  if (chain == null || !Number.isFinite(chain)) throw new Error('candidate row needs chain_id');
  const pool = row.pool_address ?? row.pool;
  if (!pool) throw new Error('candidate row needs pool_address');
  const token = row.token_contract ?? row.token;
  if (!token) throw new Error('candidate row needs token_contract');
  const passed = row.passed === true;
  const rejected = row.rejected ?? !passed;
  return blankPlay({
    play_id: row.play_id ?? id ?? `cand-${chain}-${pool.slice(2, 10)}`,
    kind: row.kind === 'launchpad' ? 'launchpad' : 'play',
    signal_type: row.signal_type ?? 'unknown',
    source: row.source ?? 'candidate',
    passed: passed && !rejected,
    rejected: rejected || !passed,
    reason: row.reason ?? null,
    chain_id: chain,
    pool_address: pool,
    token_contract: token,
    priceAtFlag: numOrNull(row.priceAtFlag),
    feeTierEntry: copyFee(row.feeTier),
    xMentions: numOrNull(row.xMentions),
    xUniqueAuthors: numOrNull(row.xUniqueAuthors),
    xUniqueAuthorsBasis: typeof row.xUniqueAuthorsBasis === 'string' ? row.xUniqueAuthorsBasis : null,
  });
}

/** Record a real horizon print. A price that is not a positive finite number is refused, and the slot stays as it was. */
export function setHorizon(p: PlayRecord, h: PlayHorizon, mark: HorizonMark | null): PlayRecord {
  if (mark == null) return { ...p, horizons: { ...p.horizons, [h]: null } };
  if (!(mark.price > 0) || !Number.isFinite(mark.at)) return p;
  return { ...p, horizons: { ...p.horizons, [h]: { at: mark.at, price: mark.price, feeTier: copyFee(mark.feeTier), impact: numOrNull(mark.impact) } } };
}

export interface FeeRead { frac: number | null; assumed: boolean }

/** Fraction of notional the fee removes. A tier number uses `tier / 1_000_000`. `source` starting with `assumed` is flagged. */
export function feeFraction(tier: FeeTier | null): FeeRead {
  if (tier == null) return { frac: null, assumed: false };
  if (typeof tier === 'number') {
    if (!Number.isFinite(tier) || tier < 0) return { frac: null, assumed: false };
    return { frac: tier / 1_000_000, assumed: false };
  }
  const assumed = typeof tier.source === 'string' && tier.source.startsWith('assumed');
  if (typeof tier.feePct === 'number' && Number.isFinite(tier.feePct) && tier.feePct >= 0) return { frac: tier.feePct, assumed };
  if (typeof tier.fee === 'number' && Number.isFinite(tier.fee) && tier.fee >= 0) return { frac: tier.fee / 1_000_000, assumed };
  return { frac: null, assumed };
}

export interface AssumeGas {
  units: number;
  priceWei: number;
  nativeToSpend: number;
  note?: string;
}

export interface PlayScore {
  play_id: string;
  /** `fill` uses measured proceeds. `model` applies fee, impact and tax to the prices. Null when there is no grade. */
  basis: 'fill' | 'model' | null;
  /** Units of the coin spent. Null while the play is open, rejected, or missing a read it would have to invent. */
  netTokens: number | null;
  /** `netTokens × usd_per_spend`. Null when either is missing. */
  netUsd: number | null;
  measured: boolean;
  assumed: boolean;
  assumptions: string[];
  tokensBought: number | null;
  quoteOut: number | null;
  /** Spend-coin units each cost removed. Null when that cost was not applied (already inside a fill, or not read). */
  costs: { feeEntry: number | null; feeExit: number | null; impactEntry: number | null; impactExit: number | null; tax: number | null; gas: number | null };
  horizons: Record<PlayHorizon, { at: number; price: number; netTokens: number | null } | null>;
}

interface GasSpend { spend: number | null; assumed: boolean; note: string | null }

function gasOf(p: PlayRecord, assume?: AssumeGas): GasSpend {
  if (p.gas_assumed) {
    const native = p.gas_native ?? (p.gas_used != null && p.gas_price != null ? (p.gas_used * p.gas_price) / 1e18 : null);
    if (native == null || p.native_to_spend == null) return { spend: null, assumed: true, note: p.gas_note ?? 'assumed gas could not be converted into the coin spent' };
    return { spend: native * p.native_to_spend, assumed: true, note: p.gas_note ?? 'gas is assumed' };
  }
  const native = p.gas_native != null ? p.gas_native : (p.gas_used != null && p.gas_price != null ? (p.gas_used * p.gas_price) / 1e18 : null);
  if (native === 0) return { spend: 0, assumed: false, note: null };
  if (native != null && p.native_to_spend != null) return { spend: native * p.native_to_spend, assumed: false, note: null };
  if (assume && assume.units >= 0 && assume.priceWei >= 0 && assume.nativeToSpend > 0) {
    const n = (assume.units * assume.priceWei) / 1e18;
    return { spend: n * assume.nativeToSpend, assumed: true, note: assume.note ?? `assumed gas: ${assume.units} units` };
  }
  if (native == null) return { spend: null, assumed: false, note: p.gas_note ?? 'no receipt gas' };
  return { spend: null, assumed: false, note: 'gas not converted: no price of the native coin in the coin spent' };
}

function fracOk(x: number | null): x is number {
  return x != null && x >= 0 && x < 1;
}

interface Model {
  tokens: number;
  quote: number;
  costs: PlayScore['costs'];
}

/** Entry fee, then entry impact, then sell tax, then exit fee, then exit impact. Prices are spend per token. */
function modelNet(size: number, entry: number, exit: number, feeIn: number, feeOut: number, impIn: number, impOut: number, tax: number, gas: number): Model {
  const tokens = (size * (1 - feeIn) * (1 - impIn)) / entry;
  const afterTaxNotional = tokens * (1 - tax) * exit;
  const quote = afterTaxNotional * (1 - feeOut) * (1 - impOut);
  const feeEntry = size * feeIn;
  const impactEntry = size * (1 - feeIn) * impIn;
  const taxCost = tokens * tax * exit;
  const feeExit = afterTaxNotional * feeOut;
  const impactExit = afterTaxNotional * (1 - feeOut) * impOut;
  return {
    tokens, quote,
    costs: { feeEntry, feeExit, impactEntry, impactExit, tax: taxCost, gas },
  };
}

function horizonScore(p: PlayRecord, gas: number | null, feeIn: FeeRead, impIn: number | null, tax: number | null): PlayScore['horizons'] {
  const out = {} as PlayScore['horizons'];
  for (const h of PLAY_HORIZONS) {
    const m = p.horizons[h];
    if (m == null) { out[h] = null; continue; }
    const feeOut = feeFraction(m.feeTier);
    let net: number | null = null;
    if (
      p.entry_price != null && p.entry_price > 0 && p.size_spend > 0 && gas != null
      && fracOk(feeIn.frac) && !feeIn.assumed && fracOk(feeOut.frac) && !feeOut.assumed
      && fracOk(impIn) && fracOk(m.impact) && tax != null && fracOk(tax)
    ) {
      net = modelNet(p.size_spend, p.entry_price, m.price, feeIn.frac, feeOut.frac, impIn, m.impact, tax, gas).quote - p.size_spend - gas;
    }
    out[h] = { at: m.at, price: m.price, netTokens: net };
  }
  return out;
}

function finish(p: PlayRecord, partial: Omit<PlayScore, 'netUsd' | 'horizons' | 'play_id'> & { gas: number | null }): PlayScore {
  const netUsd = partial.netTokens != null && p.usd_per_spend != null ? partial.netTokens * p.usd_per_spend : null;
  const { gas, ...rest } = partial;
  return {
    play_id: p.play_id,
    ...rest,
    netUsd,
    horizons: horizonScore(p, gas, feeFraction(p.feeTierEntry), p.price_impact_entry, p.sell_tax),
  };
}

const emptyCosts: PlayScore['costs'] = { feeEntry: null, feeExit: null, impactEntry: null, impactExit: null, tax: null, gas: null };

/**
 * Net units of the coin spent.
 * Pass `assumeGas` only when a caller is deliberately using a default; the leaderboard does not.
 */
export function scorePlay(p: PlayRecord, o?: { assumeGas?: AssumeGas }): PlayScore {
  const pending = (assumptions: string[], assumed = false): PlayScore => finish(p, {
    basis: null, netTokens: null, measured: false, assumed, assumptions, tokensBought: null, quoteOut: null, costs: emptyCosts, gas: null,
  });
  if (p.rejected || !p.passed) return pending(p.reason ? [p.reason] : []);
  if (p.exit_at == null || p.exit_price == null) return pending([]);

  const gas = gasOf(p, o?.assumeGas);
  // Fill proceeds already include fee, impact and tax, so a reused fee on the record is not part of this net.
  const assumptions = p.quote_out != null ? [] : [...p.assumptions];
  if (gas.note && (gas.assumed || gas.spend == null)) assumptions.push(gas.note);

  if (gas.spend == null) return pending([...new Set(assumptions)], gas.assumed);

  if (p.quote_out != null && Number.isFinite(p.quote_out)) {
    const net = p.quote_out - p.size_spend - gas.spend;
    return finish(p, {
      basis: 'fill', netTokens: net, measured: !gas.assumed, assumed: gas.assumed, assumptions: [...new Set(assumptions)],
      tokensBought: null, quoteOut: p.quote_out,
      costs: { feeEntry: null, feeExit: null, impactEntry: null, impactExit: null, tax: null, gas: gas.spend },
      gas: gas.spend,
    });
  }

  const feeIn = feeFraction(p.feeTierEntry);
  const feeOut = feeFraction(p.feeTierExit);
  if (feeIn.assumed) assumptions.push('entry fee tier is marked assumed');
  if (feeOut.assumed) assumptions.push('exit fee tier is marked assumed');
  if (!fracOk(feeIn.frac) || !fracOk(feeOut.frac) || !fracOk(p.price_impact_entry) || !fracOk(p.price_impact_exit) || p.sell_tax == null || !fracOk(p.sell_tax)) {
    if (!fracOk(feeOut.frac) && !feeOut.assumed) assumptions.push('exit fee tier was not read');
    return pending(assumptions, feeIn.assumed || feeOut.assumed || gas.assumed);
  }
  if (p.entry_price == null || !(p.entry_price > 0) || !(p.size_spend > 0)) return pending(assumptions, gas.assumed || feeIn.assumed || feeOut.assumed);

  const m = modelNet(p.size_spend, p.entry_price, p.exit_price, feeIn.frac, feeOut.frac, p.price_impact_entry, p.price_impact_exit, p.sell_tax, gas.spend);
  const assumed = gas.assumed || feeIn.assumed || feeOut.assumed;
  return finish(p, {
    basis: 'model', netTokens: m.quote - p.size_spend - gas.spend, measured: !assumed, assumed, assumptions: [...new Set(assumptions)],
    tokensBought: m.tokens, quoteOut: m.quote, costs: m.costs, gas: gas.spend,
  });
}

export interface BoardStats {
  key: string;
  /** Closed plays graded from measured reads only. */
  sample: number;
  hitRate: number | null;
  /** Mean net units of the coin spent. Measured rows of one basis only. */
  avgNetTokens: number | null;
  /** Largest peak-to-trough of cumulative net, in the coin spent. */
  maxDrawdown: number | null;
  /** Mean milliseconds from entry to the first real print at or above the target. Null if none reached it. */
  timeToTargetMs: number | null;
  /** Graded with an assumed fee or gas figure. Not in `sample` or `avgNetTokens`. */
  assumed: number;
  avgNetTokensAssumed: number | null;
  /** Closed, but a read is missing, so there is no net. */
  partial: number;
  open: number;
  /** Measured on the other basis (fill vs price model). Not mixed into `avgNetTokens`. */
  heldOut: number;
  assumptions: string[];
}

export interface PlayLeaderboard {
  chainId: number;
  plays: { bySignalType: BoardStats[]; bySource: BoardStats[] };
  launchpad: { bySignalType: BoardStats[]; bySource: BoardStats[] };
  rejected: { bySignalType: BoardStats[]; bySource: BoardStats[] };
  /** Rows outside Robinhood Chain. Kept, and absent from the groups above. */
  excluded: PlayRecord[];
}

function drawdown(rows: { at: number; net: number }[]): number | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.at - b.at || a.net - b.net);
  let equity = 0, peak = 0, dd = 0;
  for (const r of sorted) {
    equity += r.net;
    if (equity > peak) peak = equity;
    if (peak - equity > dd) dd = peak - equity;
  }
  return dd;
}

function timeToTarget(p: PlayRecord): number | null {
  if (p.entry_at == null || p.entry_price == null || p.target_pct == null || !(p.target_pct >= 0)) return null;
  const goal = p.entry_price * (1 + p.target_pct);
  let best: number | null = null;
  const consider = (at: number | null, price: number | null) => {
    if (at == null || price == null || !(price >= goal)) return;
    const dt = at - (p.entry_at as number);
    if (dt < 0) return;
    if (best == null || dt < best) best = dt;
  };
  consider(p.exit_at, p.exit_price);
  for (const h of PLAY_HORIZONS) {
    const m = p.horizons[h];
    if (m) consider(m.at, m.price);
  }
  return best;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

interface Graded { row: PlayRecord; score: PlayScore }

function board(rows: Graded[], keyOf: (r: PlayRecord) => string, mode: 'grade' | 'rejected'): BoardStats[] {
  const keys = [...new Set(rows.map((g) => keyOf(g.row)))].sort((a, b) => a.localeCompare(b));
  return keys.map((key) => {
    const group = rows.filter((g) => keyOf(g.row) === key);
    if (mode === 'rejected') {
      return {
        key, sample: group.length, hitRate: null, avgNetTokens: null, maxDrawdown: null, timeToTargetMs: null,
        assumed: 0, avgNetTokensAssumed: null, partial: 0, open: 0, heldOut: 0, assumptions: [],
      };
    }
    const assumedRows = group.filter((g) => g.score.assumed && g.score.netTokens != null);
    const partial = group.filter((g) => g.score.netTokens == null && g.row.exit_at != null).length;
    const open = group.filter((g) => g.row.exit_at == null).length;
    const measured = group.filter((g) => g.score.measured && g.score.netTokens != null);
    const fills = measured.filter((g) => g.score.basis === 'fill');
    const models = measured.filter((g) => g.score.basis === 'model');
    const both = fills.length > 0 && models.length > 0;
    const use = both ? fills : measured;
    const held = both ? models : [];
    const nets = use.map((g) => g.score.netTokens as number);
    const times = group.map((g) => timeToTarget(g.row)).filter((t): t is number => t != null);
    const assumptions = [...new Set([...assumedRows, ...group.filter((g) => g.score.netTokens == null && g.row.exit_at != null)].flatMap((g) => g.score.assumptions))];
    if (held.length) assumptions.push(`${held.length} price-model row${held.length === 1 ? '' : 's'} kept out of avgNetTokens so they are not mixed with fill proceeds`);
    return {
      key,
      sample: use.length,
      hitRate: use.length ? use.filter((g) => (g.score.netTokens as number) > 0).length / use.length : null,
      avgNetTokens: mean(nets),
      maxDrawdown: drawdown(use.map((g) => ({ at: g.row.exit_at as number, net: g.score.netTokens as number }))),
      timeToTargetMs: mean(times),
      assumed: assumedRows.length,
      avgNetTokensAssumed: mean(assumedRows.map((g) => g.score.netTokens as number)),
      partial, open, heldOut: held.length,
      assumptions,
    };
  });
}

function bucket(rows: Graded[]): { bySignalType: BoardStats[]; bySource: BoardStats[] } {
  return { bySignalType: board(rows, (r) => r.signal_type, 'grade'), bySource: board(rows, (r) => r.source, 'grade') };
}

/** Robinhood Chain only. Launchpad, rejected candidates, and assumed gas or fees each stay in their own figures. Other chains are returned on `excluded`. */
export function playLeaderboard(rows: readonly PlayRecord[], o?: { chainId?: number }): PlayLeaderboard {
  const chainId = o?.chainId ?? ROBINHOOD_CHAIN_ID;
  const excluded = rows.filter((r) => r.chain_id !== chainId);
  const inScope = rows.filter((r) => r.chain_id === chainId);
  const graded = inScope.map((row) => ({ row, score: scorePlay(row) }));
  const rejected = graded.filter((g) => g.row.rejected || !g.row.passed);
  const taken = graded.filter((g) => g.row.passed && !g.row.rejected);
  return {
    chainId,
    plays: bucket(taken.filter((g) => g.row.kind === 'play')),
    launchpad: bucket(taken.filter((g) => g.row.kind === 'launchpad')),
    rejected: {
      bySignalType: board(rejected, (r) => r.signal_type, 'rejected'),
      bySource: board(rejected, (r) => r.source, 'rejected'),
    },
    excluded: [...excluded],
  };
}
