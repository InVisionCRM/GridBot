/**
 * Token trader page (Kyle, 2026-10-30: its own page like the Smart trader, easier to set up and more fun).
 * Top to bottom: the hero (on/off, paper/live, what it generated), the radar and the funnel (what it is looking at
 * right now and where each coin left), setup in three choices (style, how much, where) with every other setting under
 * Advanced, open positions on their exit ladders, the scorecard, and the trades. Server: bot/tokenTrader.ts.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { http } from './api';
import { ago, px, qty } from './fmt';
import { ChainBadge, chainOf } from './chains';
import { errMsg, type AnyObj, type Nav } from './model';
import { haltText } from './haltText';
import { MoneyDetails } from './MoneyDetails';
import { AnimatedNumber } from './motion';
import { Icon, type IconName } from './icons';
import { useEthUsd } from './units';
import { CoinLogo } from './Wallet';
import { VENUES } from '../live/venues';
import { EthLimit, SpendDetails, TokenAdvanced, blockedNote, feePct, generatedText, modeLabel, offCompletely, startTrader } from './TokenTrader';
import { STYLES, exitTrack, lookCycle, radarBlips, radarSectors, scorecard, styleOf, type ExitTrack, type TrackMark } from './tokenModel';

/** The two auto traders share the "Auto traders" tile: this switches between their pages. */
export function TraderSwitch({ at, nav }: { at: 'auto' | 'token'; nav: Nav }) {
  return (
    <nav className="tk-switch" aria-label="Auto traders">
      <button type="button" className={at === 'auto' ? 'on' : ''} aria-pressed={at === 'auto'} onClick={() => nav({ v: 'auto' })}><Icon name="spark" size={16} /> Smart trader</button>
      <button type="button" className={at === 'token' ? 'on' : ''} aria-pressed={at === 'token'} onClick={() => nav({ v: 'token' })}><Icon name="target" size={16} /> Token trader</button>
      <i className={`tk-switch-pill ${at}`} aria-hidden="true" />
    </nav>
  );
}

function useTrader(seed?: AnyObj) {
  const [t, setT] = useState<AnyObj | null>(seed ?? null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => http('/api/token-trader').then((x) => { setT(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); const id = setInterval(load, 2000); return () => clearInterval(id); }, [load]);
  return { t, setT, err, setErr };
}

/** A clock for the time rings and blip fades; tests pass a fixed time */
function useNow(fixed?: number) {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => { if (fixed != null) return; const id = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(id); }, [fixed]);
  return now;
}

export function TokenTraderPage({ s, nav, seed, now: fixedNow }: { s: AnyObj; nav: Nav; seed?: AnyObj; now?: number }) {
  const { t, setT, err, setErr } = useTrader(seed);
  const [busy, setBusy] = useState(false);
  const ethUsd = useEthUsd();
  const now = useNow(fixedNow);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const run = async (fn: () => Promise<AnyObj | void>): Promise<boolean> => {
    setBusy(true);
    try { const x = await fn(); if (x) setT(x); setErr(null); return true; } catch (e) { setErr(errMsg(e)); return false; } finally { setBusy(false); }
  };
  if (err && !t) return <main className="tk"><TraderSwitch at="token" nav={nav} /><div className="banner error"><span className="grow">{err}</span></div></main>;
  if (!t) return <main className="tk"><TraderSwitch at="token" nav={nav} /><p className="muted">Loading…</p></main>;
  const o = t.options;
  const save = (patch: AnyObj) => void run(() => http('/api/token-trader', 'PUT', patch)).then((ok) => { if (ok) setSavedAt(Date.now()); });
  const on = !!t.on, live = o.mode === 'live';

  return (
    <main className={`tk ${on ? 'is-on' : ''} ${live ? 'is-live' : ''}`}>
      <TraderSwitch at="token" nav={nav} />
      <Hero t={t} busy={busy} run={run} ethUsd={ethUsd} save={save} />
      {err && <div className="banner error" role="alert"><span className="grow">{err}</span></div>}
      {t.lastError && <div className="banner"><span className="grow">{t.lastError}</span></div>}
      {t.entriesHalt && (
        <div className="banner error" role="status">
          <span className="grow">
            New buys and snipes stopped{t.entriesHalt.chains ? ` on ${t.entriesHalt.chains.map((c: number) => chainOf(s, c)?.name ?? c).join(', ')}` : ''}
            {t.entriesHalt.halt ? ` (${haltText(t.entriesHalt.halt)})` : ''}.
            {' '}{t.runMode !== 'full' ? <b>Exits still managed: {t.exitsManaged ?? 0}</b> : `It is off completely: the exits of its ${t.positions.length} position(s) are not watched.`}
          </span>
          <button type="button" className="btn small-btn" disabled={busy} onClick={() => void run(() => http('/api/token-trader/resume-entries', 'POST'))}>Resume new buys</button>
        </div>
      )}
      <div className="tk-watch">
        <Radar t={t} s={s} now={now} live={fixedNow == null} />
        <Funnel t={t} />
      </div>
      <Setup s={s} t={t} save={save} ethUsd={ethUsd} savedAt={savedAt} />
      <Positions s={s} t={t} now={now} busy={busy} run={run} />
      <div className="tk-split">
        <Score t={t} />
        <Trades t={t} s={s} now={now} />
      </div>
      {t.metrics && t.metrics.quote?.symbol !== 'USD' && <MoneyDetails b={t} />}
      {t.metrics && t.metrics.quote?.symbol === 'USD' && <SpendDetails t={t} ethUsd={ethUsd} />}
    </main>
  );
}

