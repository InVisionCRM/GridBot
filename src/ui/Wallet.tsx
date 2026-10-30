/**
 * The Wallet, Coinbase style: the balance in dollars, its change over the range, a line you can scrub (hover, or press
 * and drag) to read any moment, chain pills, then each coin with its logo and a small chain badge, dollars first and
 * the coins under them; liquidity positions show both coins' logos. The drawer shows the largest rows and "View all";
 * the full page (Holdings) shows every row, uncollected fees, dust and how it's counted.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { http } from './api';
import { useChainFilter, type ChainInfo } from './chains';
import { ago, usd } from './fmt';
import { TokenMark } from './icons';
import { botView, type AnyObj, type Nav } from './model';
import { smoothPath } from './smooth';
import { coinAmount, walletModel, worthChange, worthLine, type AssetRow, type PoolRow } from './walletModel';
import type { CoinView, HoldingsSnapshot } from '../live/holdingsMath';

type Range = '1D' | '1W' | '1M' | 'ALL';
const RANGES: Range[] = ['1D', '1W', '1M', 'ALL'];
const RANGE_WORDS: Record<Range, string> = { '1D': 'today', '1W': 'past week', '1M': 'past month', ALL: 'all time' };
/** Rows in the drawer before "View all" */
const DRAWER_ROWS = 5;
const RANGE_TEXT: Record<string, string> = { in: 'in range', below: 'below range', above: 'above range' };

function useWorth(range: Range, chain: number | 'all') {
  const [points, setPoints] = useState<{ t: number; usd: number }[] | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http<{ points: { t: number; usd: number }[] }>(`/api/holdings/history?range=${range}&chain=${chain}`)
      .then((r) => { if (!dead) setPoints(r.points); }).catch(() => { if (!dead) setPoints([]); });
    void load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [range, chain]);
  return points;
}

// ── logos ────────────────────────────────────────────────────────────────
export function CoinLogo({ coin, chain, size = 40 }: { coin: Pick<CoinView, 'chainId' | 'address' | 'symbol'>; chain: ChainInfo | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="wl-logo" style={{ width: size, height: size } as CSSProperties}>
      <span className="wl-logo-i">
        {coin.address && !failed
          ? <img src={`/api/logo/${coin.chainId}/${coin.address}`} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
          : <TokenMark symbol={coin.symbol} address={coin.address} size={size} />}
      </span>
      {chain && <ChainDot chain={chain} />}
    </span>
  );
}
function PairLogo({ a, b, chain }: { a: CoinView; b: CoinView; chain: ChainInfo | null }) {
  return (
    <span className="wl-pair">
      <CoinLogo coin={a} chain={null} size={30} />
      <CoinLogo coin={b} chain={chain} size={30} />
    </span>
  );
}
function ChainDot({ chain }: { chain: ChainInfo }) {
  return <span className="wl-chain" style={{ background: chain.color }} title={chain.name}>{chain.short.slice(0, 1)}</span>;
}

