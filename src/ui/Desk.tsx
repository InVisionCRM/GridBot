/**
 * Home: one screen, nothing to scroll. On top, what the bots generated (a big dollar figure with the coins under it)
 * and the profits banked over time, always moving. Below, the board: Money flow, Price ladder and Kill funnel as tabs
 * (keys 1, 2, 3), with Next payday and the live river beside them. On a phone the five are one tap apart.
 * Every card opens a drawer; new profits pop one up. Data: deskModel.ts (status payloads only).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { http } from './api';
import { allBots, generatedByMode, listBots, totalGeneratedUsd } from './botRow';
import { useChainFilter } from './chains';
import { ALMOST, amountsText, bankedCurve, bankedItems, funnelOf, ladders, openItems, type BankedItem, type Ladder, type Mode, type OpenItem } from './deskModel';
import { ago, qty, usd } from './fmt';
import type { HoldingsSnapshot } from '../live/holdingsMath';
import type { AnyObj, Nav } from './model';
import { useCount, useReducedMotion } from './motion';
import { DeskSheet, type SheetOf } from './DeskSheet';
import { smoothPath } from './smooth';
import type { ActivityEvent } from './useStream';

type Tab = 'flow' | 'ladder' | 'funnel';
type PhoneTab = Tab | 'payday' | 'river';
type Range = '1H' | '1D' | '1W' | '1M' | 'ALL';
const RANGE_MS: Record<Range, number | null> = { '1H': 3_600_000, '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, ALL: null };
const TABS: { k: Tab; label: string }[] = [{ k: 'flow', label: 'Money flow' }, { k: 'ladder', label: 'Price ladder' }, { k: 'funnel', label: 'Kill funnel' }];
const PHONE_TABS: { k: PhoneTab; label: string }[] = [{ k: 'flow', label: 'Flow' }, { k: 'payday', label: 'Next' }, { k: 'river', label: 'Live' }, { k: 'ladder', label: 'Ladder' }, { k: 'funnel', label: 'Funnel' }];
/** A card's height (styles.css .dk-cardi): lists fit as many as the space holds */
const CARD_H = 82;
const AV = ['#5CD08D', '#5B8DEF', '#F5B841', '#F2706B', '#9B8CF2', '#E94BD1', '#4FC1D9'];
const avColor = (sym: string) => AV[[...sym].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];

function useTrader(): AnyObj | null {
  const [t, setT] = useState<AnyObj | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http<AnyObj>('/api/token-trader').then((d) => { if (!dead) setT(d); }).catch(() => undefined);
    void load();
    const id = setInterval(load, 5000);
    return () => { dead = true; clearInterval(id); };
  }, []);
  return t;
}

/** The home takes the rest of the window (above the phone's tab bar), so the page itself never scrolls. */
function useFill(ref: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    document.body.classList.add('dk-on');
    const set = () => {
      const el = ref.current;
      if (!el) return;
      const phone = innerWidth <= 860, top = el.getBoundingClientRect().top + scrollY;
      el.style.height = `${Math.max(phone ? 560 : 600, innerHeight - top - (phone ? 92 : 16))}px`;
    };
    set();
    addEventListener('resize', set);
    return () => { removeEventListener('resize', set); document.body.classList.remove('dk-on'); };
  }, [ref]);
}