// ── hero ────────────────────────────────────────────────────────────────
function Hero({ t, busy, run, ethUsd, save }: { t: AnyObj; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<boolean>; ethUsd: number | null; save: (p: AnyObj) => void }) {
  const o = t.options, on = !!t.on;
  const head = on ? 'Hunting new pools' : t.runMode === 'full' ? 'Fully off' : t.positions.length ? 'Watching its exits' : 'Resting';
  return (
    <section className="tk-hero">
      <Orb t={t} />
      <div className="tk-hero-main">
        <span className="tk-eyebrow">Token trader</span>
        <h1 className="tk-head">{head}</h1>
        <span className={`tk-mode ${on ? (o.mode === 'live' ? 'live' : 'on') : ''}`}>{modeLabel(t, o)}</span>
        {t.metrics && (
          <p className="tk-gen" title={t.metrics.calc}>
            Generated <b className={(t.metrics.generatedUsd ?? 0) >= 0 ? 'pos' : 'neg'} data-testid="tt-generated">{generatedText(t.metrics, ethUsd)}</b>
            <span className="muted"> from closed sells · {t.metrics.fillCount ?? 0} trades</span>
          </p>
        )}
      </div>
      <div className="tk-hero-act">
        <div className="tk-seg" role="group" aria-label="Paper or live">
          {(['paper', 'live'] as const).map((m) => (
            <button key={m} type="button" className={o.mode === m ? 'on' : ''} aria-pressed={o.mode === m} disabled={on || busy} title={on ? 'Turn it off to change' : undefined} onClick={() => save({ mode: m })}>{m === 'paper' ? 'Paper' : 'Live'}</button>
          ))}
        </div>
        {!on && <button type="button" className="tk-go" disabled={busy} onClick={() => void startTrader(o, run, ethUsd)}><span>Start hunting</span></button>}
        {t.runMode !== 'exits' && on && <button type="button" className="btn small-btn" disabled={busy} title="No new buys, discovery or snipes. Stop-loss and take-profit exits keep running." onClick={() => void run(() => http('/api/token-trader/off', 'POST', { mode: 'exits' }))}>Off for new buys</button>}
        {t.runMode !== 'full' && <button type="button" className="btn small-btn danger-ghost" disabled={busy} title="Runs nothing: no exits, no discovery, no buys." onClick={() => void offCompletely(t, run)}>Off completely</button>}
      </div>
    </section>
  );
}

// ── orb: one ring per discovery run ─────────────────────────────────────
/**
 * The ring fills from one discovery run to the next (status.look) and the orb sends one ripple when a run lands; a
 * buy sends a brighter one. Nothing moves while the trader is off.
 */
