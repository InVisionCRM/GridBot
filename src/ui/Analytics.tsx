/** Analytics: portfolio overview, allocation, equity/drawdown, per-bot stats, market panels, journal + CSV. */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { AnimatedNumber, Spark } from './motion';
import { EquityChart } from './Chart';
import { cls, num, pct, px, time, usd } from './fmt';
import { ChainBadge, chainOf, explorerTx, feeLabel, lbl, MarketOptions, mk, RiskBadge, useChainFilter } from './chains';
import { IND, T } from './theme';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const COLORS = [T.text, IND.slow, T.warn, IND.band, T.muted, IND.fast, T.line2];

function Kpi({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return <div className="kpi"><span>{label}</span><div className="kpi-v">{children}</div>{sub && <small className="muted">{sub}</small>}</div>;
}

export function MarketPanels({ panels }: { panels: AnyObj[] }) {
  return (
    <div className="mkt-grid">
      {panels.map((m) => (
        <div key={m.pair} className={`mkt regime-${m.regime.kind}`}>
          <div className="mkt-head">{m.chainShort && !m.legacy ? <span className="chain-badge" style={{ ['--cc' as string]: m.chainColor }}>{m.chainShort}</span> : null}<strong>{m.base ?? 'PLS'}/{m.quote ?? m.pair}</strong>{m.custom ? <RiskBadge risk={m.safety?.risk ?? 'unknown'} /> : null}<Spark data={m.spark} /><span className={`regime-tag ${m.regime.kind}`}>{m.regime.kind}</span></div>
          <div className="mkt-px">{px(m.spot)} <small className="muted">{m.quote ?? m.pair}/{m.base ?? 'PLS'} · {m.dexName ?? 'PulseX V2'} {m.feeBps != null ? feeLabel({ feeBps: m.feeBps, feeTier: m.feeTier, kind: m.feeTier != null ? 'v3' : 'v2' }) : ''}</small></div>
          <div className="mkt-row"><span>24h</span><b className={cls(m.change24h)}>{pct(m.change24h, 2, true)}</b><span>7d</span><b className={cls(m.change7d)}>{pct(m.change7d, 2, true)}</b></div>
          <div className="mkt-row"><span>Liquidity</span><b>{m.liquidityUsd ? usd(m.liquidityUsd) : '—'}</b><span>Vol 24h</span><b title={m.volumeNote}>{m.volume24hUsd ? usd(m.volume24hUsd) : '—'}</b></div>
          <div className="mkt-row"><span>ATR% 1h</span><b>{pct(m.atrPct, 2)}</b><span>Trend</span><b className={m.trend === 'up' ? 'pos' : m.trend === 'down' ? 'neg' : ''}>{m.trend ?? '—'}{m.er != null ? ` · ER ${m.er.toFixed(2)}` : ''}</b></div>
          <div className="mkt-depth">{m.depth.map((d: AnyObj) => <span key={d.usd} title="price impact buy / sell at current reserves">${d.usd}: <b>{pct(d.buyImpactPct, 2)}</b>/<b>{pct(d.sellImpactPct, 2)}</b></span>)}</div>
          <div className="mkt-hint">{m.regime.hint}</div>
        </div>
      ))}
    </div>
  );
}

export function Analytics({ status: s }: { status: AnyObj }) {
  const { chain } = useChainFilter();
  const [ov, setOv] = useState<AnyObj | null>(null);
  const [panels, setPanels] = useState<AnyObj[]>([]);
  const [j, setJ] = useState<{ total: number; rows: AnyObj[] }>({ total: 0, rows: [] });
  const [f, setF] = useState({ botId: '', kind: '', pair: '', side: '', mode: '', from: '' });
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, k === 'from' ? String(new Date(v).getTime()) : v);
    return p.toString();
  }, [f]);
  const sig = `${s.aggregate?.roundTrips}:${(s.trends ?? []).map((t: AnyObj) => t.trades.length).join(',')}:${s.grids?.length}:${s.trends?.length}`;
  useEffect(() => {
    let dead = false;
    const load = () => http('/api/analytics/overview').then((o) => !dead && setOv(o)).catch(() => undefined);
    void load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [sig]);
  useEffect(() => {
    let dead = false;
    const load = () => http(`/api/market/panels${chain !== 'all' ? `?chainId=${chain}` : ''}`).then((r) => !dead && setPanels(r.panels)).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [chain]);
  useEffect(() => { void http(`/api/analytics/journal?limit=300&${qs}`).then(setJ).catch(() => undefined); }, [qs, sig]);

  const tot = ov?.totals;
  const per = ov?.periods;
  const allocTotal = (ov?.allocation ?? []).reduce((a: number, x: AnyObj) => a + x.usd, 0);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const P = ({ k }: { k: 'today' | 'd7' | 'all' }) => {
    const p = per?.[k];
    if (!p) return <>—</>;
    const v = p.equityChange ?? p.realized;
    return <><AnimatedNumber value={v} format={(x) => usd(x, true)} className={cls(v)} /><small className="muted"> realized {usd(p.realized, true)}{p.partial ? ' · partial' : ''}</small></>;
  };

  return (
    <div className="analytics">
      <div className="card">
        <h3>Portfolio <span className="muted small">all bots on all chains · ≈USD (stables $1; other quotes via each chain's native/stable market)</span></h3>
        <div className="kpi-row">
          <Kpi label="Total equity ≈$"><AnimatedNumber value={tot?.equityUsd} format={(x) => usd(x)} className="big" /></Kpi>
          <Kpi label="Allocated" sub={`${ov?.bots?.length ?? 0} bots`}>{usd(tot?.capitalUsd)}</Kpi>
          <Kpi label="Realized"><AnimatedNumber value={tot?.realizedUsd} format={(x) => usd(x, true)} className={cls(tot?.realizedUsd)} /></Kpi>
          <Kpi label="Unrealized"><AnimatedNumber value={tot?.unrealizedUsd} format={(x) => usd(x, true)} className={cls(tot?.unrealizedUsd)} /></Kpi>
          <Kpi label="Today"><P k="today" /></Kpi>
          <Kpi label="7 days"><P k="d7" /></Kpi>
          <Kpi label="All-time"><P k="all" /></Kpi>
          <Kpi label="Fees / gas">{usd(tot?.feesUsd)} / {usd(tot?.gasUsd)}</Kpi>
          <Kpi label="vs HODL base" sub={tot?.hodlUsd ? `HODL ${usd(tot.hodlUsd)}` : undefined}><b className={cls(tot?.vsHodlPct)}>{pct(tot?.vsHodlPct, 2, true)}</b></Kpi>
        </div>
        {allocTotal > 0 && (
          <div className="alloc">
            <div className="alloc-bar">{ov!.allocation.map((a: AnyObj, i: number) => <span key={a.asset} style={{ width: `${(a.usd / allocTotal) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${a.asset} ${usd(a.usd)}`} />)}</div>
            <div className="alloc-legend small">{ov!.allocation.map((a: AnyObj, i: number) => <span key={a.asset}><i style={{ background: COLORS[i % COLORS.length] }} />{a.asset} {usd(a.usd)} ({pct(a.usd / allocTotal, 0)}){a.amount != null ? ` · ${num(a.amount, 0)}` : ''}</span>)}</div>
          </div>
        )}
        {ov?.chains?.length > 0 && (
          <table className="chain-breakdown small">
            <thead><tr><th>Chain</th><th>Bots</th><th>Equity ≈$</th><th>Allocated</th><th>Realized</th><th>Unrealized</th><th>Gas paid</th><th>Gas wallet</th></tr></thead>
            <tbody>{ov!.chains.map((c: AnyObj) => (
              <tr key={c.chainId} className={chain !== 'all' && chain !== c.chainId ? 'dim' : ''}>
                <td><span className="chain-badge" style={{ ['--cc' as string]: c.color }}>{c.short}</span> {c.name}</td>
                <td>{c.running}/{c.bots}</td><td>{usd(c.equityUsd)}</td><td>{usd(c.capitalUsd)}</td>
                <td className={cls(c.realizedUsd)}>{usd(c.realizedUsd, true)}</td><td className={cls(c.unrealizedUsd)}>{usd(c.unrealizedUsd, true)}</td>
                <td>{usd(c.gasUsd)}</td>
                <td>{c.gasNative != null ? `${num(c.gasNative, c.gasNative < 1 ? 5 : 1)} ${c.nativeSymbol}` : '—'}{c.gasNativeUsd != null ? <span className="muted"> ≈{usd(c.gasNativeUsd)}</span> : null}{c.lowGas ? <b className="neg"> LOW</b> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <EquityChart series={[{ name: 'portfolio ≈$', data: ov?.portfolio ?? [], color: T.text }]} height={240} format={(v) => usd(v)} />
        <p className="muted small">Max drawdown {pct(ov?.portfolioDrawdown, 2)} · {ov?.notes?.join(' ')}</p>
        {s.allocations?.rows?.length > 0 && (
          <p className={`small ${s.allocations.ok ? 'muted' : 'neg'}`}>Live funds coverage: {s.allocations.rows.map((r: AnyObj) => `${r.token} ${num(r.allocated, 4)} / ${r.wallet == null ? '?' : num(r.wallet, 4)} ${r.ok === false ? '✗' : '✓'}`).join(' · ')} — {s.allocations.note}</p>
        )}
      </div>

      <div className="card">
        <h3>Per-bot stats</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Bot</th><th>Mode</th><th>Equity ≈$</th><th>Return</th><th>vs HODL</th><th>Trades</th><th>Win</th><th>PF</th><th>Avg</th><th>Max DD</th><th>Streak (max)</th><th>In mkt</th><th>Best / worst</th></tr></thead>
          <tbody>{[...(ov?.bots ?? [])].sort((a: AnyObj, b: AnyObj) => Number(b.status === 'running') - Number(a.status === 'running') || (a.kind === b.kind ? 0 : a.kind === 'trend' ? -1 : 1)).map((b: AnyObj) => (
            <tr key={b.id}><td><span className={`kind ${b.kind}`}>{b.kind}</span> {b.chainId !== s.legacyChainId ? <ChainBadge c={chainOf(s, b.chainId)} testnet={false} /> : null}{b.name}</td><td>{b.mode} · {b.status}</td><td>{usd(b.equityUsd)}</td>
              <td className={cls(b.returnPct)}>{pct(b.returnPct, 2, true)}</td><td className={cls(b.vsHodlPct)}>{pct(b.vsHodlPct, 2, true)}</td>
              <td>{b.stats.count}</td><td>{pct(b.stats.winRate, 0)}</td><td>{num(b.stats.profitFactor, 2)}</td><td className={cls(b.stats.avg)}>{num(b.stats.avg, 5)}</td>
              <td className="neg">{pct(b.stats.maxDrawdown, 1)}</td>
              <td>{b.stats.streak > 0 ? `${b.stats.streak}W` : b.stats.streak < 0 ? `${-b.stats.streak}L` : '—'} ({b.stats.maxWinStreak}W/{b.stats.maxLossStreak}L)</td>
              <td>{pct(b.stats.timeInMarket, 0)}</td><td><span className="pos">{num(b.stats.best, 4)}</span> / <span className="neg">{num(b.stats.worst, 4)}</span></td></tr>
          ))}{!ov?.bots?.length && <tr><td colSpan={13} className="muted">no bots yet</td></tr>}</tbody>
        </table></div>
      </div>

      <div className="card">
        <h3>Markets <span className="muted small">depth = price impact for $100 / $500 / $1k (buy/sell) at current reserves · regime from 1h efficiency ratio + EMA20/50</span></h3>
        <MarketPanels panels={panels} />
      </div>

      <div className="card">
        <h3>Journal <span className="muted small">{j.total} rows</span></h3>
        <div className="form-row">
          <label>Bot<select value={f.botId} onChange={set('botId')}><option value="">all</option>{[...(s.grids ?? []), ...(s.trends ?? [])].map((b: AnyObj) => <option key={b.id} value={b.id}>{b.name ?? `Grid ${lbl(s, b.stable)}`} ({b.id.slice(0, 8)})</option>)}</select></label>
          <label>Kind<select value={f.kind} onChange={set('kind')}><option value="">all</option><option>grid</option><option>trend</option></select></label>
          <label>Pair<select value={f.pair} onChange={set('pair')}><option value="">all</option><MarketOptions s={s} all /></select></label>
          <label>Side<select value={f.side} onChange={set('side')}><option value="">all</option><option>buy</option><option>sell</option></select></label>
          <label>Mode<select value={f.mode} onChange={set('mode')}><option value="">all</option><option>paper</option><option>live</option></select></label>
          <label>From<input type="date" value={f.from} onChange={set('from')} /></label>
          <a className="btn small-btn" href={`/api/analytics/journal.csv?${qs}`} download>Export CSV</a>
        </div>
        <div className="table-wrap tall"><table>
          <thead><tr><th>Time</th><th>Bot</th><th>Pair</th><th>Mode</th><th>Side</th><th>Reason</th><th>Base</th><th>Quote</th><th>Price</th><th>Fee</th><th>Gas</th><th>PnL</th><th>≈$</th><th>Tx</th></tr></thead>
          <tbody>{j.rows.map((r, i) => (
            <tr key={i} className={r.failed ? 'failed-row' : ''}><td>{time(r.t)}</td><td><span className={`kind ${r.kind}`}>{r.kind}</span> {r.bot}</td><td>{lbl(s, r.pair)}</td><td>{r.mode}</td>
              <td className={`side ${r.side}`}>{r.side}</td><td>{r.reason}</td><td>{num(r.pls, 0)}</td><td>{num(r.quote, 5)}</td><td>{px(r.price)}</td>
              <td>{num(r.fee, 6)}</td><td>{num(r.gas, 6)}</td><td className={cls(r.pnl)}>{r.pnl == null ? '' : num(r.pnl, 5)}</td><td className={cls(r.pnlUsd)}>{r.pnlUsd == null ? '' : usd(r.pnlUsd, true)}</td>
              <td className="mono small">{r.tx?.startsWith('paper') ? 'paper' : r.tx ? <a href={explorerTx(s, mk(s, r.pair).chainId, r.tx)} target="_blank" rel="noreferrer">{r.tx.slice(0, 10)}…</a> : ''}</td></tr>
          ))}{!j.rows.length && <tr><td colSpan={14} className="muted">no trades match</td></tr>}</tbody>
        </table></div>
      </div>
    </div>
  );
}
