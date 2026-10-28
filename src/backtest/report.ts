/**
 * The summary a strategy change is judged on.
 *
 * The lead is one number: net units per day in the bot's quote coin, after every fee coin has been converted
 * at the price when it was collected, and after gas, taxes and realized rebalancing losses. USD/day is a smaller
 * line under that. There is no dollar-per-month and no percent-per-month figure. One window only: the last 30
 * days, unless a footnote says the run used another window or an in-sample one. A replayed number is a fitted
 * model. A live bot's recorded totals are on-chain. A paper bot's recorded fills are simulated, never on-chain.
 */
/** Same three names the opportunities export uses. */
export type FigureSource = 'modeled' | 'onchain' | 'paper-fills';

/** Words printed next to a number. `modeled` is the fitted replay. */
export function sourceLabel(source: FigureSource): string {
  if (source === 'onchain') return 'on-chain actual';
  if (source === 'paper-fills') return 'paper (simulated fills)';
  return 'fitted model';
}

/** Where a saved bot's own totals came from. Live totals are on-chain. Paper fills are not. */
export function recordedSource(mode: 'paper' | 'live'): FigureSource {
  return mode === 'live' ? 'onchain' : 'paper-fills';
}

/** The fitted-model marker every JSON export carries, on the run and on each replayed row. */
export interface FittedModel {
  fitted: boolean;
  calibrationError: number | null;
  calibrated: boolean;
  source: 'modeled';
  label: 'fitted model';
}

export function fittedModel(fitted: boolean, calibrationError: number | null, calibrated: boolean): FittedModel {
  return { fitted, calibrationError, calibrated, source: 'modeled', label: 'fitted model' };
}

/** Worst net-units error in the run. `calibrated` is true only when every fitted live bot cleared the bar. */
export function aggregateModel(rows: { mode: 'paper' | 'live'; model: FittedModel }[]): FittedModel {
  const errors = rows.map((r) => r.model.calibrationError).filter((n): n is number => n != null);
  const liveFitted = rows.filter((r) => r.mode === 'live' && r.model.fitted);
  return fittedModel(
    rows.some((r) => r.model.fitted),
    errors.length ? Math.max(...errors) : null,
    liveFitted.length > 0 && liveFitted.every((r) => r.model.calibrated),
  );
}

export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_WINDOW_SEC = DEFAULT_WINDOW_DAYS * 86_400;

export interface TokenRate { symbol: string; perDay: number; source: FigureSource }
export interface NamedNumber { label: string; value: number; unit?: string; source: FigureSource }

/** One simulated fill. Used to compare a replay with the fills saved in the app state. Not a headline. */
export interface SimFill {
  t: number;
  side: 'buy' | 'sell';
  /** Quote per base, after the pool fee and the fill model */
  price: number;
  baseAmount: number;
  quoteAmount: number;
  feeQuote: number;
}

export interface BotSummary {
  /** Heading. Kept free of digits so it is not a measured number. */
  title: string;
  kind: 'lp' | 'grid' | 'trend' | 'token';
  /** One rate: net quote units per day. Fee coins were converted at the price when they were earned. */
  rates: TokenRate[];
  usdPerDay: number;
  usdSource: FigureSource;
  moves: number;
  /** "Moves" for a liquidity bot, "Fills" for a grid, trend or token trader */
  movesWord: 'Moves' | 'Fills';
  /** Share of the window, 0–1 */
  timeInRange: number;
  /** Liquidity and grids have a price range. Trend and token bots report time in a position. */
  timeWord: 'Time in range' | 'Time in a position';
  feeApr: number;
  priceChange: { symbol: string; pct: number }[];
  /** Model inputs worth stating (k, LP share). Each rendered line is labeled. */
  modelNotes: NamedNumber[];
  /** Readings taken from a node, not from the simulator. */
  onChain: NamedNumber[];
  /** Fills the replay produced. Omitted from the markdown; the calibration compares them with the saved fills. */
  simFills: SimFill[];
}

export interface RunWindow { from: number; to: number; inSample?: boolean }

const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

export function fmt(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const a = Math.abs(n);
  if (a >= 1e8 || a < 1e-8) return a.toExponential(3);
  const digits = a >= 100 ? 2 : a >= 1 ? 4 : 8;
  return a.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}
export function signed(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '+0';
  return (n < 0 ? '-' : '+') + fmt(n);
}
const pct = (n: number) => `${signed(n * 100)}%`;