function Orb({ t }: { t: AnyObj }) {
  const on = !!t.on, at = t.look?.last?.at ?? null, bought = t.funnel?.bought ?? 0;
  return (
    <div className={`tk-orb ${on ? 'on' : ''} ${t.options.mode === 'live' ? 'live' : ''}`} aria-hidden="true">
      {on && at != null && <Cycle key={at} at={at} everyMs={t.look.everyMs} render={(style) => (
        <svg className="tk-orb-ring" viewBox="0 0 84 84"><circle cx="42" cy="42" r="39" className="bg" /><circle cx="42" cy="42" r="39" className="fg" pathLength={1} style={style} /></svg>
      )} />}
      {on && at != null && <i key={`look-${at}`} className="tk-orb-pulse" />}
      {on && bought > 0 && <i key={`buy-${bought}`} className="tk-orb-pulse buy" />}
      <b><Icon name="target" size={26} /></b>
    </div>
  );
}

/**
 * A CSS animation that runs once over one discovery cycle, started where the cycle is now. Keyed by the run's time, so
 * it starts over when a new run lands; its offset is read once, so a refresh doesn't move it.
 */
function Cycle({ at, everyMs, render }: { at: number; everyMs: number; render: (style: CSSProperties) => ReactNode }) {
  const [offset] = useState(() => Math.max(0, Date.now() - at));
  return <>{render({ animationDuration: `${everyMs}ms`, animationDelay: `-${Math.min(offset, everyMs)}ms` })}</>;
}

