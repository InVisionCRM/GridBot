/** The figures under a chart. A dash is a figure the stored bot does not have. */
import { chainOf, mk } from './chains';
import { botFacts } from './deskStats';
import { ago, dur, pct, px, usd } from './fmt';
import type { AnyObj } from './model';

function money(v: number | null, p: number | null) {
  if (v == null && p == null) return '—';
  const d = v == null ? '—' : usd(v, true);
  const r = p == null ? '' : ` · ${pct(p, 2, true)}`;
  return d + r;
}

function est(v: { amount: number; pct: number | null } | null) {
  if (!v) return '—';
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
  const hide = b.kind === 'lp' ? new Set(['Realized', 'Unrealized', 'Moves']) : new Set<string>();
  const rows: [string, string][] = [
    ['Age', f.ageMs == null ? '—' : dur(f.ageMs)],
    ['Invested', f.investedUsd == null ? '—' : usd(f.investedUsd)],
    ['Value', f.valueUsd == null ? '—' : usd(f.valueUsd)],
    ['Realized', money(f.realizedUsd, f.realizedPct)],
    ['Unrealized', money(f.unrealizedUsd, f.unrealizedPct)],
    ['Est. 24h', est(f.est.h24)],
    ['Est. 7d', est(f.est.d7)],
    ['Est. 365d', est(f.est.d365)],
    ['Moves', f.moves.text ?? '—'],
    ['Win rate', f.winRate == null ? '—' : pct(f.winRate, 0)],
    ['Fees paid', f.feesPaidUsd == null ? '—' : usd(f.feesPaidUsd)],
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
      <p className="stat-note">Est. 24h, 7d, and 365d extrapolate performance so far. They are not a forecast.</p>
      <table>
        <tbody>
          {rows.filter(([k]) => !hide.has(k)).map(([k, v]) => (
            <tr key={k}><th>{k}</th><td className="mono">{v}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
