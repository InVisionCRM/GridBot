/** Analytics: portfolio overview, allocation, equity/drawdown, per-bot stats, market panels, journal + CSV. */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { AnimatedNumber, Spark } from './motion';
import { EquityChart } from './Chart';
import { cls, num, pct, px, time } from './fmt';
import { unitsText } from './deskStats';
import { inEth, inEthShort, useEthUsd } from './units';
import { ChainBadge, chainOf, explorerTx, feeLabel, lbl, MarketOptions, mk, RiskBadge, useChainFilter } from './chains';
import { IND, T } from './theme';
import { L } from './Tip';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const COLORS = [T.text, IND.slow, T.warn, IND.band, T.muted, IND.fast, T.line2];

function Kpi({ label, children, sub, tip }: { label: string; children: React.ReactNode; sub?: React.ReactNode; tip: string }) {
  return <div className="kpi"><span><L tip={tip}>{label}</L></span><div className="kpi-v">{children}</div>{sub && <small className="muted">{sub}</small>}</div>;
}

/** Per quote coin: Σ of one quote-coin field over the bots (crypto units only; no dollar totals on screen). */
function perCoin(bots: AnyObj[], v: (b: AnyObj) => number | null | undefined): Record<string, number> | null {
  let out: Record<string, number> | null = null;
  for (const b of bots) {
    const sym = b.metrics?.quote?.symbol, x = v(b);
    if (!sym || typeof x !== 'number' || !Number.isFinite(x)) continue;
    out ??= {};
    out[sym] = (out[sym] ?? 0) + x;
  }
  return out;
}

export function MarketPanels({ panels }: { panels: AnyObj[] }) {
  const ethUsd = useEthUsd();
  return (
    <div className="mkt-grid">
      {panels.map((m) => (
        <div key={m.pair} className={`mkt regime-${m.regime.kind}`}>
          <div className="mkt-head">{m.chainShort && !m.legacy ? <span className="chain-badge" style={{ ['--cc' as string]: m.chainColor }}>{m.chainShort}</span> : null}<strong>{m.base ?? 'PLS'}/{m.quote ?? m.pair}</strong>{m.custom || m.safety ? <RiskBadge risk={m.safety?.risk ?? 'unknown'} /> : null}<Spark data={m.spark} /><span className={`regime-tag ${m.regime.kind}`}>{m.regime.kind}</span></div>
          <div className="mkt-px">{px(m.spot)} <small className="muted">{m.quote ?? m.pair}/{m.base ?? 'PLS'} · {m.dexName ?? 'PulseX V2'} {m.feeBps != null ? feeLabel({ feeBps: m.feeBps, feeTier: m.feeTier, kind: m.feeTier != null ? 'v3' : 'v2' }) : ''}</small></div>
          <div className="mkt-row"><span>24h</span><b className={cls(m.change24h)}>{pct(m.change24h, 2, true)}</b><span>7d</span><b className={cls(m.change7d)}>{pct(m.change7d, 2, true)}</b></div>
          <div className="mkt-row"><span>Liquidity</span><b>{m.liquidityUsd ? inEthShort(m.liquidityUsd, ethUsd) : '—'}</b><span>Vol 24h</span><b title={m.volumeNote}>{m.volume24hUsd ? inEthShort(m.volume24hUsd, ethUsd) : '—'}</b></div>
          <div className="mkt-row"><span>ATR% 1h</span><b>{pct(m.atrPct, 2)}</b><span>Trend</span><b className={m.trend === 'up' ? 'pos' : m.trend === 'down' ? 'neg' : ''}>{m.trend ?? '—'}{m.er != null ? ` · ER ${m.er.toFixed(2)}` : ''}</b></div>
          <div className="mkt-depth">{m.depth.map((d: AnyObj) => <span key={d.usd} title="price impact buy / sell at current reserves">{inEthShort(d.usd, ethUsd)}: <b>{pct(d.buyImpactPct, 2)}</b>/<b>{pct(d.sellImpactPct, 2)}</b></span>)}</div>
          <div className="mkt-hint">{m.regime.hint}</div>
        </div>
      ))}
    </div>
  );
}

type Tab = 'live' | 'paper' | 'markets';

