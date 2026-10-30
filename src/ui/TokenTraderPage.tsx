/**
 * Token trader page (Kyle, 2026-10-30: its own page like the Smart trader, easier to set up and more fun).
 * Top to bottom: the hero (on/off, paper/live, what it generated), the radar and the funnel (what it is looking at
 * right now and where each coin left), setup in three choices (style, how much, where) with every other setting under
 * Advanced, open positions on their exit ladders, the scorecard, and the trades. Server: bot/tokenTrader.ts.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { http } from './api';
import { ago, pct, qty } from './fmt';
import { ChainBadge, chainOf } from './chains';
import { errMsg, type AnyObj, type Nav } from './model';
import { haltText } from './haltText';
import { MoneyDetails } from './MoneyDetails';
import { AnimatedNumber } from './motion';
import { Icon, type IconName } from './icons';
import { useEthUsd } from './units';
import { VENUES } from '../live/venues';
import { EthLimit, SpendDetails, TokenAdvanced, blockedNote, feePct, generatedText, modeLabel, offCompletely, startTrader } from './TokenTrader';
import { STYLES, ladderRungs, ladderX, radarBlips, scorecard, styleOf, timeUsed } from './tokenModel';

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
  useEffect(() => { void load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, [load]);
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
  const run = async (fn: () => Promise<AnyObj | void>) => {
    setBusy(true);
    try { const x = await fn(); if (x) setT(x); setErr(null); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (err && !t) return <main className="tk"><TraderSwitch at="token" nav={nav} /><div className="banner error"><span className="grow">{err}</span></div></main>;
  if (!t) return <main className="tk"><TraderSwitch at="token" nav={nav} /><p className="muted">Loading…</p></main>;
  const o = t.options;
  const save = (patch: AnyObj) => void run(() => http('/api/token-trader', 'PUT', patch));
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
        <Radar t={t} s={s} now={now} />
        <Funnel t={t} />
      </div>
      <Setup s={s} t={t} setT={setT} save={save} ethUsd={ethUsd} />
      <Positions s={s} t={t} now={now} />
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
function Hero({ t, busy, run, ethUsd, save }: { t: AnyObj; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<void>; ethUsd: number | null; save: (p: AnyObj) => void }) {
  const o = t.options, on = !!t.on;
  const head = on ? 'Hunting new pools' : t.runMode === 'full' ? 'Fully off' : t.positions.length ? 'Watching its exits' : 'Resting';
  return (
    <section className="tk-hero">
      <div className={`tk-orb ${on ? 'on' : ''} ${o.mode === 'live' ? 'live' : ''}`} aria-hidden="true"><i /><i /><i /><b><Icon name="target" size={26} /></b></div>
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

// ── radar ───────────────────────────────────────────────────────────────
function Radar({ t, s, now }: { t: AnyObj; s: AnyObj; now: number }) {
  const blips = radarBlips(t.feed, now);
  const last = (t.feed ?? [])[0];
  return (
    <section className="tk-card tk-radar-card">
      <h3><Icon name="search" size={16} /> Radar <span className="muted small">{last ? `last look ${ago(last.t, now)}` : 'nothing yet'}</span></h3>
      <div className={`tk-radar ${t.on ? 'on' : ''}`}>
        <i className="tk-ring r1" /><i className="tk-ring r2" /><i className="tk-ring r3" /><i className="tk-cross" />
        <i className="tk-sweep" />
        {blips.map((b, i) => (
          <span key={b.key} className={`tk-blip is-${b.tone}`} style={{ left: `${b.x}%`, top: `${b.y}%`, opacity: b.fade, animationDelay: `${i * 60}ms` }} title={b.label} />
        ))}
        <b className="tk-radar-core" />
      </div>
      <ul className="tk-feed">
        {(t.feed ?? []).slice(0, 6).map((f: AnyObj, i: number) => (
          <li key={`${f.pool}:${f.t}`} className={`tk-feed-row is-${f.verdict === 'bought' ? 'bought' : f.stage ?? 'rules'}`} style={{ animationDelay: `${i * 45}ms` }}>
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
              <span className="tk-stage-n"><AnimatedNumber value={n} format={(x) => Math.round(x).toLocaleString()} />{out ? <small> out</small> : null}</span>
              <span className="tk-stage-bar"><i style={{ width: `${Math.min(100, (n / top) * 100)}%` }} /></span>
              {i < STAGES.length - 1 && <span className="tk-flow" aria-hidden="true"><i /><i /><i /></span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ── setup ───────────────────────────────────────────────────────────────
function Setup({ s, t, setT, save, ethUsd }: { s: AnyObj; t: AnyObj; setT: (t: AnyObj) => void; save: (p: AnyObj) => void; ethUsd: number | null }) {
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
      <h3><Icon name="gear" size={16} /> Set it up <span className="muted small">three choices; everything else is under Advanced</span></h3>
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
          <input type="checkbox" checked={!!o.sniper.on} onChange={(e) => save({ sniper: { ...o.sniper, on: e.target.checked } })} />
          <span className="tk-toggle-track" aria-hidden="true"><i /></span>
          <span><b>Sniper</b> <small className="muted">buys a pool the moment liquidity lands (skips the age rule)</small></span>
        </label>
      </Step>
      <details className="tk-more">
        <summary><Icon name="list" size={14} /> Advanced <span className="muted small">limits, checks, sniper timing, send RPC</span></summary>
        <TokenAdvanced s={s} t={t} setT={setT} save={save} />
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
function Positions({ s, t, now }: { s: AnyObj; t: AnyObj; now: number }) {
  const ps: AnyObj[] = t.positions ?? [];
  return (
    <section className="tk-card">
      <h3><Icon name="coins" size={16} /> Open positions <span className="muted small">{ps.length ? `${ps.length} open` : 'none open'}</span></h3>
      {!ps.length && <p className="muted small">Each buy shows here on its exit ladder: the stop at −25%, take profits at +50% and +100%, a trailing stop once it is up 30%, and a 6 h time stop.</p>}
      <div className="tk-pos-grid">
        {ps.map((p, i) => <PositionCard key={p.id} p={p} s={s} now={now} i={i} />)}
      </div>
    </section>
  );
}

function PositionCard({ p, s, now, i }: { p: AnyObj; s: AnyObj; now: number; i: number }) {
  const gain = Number(p.pnlPct ?? 0);
  const x = ladderX(gain) * 100, zero = ladderX(0) * 100;
  const used = timeUsed(Number(p.openedAt), now);
  const R = 15, C = 2 * Math.PI * R;
  const blocked = blockedNote(p);
  return (
    <article className={`tk-pos ${gain >= 0 ? 'up' : 'down'}`} style={{ animationDelay: `${i * 70}ms` }}>
      <header>
        <b>{p.label}</b>
        <ChainBadge c={chainOf(s, p.chainId)} testnet={false} />
        <span className="tk-chip">{p.source}</span>
        <span className="grow" />
        <svg className="tk-clock" viewBox="0 0 36 36" aria-label={`${Math.round(used * 100)}% of the 6 h time stop used`}>
          <circle cx="18" cy="18" r={R} className="bg" />
          <circle cx="18" cy="18" r={R} className="fg" strokeDasharray={C} strokeDashoffset={C * (1 - used)} />
        </svg>
      </header>
      <div className="tk-pos-big">
        <AnimatedNumber value={gain * 100} format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`} className={gain >= 0 ? 'pos' : 'neg'} />
        <small>{p.pnl != null && p.spendSym ? qty(p.pnl, p.spendSym, 5) : ''}</small>
      </div>
      <div className="tk-ladder" aria-label={`at ${pct(gain, 1, true)} on the exit ladder`}>
        <i className={`tk-ladder-fill ${gain >= 0 ? 'up' : 'down'}`} style={{ left: `${Math.min(x, zero)}%`, width: `${Math.abs(x - zero)}%` }} />
        {ladderRungs(p).map((r) => <span key={r.key} className={`tk-rung ${r.kind} ${r.done ? 'done' : ''}`} style={{ left: `${r.x * 100}%` }}><em>{r.label}</em></span>)}
        <i className="tk-puck" style={{ left: `${x}%` }} />
      </div>
      <p className="tk-pos-foot small">
        {blocked ? <b className="neg" role="alert">{blocked}</b> : <>exit plan: {p.exitPlan}</>}
        <span className="muted"> · pool fee {feePct(p.feeBps)}{p.dynamicFee ? ' (dynamic)' : ''} · opened {ago(p.openedAt, now)}</span>
      </p>
    </article>
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
