/**
 * The figures under a chart. A dash is a figure the stored bot does not have.
 *
 * Each figure shows once per screen (Kyle's rule):
 * - Net shows once. Realized and Unrealized show only when they differ from it (when one equals the net the other is ~0).
 * - Invested shows only when it differs from Value.
 * - `inRow`: the table sits under a Bots-list row. Figures that row already shows in its columns (value, P&L %, age,
 *   moves, fees, APR) get the `in-row` class: hidden on desktop, where the columns show, and shown on a phone, where they
 *   don't (styles.css). The row's P&L amount (`rowPnlUsd`) shows on both, so the net amount is left out here, and so is
 *   Realized or Unrealized when it is that amount (an LP row's P&L is its net after costs, which is Realized here).
 * - `omit`: rows a page already shows elsewhere (the LP page's cards).
 * Display only: botFacts and every value behind it are unchanged.
 */
import type { ReactNode } from 'react';
import { chainOf, mk } from './chains';
import { botFacts } from './deskStats';
import { ago, dur, pct, px, usd } from './fmt';
import type { AnyObj } from './model';
import { isShortRun, runSpan } from './runRate';

export type StatKey = 'age' | 'net' | 'netPct' | 'netSpan' | 'realized' | 'unrealized' | 'feesPaid' | 'feesEarned' | 'moves' | 'range' | 'spacing' | 'value' | 'invested' | 'lastMove' | 'winRate';

function money(v: number | null, p: number | null) {
  if (v == null && p == null) return '—';
  const d = v == null ? '—' : usd(v, true);
  const r = p == null ? '' : ` · ${pct(p, 2, true)}`;
  return d + r;
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

export function StatTable({ b, s, inRow = false, rowPnlUsd = null, omit = [] }: { b: AnyObj; s: AnyObj; inRow?: boolean; rowPnlUsd?: number | null; omit?: StatKey[] }) {
  const key = (b.stable || b.market || b.quote) as string | undefined;
  const market = key ? mk(s, key) : null;
  const chain = chainOf(s, b.chainId ?? s.legacyChainId)?.short ?? (typeof b.chainShort === 'string' ? b.chainShort : null);
  const f = botFacts(b, Date.now(), {
    chain,
    dex: (typeof b.dexName === 'string' ? b.dexName : null) ?? market?.dexName ?? null,
    pool: (typeof b.pool === 'string' ? b.pool : null) ?? market?.pool ?? null,
  });
  const skip = new Set<StatKey>(omit);
  const short = isShortRun(f.ageMs);
  const row = inRow ? 'in-row' : undefined; // also in the Bots-list row's columns
  const range = f.range ? `${px(f.range.lower)} – ${px(f.range.upper)}` : '—';
  const spacing = f.spacingFrac != null ? `${(f.spacingFrac * 100).toFixed(3)}%` : f.bandPct != null ? `±${(f.bandPct * 100).toFixed(2)}%` : '—';
  const showNet = !skip.has('net') && (f.pnlUsd != null || f.pnlPct != null);
  // one of them equals the net, so the other is ~0: the net row says it all
  if (showNet && (sameFigure(f.realizedUsd, f.pnlUsd) || sameFigure(f.unrealizedUsd, f.pnlUsd))) { skip.add('realized'); skip.add('unrealized'); }
  if (inRow && sameFigure(f.realizedUsd, rowPnlUsd)) skip.add('realized');
  if (inRow && sameFigure(f.unrealizedUsd, rowPnlUsd)) skip.add('unrealized');
  // same as shown ("$2,000" and "$2,000.07" both read $2,000)
  if (f.investedUsd != null && f.valueUsd != null && usd(f.investedUsd) === usd(f.valueUsd)) skip.add('invested');
  // under a day the net row carries the run length ("over 8.8h"), so no separate Age row
  if (short && showNet && !skip.has('netSpan') && f.ageMs != null && f.ageMs > 0) skip.add('age');
  const span = short && !skip.has('netSpan') ? ` ${runSpan(f.ageMs)}` : '';
  const netText = inRow
    ? `${f.pnlPct == null ? '—' : pct(f.pnlPct, 2, true)}${span}` // the amount is in the row
    : `${money(f.pnlUsd, skip.has('netPct') ? null : f.pnlPct)}${span}`;
  const est = (v: { amount: number; pct: number | null } | null, apr = false): ReactNode => {
    if (!v) return '—';
    return <>{usd(v.amount, true)}{v.pct != null && <span className={apr ? row : undefined}>{` · ${pct(v.pct, 2, true)}`}</span>}</>;
  };
  const rows: (Row & { id?: StatKey })[] = [
    { id: 'age', k: 'Age', v: f.ageMs == null ? '—' : dur(f.ageMs), cls: row },
    { id: 'invested', k: 'Invested', v: f.investedUsd == null ? '—' : usd(f.investedUsd) },
    { id: 'value', k: 'Value', v: f.valueUsd == null ? '—' : usd(f.valueUsd), cls: row },
    { id: 'realized', k: 'Realized', v: money(f.realizedUsd, f.realizedPct) },
    { id: 'unrealized', k: 'Unrealized', v: money(f.unrealizedUsd, f.unrealizedPct) },
    ...(showNet ? [{ id: 'net' as StatKey, k: short ? 'Net so far' : 'Net', v: netText, cls: row }] : []),
    // Under a day: the net for the run with its length, not estimates scaled up from it (runRate.ts).
    ...(short ? [] : [{ k: 'Est. 24h', v: est(f.est.h24) }, { k: 'Est. 7d', v: est(f.est.d7) }, { k: 'Est. 365d', v: est(f.est.d365, true) }]),
    { id: 'moves', k: 'Moves', v: f.moves.text ?? '—', cls: row },
    { id: 'winRate', k: 'Win rate', v: f.winRate == null ? '—' : pct(f.winRate, 0) },
    { id: 'feesPaid', k: 'Fees paid', v: f.feesPaidUsd == null ? '—' : usd(f.feesPaidUsd) },
    { id: 'feesEarned', k: 'Fees earned', v: f.feesEarnedUsd == null ? '—' : usd(f.feesEarnedUsd), cls: row },
    { k: 'Time in range', v: f.timeInRange == null ? '—' : pct(f.timeInRange, 0) },
    { id: 'range', k: 'Range', v: range },
    { id: 'spacing', k: 'Spacing', v: spacing },
    { id: 'lastMove', k: 'Last move', v: f.lastMoveAt == null ? '—' : ago(f.lastMoveAt) },
    { k: 'Chain', v: f.chain || '—' },
    { k: 'DEX', v: f.dex || '—' },
    { k: 'Pool', v: poolText(f.pool) },
  ];
  return (
    <div className="stat-table">
      <p className="stat-note">{short
        ? 'Est. 24h, 7d, and 365d show once the bot has run a day. Until then: the net for the run.'
        : 'Est. 24h, 7d, and 365d extrapolate performance so far. They are not a forecast.'}</p>
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
