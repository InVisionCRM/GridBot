/**
 * The figures under a chart. A dash is a figure the stored bot does not have.
 *
 * Display rules (Kyle): crypto units only (no dollars), each figure once per screen, and the headline is what was
 * Invested plus what the bot Generated, net of costs (generated.ts). No price-move figures.
 * - Generated shows once, in tokens, with its share of what was put in; under a day with the run length ("over 8.8h").
 * - Estimates (24h, 7d, 365d) are Generated per token ÷ days run (src/shared/generated.ts estimates), from a day on.
 * - Invested shows only when it differs from Value now.
 * - `inRow`: the table sits under a Bots-list row. Figures that row already shows in its columns (invested, generated %,
 *   age, moves, fees) get the `in-row` class: hidden on desktop, where the columns show, and shown on a phone, where they
 *   don't (styles.css). The row's Generated amount shows on both, so here only its share.
 * - `omit`: rows a page already shows elsewhere (the bot pages' cards).
 * Display only: botFacts and every value behind it are unchanged.
 */
import type { ReactNode } from 'react';
import { chainOf, mk } from './chains';
import { botFacts } from './deskStats';
import { ago, dur, pct, px, qty } from './fmt';
import { formatTokens, generatedOf, generatedPct, investedOf, quoteSymbolOf } from './generatedView';
import { quoteSym, type AnyObj } from './model';
import { isShortRun, runSpan } from './runRate';
import { estimates } from '../shared/generated';

export type StatKey = 'age' | 'net' | 'netPct' | 'netSpan' | 'feesPaid' | 'feesEarned' | 'moves' | 'range' | 'spacing' | 'value' | 'invested' | 'lastMove' | 'winRate' | 'est';

/**
 * An amount the bot's facts hold in dollars, shown in the bot's coin only (crypto units, no dollars on these screens):
 * the dollar figure divided back by the same dollars-per-coin it was made with (botFacts). No coin price: "—".
 */
export function coinFirst(b: AnyObj): (v: number | null | undefined, sign?: boolean) => ReactNode {
  const k = typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : null;
  const sym = String(quoteSym(b) ?? '');
  return (v, sign = false) => {
    if (v == null || !Number.isFinite(v) || k == null || !sym) return '—';
    return qty(v / k, sym, 5, sign);
  };
}

/** Same figure as shown (to the cent): a repeat. */
export function sameFigure(a: number | null | undefined, b: number | null | undefined): boolean {
  return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005 + 1e-9 * Math.abs(b);
}

function poolText(pool: string | null) {
  if (!pool) return '—';
  return pool.startsWith('0x') && pool.length > 12 ? `${pool.slice(0, 6)}…${pool.slice(-4)}` : pool;
}

interface Row { k: string; v: ReactNode; cls?: string }