/** A phone-width window: the board shows one view at a time, picked from five */
function useNarrow(): boolean {
  const q = '(max-width: 860px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q), on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** How many rows of `rowH` fit in the element: lists show what fits and count the rest, never scroll. */
function useFit(ref: RefObject<HTMLElement | null>, rowH: number, gap = 8): number {
  const [n, setN] = useState(5);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setN(Math.max(1, Math.floor((el.clientHeight + gap) / (rowH + gap)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, rowH, gap]);
  return n;
}

/** Cards that change place glide there (also from one column to another); new ones drop in. */
function useFlip(ref: RefObject<HTMLElement | null>, dep: unknown) {
  const prev = useRef(new Map<string, DOMRect>());
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = new Map<string, DOMRect>();
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((n) => {
      const k = n.dataset.flip!, r = n.getBoundingClientRect(), o = prev.current.get(k);
      next.set(k, r);
      if (reduced || !n.animate) return;
      if (o) {
        const dx = o.left - r.left, dy = o.top - r.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' });
      } else if (prev.current.size) n.animate([{ opacity: 0, transform: 'translateY(-10px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'ease-out' });
    });
    prev.current = next;
  }, [dep, ref, reduced]);
}

export function Desk({ s, nav, act, busy, holdings, events }: { s: AnyObj; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean; holdings: HoldingsSnapshot | null; events: ActivityEvent[] }) {
  const { chain } = useChainFilter();
  const trader = useTrader();
  // open bots fill the board; every bot (closed ones too) counts towards Generated and Banked
  const bots = useMemo(() => listBots(s, chain), [s, chain]);
  const ever = useMemo(() => allBots(s, chain), [s, chain]);
  const hasLive = ever.some((b) => b.mode === 'live') || trader?.options?.mode === 'live';
  const [modePick, setMode] = useState<Mode | null>(null);
  const mode: Mode = modePick ?? (hasLive ? 'live' : 'paper');
  const [tab, setTab] = useState<Tab>('flow');
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('flow');
  const [range, setRange] = useState<Range>('1D');
  const [sheet, setSheet] = useState<SheetOf | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  useFill(root);

  const open = useMemo(() => openItems(bots, trader, mode), [bots, trader, mode]);
  const banked = useMemo(() => bankedItems(ever, trader, mode), [ever, trader, mode]);
  const lads = useMemo(() => ladders(bots, mode), [bots, mode]);
  const funnel = useMemo(() => funnelOf(trader), [trader]);
  const withTrader = useMemo(() => (trader?.metrics ? [...ever, { id: 'token-trader', kind: 'token', mode: trader.metrics.mode, metrics: trader.metrics }] : ever), [ever, trader]);
  const genUsd = totalGeneratedUsd(withTrader, mode);
  const genUnits = generatedByMode(withTrader)[mode];
  const running = bots.filter((b) => (b.mode === 'live' ? 'live' : 'paper') === mode && b.status === 'running').length;

  // profit moments: a profit that lands while the home is open pops the drawer (one every 15 s at most)
  const seen = useRef<Set<string> | null>(null), lastMoment = useRef(0);
  useEffect(() => {
    if (seen.current == null) { seen.current = new Set(banked.map((b) => b.key)); return; }
    const fresh = banked.filter((b) => !seen.current!.has(b.key));
    fresh.forEach((b) => seen.current!.add(b.key));
    const best = fresh.find((b) => b.amounts.some((a) => a.amt > 0));
    if (best && !sheet && Date.now() - lastMoment.current > 15_000) { lastMoment.current = Date.now(); setSheet({ kind: 'moment', item: best }); }
  }, [banked]); // eslint-disable-line react-hooks/exhaustive-deps

  // 1 / 2 / 3 switch the board
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (sheet || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      const t = ({ 1: 'flow', 2: 'ladder', 3: 'funnel' } as Record<string, Tab>)[e.key];
      if (t) { setTab(t); setPhoneTab(t); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [sheet]);

  const openBot = (botId: string) => setSheet({ kind: 'bot', botId });
  const flow = <FlowBoard open={open} banked={banked} narrow={narrow} onOpen={openBot} onMore={(title, items) => setSheet({ kind: 'list', title, items })} />;
  const ladder = <LadderBoard ladders={lads} perView={narrow ? 1 : 3} onOpen={openBot} />;
  const funnelView = <FunnelBoard funnel={funnel} held={open.filter((o) => o.kind === 'token')} on={!!trader?.on} onOpen={openBot} onSetup={() => nav({ v: 'auto' })} />;
  const payday = <Payday open={open} onOpen={openBot} />;
  const river = <River events={events} />;
  const boards: Record<Tab, ReactNode> = { flow, ladder, funnel: funnelView };

  return (
    <div className="dk" ref={root}>
      <Hero mode={mode} setMode={hasLive ? setMode : null} genUsd={genUsd} genUnits={genUnits} running={running} banked={banked} range={range} setRange={setRange}
        onNew={() => setSheet({ kind: 'new' })} onWallet={() => setSheet({ kind: 'wallet' })} onBanked={(item) => setSheet({ kind: 'moment', item, pinned: true })} />
      <div className="dk-main">
        <section className="dk-stage" aria-label="Board">
          {narrow ? (
            <div className="dk-tabs" role="tablist" aria-label="View">
              {PHONE_TABS.map((t) => <button key={t.k} type="button" role="tab" aria-selected={phoneTab === t.k} className={phoneTab === t.k ? 'on' : ''} onClick={() => setPhoneTab(t.k)}>{t.label}</button>)}
            </div>
          ) : (
            <div className="dk-tabs" role="tablist" aria-label="Board view">
              {TABS.map((t, i) => (
                <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} className={tab === t.k ? 'on' : ''} onClick={() => setTab(t.k)}>
                  {t.label}<kbd>{i + 1}</kbd>
                </button>
              ))}
            </div>
          )}
          <div className="dk-track">
            {narrow
              ? <div key={`p-${phoneTab}`} className="dk-pane">{phoneTab === 'payday' ? payday : phoneTab === 'river' ? river : boards[phoneTab]}</div>
              : <div key={tab} className="dk-pane">{boards[tab]}</div>}
          </div>
        </section>
        {!narrow && (
          <aside className="dk-rail" aria-label="Next payday and live activity">
            <section className="dk-card"><h3>Next payday <span className="muted small">closest to paying you</span></h3>{payday}</section>
            <section className="dk-card"><h3><span className="dk-live-dot" />Live <span className="muted small">what just happened</span></h3>{river}</section>
          </aside>
        )}
      </div>
      {sheet && <DeskSheet sheet={sheet} close={() => setSheet(null)} s={s} bots={bots} trader={trader} holdings={holdings} nav={nav} act={act} busy={busy} />}
    </div>
  );
}

// ── hero ─────────────────────────────────────────────────────────────────
function Hero({ mode, setMode, genUsd, genUnits, running, banked, range, setRange, onNew, onWallet, onBanked }: {
  mode: Mode; setMode: ((m: Mode) => void) | null; genUsd: number | null; genUnits: Record<string, number> | null; running: number; banked: BankedItem[];
  range: Range; setRange: (r: Range) => void; onNew: () => void; onWallet: () => void; onBanked: (b: BankedItem) => void;
}) {
  const shown = useCount(genUsd, 700);
  const now = Date.now(), win = RANGE_MS[range];
  // the start of the range, to the minute (the chart's own clock moves the right edge)
  const from = Math.floor((win == null ? Math.min(now - 86_400_000, ...banked.map((b) => b.t)) : now - win) / 60_000) * 60_000;
  const curve = useMemo(() => bankedCurve(banked, from), [banked, from]);
  const inRange = curve.length ? curve[curve.length - 1].v : 0;
  const [bump, setBump] = useState(0);
  const lastTop = useRef<string | null>(null);
  useEffect(() => { const k = banked[0]?.key ?? null; if (lastTop.current && k !== lastTop.current) setBump((n) => n + 1); lastTop.current = k; }, [banked]);
  const units = Object.entries(genUnits ?? {}).filter(([, v]) => v !== 0);
  const today = banked.filter((b) => b.t >= now - 86_400_000).length;
  return (
    <section className="dk-hero" aria-label="Generated">
      <BankedChart curve={curve} from={from} onPick={onBanked} />
      <div className="dk-hero-l">
        <div className="dk-hero-k">
          <span className="dk-k">Generated</span>
          {setMode ? (
            <span className="dk-mode" role="radiogroup" aria-label="Live or paper">
              {(['live', 'paper'] as Mode[]).map((m) => <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m === 'live' ? 'Live' : 'Paper'}</button>)}
            </span>
          ) : <span className="dk-chip">{mode === 'live' ? 'Live' : 'Paper'}</span>}
        </div>
        <div key={bump} className={`dk-big ${genUsd != null && genUsd < 0 ? 'neg' : 'pos'} ${bump ? 'bump' : ''}`} data-testid="dk-big">{shown == null ? '—' : usd(shown, true)}</div>
        <div className="dk-units" data-testid="dk-units">{units.length ? units.map(([sym, v]) => <span key={sym} className={v >= 0 ? 'pos' : 'neg'}>{qty(v, sym, 5)}</span>) : <span className="muted">nothing generated yet</span>}</div>
        <div className="dk-hero-sub"><span>{running} running</span><span>{today === 1 ? '1 profit' : `${today} profits`} banked today</span></div>
        <div className="dk-hero-actions">
          <button type="button" className="dk-btn primary" onClick={onNew}>New bot</button>
          <button type="button" className="dk-btn" onClick={onWallet}>Wallet & funds</button>
        </div>
      </div>
      <div className="dk-hero-r">
        <div className="dk-chart-head">
          <span className="dk-k">Banked {range === 'ALL' ? 'so far' : `in ${range}`}</span>
          {/* one profit in the range: its card carries the figure, the total would only repeat it */}
          {curve.length === 1 ? <b className="muted">1 profit</b> : <b className={inRange >= 0 ? 'pos' : 'neg'}>{usd(inRange, true)}</b>}
        </div>
        <div className="dk-ranges" role="radiogroup" aria-label="Chart range">
          {(['1H', '1D', '1W', '1M', 'ALL'] as Range[]).map((r) => <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r === '1H' ? <><span className="dk-live-dot" />1H</> : r}</button>)}
        </div>
      </div>
    </section>
  );
}

/** Profits banked over the range: steps up at each profit (a dot), slides with the clock, pulses at now. */
function BankedChart({ curve, from, onPick }: { curve: { t: number; v: number; item: BankedItem }[]; from: number; onPick: (b: BankedItem) => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const data = useRef(curve);
  data.current = curve;
  // scrubbing: a mouse over the chart, or a finger pressed and dragged along it, snaps to the nearest profit
  const wrap = useRef<HTMLDivElement>(null);
  const scrub = useRef<number | null>(null), width = useRef(0), down = useRef<{ x: number; y: number } | null>(null), hide = useRef(0);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const tipNow = useRef(tip);
  tipNow.current = tip;
  useEffect(() => () => clearTimeout(hide.current), []);
  useEffect(() => {
    let raf = 0, last = 0;
    const draw = (ms: number) => {
      raf = requestAnimationFrame(draw);
      if (ms - last < 33) return;
      last = ms;
      const c = cv.current;
      if (!c) return;
      const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const pts = data.current, now = Date.now(), span = Math.max(1, now - from);
      const max = Math.max(...pts.map((p) => p.v), 0), min = Math.min(...pts.map((p) => p.v), 0), pad = (max - min) * 0.18 || 1;
      // edge to edge across the card (room on the right for the pulse at now), the curve in the lower part
      const X = (t: number) => ((t - from) / span) * (w - 16), Y = (v: number) => h - 14 - ((v - min + pad * 0.3) / (max - min + pad * 1.3)) * (h - 40);
      const v = pts.length ? pts[pts.length - 1].v : 0;
      const path = smoothPath([[X(from), Y(0)], ...pts.map((p): [number, number] => [X(p.t), Y(p.v)]), [X(now), Y(v)]]);
      const area = new Path2D(path);
      area.lineTo(X(now), h); area.lineTo(X(from), h); area.closePath();
      const grad = g.createLinearGradient(0, Y(max), 0, h);
      grad.addColorStop(0, 'rgba(92,208,141,.26)'); grad.addColorStop(1, 'rgba(92,208,141,0)');
      g.fillStyle = grad; g.fill(area);
      g.save(); g.shadowColor = 'rgba(92,208,141,.55)'; g.shadowBlur = 14;
      g.strokeStyle = '#5CD08D'; g.lineWidth = 2.2; g.lineJoin = 'round'; g.stroke(path);
      g.restore();
      width.current = w;
      for (const p of pts) {
        const x = X(p.t), y = Y(p.v), up = (p.item.usd ?? 0) >= 0;
        g.beginPath(); g.arc(x, y, 3.6, 0, Math.PI * 2); g.fillStyle = '#0E0F11'; g.fill();
        g.lineWidth = 2; g.strokeStyle = up ? '#5CD08D' : '#F2706B'; g.stroke();
      }
      let snap: { i: number; x: number; y: number } | null = null;
      if (scrub.current != null && pts.length) {
        let i = 0;
        for (let k = 1; k < pts.length; k++) if (Math.abs(X(pts[k].t) - scrub.current) < Math.abs(X(pts[i].t) - scrub.current)) i = k;
        snap = { i, x: X(pts[i].t), y: Y(pts[i].v) };
        g.save(); g.strokeStyle = 'rgba(255,255,255,.28)'; g.setLineDash([3, 4]); g.lineWidth = 1;
        g.beginPath(); g.moveTo(snap.x, 0); g.lineTo(snap.x, h); g.stroke(); g.restore();
        g.beginPath(); g.arc(snap.x, snap.y, 9, 0, Math.PI * 2); g.fillStyle = 'rgba(92,208,141,.22)'; g.fill();
        g.beginPath(); g.arc(snap.x, snap.y, 4.5, 0, Math.PI * 2); g.fillStyle = '#5CD08D'; g.fill();
      }
      const was = tipNow.current;
      if ((snap?.i ?? -1) !== (was?.i ?? -1) || (snap && was && (Math.abs(snap.x - was.x) > 1 || Math.abs(snap.y - was.y) > 1))) setTip(snap);
      const pulse = reduced ? 0 : (ms / 900) % 1, hx = X(now), hy = Y(v);
      g.beginPath(); g.arc(hx, hy, 4 + pulse * 10, 0, Math.PI * 2); g.fillStyle = `rgba(92,208,141,${0.35 * (1 - pulse)})`; g.fill();
      g.beginPath(); g.arc(hx, hy, 4, 0, Math.PI * 2); g.fillStyle = '#5CD08D'; g.fill();
      const lastP = pts[pts.length - 1];
      if (lastP && !snap) {
        const txt = amountsText(lastP.item.amounts, 3);
        g.font = '500 12px "DM Mono", monospace';
        const tw = g.measureText(txt).width + 16, lx = Math.min(w - tw - 4, Math.max(4, X(lastP.t) - tw / 2)), ly = Math.max(2, Y(lastP.v) - 30);
        g.fillStyle = 'rgba(92,208,141,.16)'; g.strokeStyle = 'rgba(92,208,141,.6)';
        g.beginPath(); g.roundRect(lx, ly, tw, 22, 11); g.fill(); g.stroke();
        g.fillStyle = '#5CD08D'; g.fillText(txt, lx + 8, ly + 15);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [from, reduced]);
  const xOf = (e: React.PointerEvent<HTMLCanvasElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    clearTimeout(hide.current);
    if (e.pointerType !== 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
    down.current = { x: e.clientX, y: e.clientY };
    scrub.current = xOf(e);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => { if (e.pointerType === 'mouse' || down.current) scrub.current = xOf(e); };
  // a tap (or click) that didn't drag opens the profit it landed on; a finger's details linger a moment after a drag
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = down.current, t = tipNow.current;
    down.current = null;
    if (d && t && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && Math.abs(xOf(e) - t.x) < 28 && curve[t.i]) onPick(curve[t.i].item);
    if (e.pointerType !== 'mouse') hide.current = window.setTimeout(() => { scrub.current = null; }, 1600);
  };
  const onOut = (e: React.PointerEvent<HTMLCanvasElement>) => { if (e.pointerType === 'mouse') { scrub.current = null; down.current = null; } };
  const at = tip && curve[tip.i];
  // the card sits in the hero, over its text (the chart is under it): above the point when there's room, else beside it
  const box = wrap.current, hero = box?.offsetParent as HTMLElement | null | undefined;
  const top = box && tip ? box.offsetTop + tip.y : 0, x = box && tip ? box.offsetLeft + tip.x : 0;
  const place = top >= TIP_ROOM ? 'above' : x > TIP_W + 30 ? 'left' : 'right';
  const tipStyle = place === 'above'
    ? { left: box ? box.offsetLeft + Math.min(Math.max(tip!.x, TIP_W / 2 + 8), width.current - TIP_W / 2 - 8) : 0, top }
    : { left: x, top: Math.min(Math.max(top, TIP_ROOM / 2), (hero?.clientHeight ?? 0) - TIP_ROOM / 2) };
  return (
    <>
      <div className="dk-chart" ref={wrap}>
        <canvas ref={cv} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onOut} onPointerCancel={() => { scrub.current = null; down.current = null; }}
          aria-label={`Profits banked: ${curve.length} in this range`} />
        {!curve.length && <p className="dk-empty-chart">No profit banked in this range yet. It draws as profits land.</p>}
      </div>
      {at && tip && box && (
        <div className={`dk-tip ${place}`} role="status" style={tipStyle}>
          <span className="dk-tip-when">{new Date(at.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {ago(at.t)}</span>
          <b>{at.item.title}</b>
          <span className={at.item.amounts.some((a) => a.amt < 0) ? 'neg' : 'pos'}>{amountsText(at.item.amounts, 5)}</span>
          <span className="dk-tip-sub">{at.item.usd != null && <em>{usd(at.item.usd, true)} · </em>}{at.item.sub}</span>
          <span className="dk-tip-tot">Banked by then <b>{usd(at.v, true)}</b></span>
        </div>
      )}
    </>
  );
}
/** The scrub card's width, and the height it needs above its point (card + gap) */
const TIP_W = 260, TIP_ROOM = 136;

// ── cards ────────────────────────────────────────────────────────────────
function Card({ k, sym, title, sub, value, usdV, close, glow, onClick }: { k: string; sym: string; title: string; sub: string; value: string; usdV: number | null; close: number | null; glow?: boolean; onClick: () => void }) {
  const neg = value.startsWith('−');
  return (
    <button type="button" className={`dk-cardi ${glow ? 'glow' : ''} ${close != null && close >= ALMOST ? 'almost' : ''}`} data-flip={k} onClick={onClick}>
      <span className="dk-av" style={{ background: avColor(sym) }}>{sym.replace('$', '').slice(0, 1)}</span>
      <span className="dk-ct">{title}</span>
      <span className={`dk-cv ${neg ? 'neg' : 'pos'}`}>{value}</span>
      <span className="dk-cu">{usdV == null ? '' : usd(usdV, true)}</span>
      <span className="dk-cs">{sub}</span>
      {close != null && <span className="dk-bar"><i style={{ width: `${Math.round(close * 100)}%` }} /></span>}
    </button>
  );
}
const openCard = (o: OpenItem, onOpen: (id: string) => void, glow?: boolean) => (
  <Card key={o.key} k={o.key} sym={o.sym} title={o.title} sub={o.sub} value={o.value.length ? `${o.kind === 'grid' ? '≈ ' : ''}${amountsText(o.value)}` : '—'} usdV={o.usd} close={o.close} glow={glow} onClick={() => onOpen(o.botId)} />
);

function Column({ title, color, count, children }: { title: string; color: string; count: number; children: ReactNode }) {
  return (
    <div className="dk-col">
      <div className="dk-col-h"><span className="dk-pill" style={{ background: color }} />{title}<span className="dk-n">{count}</span></div>
      {children}
    </div>
  );
}

function FlowBoard({ open, banked, narrow, onOpen, onMore }: { open: OpenItem[]; banked: BankedItem[]; narrow: boolean; onOpen: (id: string) => void; onMore: (title: string, items: (OpenItem | BankedItem)[]) => void }) {
  const box = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null);
  const [col, setCol] = useState<'Open' | 'Almost' | 'Banked'>('Open');
  const fit = useFit(listRef, CARD_H);
  const sorted = useMemo(() => open.slice().sort((a, b) => b.close - a.close), [open]);
  const almost = sorted.filter((o) => o.close >= ALMOST), rest = sorted.filter((o) => o.close < ALMOST);
  const fresh = Date.now() - 8000;
  useFlip(box, `${open.map((o) => `${o.key}${o.close >= ALMOST}`).join()}|${banked.slice(0, fit).map((b) => b.key).join()}`);
  const more = (title: string, items: (OpenItem | BankedItem)[]) => (items.length > fit ? <button type="button" className="dk-more" onClick={() => onMore(title, items)}>+{items.length - fit + 1} more</button> : null);
  const show = <T,>(items: T[]) => (items.length > fit ? items.slice(0, fit - 1) : items);
  if (!open.length && !banked.length) return <Empty title="Nothing on the board yet">Start a bot and its trades show up here: each level it buys, each range it opens, then every profit it banks.</Empty>;
  const columns = [
    { title: 'Open' as const, color: 'var(--hold)', count: rest.length, body: <>{show(rest).map((o) => openCard(o, onOpen))}{more('Open', rest)}</> },
    { title: 'Almost' as const, color: 'var(--warn)', count: almost.length, body: <>{show(almost).map((o) => openCard(o, onOpen))}{more('Almost', almost)}</> },
    {
      title: 'Banked' as const, color: 'var(--profit)', count: banked.length,
      body: <>{show(banked).map((b) => <Card key={b.key} k={b.key} sym={b.sym} title={b.title} sub={`${b.sub} · ${ago(b.t)}`} value={amountsText(b.amounts)} usdV={b.usd} close={null} glow={b.t >= fresh} onClick={() => onOpen(b.botId)} />)}{more('Banked', banked)}</>,
    },
  ];
  if (narrow) {
    // a phone: one column at a time, picked by its count
    const c = columns.find((x) => x.title === col)!;
    return (
      <div className="dk-flow one" ref={box}>
        <div className="dk-flow-pick" role="radiogroup" aria-label="Column">
          {columns.map((x) => <button key={x.title} type="button" role="radio" aria-checked={col === x.title} className={col === x.title ? 'on' : ''} onClick={() => setCol(x.title)}><span className="dk-pill" style={{ background: x.color }} />{x.title}<span className="dk-n">{x.count}</span></button>)}
        </div>
        <div className="dk-list" ref={listRef}>{c.body}</div>
      </div>
    );
  }
  return (
    <div className="dk-flow" ref={box}>
      {columns.map((x, i) => (
        <Column key={x.title} title={x.title} color={x.color} count={x.count}>
          <div className="dk-list" ref={i === 0 ? listRef : undefined}>{x.body}</div>
        </Column>
      ))}
    </div>
  );
}

function LadderBoard({ ladders: ls, perView, onOpen }: { ladders: Ladder[]; perView: number; onOpen: (id: string) => void }) {
  const [first, setFirst] = useState(0);
  if (!ls.length) return <Empty title="No grid running">A grid's levels show here as a ladder, with the live price moving through them.</Empty>;
  const start = Math.min(first, Math.max(0, ls.length - perView)), shown = ls.slice(start, start + perView);
  return (
    <div className="dk-ladders-wrap">
      {ls.length > perView && (
        <div className="dk-ladder-pick">
          {ls.map((l, i) => <button key={l.botId} type="button" className={i >= start && i < start + perView ? 'on' : ''} onClick={() => setFirst(Math.min(i, ls.length - perView))}>{l.title}</button>)}
        </div>
      )}
      <div className="dk-ladders" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>{shown.map((l) => <LadderView key={l.botId} l={l} onOpen={onOpen} />)}</div>
    </div>
  );
}

function LadderView({ l, onOpen }: { l: Ladder; onOpen: (id: string) => void }) {
  const lo = l.prices[0], hi = l.prices[l.prices.length - 1];
  const y = (p: number) => `${(1 - Math.log(p / lo) / Math.log(hi / lo)) * 90 + 5}%`;
  const [flash, setFlash] = useState<number | null>(null);
  const was = useRef(l.lastSold);
  useEffect(() => {
    if (l.lastSold != null && l.lastSold !== was.current) { setFlash(l.lastSold + 1); const t = setTimeout(() => setFlash(null), 1400); was.current = l.lastSold; return () => clearTimeout(t); }
    was.current = l.lastSold;
  }, [l.lastSold]);
  const p = l.price == null ? null : Math.min(hi, Math.max(lo, l.price));
  const step = Math.max(1, Math.ceil(l.prices.length / 14));
  return (
    <button type="button" className="dk-ladder" onClick={() => onOpen(l.botId)} aria-label={`${l.title} ladder`}>
      <span className="dk-ladder-h">{l.title}<span className="dk-n">{l.holding.filter(Boolean).length} holding</span></span>
      <span className="dk-rungs">
        {l.prices.map((price, i) => (
          <span key={i} className={`dk-rung ${l.holding[i] ? 'held' : ''} ${flash === i ? 'flash' : ''}`} style={{ top: y(price) }}>
            {i % step === 0 || i === l.prices.length - 1 ? <em>{price.toPrecision(5)}</em> : null}<b />
          </span>
        ))}
        {p != null && <span className="dk-px" style={{ top: y(p) }}><em>{l.price!.toPrecision(5)}</em></span>}
      </span>
    </button>
  );
}

/** "$NEON" for a coin; a pool skipped before its coin was read is shown by its address, without the "$" */
const coinName = (label: string) => { const c = label.split('/')[0]; return c.startsWith('0x') ? c : `$${c}`; };
const STAGES: { k: 'rules' | 'checks' | 'buy' | 'bought'; name: string; small: string; color: string }[] = [
  { k: 'rules', name: 'Filter', small: 'hard rules', color: 'var(--warn)' },
  { k: 'checks', name: 'Analyst', small: 'safety checks', color: '#9B8CF2' },
  { k: 'buy', name: 'Size check', small: 'at the buy', color: 'var(--loss)' },
  { k: 'bought', name: 'Executor', small: 'bought', color: 'var(--profit)' },
];
function FunnelBoard({ funnel, held, on, onOpen, onSetup }: { funnel: ReturnType<typeof funnelOf>; held: OpenItem[]; on: boolean; onOpen: (id: string) => void; onSetup: () => void }) {
  const [hit, setHit] = useState<string | null>(null);
  const prev = useRef(funnel);
  useEffect(() => {
    const was = prev.current;
    prev.current = funnel;
    if (!was || !funnel) return;
    const k = STAGES.find((st) => funnel[st.k] > was[st.k])?.k;
    if (k) { setHit(k); const t = setTimeout(() => setHit(null), 700); return () => clearTimeout(t); }
  }, [funnel]);
  if (!funnel) {
    return <Empty title={on ? 'The funnel fills on the next scan' : 'The token trader is off'} action={<button type="button" className="dk-btn" onClick={onSetup}>{on ? 'Open the token trader' : 'Set up the token trader'}</button>}>Every new coin it finds goes through here: hard rules, safety checks, the size check at the buy, then a buy.</Empty>;
  }
  return (
    <div className="dk-funnel">
      <div className="dk-funnel-h"><b>Today</b><span><span className="mono">{funnel.scouted.toLocaleString()}</span> found · <span className="pos mono">{funnel.bought} bought</span></span></div>
      <div className="dk-stage-row scout">
        <span className="dk-ic" style={{ background: 'var(--hold)' }}>⌕</span><span className="dk-sn">Scout<small>finds new pairs</small></span>
        <span className="dk-last">{on ? 'scanning new pairs…' : 'off'}</span><span className="dk-cnt" style={{ color: 'var(--hold)' }}>{funnel.scouted.toLocaleString()} found</span>
      </div>
      {STAGES.map((st) => {
        const last = funnel.last[st.k];
        return (
          <div key={st.k} className={`dk-stage-row ${hit === st.k ? 'hit' : ''}`}>
            <span className="dk-ic" style={{ background: st.color }}>{st.k === 'bought' ? '↯' : '×'}</span>
            <span className="dk-sn">{st.name}<small>{st.small}</small></span>
            <span className="dk-last">{last ? <>{st.k === 'bought' ? <b>{coinName(last.label)}</b> : <s>{coinName(last.label)}</s>} <span className={st.k === 'bought' ? 'pos' : 'neg'}>{st.k === 'bought' ? '' : '× '}{last.why}</span></> : <span className="muted">—</span>}</span>
            <span className="dk-cnt" style={{ color: st.color }}>{funnel[st.k].toLocaleString()} {st.k === 'bought' ? 'bought' : 'out'}</span>
          </div>
        );
      })}
      {held.length > 0 && <div className="dk-list dk-held">{held.slice(0, 2).map((o) => openCard(o, onOpen))}</div>}
    </div>
  );
}

function Payday({ open, onOpen }: { open: OpenItem[]; onOpen: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box, CARD_H);
  const items = useMemo(() => open.filter((o) => o.close > 0).sort((a, b) => b.close - a.close), [open]);
  useFlip(box, items.slice(0, fit).map((o) => o.key).join());
  if (!items.length) return <p className="muted small dk-empty-s">Nothing near its target yet.</p>;
  return (
    <div className="dk-list dk-fill" ref={box}>
      {items.slice(0, fit).map((o, i) => (
        <Card key={o.key} k={`n${o.key}`} sym={o.sym} title={i === 0 ? `${o.title}  · next` : o.title} sub={o.sub} value={o.value.length ? amountsText(o.value) : '—'} usdV={o.usd} close={o.close} glow={i === 0} onClick={() => onOpen(o.botId)} />
      ))}
    </div>
  );
}

const RIVER_TYPES = new Set(['filled', 'range', 'sent', 'alert', 'started', 'stopped', 'error', 'skipped', 'queued']);
function River({ events }: { events: ActivityEvent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box, 30, 6);
  const rows = useMemo(() => events.filter((e) => RIVER_TYPES.has(e.type)).slice(-fit).reverse(), [events, fit]);
  useFlip(box, rows.map((r) => r.id).join());
  if (!rows.length) return <p className="muted small dk-empty-s">Fills, fees and range moves stream in here as they happen.</p>;
  return (
    <div className="dk-river dk-fill" ref={box}>
      {rows.map((e) => (
        <div key={e.id} className="dk-ev" data-flip={`e${e.id}`} title={e.msg}>
          <span className="dk-pill" style={{ background: e.level === 'success' ? 'var(--profit)' : e.level === 'error' ? 'var(--loss)' : e.level === 'warn' ? 'var(--warn)' : e.type === 'filled' ? 'var(--hold)' : 'var(--faint)' }} />
          <span className="dk-when">{ago(e.t)}</span>
          <span className="dk-what">{e.msg}</span>
        </div>
      ))}
    </div>
  );
}

function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="dk-empty"><b>{title}</b><p className="muted small">{children}</p>{action}</div>;
}
