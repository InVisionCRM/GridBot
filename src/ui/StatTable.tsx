/** The figures under a chart. A dash is a figure the stored bot does not have. */
import { chainOf, mk } from './chains';
import { botFacts, figuresOf, unitsText } from './deskStats';
import { ago, dur, pct, px, qty } from './fmt';
import type { AnyObj } from './model';
import { isShortRun } from './runRate';

function poolText(pool: string | null) {
  if (!pool) return '—';
  return pool.startsWith('0x') && pool.length > 12 ? `${pool.slice(0, 6)}…${pool.slice(-4)}` : pool;
}

/**
 * Generated, its estimates and the bot's facts, in crypto units only (no dollars). Total P&L, price change, open
 * positions and value vs deposit are in MoneyDetails.
 */
/** Rows a page can leave out because it shows the same figure elsewhere (no number twice on a screen). */
export type StatRow = 'Generated' | 'APR' | 'Age'
  | 'Est. 24h' | 'Est. 7d' | 'Est. 30d' | 'Est. 365d' | 'Moves' | 'Win rate' | 'Fees paid' | 'Fees earned' | 'Time in range' | 'Range' | 'Spacing' | 'Last move';

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
  // under a day: no Est. rows scaled up from a few hours (runRate.ts, #72); Generated above is the run's figure
  const short = isShortRun(f.ageMs);
  const rate = (r: Record<string, number> | null | undefined, hint: string | null | undefined) => (short ? '— (shows after a day)' : r ? unitsText(r) : hint ? `— (${hint})` : '—');
  const gr = f.generatedRate;
  const sym = f.quoteSym ?? '';
  // Est. = Generated ÷ age × the window, per token (the server's generatedRate); a dash and "needs …" until the history is long enough
  // a liquidity bot has no move count of its own here (main: hidden for lp); #43 has no Realized/Unrealized rows
  const hidden: readonly string[] = b.kind === 'lp' ? [...hide, 'Moves'] : hide;
  const rows: [string, string, string?][] = [
    ['Generated', unitsText(f.generated), calc],
    ['Est. 24h', rate(gr?.d1, gr?.needs.d1), calc],
    ['Est. 7d', rate(gr?.d7, gr?.needs.d7), calc],
    ['Est. 30d', rate(gr?.d30, gr?.needs.d30), calc],
    ['Est. 365d', rate(gr?.d365, gr?.needs.d365), calc],
    ['APR', f.aprPct == null ? (f.estHint.d365 ? `— (${f.estHint.d365})` : '—') : pct(f.aprPct, 1, true), calc],
    ['Age', f.ageMs == null ? '—' : dur(f.ageMs)],
    ['Moves', f.moves.text ?? '—'],
    ['Win rate', f.winRate == null ? '—' : pct(f.winRate, 0)],
    ['Fees paid', f.feesPaid == null ? '—' : qty(f.feesPaid, sym, 4, false), `Gas + swap fees paid, in ${sym || 'the quote coin'}; for an LP also what range moves locked in.`],
    ['Fees earned', f.feesEarned == null ? '—' : qty(f.feesEarned, sym, 4, false), `In ${sym || 'the quote coin'}, both coins' fees at today's price.`],
    ['Time in range', f.timeInRange == null ? '—' : pct(f.timeInRange, 0)],
    ['Range', range],
    ['Spacing', spacing],
    ['Last move', f.lastMoveAt == null ? '—' : ago(f.lastMoveAt)],
    ['Chain', f.chain || '—'],
    ['DEX', f.dex || '—'],
    ['Pool', poolText(f.pool)],
  ];
  // no number twice: leave out the rows the page shows elsewhere, and a row whose figures the rows above already print
  const seen = new Set<string>();
  const shown = rows.filter(([k, v]) => {
    if (hidden.includes(k)) return false;
    const f = v.startsWith('—') ? [] : figuresOf(v);
    if (f.length && f.every((x) => seen.has(x))) return false;
    for (const x of f) seen.add(x);
    return true;
  });
  return (
    <div className="stat-table" data-testid="stat-table">
      <p className="stat-note">Generated leads. Est. 24h/7d/30d/365d = Generated ÷ age × the days, per coin, and APR scales it the same way; not a forecast.{short && ' They show once the bot has run a day.'}{calc && <> <abbr className="calc-hint" title={calc}>How it's calculated</abbr></>}</p>
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