export function StatTable({ b, s, inRow = false, omit = [] }: { b: AnyObj; s: AnyObj; inRow?: boolean; omit?: StatKey[] }) {
  const key = (b.stable || b.market || b.quote) as string | undefined;
  const market = key ? mk(s, key) : null;
  const chain = chainOf(s, b.chainId ?? s.legacyChainId)?.short ?? (typeof b.chainShort === 'string' ? b.chainShort : null);
  const f = botFacts(b, Date.now(), {
    chain,
    dex: (typeof b.dexName === 'string' ? b.dexName : null) ?? market?.dexName ?? null,
    pool: (typeof b.pool === 'string' ? b.pool : null) ?? market?.pool ?? null,
  });
  const skip = new Set<StatKey>(omit);
  const amt = coinFirst(b);
  const gen = generatedOf(b);
  const inv = investedOf(b);
  const gp = generatedPct(b);
  const short = isShortRun(f.ageMs);
  const row = inRow ? 'in-row' : undefined; // also in the Bots-list row's columns
  const baseSym = typeof b.base === 'string' ? b.base : null;
  const range = f.range ? `${px(f.range.lower)} – ${px(f.range.upper)}${baseSym ? ` ${quoteSymbolOf(b)} per ${baseSym}` : ''}` : '—';
  const spacing = f.spacingFrac != null ? `${(f.spacingFrac * 100).toFixed(3)}%` : f.bandPct != null ? `±${(f.bandPct * 100).toFixed(2)}%` : '—';
  // the Bots-list row shows Generated in tokens on desktop and phone: here only its share and, under a day, the run length
  const showNet = !skip.has('net') && (gen != null || gp != null);
  // the Bots-list row has Generated and its share in its columns: not again in the table under it
  if (inRow) skip.add('net');
  // Value now within 0.1% of what was put in reads as the same figure twice: say so in words instead
  const k = typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0 ? b.usdPerQuote : null;
  const valueQuote = f.valueUsd != null && k != null ? f.valueUsd / k : null;
  const valueSame = inv != null && valueQuote != null && inv.amount > 0 && Math.abs(valueQuote - inv.amount) / inv.amount < 0.001;
  // under a day the Generated row carries the run length ("over 8.8h"), so no separate Age row
  if (short && showNet && !skip.has('netSpan') && f.ageMs != null && f.ageMs > 0) skip.add('age');
  const span = short && !skip.has('netSpan') ? ` ${runSpan(f.ageMs)}` : '';
  const share = skip.has('netPct') || gp == null ? '' : `${pct(gp, 2, true)} of what was put in`;
  const netText = inRow
    ? `${share || '—'}${span}`
    : [formatTokens(gen?.tokens, true), share].filter(Boolean).join(' · ') + span;
  // shared estimates: Generated per token ÷ age in days × 1, 7, 365; none under a day
  const est = estimates(gen?.tokens ?? [], f.ageMs == null ? null : f.ageMs / 1000);
  const pace = est.h24 ? { d1: est.h24, d7: est.d7, d365: est.d365 } : null;
  const rows: (Row & { id?: StatKey })[] = [
    { id: 'age', k: 'Age', v: f.ageMs == null ? '—' : dur(f.ageMs), cls: row },
    { id: 'invested', k: 'Invested', v: inv ? formatTokens([inv], false) : '—', cls: row },
    { id: 'value', k: 'Value now', v: valueSame ? 'about what was put in' : amt(f.valueUsd) },
    ...(showNet ? [{ id: 'net' as StatKey, k: short ? 'Generated so far, net of costs' : 'Generated, net of costs', v: netText }] : []),
    // Under a day: none (runRate.ts). From a day: Generated per token ÷ days run × 1, 7, 365.
    ...(short || skip.has('est') ? [] : [
      { k: 'Est. 24h (estimate)', v: formatTokens(pace?.d1, true, 4) },
      { k: 'Est. 7d (estimate)', v: formatTokens(pace?.d7, true, 4) },
      { k: 'Est. 365d (estimate)', v: formatTokens(pace?.d365, true, 4) },
    ]),
    { id: 'moves', k: 'Moves', v: f.moves.text ?? '—', cls: row },
    // rows with nothing to say are left out (an LP has no win rate; no bot sends a time-in-range fraction yet)
    ...(f.winRate == null ? [] : [{ id: 'winRate' as StatKey, k: 'Win rate', v: pct(f.winRate, 0) }]),
    { id: 'feesPaid', k: 'Fees paid', v: amt(f.feesPaidUsd) },
    { id: 'feesEarned', k: 'Fees earned', v: amt(f.feesEarnedUsd), cls: row },
    ...(f.timeInRange == null ? [] : [{ k: 'Time in range', v: pct(f.timeInRange, 0) }]),
    { id: 'range', k: 'Range', v: range },
    { id: 'spacing', k: 'Spacing', v: spacing },
    { id: 'lastMove', k: 'Last move', v: f.lastMoveAt == null ? '—' : ago(f.lastMoveAt) },
    { k: 'Chain', v: f.chain || '—' },
    { k: 'DEX', v: f.dex || '—' },
    { k: 'Pool', v: poolText(f.pool) },
  ];
  return (
    <div className="stat-table">
      {/* the note explains the Est. rows: none when they're left out (the LP page's pace card has them) */}
      {!skip.has('est') && <p className="stat-note">{short
        ? 'Estimates (24h, 7d, 365d) show once the bot has run a day. Until then: what it generated over the run.'
        : 'Estimates: what it generated so far, per token, carried over 24h, 7d and 365d at the same pace. Not a forecast.'}</p>}
      <table>
        <tbody>
          {rows.filter((r) => !r.id || !skip.has(r.id)).map((r) => (
            <tr key={r.k} className={r.cls}><th>{r.k}</th><td className="mono">{r.v}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
