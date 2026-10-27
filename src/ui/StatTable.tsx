/** The figures under a chart. A dash is a figure the stored bot does not have. */
import { chainOf, mk } from './chains';
import { botFacts, unitsText } from './deskStats';
import { ago, dur, pct, px, usd } from './fmt';
import type { AnyObj } from './model';

function money(v: number | null, p: number | null) {
  if (v == null && p == null) return '—';
  const d = v == null ? '—' : usd(v, true);
  const r = p == null ? '' : ` · ${pct(p, 2, true)}`;
  return d + r;
}

function est(v: { amount: number; pct: number | null } | null, hint: string | null) {
  if (!v) return hint ? `— (${hint})` : '—';
  return `${usd(v.amount, true)}${v.pct == null ? '' : ` · ${pct(v.pct, 2, true)}`}`;
}

function poolText(pool: string | null) {
  if (!pool) return '—';
  return pool.startsWith('0x') && pool.length > 12 ? `${pool.slice(0, 6)}…${pool.slice(-4)}` : pool;
}

export function StatTable({ b, s }: { b: AnyObj; s: AnyObj }) {
  const key = (b.stable || b.market || b.quote) as string | undefined;
  const market = key ? mk(s, key) : null;
  const chain = chainOf(s, b.chainId ?? s.legacyChainId)?.short ?? (typeof b.chainShort === 'string' ? b.chainShort : null);
  const f = botFacts(b, Date.now(), {
    chain,
    dex: (typeof b.dexName === 'string' ? b.dexName : null) ?? market?.dexName ?? null,
    pool: (typeof b.pool === 'string' ? b.pool : null) ?? market?.pool ?? null,
  });
  const range = f.range ? `${px(f.range.lower)} – ${px(f.range.upper)}` : '—';
  const spacing = f.spacingFrac != null ? `${(f.spacingFrac * 100).toFixed(3)}%` : f.bandPct != null ? `±${(f.bandPct * 100).toFixed(2)}%` : '—';
  const calc = f.calc ?? undefined;
  const rate = (r: Record<string, number> | null | undefined, hint: string | null | undefined) => (r ? unitsText(r) : hint ? `— (${hint})` : '—');
  const gr = f.generatedRate;
  const rows: [string, string, string?][] = [
    ['Generated', unitsText(f.generated), calc],
    ['Generated, today\'s value', f.generatedUsd == null ? '—' : usd(f.generatedUsd, true), calc],
    ['Per day', rate(gr?.d1, gr?.needs.d1), calc],
    ['Per week', rate(gr?.d7, gr?.needs.d7), calc],
    ['Per year', rate(gr?.d365, gr?.needs.d365), calc],
    ['APR', f.aprPct == null ? (f.estHint.d365 ? `— (${f.estHint.d365})` : '—') : pct(f.aprPct, 1, true), calc],
    ['Age', f.ageMs == null ? '—' : dur(f.ageMs)],
    ['Unrealized', money(f.unrealizedUsd, null), calc],
    ['Price change', f.priceChangeUsd == null ? '—' : usd(f.priceChangeUsd, true), calc],
    ['Value vs deposit', f.valueUsd == null && f.investedUsd == null ? '—' : `${f.valueUsd == null ? '—' : usd(f.valueUsd)} now · ${f.investedUsd == null ? '—' : usd(f.investedUsd)} in`],
    ['Total P&L', money(f.pnlUsd, f.pnlPct), calc],
    ['Est. 24h', est(f.est.h24, f.estHint.h24), calc],
    ['Est. 7d', est(f.est.d7, f.estHint.d7), calc],
    ['Est. 365d', est(f.est.d365, f.estHint.d365), calc],
    ['Moves', f.moves.text ?? '—'],
    ['Win rate', f.winRate == null ? '—' : pct(f.winRate, 0)],
    ['Fees paid', f.feesPaidUsd == null ? '—' : usd(f.feesPaidUsd), 'Gas + swap fees paid; for an LP also what range moves locked in (fees earned − fees paid = Generated, in dollars at each event).'],
    ['Fees earned', f.feesEarnedUsd == null ? '—' : usd(f.feesEarnedUsd)],
    ['Time in range', f.timeInRange == null ? '—' : pct(f.timeInRange, 0)],
    ['Range', range],
    ['Spacing', spacing],
    ['Last move', f.lastMoveAt == null ? '—' : ago(f.lastMoveAt)],
    ['Chain', f.chain || '—'],
    ['DEX', f.dex || '—'],
    ['Pool', poolText(f.pool)],
  ];
  return (
    <div className="stat-table">
      <p className="stat-note">Generated leads. Rates, Est. 24h/7d/365d and APR scale Generated so far linearly; they are not a forecast.{calc && <> <abbr className="calc-hint" title={calc}>How it's calculated</abbr></>}</p>
      <table>
        <tbody>
          {rows.map(([k, v, t]) => (
            <tr key={k} title={t}><th>{k}</th><td className="mono">{v}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
