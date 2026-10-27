/** The figures under a chart. A dash is a figure the stored bot does not have. */
import { chainOf, mk } from './chains';
import { botFacts, echoes, figuresOf, unitsText } from './deskStats';
import { ago, dur, pct, px, usd } from './fmt';
import type { AnyObj } from './model';

/** An estimate in dollars; when the rate above (`rate`, in coins) already prints the same number (a stablecoin), only the %. */
function est(v: { amount: number; pct: number | null } | null, hint: string | null, rate?: [string, string]) {
  if (!v) return hint ? `— (${hint})` : '—';
  const p = v.pct == null ? '' : pct(v.pct, 2, true);
  if (rate && echoes(rate[1], usd(v.amount, true))) return p ? `${p} (in dollars, same as ${rate[0]})` : `same as ${rate[0]}, in dollars`;
  return `${usd(v.amount, true)}${p ? ` · ${p}` : ''}`;
}

function poolText(pool: string | null) {
  if (!pool) return '—';
  return pool.startsWith('0x') && pool.length > 12 ? `${pool.slice(0, 6)}…${pool.slice(-4)}` : pool;
}

/** Generated, its rates and the bot's facts. Total P&L, price change, unrealized and value vs deposit are in MoneyDetails. */
/** Rows a page can leave out because it shows the same figure elsewhere (no number twice on a screen). */
export type StatRow = 'Generated' | "Generated, today's value" | 'Per day' | 'Per week' | 'Per month' | 'Per year' | 'APR' | 'Age'
  | 'Est. 24h' | 'Est. 7d' | 'Est. 365d' | 'Moves' | 'Win rate' | 'Fees paid' | 'Fees earned' | 'Time in range' | 'Range' | 'Spacing' | 'Last move';

export function StatTable({ b, s, hide = [] }: { b: AnyObj; s: AnyObj; hide?: readonly StatRow[] }) {
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
    ['Per month', rate(gr?.d30, gr?.needs.d30), calc],
    ['Per year', rate(gr?.d365, gr?.needs.d365), calc],
    ['APR', f.aprPct == null ? (f.estHint.d365 ? `— (${f.estHint.d365})` : '—') : pct(f.aprPct, 1, true), calc],
    ['Age', f.ageMs == null ? '—' : dur(f.ageMs)],
    ['Est. 24h', est(f.est.h24, f.estHint.h24, hide.includes('Per day') ? undefined : ['Per day', rate(gr?.d1, null)]), calc],
    ['Est. 7d', est(f.est.d7, f.estHint.d7, hide.includes('Per week') ? undefined : ['Per week', rate(gr?.d7, null)]), calc],
    ['Est. 365d', est(f.est.d365, f.estHint.d365, hide.includes('Per year') ? undefined : ['Per year', rate(gr?.d365, null)]), calc],
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
  // no number twice: leave out the rows the page shows elsewhere, and a row whose figures the rows above already
  // print (a stablecoin's Est. 7d in dollars is its Per week in coins)
  const seen = new Set<string>();
  const shown = rows.filter(([k, v]) => {
    if ((hide as readonly string[]).includes(k)) return false;
    const f = v.startsWith('—') ? [] : figuresOf(v);
    if (f.length && f.every((x) => seen.has(x))) return false;
    for (const x of f) seen.add(x);
    return true;
  });
  return (
    <div className="stat-table" data-testid="stat-table">
      <p className="stat-note">Generated leads. Rates, Est. 24h/7d/365d and APR scale Generated so far linearly; they are not a forecast.{calc && <> <abbr className="calc-hint" title={calc}>How it's calculated</abbr></>}</p>
      <table>
        <tbody>
          {shown.map(([k, v, t]) => (
            <tr key={k} title={t}><th>{k}</th><td className="mono">{v}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
