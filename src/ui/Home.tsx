/** Home: net worth, what changed today, and the bots that are running. */
import { usd, cls } from './fmt';
import { useChainFilter } from './chains';
import { formatUsdAmount, type HoldingsSnapshot } from '../live/holdingsMath';
import { botView, gridName, quoteSym, type AnyObj, type Nav } from './model';

function titleOf(b: AnyObj) {
  if (b.kind === 'grid') return gridName(b);
  if (b.kind === 'lp') return b.label ? String(b.label) : 'Liquidity';
  return String(b.name ?? 'Trend');
}
function kindOf(b: AnyObj) {
  return b.kind === 'lp' ? 'Liquidity' : b.kind === 'trend' ? 'Trend' : 'Grid';
}
function pnlOf(b: AnyObj): { text: string; n: number | null } {
  const n = b.kind === 'lp' ? (b.pnl?.net ?? null) : (b.pnl?.realized ?? null);
  if (n == null || !Number.isFinite(n)) return { text: '—', n: null };
  const k = b.usdPerQuote as number | null;
  if (k != null && Number.isFinite(k)) return { text: usd(n * k, true), n: n * k };
  const sym = quoteSym(b);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return { text: `${sign}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${sym}`, n };
}

/** Closed trades since local midnight, as a running total in dollars. Live bots only. */
function todaySeries(bots: AnyObj[]): number[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const from = start.getTime();
  const ev: { t: number; usd: number }[] = [];
  for (const b of bots) {
    if (b.mode === 'paper') continue;
    const k = b.usdPerQuote as number | null;
    if (!(typeof k === 'number' && k > 0)) continue;
    for (const tr of (b.trades ?? []) as AnyObj[]) {
      if (tr.failed || tr.side === 'buy' || !(tr.timestamp >= from)) continue;
      const pnl = tr.roundTripNet ?? tr.realizedPnlUsd;
      if (typeof pnl === 'number' && Number.isFinite(pnl)) ev.push({ t: tr.timestamp, usd: pnl * k });
    }
  }
  ev.sort((a, b) => a.t - b.t);
  const pts = [0];
  let acc = 0;
  for (const e of ev) { acc += e.usd; pts.push(acc); }
  return pts;
}

function Spark({ points }: { points: number[] }) {
  const w = 96, h = 36;
  const p = points.length > 1 ? points : [0, 0];
  const min = Math.min(...p), max = Math.max(...p), span = max - min || 1;
  const d = p.map((y, i) => {
    const x = (i / (p.length - 1)) * w;
    const yy = h - 3 - ((y - min) / span) * (h - 6);
    return `${i ? 'L' : 'M'}${x.toFixed(1)} ${yy.toFixed(1)}`;
  }).join(' ');
  const last = p[p.length - 1];
  const tone = last > 0 ? 'var(--profit)' : last < 0 ? 'var(--loss)' : 'var(--muted)';
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={tone} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function BotLine({ b, nav }: { b: AnyObj; nav: Nav }) {
  const pnl = pnlOf(b);
  const bad = !!b.lastError;
  const on = b.status === 'running' && !bad;
  return (
    <button type="button" className="line" onClick={() => nav(botView(b.kind, b.id))}>
      <i className={`status-dot${on ? ' on' : ''}${bad ? ' bad' : ''}`} />
      <span className="line-name">{titleOf(b)}<span>{kindOf(b)}</span></span>
      <b className={cls(pnl.n)}>{pnl.text}</b>
    </button>
  );
}

export function Home({ s, nav, holdings }: { s: AnyObj; nav: Nav; holdings: HoldingsSnapshot | null }) {
  const { chain } = useChainFilter();
  const all: AnyObj[] = [
    ...s.grids.map((g: AnyObj) => ({ ...g, kind: 'grid' })),
    ...(s.trends ?? []).map((t: AnyObj) => ({ ...t, kind: 'trend' })),
    ...(s.lps ?? []).map((t: AnyObj) => ({ ...t, kind: 'lp' })),
  ].filter((b) => !b.archivedAt && (chain === 'all' || (b.chainId ?? s.legacyChainId) === chain));
  const bots = all.filter((b) => b.status === 'running');
  const worth = !holdings || !holdings.hasSigner ? null
    : chain === 'all' ? (holdings.netWorthExDustUsd ?? holdings.netWorthUsd)
    : (holdings.chains.find((c) => c.chainId === chain)?.usd ?? null);
  const series = todaySeries(all);
  const today = series[series.length - 1] ?? 0;
  const traded = series.length > 2 || (series.length === 2 && series[1] !== 0);

  return (
    <main className="home">
      <section className="home-fig" aria-label="Net worth">
        <div>
          <p className="home-num">{worth == null ? '—' : formatUsdAmount(worth)}</p>
          <p className={`home-day ${holdings?.hasSigner && traded ? cls(today) : 'muted'}`}>
            {holdings?.hasSigner === false && 'Paper mode'}
            {holdings?.hasSigner && (traded ? `Today ${usd(today, true)}` : 'Today $0.00')}
            {holdings == null && 'Reading…'}
          </p>
        </div>
        {holdings?.hasSigner && <Spark points={series} />}
      </section>
      <section aria-label="Running">
        <h2 className="plain-h">Running</h2>
        {bots.map((b) => <BotLine key={b.id} b={b} nav={nav} />)}
        {!bots.length && <p className="muted home-empty">Nothing is running. <button type="button" className="text-link" onClick={() => nav({ v: 'bots' })}>Bots</button></p>}
      </section>
    </main>
  );
}