/** Lines that carry a digit but no source label. The summary must return none. */
export function unlabeledNumberLines(md: string): string[] {
  return md.split('\n').filter((line) => /\d/.test(line) && !/fitted model|on-chain actual|paper \(simulated fills\)/.test(line));
}

function rateLine(r: TokenRate, lead: boolean): string {
  const text = `${signed(r.perDay)} ${r.symbol}/day (${sourceLabel(r.source)})`;
  return lead ? `**${text}**` : text;
}

export function windowDays(w: RunWindow): number {
  return (w.to - w.from) / 86_400;
}

/** Footnote when the run is not the default last 30 days, or the window was used to fit the model. */
export function windowFootnote(w: RunWindow): string | null {
  const days = windowDays(w);
  const parts: string[] = [];
  if (Math.abs(days - DEFAULT_WINDOW_DAYS) > 0.05) {
    parts.push(`This window is ${fmt(days)} days (${iso(w.from)} to ${iso(w.to)}), not the default last 30 days.`);
  }
  if (w.inSample) parts.push('This window was used to fit the model, so these figures are in sample.');
  if (!parts.length) return null;
  return `${parts.join(' ')} (fitted model)`;
}

/** Markdown for one or more bots that shared a window. Token rates lead. USD/day follows, unlabeled as a headline. */
export function renderMarkdown(bots: BotSummary[], w: RunWindow): string {
  const blocks = bots.map((b) => {
    const lines: string[] = [
      `# ${b.title}`,
      '',
      ...b.rates.map((r) => rateLine(r, true)),
      '',
      `also ${signed(b.usdPerDay)} USD/day (${sourceLabel(b.usdSource)})`,
      '',
    ];
    if (Math.abs(windowDays(w) - DEFAULT_WINDOW_DAYS) <= 0.05) lines.push(`Last 30 days (fitted model). After swap fees, gas, token taxes, and realized rebalancing losses.`);
    else lines.push('After swap fees, gas, token taxes, and realized rebalancing losses.');
    lines.push('');
    lines.push(`${b.movesWord}: ${fmt(b.moves)} (fitted model). ${b.timeWord}: ${pct(b.timeInRange)} (fitted model). Fee APR: ${pct(b.feeApr)} (fitted model).`);
    lines.push('');
    const px = b.priceChange.map((p) => `${p.symbol} ${pct(p.pct)} (fitted model)`).join(', ');
    lines.push(`Price change on coins held: ${px}.`);
    if (b.onChain.length || b.modelNotes.length) {
      lines.push('');
      for (const n of b.onChain) lines.push(`${n.label}: ${fmt(n.value)}${n.unit ? ' ' + n.unit : ''} (${sourceLabel(n.source)}).`);
      for (const n of b.modelNotes) lines.push(`${n.label}: ${fmt(n.value)}${n.unit ? ' ' + n.unit : ''} (${sourceLabel(n.source)}).`);
    }
    return lines.join('\n');
  });
  const note = windowFootnote(w);
  return blocks.join('\n\n') + (note ? `\n\nNote: ${note}` : '') + '\n';
}

const tagged = (source: FigureSource) => ({ source, label: sourceLabel(source) });

export function summaryJson(bots: BotSummary[], w: RunWindow, model: FittedModel = fittedModel(!!w.inSample, null, false)) {
  return {
    model,
    window: { from: iso(w.from), to: iso(w.to), days: windowDays(w), defaultLast30Days: Math.abs(windowDays(w) - DEFAULT_WINDOW_DAYS) <= 0.05, inSample: !!w.inSample },
    bots: bots.map((b) => ({
      title: b.title,
      kind: b.kind,
      generationPerDay: {
        ...Object.fromEntries(b.rates.map((r) => [r.symbol, { value: r.perDay, unit: `${r.symbol}/day`, ...tagged(r.source) }])),
        usd: { value: b.usdPerDay, unit: 'USD/day', ...tagged(b.usdSource), role: 'secondary' },
      },
      moves: { value: b.moves, ...tagged('modeled') },
      timeInRange: { value: b.timeInRange, ...tagged('modeled') },
      feeApr: { value: b.feeApr, ...tagged('modeled') },
      priceChange: b.priceChange.map((p) => ({ symbol: p.symbol, value: p.pct, ...tagged('modeled') })),
      onChain: b.onChain.map((n) => ({ label: n.label, value: n.value, ...(n.unit ? { unit: n.unit } : {}), ...tagged(n.source) })),
      modelNotes: b.modelNotes.map((n) => ({ ...n, ...tagged(n.source) })),
    })),
  };
}