// ── the chart ────────────────────────────────────────────────────────────
function WorthChart({ line, up, onScrub, tall }: { line: { t: number; usd: number }[]; up: boolean; onScrub: (i: number | null) => void; tall: boolean }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const down = useRef(false);
  const xs = useRef<number[]>([]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const draw = () => {
      const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (line.length < 2) { xs.current = []; return; }
      const t0 = line[0].t, t1 = line[line.length - 1].t, span = Math.max(1, t1 - t0);
      const lo = Math.min(...line.map((p) => p.usd)), hi = Math.max(...line.map((p) => p.usd)), pad = (hi - lo) * 0.15 || Math.max(1, hi * 0.01);
      const X = (t: number) => 2 + ((t - t0) / span) * (w - 10), Y = (v: number) => h - 8 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (h - 16);
      xs.current = line.map((p) => X(p.t));
      const color = up ? '#5CD08D' : '#F2706B';
      const path = smoothPath(line.map((p): [number, number] => [X(p.t), Y(p.usd)]));
      const area = new Path2D(path);
      area.lineTo(X(t1), h); area.lineTo(X(t0), h); area.closePath();
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, up ? 'rgba(92,208,141,.18)' : 'rgba(242,112,107,.18)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fill(area);
      g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke(path);
      const i = at ?? line.length - 1, p = line[i];
      if (at != null) {
        g.save(); g.strokeStyle = 'rgba(255,255,255,.25)'; g.setLineDash([3, 4]);
        g.beginPath(); g.moveTo(X(p.t), 0); g.lineTo(X(p.t), h); g.stroke(); g.restore();
      }
      g.beginPath(); g.arc(X(p.t), Y(p.usd), 4.5, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [line, up, at]);
  const pick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (!xs.current.length) return;
    let i = 0;
    for (let k = 1; k < xs.current.length; k++) if (Math.abs(xs.current[k] - x) < Math.abs(xs.current[i] - x)) i = k;
    setAt(i); onScrub(i);
  };
  const end = () => { down.current = false; setAt(null); onScrub(null); };
  return (
    <canvas ref={cv} className={`wl-chart ${tall ? 'tall' : ''}`} aria-label="Wallet value over time"
      onPointerDown={(e) => { down.current = true; if (e.pointerType !== 'mouse') e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
      onPointerMove={(e) => { if (e.pointerType === 'mouse' || down.current) pick(e); }}
      onPointerUp={(e) => { down.current = false; if (e.pointerType !== 'mouse') end(); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') end(); }} onPointerCancel={end} />
  );
}

// ── rows ─────────────────────────────────────────────────────────────────
function AssetLine({ r, chain }: { r: AssetRow; chain: ChainInfo | null }) {
  return (
    <div className="wl-row">
      <CoinLogo coin={r} chain={chain} />
      <span className="wl-name"><b>{r.symbol}</b><small>{chain?.name ?? 'Chain'}{r.inBot ? ' · in a bot' : ''}</small></span>
      <span className="wl-val"><b>{r.usd == null ? '—' : usd(r.usd)}</b><small>{coinAmount(r.amount, r.symbol)}</small></span>
    </div>
  );
}
function PoolLine({ r, chain, nav }: { r: PoolRow; chain: ChainInfo | null; nav: Nav }) {
  const body = (
    <>
      <PairLogo a={r.t0} b={r.t1} chain={chain} />
      <span className="wl-name"><b>{r.t0.symbol}/{r.t1.symbol}</b><small>{r.dex} {r.fee}{r.range ? ` · ${RANGE_TEXT[r.range]}` : ''}{r.bot ? ` · ${r.bot.name}` : ''}</small></span>
      <span className="wl-val"><b>{r.usd == null ? '—' : usd(r.usd)}</b><small>{[r.t0, r.t1].filter((c) => c.amount > 0).map((c) => coinAmount(c.amount, c.symbol)).join(' · ')}</small></span>
    </>
  );
  return r.bot ? <button type="button" className="wl-row" onClick={() => nav(botView(r.bot!.kind, r.bot!.id))}>{body}</button> : <div className="wl-row">{body}</div>;
}

// ── the view ─────────────────────────────────────────────────────────────
export function WalletView({ s, snap, mode, nav, onDust }: {
  s: AnyObj; snap: HoldingsSnapshot | null; mode: 'drawer' | 'page'; nav: Nav;
  /** The page's dust switch: shown, and how to flip it */
  onDust?: { shown: boolean; flip: () => void };
}) {
  const { chain: global } = useChainFilter();
  const [chain, setChain] = useState<number | 'all'>(global);
  const [range, setRange] = useState<Range>('1D');
  const [scrub, setScrub] = useState<number | null>(null);
  const points = useWorth(range, chain);
  const showDust = onDust?.shown ?? false;
  const m = useMemo(() => (snap?.hasSigner ? walletModel(snap, chain, showDust) : null), [snap, chain, showDust]);
  const info = (id: number) => ((s.chains ?? []) as ChainInfo[]).find((c) => c.id === id) ?? null;
  const line = useMemo(() => (snap && m && points ? worthLine(points, { t: snap.at, usd: m.total }) : []), [snap, m, points]);
  if (!snap) return <p className="muted">Reading the wallet…</p>;
  if (!snap.hasSigner || !m) return <><span className="dk-eyebrow">Wallet</span><p className="muted">No wallet key on this server: bots run on paper.</p></>;
  const change = worthChange(line), up = (change?.usd ?? 0) >= 0;
  const shown = scrub != null && line[scrub] ? line[scrub] : null;
  const head = shown ? shown.usd : m.total;
  const rows: ({ k: 'a'; r: AssetRow } | { k: 'p'; r: PoolRow })[] = [...m.assets.map((r) => ({ k: 'a' as const, r })), ...m.pools.map((r) => ({ k: 'p' as const, r }))]
    .sort((a, b) => (b.r.usd ?? -Infinity) - (a.r.usd ?? -Infinity));
  const listed = mode === 'drawer' ? rows.slice(0, DRAWER_ROWS) : rows;
  return (
    <div className={`wl wl-${mode}`}>
      <div className="wl-head">
        <span className="dk-eyebrow">{chain === 'all' ? 'Wallet' : `Wallet · ${info(chain)?.name ?? ''}`}</span>
        <b className="wl-big">{head == null ? '—' : usd(head)}</b>
        <span className={`wl-chg ${shown ? '' : up ? 'pos' : 'neg'}`}>
          {shown
            ? new Date(shown.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : change ? <>{up ? '▲' : '▼'} {usd(Math.abs(change.usd))}{change.pct != null ? ` (${Math.abs(change.pct * 100).toFixed(2)}%)` : ''} <em>{RANGE_WORDS[range]}</em></> : <em>read {ago(snap.at)}</em>}
        </span>
      </div>
      {line.length >= 2
        ? <WorthChart line={line} up={up} onScrub={setScrub} tall={mode === 'page'} />
        : <p className={`wl-chart-empty ${mode === 'page' ? 'tall' : ''}`}>The chart fills in from today: a point every 15 minutes while the app runs.</p>}
      <div className="wl-ranges" role="radiogroup" aria-label="Chart range">
        {RANGES.map((r) => <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}
      </div>
      {m.chains.length > 1 && (
        <div className="wl-pills" role="radiogroup" aria-label="Chain">
          <button type="button" role="radio" aria-checked={chain === 'all'} className={chain === 'all' ? 'on' : ''} onClick={() => setChain('all')}>All</button>
          {m.chains.map((c) => (
            <button key={c.chainId} type="button" role="radio" aria-checked={chain === c.chainId} className={chain === c.chainId ? 'on' : ''} onClick={() => setChain(c.chainId)}>
              <i style={{ background: info(c.chainId)?.color }} />{info(c.chainId)?.short ?? c.chainId}
            </button>
          ))}
        </div>
      )}
      <div className="wl-list">
        {mode === 'page' && !!m.assets.length && <h3>Coins</h3>}
        {(mode === 'page' ? m.assets.map((r) => ({ k: 'a' as const, r })) : listed).map((x) => (x.k === 'a'
          ? <AssetLine key={x.r.key} r={x.r} chain={info(x.r.chainId)} />
          : <PoolLine key={x.r.key} r={x.r as PoolRow} chain={info(x.r.chainId)} nav={nav} />))}
        {mode === 'page' && !!m.pools.length && <h3>Liquidity</h3>}
        {mode === 'page' && m.pools.map((r) => <PoolLine key={r.key} r={r} chain={info(r.chainId)} nav={nav} />)}
        {mode === 'page' && !!m.fees.length && <h3>Fees not collected yet</h3>}
        {mode === 'page' && m.fees.map((r) => (
          <div key={r.key} className="wl-row">
            <PairLogo a={r.t0} b={r.t1} chain={info(r.chainId)} />
            <span className="wl-name"><b>{r.t0.symbol}/{r.t1.symbol}</b><small>{r.leftover ? 'left behind when the position closed' : 'waiting in the position'}</small></span>
            <span className="wl-val"><b>{r.usd == null ? '—' : usd(r.usd)}</b><small>{[r.t0, r.t1].filter((c) => c.amount > 0).map((c) => coinAmount(c.amount, c.symbol)).join(' · ')}</small></span>
          </div>
        ))}
        {!rows.length && <p className="muted">Nothing above dust.</p>}
      </div>
      <div className="dk-row wl-actions">
        <button type="button" className="dk-btn" onClick={() => nav({ v: 'tools', tab: 'convert' })}>Convert</button>
        {mode === 'drawer'
          ? <button type="button" className="dk-btn primary" onClick={() => nav({ v: 'holdings' })}>View all{rows.length > DRAWER_ROWS ? ` ${rows.length}` : ''}</button>
          : onDust && <button type="button" className="dk-btn" onClick={onDust.flip}>{onDust.shown ? 'Hide dust' : m.hidden ? `Show ${m.hidden} dust` : 'No dust'}</button>}
      </div>
    </div>
  );
}