/** Analytics: live (real money) and paper (simulated) are separate tabs and are never added together. */
export function Analytics({ status: s, initial }: { status: AnyObj; initial: 'live' | 'paper' }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <div className="analytics">
      <div className="seg an-tabs" role="tablist" aria-label="Analytics">
        {([['live', 'Live'], ['paper', 'Paper'], ['markets', 'Market conditions']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`${tab === k ? 'on' : ''} ${k === 'paper' ? 'paper-tab' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'markets' ? <MarketsTab /> : <ModeAnalytics key={tab} s={s} mode={tab} />}
    </div>
  );
}

/** `seed`: first panels (tests); the tab loads its own. */
export function MarketsTab({ seed }: { seed?: AnyObj[] } = {}) {
  const { chain } = useChainFilter();
  const ethUsd = useEthUsd();
  const [panels, setPanels] = useState<AnyObj[]>(seed ?? []);
  useEffect(() => {
    let dead = false;
    const load = () => http(`/api/market/panels${chain !== 'all' ? `?chainId=${chain}` : ''}`).then((r) => !dead && setPanels(r.panels)).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [chain]);
  return (
    <div className="card">
      <h3>Markets <span className="muted small">depth = price impact for {[100, 500, 1000].map((u) => inEthShort(u, ethUsd)).join(' / ')} (buy/sell) at current reserves · regime from 1h efficiency ratio + EMA20/50</span></h3>
      <MarketPanels panels={panels} />
    </div>
  );
}

/** `seed`: a first overview and journal (tests render it without the network); the page loads its own. */
export function ModeAnalytics({ s, mode, seed }: { s: AnyObj; mode: 'live' | 'paper'; seed?: { ov: AnyObj; j: { total: number; rows: AnyObj[] } } }) {
  const { chain } = useChainFilter();
  const paper = mode === 'paper';
  const ethUsd = useEthUsd();
  const [ov, setOv] = useState<AnyObj | null>(seed?.ov ?? null);
  const [j, setJ] = useState<{ total: number; rows: AnyObj[] }>(seed?.j ?? { total: 0, rows: [] });
  const [f, setF] = useState({ botId: '', kind: '', pair: '', side: '', from: '' });
  const qs = useMemo(() => {
    const p = new URLSearchParams({ mode });
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, k === 'from' ? String(new Date(v).getTime()) : v);
    return p.toString();
  }, [f, mode]);
  const sig = `${(s.grids ?? []).map((g: AnyObj) => g.moveCount ?? 0).join(',')}:${(s.trends ?? []).map((t: AnyObj) => t.trades.length).join(',')}:${s.grids?.length}:${s.trends?.length}`;
  useEffect(() => {
    let dead = false;
    const load = () => http(`/api/analytics/overview?mode=${mode}`).then((o) => !dead && setOv(o)).catch(() => undefined);
    void load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [sig, mode]);
  useEffect(() => { void http(`/api/analytics/journal?limit=300&${qs}`).then(setJ).catch(() => undefined); }, [qs, sig]);
  const botsOfMode = [...(s.grids ?? []), ...(s.trends ?? [])].filter((b: AnyObj) => b.mode === mode);
  const tot = ov?.totals;
  const bots: AnyObj[] = ov?.bots ?? [];
  const per = ov?.periods;
  const allocTotal = (ov?.allocation ?? []).reduce((a: number, x: AnyObj) => a + x.usd, 0);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const P = ({ k }: { k: 'today' | 'd7' | 'all' }) => {
    const p = per?.[k];
    if (!p || !bots.length) return <>—</>;
    const v = p.equityChange ?? p.realized;
    return <><AnimatedNumber value={v} format={(x) => inEth(x, ethUsd, true)} className={cls(v)} /><small className="muted"> from trades {inEth(p.realized, ethUsd, true)}{p.partial ? ' · partial' : ''}</small></>;
  };

  return (
    <div className={`stack ${paper ? 'paper-view' : ''}`}>
      {paper
        ? <div className="banner paper-banner"><b>Paper: simulated trades, no real money.</b> Paper bots are only ever counted here, never in Live or on Home's totals.</div>
        : !ov?.bots?.length && ov ? <div className="banner">No live bots yet. Paper bots are in the <b>Paper</b> tab.</div> : null}
      <div className="card">
        <h3>{paper ? 'Paper portfolio' : 'Live portfolio'} <span className="muted small">{paper ? 'paper bots only' : 'live bots only: real money'} · all chains · per quote coin; cross-coin totals ≈ETH at ETH's price from the chain's native/stable market</span></h3>
        <div className="kpi-row">
          <Kpi label="Total value" tip="Everything the bots hold (their coins at today's prices plus the coin they spend), per quote coin. It moves with the market every day." sub={`≈ ${inEth(tot?.equityUsd, ethUsd)}`}><span className="big units">{unitsText(perCoin(bots, (b) => b.equity), 3, false)}</span></Kpi>
          <Kpi label="Allocated" tip="The amounts you gave the bots, per quote coin." sub={`${ov?.bots?.length ?? 0} bots`}><span className="units">{unitsText(perCoin(bots, (b) => b.capital), 3, false)}</span></Kpi>
          <Kpi label="From trades" tip="Banked from completed trades and liquidity fees after gas, per quote coin. Price moves don't change it."><span className={`units ${cls(tot?.realizedUsd)}`}>{unitsText(perCoin(bots, (b) => b.realized), 3)}</span></Kpi>
          <Kpi label="Open positions" tip="The change on coins bought and not sold yet, at today's price, per quote coin. It moves with the market until they sell."><span className={`units ${cls(tot?.unrealizedUsd)}`}>{unitsText(perCoin(bots, (b) => b.unrealized), 3)}</span></Kpi>
          <Kpi label="Today" tip="How much the bots' value changed since midnight (realized from trades shown below it)."><P k="today" /></Kpi>
          <Kpi label="7 days" tip="How much the bots' value changed over the last 7 days (realized from trades shown below it)."><P k="d7" /></Kpi>
          <Kpi label="All-time" tip="How much the bots' value changed since they started (realized from trades shown below it)."><P k="all" /></Kpi>
          <Kpi label="Fees / gas" tip={`Pool fees and network gas paid by your ${mode} bots, per quote coin.${paper ? " Simulated: nothing was paid." : ""}`}><span className="units">{unitsText(perCoin(bots, (b) => b.fees), 3, false)} / {unitsText(perCoin(bots, (b) => b.gas), 3, false)}</span></Kpi>
        </div>
        {allocTotal > 0 && (
          <div className="alloc">
            <div className="alloc-bar">{ov!.allocation.map((a: AnyObj, i: number) => <span key={a.asset} style={{ width: `${(a.usd / allocTotal) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${a.asset} ${a.amount != null ? num(a.amount, 4) : ''} (${pct(a.usd / allocTotal, 0)})`} />)}</div>
            <div className="alloc-legend small">{ov!.allocation.map((a: AnyObj, i: number) => <span key={a.asset}><i style={{ background: COLORS[i % COLORS.length] }} />{a.amount != null ? `${num(a.amount, a.amount < 1 ? 5 : 2)} ` : ''}{a.asset} ({pct(a.usd / allocTotal, 0)})</span>)}</div>
          </div>
        )}
        {ov?.chains?.length > 0 && (
          <table className="chain-breakdown small">
            <thead><tr><th>Chain</th><th>Bots</th><th>Equity</th><th>Allocated</th><th>From trades</th><th>Open positions</th><th>Gas paid</th>{!paper && <th>Gas wallet</th>}</tr></thead>
            <tbody>{ov!.chains.map((c: AnyObj) => { const cb = bots.filter((b) => b.chainId === c.chainId); return (
              <tr key={c.chainId} className={chain !== 'all' && chain !== c.chainId ? 'dim' : ''}>
                <td><span className="chain-badge" style={{ ['--cc' as string]: c.color }}>{c.short}</span> {c.name}</td>
                <td>{c.running}/{c.bots}</td><td>{unitsText(perCoin(cb, (b) => b.equity), 3, false)}</td><td>{unitsText(perCoin(cb, (b) => b.capital), 3, false)}</td>
                <td className={cls(c.realizedUsd)}>{unitsText(perCoin(cb, (b) => b.realized), 3)}</td><td className={cls(c.unrealizedUsd)}>{unitsText(perCoin(cb, (b) => b.unrealized), 3)}</td>
                <td>{unitsText(perCoin(cb, (b) => b.gas), 3, false)}</td>
                {!paper && <td>{c.gasNative != null ? `${num(c.gasNative, c.gasNative < 1 ? 5 : 1)} ${c.nativeSymbol}` : '—'}{c.lowGas ? <b className="neg"> LOW</b> : null}</td>}
              </tr>
            ); })}</tbody>
          </table>
        )}
        <EquityChart series={[{ name: 'portfolio ≈ETH', data: ethUsd ? (ov?.portfolio ?? []).map(([t, v]: [number, number]) => [t, v / ethUsd] as [number, number]) : [], color: T.text }]} height={240} format={(v) => `${num(v, 4)} ETH`} />
        <p className="muted small">Max drawdown {pct(ov?.portfolioDrawdown, 2)} · {ov?.notes?.join(' ')}</p>
        {!paper && s.allocations?.rows?.length > 0 && (
          <p className={`small ${s.allocations.ok ? 'muted' : 'neg'}`}>Live funds coverage: {s.allocations.rows.map((r: AnyObj) => `${r.token} ${num(r.allocated, 4)} / ${r.wallet == null ? '?' : num(r.wallet, 4)} ${r.ok === false ? '✗' : '✓'}`).join(' · ')} — {s.allocations.note}</p>
        )}
      </div>

      <div className="card">
        <h3>{paper ? 'Paper bots' : 'Live bots'}</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Bot</th><th>Status</th><th>Equity</th><th>Return</th><th>Trades</th><th>Win</th><th>PF</th><th>Avg</th><th>Max DD</th><th>Streak (max)</th><th>In mkt</th><th>Best / worst</th></tr></thead>
          <tbody>{[...(ov?.bots ?? [])].sort((a: AnyObj, b: AnyObj) => Number(b.status === 'running') - Number(a.status === 'running') || (a.kind === b.kind ? 0 : a.kind === 'trend' ? -1 : 1)).map((b: AnyObj) => (
            <tr key={b.id}><td><span className={`kind ${b.kind}`}>{b.kind}</span> {b.chainId !== s.legacyChainId ? <ChainBadge c={chainOf(s, b.chainId)} testnet={false} /> : null}{b.name}</td><td>{b.status}</td><td>{b.metrics?.quote?.symbol ? unitsText({ [b.metrics.quote.symbol]: b.equity }, 1, false) : '—'}</td>
              <td className={cls(b.returnPct)} title={b.metrics?.calc}>{pct(b.returnPct, 2, true)}</td>
              <td>{b.stats.count}</td><td>{pct(b.stats.winRate, 0)}</td><td>{num(b.stats.profitFactor, 2)}</td><td className={cls(b.stats.avg)}>{num(b.stats.avg, 5)}</td>
              <td className="neg">{pct(b.stats.maxDrawdown, 1)}</td>
              <td>{b.stats.streak > 0 ? `${b.stats.streak}W` : b.stats.streak < 0 ? `${-b.stats.streak}L` : '—'} ({b.stats.maxWinStreak}W/{b.stats.maxLossStreak}L)</td>
              <td>{pct(b.stats.timeInMarket, 0)}</td><td><span className="pos">{num(b.stats.best, 4)}</span> / <span className="neg">{num(b.stats.worst, 4)}</span></td></tr>
          ))}{!ov?.bots?.length && <tr><td colSpan={13} className="muted">no {mode} bots yet</td></tr>}</tbody>
        </table></div>
      </div>

      <div className="card">
        <h3>{paper ? 'Paper journal' : 'Live journal'} <span className="muted small">{j.total} rows</span></h3>
        <div className="form-row">
          <label>Bot<select value={f.botId} onChange={set('botId')}><option value="">all</option>{botsOfMode.map((b: AnyObj) => <option key={b.id} value={b.id}>{b.name ?? `Grid ${lbl(s, b.stable)}`} ({b.id.slice(0, 8)}){b.archivedAt ? ' (closed)' : ''}</option>)}</select></label>
          <label>Kind<select value={f.kind} onChange={set('kind')}><option value="">all</option><option>grid</option><option>trend</option></select></label>
          <label>Pair<select value={f.pair} onChange={set('pair')}><option value="">all</option><MarketOptions s={s} all /></select></label>
          <label>Side<select value={f.side} onChange={set('side')}><option value="">all</option><option>buy</option><option>sell</option></select></label>
          <label>From<input type="date" value={f.from} onChange={set('from')} /></label>
          <a className="btn small-btn" href={`/api/analytics/journal.csv?${qs}`} download>Export CSV</a>
        </div>
        <div className="table-wrap tall"><table>
          <thead><tr><th>Time</th><th>Bot</th><th>Pair</th><th>Side</th><th>Reason</th><th>Base</th><th>Quote</th><th>Price</th><th>Fee</th><th>Gas</th><th>PnL</th><th>≈ETH</th><th>Tx</th></tr></thead>
          <tbody>{j.rows.map((r, i) => (
            <tr key={i} className={r.failed ? 'failed-row' : ''}><td>{time(r.t)}</td><td><span className={`kind ${r.kind}`}>{r.kind}</span> {r.bot}</td><td>{lbl(s, r.pair)}</td>
              <td className={`side ${r.side}`}>{r.side}</td><td>{r.reason}</td><td>{num(r.pls, 0)}</td><td>{num(r.quote, 5)}</td><td>{px(r.price)}</td>
              <td>{num(r.fee, 6)}</td><td>{num(r.gas, 6)}</td><td className={cls(r.pnl)}>{r.pnl == null ? '' : num(r.pnl, 5)}</td><td className={cls(r.pnlUsd)}>{r.pnlUsd == null ? '' : inEth(r.pnlUsd, ethUsd, true)}</td>
              <td className="mono small">{r.tx?.startsWith('paper') ? 'paper' : r.tx ? <a href={explorerTx(s, mk(s, r.pair).chainId, r.tx)} target="_blank" rel="noreferrer">{r.tx.slice(0, 10)}…</a> : ''}</td></tr>
          ))}{!j.rows.length && <tr><td colSpan={13} className="muted">no trades match</td></tr>}</tbody>
        </table></div>
      </div>
    </div>
  );
}