/** "next look in 12 s" (a 1 s clock of its own, so the page doesn't redraw every second) */
function NextLook({ look, live, now: fixed }: { look: AnyObj | null; live: boolean; now: number }) {
  const [now, setNow] = useState(fixed);
  useEffect(() => { if (!live) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [live]);
  const c = lookCycle(look, now);
  if (!c) return <>first look on the next check</>;
  const found = look?.last?.found ?? 0;
  return <>{c.inMs > 0 ? `next look in ${Math.ceil(c.inMs / 1000)} s` : 'looking now'} · last look found {found} pool{found === 1 ? '' : 's'}</>;
}

// ── radar ───────────────────────────────────────────────────────────────
/**
 * One slice per chain it reads. A coin is a blip in its chain's slice, as deep as it got: the rim is the rules, then
 * the safety check, then the buy; the core is bought. A new blip pops in once. The sweep goes round once per discovery
 * run and is where the next run is.
 */
function Radar({ t, s, now, live }: { t: AnyObj; s: AnyObj; now: number; live: boolean }) {
  const tradable: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const reads = tradable.map((c) => c.id as number).filter((id) => !t.options.chains?.length || t.options.chains.includes(id));
  const sectors = radarSectors(reads);
  const blips = radarBlips(t.feed, now, reads);
  const at = t.look?.last?.at ?? null;
  return (
    <section className="tk-card tk-radar-card">
      <h3><Icon name="search" size={16} /> Radar <span className="muted small">{t.on ? <NextLook look={t.look} live={live} now={now} /> : 'off: not looking'}</span></h3>
      <div className={`tk-radar ${t.on ? 'on' : ''}`}>
        <i className="tk-ring r1" /><i className="tk-ring r2" /><i className="tk-ring r3" />
        <svg className="tk-sectors" viewBox="0 0 100 100" aria-hidden="true">
          {sectors.length > 1 && sectors.map((x) => <line key={x.chainId} x1="50" y1="50" x2={50 + Math.cos(x.from) * 50} y2={50 + Math.sin(x.from) * 50} />)}
        </svg>
        {sectors.map((x) => (
          <span key={x.chainId} className="tk-sector-name" style={{ left: `${50 + Math.cos(x.mid) * 40}%`, top: `${50 + Math.sin(x.mid) * 40}%` }}>{chainOf(s, x.chainId)?.short ?? x.chainId}</span>
        ))}
        {t.on && at != null && <Cycle key={at} at={at} everyMs={t.look.everyMs} render={(style) => <i className="tk-sweep" style={style} />} />}
        {blips.map((b) => (
          <span key={b.key} className={`tk-blip is-${b.tone}`} style={{ left: `${b.x}%`, top: `${b.y}%`, opacity: b.fade }} title={`${b.label}: ${b.tone === 'bought' ? 'bought' : b.tone === 'checks' ? 'failed the safety check' : b.tone === 'buy' ? 'stopped at the buy' : 'outside the rules'}`} />
        ))}
        <b className="tk-radar-core" />
      </div>
      <p className="tk-legend small"><i className="is-rules" /> rules <i className="is-checks" /> safety <i className="is-buy" /> at the buy <i className="is-bought" /> bought</p>
      <ul className="tk-feed">
        {(t.feed ?? []).slice(0, 6).map((f: AnyObj) => (
          <li key={`${f.pool}:${f.t}`} className={`tk-feed-row is-${f.verdict === 'bought' ? 'bought' : f.stage ?? 'rules'}`}>
            <span className="tk-chip">{f.verdict === 'bought' ? 'bought' : f.stage === 'checks' ? 'unsafe' : f.stage === 'buy' ? 'at buy' : 'rule'}</span>
            {f.chainId ? <ChainBadge c={chainOf(s, f.chainId)} testnet={false} /> : null}
            <b className="tk-feed-label">{f.label}</b>
            <span className="tk-feed-why">{f.why}</span>
            <span className="muted small">{ago(f.t, now)}</span>
          </li>
        ))}
        {!t.feed?.length && <li className="muted small">Pools it looks at show here as they land.</li>}
      </ul>
    </section>
  );
}

// ── funnel ──────────────────────────────────────────────────────────────
const STAGES: { key: 'scouted' | 'rules' | 'checks' | 'buy' | 'bought'; label: string; sub: string; icon: IconName }[] = [
  { key: 'scouted', label: 'Found', sub: 'new and trending pools', icon: 'search' },
  { key: 'rules', label: 'Rules', sub: 'age, liquidity, chain, venue', icon: 'list' },
  { key: 'checks', label: 'Safety', sub: 'honeypot, tax, owner, holders', icon: 'pulse' },
  { key: 'buy', label: 'At the buy', sub: 'size, impact, fee', icon: 'coins' },
  { key: 'bought', label: 'Bought', sub: 'today', icon: 'spark' },
];
function Funnel({ t }: { t: AnyObj }) {
  const f = t.funnel ?? { scouted: 0, rules: 0, checks: 0, buy: 0, bought: 0 };
  const top = Math.max(1, f.scouted);
  return (
    <section className="tk-card tk-funnel">
      <h3><Icon name="list" size={16} /> Today's funnel</h3>
      <ol className={`tk-stages ${t.on ? 'on' : ''}`}>
        {STAGES.map((st, i) => {
          const n = f[st.key] ?? 0;
          const out = st.key !== 'scouted' && st.key !== 'bought';
          return (
            <li key={st.key} className={`tk-stage is-${st.key}`} style={{ animationDelay: `${i * 70}ms` }}>
              <span className="tk-stage-ic"><Icon name={st.icon} size={18} /></span>
              <span className="tk-stage-name"><b>{st.label}</b><small>{st.sub}</small></span>
              <StageCount n={n} out={out} />
              <span className="tk-stage-bar"><i style={{ width: `${Math.min(100, (n / top) * 100)}%` }} /></span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A stage's count; when it rises between refreshes, the stage lights up once and shows how many came in. */
function StageCount({ n, out }: { n: number; out: boolean }) {
  const prev = useRef(n);
  const [bump, setBump] = useState<{ by: number; at: number } | null>(null);
  useEffect(() => { if (n > prev.current) setBump({ by: n - prev.current, at: n }); prev.current = n; }, [n]);
  return (
    <span className="tk-stage-n">
      {bump && <i key={bump.at} className="tk-stage-hit" aria-hidden="true" onAnimationEnd={() => setBump(null)} />}
      <AnimatedNumber value={n} format={(x) => Math.round(x).toLocaleString()} />{out ? <small> out</small> : null}
      {bump && <em key={`+${bump.at}`} className="tk-bump">+{bump.by}</em>}
    </span>
  );
}

// ── setup ───────────────────────────────────────────────────────────────
function Setup({ s, t, save, ethUsd, savedAt }: { s: AnyObj; t: AnyObj; save: (p: AnyObj) => void; ethUsd: number | null; savedAt: number | null }) {
  const o = t.options;
  const style = styleOf(o);
  const tradable: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const chainOn = (id: number) => !o.chains?.length || o.chains.includes(id);
  const onCount = tradable.filter((c) => chainOn(c.id)).length;
  const toggleChain = (id: number) => {
    const next = tradable.map((c) => c.id).filter((x) => (x === id ? !chainOn(id) : chainOn(x)));
    save({ chains: next.length === tradable.length ? [] : next });
  };
  const venues = VENUES.filter((v) => tradable.some((c) => c.id === v.chainId));
  return (
    <section className="tk-card tk-setup">
      <h3><Icon name="gear" size={16} /> Set it up {savedAt != null && <span key={savedAt} className="tk-saved" role="status">Saved ✓</span>}<span className="muted small">three choices; each change saves when you tap it or leave its box</span></h3>
      <Step n={1} title="Style" note={style ? null : 'Custom: set by hand under Advanced'}>
        <div className="tk-styles">
          {STYLES.map((st, i) => (
            <button key={st.id} type="button" className={`tk-style ${st.id} ${style === st.id ? 'on' : ''}`} aria-pressed={style === st.id} style={{ animationDelay: `${i * 80}ms` }} onClick={() => save(st.patch)}>
              <b>{st.name}</b><small>{st.line}</small><i className="tk-style-tick" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Step>
      <Step n={2} title="How much">
        <div className="tk-amounts">
          <EthLimit label="Per trade" usd={o.perTradeUsd} ethUsd={ethUsd} onSave={(v) => save({ perTradeUsd: v })} />
          <EthLimit label="Total open" usd={o.totalUsd} ethUsd={ethUsd} onSave={(v) => save({ totalUsd: v })} />
        </div>
      </Step>
      <Step n={3} title="Where">
        <div className="tk-chips">
          {tradable.map((c) => (
            <button key={c.id} type="button" className={`tk-pill ${chainOn(c.id) ? 'on' : ''}`} aria-pressed={chainOn(c.id)} disabled={chainOn(c.id) && onCount === 1} title={chainOn(c.id) && onCount === 1 ? 'At least one chain stays on' : undefined} onClick={() => toggleChain(c.id)}>
              <ChainBadge c={chainOf(s, c.id)} testnet={false} /> {c.name}
            </button>
          ))}
        </div>
        {venues.length > 0 && (
          <>
            <span className="tk-sub">Launch venues</span>
            <div className="tk-chips">
              {venues.map((v) => (
                <button key={v.id} type="button" className={`tk-pill ${o.venues?.[v.id] !== false ? 'on' : ''}`} aria-pressed={o.venues?.[v.id] !== false} onClick={() => save({ venues: { [v.id]: o.venues?.[v.id] === false } })}>
                  <ChainBadge c={chainOf(s, v.chainId)} testnet={false} /> {v.name}
                </button>
              ))}
            </div>
            <span className="muted small">Launcher pools (Pons V2 Dex, Long.xyz, Bankr, Frontier) take a cut of every swap through their hook. The safety check counts it as a tax, so the Careful style skips them.</span>
          </>
        )}
        <label className="tk-toggle">
          <input type="checkbox" checked={!!o.sniper.on} onChange={(e) => save({ sniper: { on: e.target.checked } })} />
          <span className="tk-toggle-track" aria-hidden="true"><i /></span>
          <span><b>Sniper</b> <small className="muted">buys a pool the moment liquidity lands (skips the age rule)</small></span>
        </label>
      </Step>
      <details className="tk-more">
        <summary><Icon name="list" size={14} /> Advanced <span className="muted small">limits, checks, sniper timing, send RPC</span></summary>
        <TokenAdvanced s={s} t={t} save={save} />
      </details>
    </section>
  );
}

function Step({ n, title, note, children }: { n: number; title: string; note?: string | null; children: ReactNode }) {
  return (
    <div className="tk-step">
      <span className="tk-step-n">{n}</span>
      <div className="tk-step-body"><span className="tk-step-title">{title}{note ? <small className="muted"> · {note}</small> : null}</span>{children}</div>
    </div>
  );
}

// ── positions ───────────────────────────────────────────────────────────
function Positions({ s, t, now, busy, run }: { s: AnyObj; t: AnyObj; now: number; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<boolean> }) {
  const ps: AnyObj[] = t.positions ?? [];
  return (
    <section className="tk-card">
      <h3><Icon name="coins" size={16} /> Open positions <span className="muted small">{ps.length ? `${ps.length} open · flip a card for its numbers` : 'none open'}</span></h3>
      {!ps.length && <p className="muted small">Each buy shows here as a card: its price since the buy, how far it is from each exit, and what it is worth.</p>}
      {ps.length > 0 && <div className="tk-cards">{ps.map((p) => <PositionCard key={p.id} p={p} s={s} now={now} busy={busy} run={run} />)}</div>}
    </section>
  );
}

/** A price older than this is stale: the trader re-reads every open position each 10 s tick */
const STALE_MS = 60_000;
const hm = (ms: number) => `${Math.floor(ms / 3600_000)}h ${String(Math.floor((ms % 3600_000) / 60_000)).padStart(2, '0')}m`;
const signed = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;

/**
 * One open position as a card. Front: result, chart since the buy, the exit track (stop … last take-profit, with the
 * result now on it) and the time stop. Back (Flip): the position's numbers. Exits: each rule and how far away it is.
 */
function PositionCard({ p, s, now, busy, run }: { p: AnyObj; s: AnyObj; now: number; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<boolean> }) {
  const [flipped, setFlipped] = useState(false);
  const [exitsOpen, setExitsOpen] = useState(false);
  const pnl = Number(p.pnl ?? 0), gain = Number(p.pnlPct ?? 0), up = pnl >= 0;
  const sym = p.spendSym ?? '';
  const chain = chainOf(s, p.chainId);
  const blocked = blockedNote(p);
  const stale = p.markedAt == null || now - Number(p.markedAt) > STALE_MS;
  const track = exitTrack(p.exits);
  const sell = () => {
    if (p.mode === 'live' && !confirm(`Sell all of ${p.tokenSym} now, with real money? It sells through the pool like any exit (split under the impact cap).`)) return;
    void run(() => http(`/api/token-trader/positions/${encodeURIComponent(p.id)}/sell`, 'POST'));
  };
  const read = p.markedAt == null ? 'price not read yet' : `price read ${ago(p.markedAt, now)}`;
  return (
    <article className={`tk-pc ${up ? 'up' : 'down'} ${flipped ? 'flipped' : ''}`}>
      <div className="tk-pc-flip">
        <div className="tk-pc-face tk-pc-front" aria-hidden={flipped}>
          <header className="tk-pc-top">
            <CoinLogo coin={{ chainId: p.chainId, address: p.token, symbol: p.tokenSym }} chain={chain} size={38} />
            <span className="tk-pc-name"><b>{p.tokenSym}</b><small>{chain?.short ?? ''} · held {ago(p.openedAt, now).replace(' ago', '')}{p.source === 'snipe' ? ' · sniped' : ''}</small></span>
            <button type="button" className="tk-pc-flipbtn" onClick={() => setFlipped(true)} tabIndex={flipped ? -1 : 0}>Flip <span aria-hidden="true">↻</span></button>
          </header>
          <div className="tk-pc-result">
            <span className={`tk-pc-pct ${up ? 'pos' : 'neg'}`}><AnimatedNumber value={gain * 100} format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`} /></span>
            <span className="tk-pc-worth">{p.value != null ? qty(p.value, sym, 4, false) : '—'}<small className={up ? 'pos' : 'neg'}>{p.pnl != null ? qty(pnl, sym, 4) : ''}</small></span>
          </div>
          <Spark marks={p.marks ?? []} entry={Number(p.entryPrice)} up={up} />
          <p className={`tk-pc-read ${stale ? 'stale' : ''}`}><i aria-hidden="true" />{read}{stale ? ' · stale' : ''}</p>
          {track ? <ExitBar k={track} /> : <p className="muted small">The exit track shows once the price is read.</p>}
          {track?.time && <TimeBar t={track.time} />}
        </div>
        <div className="tk-pc-face tk-pc-back" aria-hidden={!flipped}>
          <header className="tk-pc-top">
            <span className="tk-pc-name"><b>{p.tokenSym}</b><small>{p.label} · {p.mode === 'live' ? 'live' : 'paper'}</small></span>
            <button type="button" className="tk-pc-flipbtn" onClick={() => setFlipped(false)} tabIndex={flipped ? 0 : -1}>Back <span aria-hidden="true">↺</span></button>
          </header>
          <dl className="tk-pc-facts">
            <div><dt>Spent</dt><dd>{qty(p.spent, sym, 5, false)}</dd></div>
            <div><dt>Holding</dt><dd>{qty(p.tokens, p.tokenSym, 5, false)}{p.entryTokens > 0 && p.tokens < p.entryTokens ? <small> · {Math.round((p.tokens / p.entryTokens) * 100)}% of the buy</small> : null}</dd></div>
            <div><dt>Bought at</dt><dd>{px(p.entryPrice)} {sym}</dd></div>
            <div><dt>Price now</dt><dd>{px(p.price)} {sym}</dd></div>
            <div><dt>Highest since buy</dt><dd>{p.entryPrice > 0 ? signed(p.peak / p.entryPrice - 1) : '—'} vs the buy</dd></div>
            <div><dt>Pool fee</dt><dd>{feePct(p.feeBps)}{p.dynamicFee ? ' (changes)' : ''}</dd></div>
            <div><dt>Sell tax</dt><dd>{(Number(p.sellTax) * 100).toFixed(1)}%</dd></div>
            {p.liqBase === 'chain' && p.entryLiq > 0 && <div><dt>Pool depth</dt><dd>{Math.round((p.liq / p.entryLiq) * 100)}% of the buy&apos;s</dd></div>}
            <div><dt>Found by</dt><dd>{p.source === 'snipe' ? 'sniper' : 'scan'} · {ago(p.openedAt, now)}</dd></div>
          </dl>
        </div>
      </div>
      {blocked && <p className="tk-pc-block neg" role="alert">{blocked}</p>}
      <div className="tk-pc-acts">
        <button type="button" className="tk-pc-drop" aria-expanded={exitsOpen} onClick={() => setExitsOpen(!exitsOpen)}>Exits <span className="tk-pc-caret" aria-hidden="true">▾</span></button>
        <button type="button" className="tk-sell" disabled={busy || !!p.sellNow} onClick={sell}>{p.sellNow ? 'Selling…' : 'Sell now'}</button>
      </div>
      {exitsOpen && <ul className="tk-pc-exits">{(p.exits ?? []).map((x: AnyObj) => <ExitLine key={x.key} x={x} />)}</ul>}
    </article>
  );
}

/** The exit track: stop on the left, the last take-profit on the right, the result now as a filled bar from the buy */
function ExitBar({ k }: { k: ExitTrack }) {
  const zero = Math.max(0, Math.min(100, ((0 - k.lo) / (k.hi - k.lo)) * 100));
  const up = k.now >= 0;
  // labels closer than this (percent of the track) to one already placed are left off; the ends go first
  const shown: TrackMark[] = [];
  for (const m of [...k.marks].sort((a, b) => Number(b.key === 'stop' || b.key === 'tp2') - Number(a.key === 'stop' || a.key === 'tp2'))) {
    if (shown.every((o) => Math.abs(o.x - m.x) >= 13)) shown.push(m);
  }
  shown.sort((a, b) => a.x - b.x);
  return (
    <div className="tk-pc-track" role="img" aria-label={`result ${signed(k.now)}: stop at ${signed(k.lo, 0)}, last take-profit at ${signed(k.hi, 0)}`}>
      <div className="tk-pc-rail">
        <i className={`tk-pc-fill ${up ? 'up' : 'down'}`} style={{ left: `${Math.min(zero, k.x)}%`, width: `${Math.abs(k.x - zero)}%` }} />
        <i className="tk-pc-zero" style={{ left: `${zero}%` }} />
        {k.marks.map((m) => <i key={m.key} className={`tk-pc-tick is-${m.key} ${m.done ? 'done' : ''}`} style={{ left: `${m.x}%` }} title={`${m.key === 'stop' ? 'stop-loss' : m.key === 'trail' ? 'trailing stop' : 'take a third'} at ${signed(m.at, 0)}`} />)}
        <b className={`tk-pc-dot ${up ? 'up' : 'down'}`} style={{ left: `${k.x}%` }} />
      </div>
      <div className="tk-pc-scale">{shown.map((m) => <span key={m.key} className={`is-${m.key}`} style={{ left: `${m.x}%` }}>{signed(m.at, 0)}</span>)}</div>
    </div>
  );
}

/** The time stop as a bar filling up over its span */
function TimeBar({ t }: { t: NonNullable<ExitTrack['time']> }) {
  return (
    <div className={`tk-pc-time ${t.off ? 'off' : ''}`}>
      <span>Time stop</span>
      <span className="tk-pc-timebar"><i style={{ width: `${t.frac * 100}%` }} /></span>
      <span className="mono">{t.off ? 'off · up enough' : `${hm(t.msLeft)} left`}</span>
    </div>
  );
}

/** One exit rule: what it does and how far the price is from it */
export function ExitLine({ x }: { x: AnyObj }) {
  const label: Record<string, string> = { stop: 'Stop-loss', trail: x.armed ? 'Trailing stop' : 'Trailing stop (not armed)', tp1: 'Take profit 1', tp2: 'Take profit 2', time: 'Time stop' };
  const away = x.key === 'time'
    ? (String(x.does).startsWith('off') ? 'off' : `${hm(x.msLeft)} left`)
    : x.done ? 'taken' : x.move == null ? '—' : `${signed(x.move)} away`;
  return <li className={`tk-pc-exit is-${x.key} ${x.done ? 'done' : ''}`}><i aria-hidden="true" /><span><b>{label[x.key] ?? x.label}</b><small>{x.does}</small></span><em>{away}</em></li>;
}

/** The position's prices since the buy, with the buy price dashed */
function Spark({ marks, entry, up }: { marks: [number, number][]; entry: number; up: boolean }) {
  const W = 96, H = 26;
  if (marks.length < 2) return <svg className="tk-spark empty" viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><line x1="0" x2={W} y1={H / 2} y2={H / 2} className="entry" /></svg>;
  const ys = [...marks.map((m) => m[1]), entry].filter((v) => Number.isFinite(v) && v > 0);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || hi * 0.01 || 1;
  const t0 = marks[0][0], t1 = marks[marks.length - 1][0];
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W, y = (v: number) => H - 2 - ((v - lo) / span) * (H - 4);
  const pts = marks.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className={`tk-spark ${up ? 'up' : 'down'}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="price since the buy">
      <line x1="0" x2={W} y1={y(entry)} y2={y(entry)} className="entry" />
      <polyline points={pts} className="line" />
    </svg>
  );
}

// ── scorecard & trades ──────────────────────────────────────────────────
function Score({ t }: { t: AnyObj }) {
  const sc = scorecard(t.trades);
  const R = 26, C = 2 * Math.PI * R;
  return (
    <section className="tk-card tk-score">
      <h3><Icon name="target" size={16} /> Scorecard <span className="muted small">closed sells</span></h3>
      <div className="tk-score-row">
        <svg className="tk-win" viewBox="0 0 64 64" aria-label={sc.winRate == null ? 'no closed sells yet' : `${Math.round(sc.winRate * 100)}% of sells made money`}>
          <circle cx="32" cy="32" r={R} className="bg" />
          <circle cx="32" cy="32" r={R} className="fg" strokeDasharray={C} strokeDashoffset={C * (1 - (sc.winRate ?? 0))} />
          <text x="32" y="36" textAnchor="middle">{sc.winRate == null ? '—' : `${Math.round(sc.winRate * 100)}%`}</text>
        </svg>
        <dl>
          <div><dt>Sells</dt><dd>{sc.sells}</dd></div>
          <div><dt>Won</dt><dd className="pos">{sc.wins}</dd></div>
          <div><dt>Best</dt><dd className="pos">{sc.best ? `${sc.best.label} ${qty(sc.best.pnl, sc.best.spendSym ?? '', 4)}` : '—'}</dd></div>
          <div><dt>Worst</dt><dd className="neg">{sc.worst ? `${sc.worst.label} ${qty(sc.worst.pnl, sc.worst.spendSym ?? '', 4)}` : '—'}</dd></div>
        </dl>
      </div>
    </section>
  );
}

function Trades({ t, s, now }: { t: AnyObj; s: AnyObj; now: number }) {
  return (
    <section className="tk-card">
      <h3><Icon name="activity" size={16} /> Trades</h3>
      <ul className="tk-trades">
        {(t.trades ?? []).slice(0, 8).map((tr: AnyObj, i: number) => (
          <li key={`${tr.t}:${tr.pool}:${i}`} className={`is-${tr.side}${tr.pnl != null && tr.pnl < 0 ? ' is-loss' : ''}`} style={{ animationDelay: `${i * 40}ms` }}>
            <span className="tk-chip">{tr.side}</span>
            <ChainBadge c={chainOf(s, tr.chainId)} testnet={false} />
            <b>{tr.label}</b>
            <span className="tk-feed-why">{tr.why}</span>
            {tr.pnl != null && tr.spendSym ? <b className={tr.pnl >= 0 ? 'pos' : 'neg'}>{qty(tr.pnl, tr.spendSym, 4)}</b> : null}
            <span className="muted small">{ago(tr.t, now)}</span>
          </li>
        ))}
        {!t.trades?.length && <li className="muted small">No trades yet.</li>}
      </ul>
    </section>
  );
}
