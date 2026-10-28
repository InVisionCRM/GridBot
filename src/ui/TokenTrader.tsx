/**
 * Token trader on the Smart trader page: limits, sniper, open positions, the decision log, and the new-pool feed.
 */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago, num, pct } from './fmt';
import { ChainBadge, chainOf } from './chains';
import { errMsg, type AnyObj } from './model';
import { haltText } from './haltText';
import { MoneyDetails } from './MoneyDetails';

const usd = (n: number) => `$${num(Math.abs(n), Math.abs(n) >= 100 ? 0 : 2)}`;

export function TokenTraderPanel({ s }: { s: AnyObj }) {
  const [t, setT] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => http('/api/token-trader').then((x) => { setT(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, [load]);
  const run = async (fn: () => Promise<AnyObj>) => {
    setBusy(true);
    try { setT(await fn()); setErr(null); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (err && !t) return <section className="card"><p className="neg">{err}</p></section>;
  if (!t) return null;
  const o = t.options;
  const chains: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const save = (patch: AnyObj) => run(() => http('/api/token-trader', 'PUT', patch));

  return (
    <section className="card" id="token-trader">
      <div className="card-head">
        <h2>Token trader</h2>
        <span className={`tag ${t.on ? (o.mode === 'live' ? 'live' : 'pos') : ''}`}>{t.on ? `On · ${o.mode}` : 'Off'}</span>
        <span className="muted small">{usd(t.openUsd ?? 0)} open of {usd(o.totalUsd)}</span>
        <span className="grow" />
        {t.on
          ? <button type="button" className="btn small-btn" disabled={busy} onClick={() => void run(() => http('/api/token-trader/off', 'POST'))}>Off</button>
          : <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => void start(o, run)}>On</button>}
      </div>
      <p className="small">New and trending pools, sized from the pool's depth, under your per-trade and total limits. Exits: a third at +50%, a third at +100%, a 20% trail after +30%, a hard stop at −25% (all measured from the effective entry, spend per token received after the pool fee, impact and tax, to what a token fetches after the exit fee and sell tax: with 1% each way, break-even is +2.03%, +7.40% with a 5% sell tax), plus liquidity pulled, a tax that appears, a failed sell, a 6h time stop and volume dying. The sniper buys a pool when liquidity is added and ignores the minimum age. Paper fills the same way, with the pool's fee, impact and tax.</p>
      {err && <div className="banner error" role="alert"><span className="grow">{err}</span></div>}
      {t.lastError && <div className="banner"><span className="grow">{t.lastError}</span></div>}
      {t.entriesHalt && (
        <div className="banner error" role="status">
          <span className="grow">
            New buys and snipes stopped{t.entriesHalt.chains ? ` on ${t.entriesHalt.chains.map((c: number) => chainOf(s, c)?.name ?? c).join(', ')}` : ''}
            {t.entriesHalt.halt ? ` (${haltText(t.entriesHalt.halt)})` : ''}.
            {' '}{t.on ? <b>Exits still managed: {t.exitsManaged ?? t.positions.length}</b> : `It is off: the exits of its ${t.positions.length} position(s) are not watched.`}
          </span>
          <button type="button" className="btn small-btn" disabled={busy} onClick={() => void run(() => http('/api/token-trader/resume-entries', 'POST'))}>Resume new buys</button>
        </div>
      )}

      <div className="tt-grid">
        <label className="smart-field"><span className="k">Per trade USD</span><input value={o.perTradeUsd} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, perTradeUsd: numIn(e.target.value) } })} onBlur={() => void save({ perTradeUsd: o.perTradeUsd })} /></label>
        <label className="smart-field"><span className="k">Total open USD</span><input value={o.totalUsd} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, totalUsd: numIn(e.target.value) } })} onBlur={() => void save({ totalUsd: o.totalUsd })} /></label>
        <label className="smart-field"><span className="k">Min pool age (hours)</span><input value={Math.round(o.minPoolAgeSec / 3600)} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, minPoolAgeSec: numIn(e.target.value) * 3600 } })} onBlur={() => void save({ minPoolAgeSec: o.minPoolAgeSec })} /></label>
        <label className="smart-field"><span className="k">Max pool share %</span><input value={Math.round(o.maxPoolShare * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxPoolShare: numIn(e.target.value) / 100 } })} onBlur={() => void save({ maxPoolShare: o.maxPoolShare })} /></label>
        <label className="smart-field"><span className="k">Impact cap %</span><input value={Math.round(o.maxImpact * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxImpact: numIn(e.target.value) / 100 } })} onBlur={() => void save({ maxImpact: o.maxImpact })} /></label>
        <label className="smart-field"><span className="k">Trade-size cap %</span><input value={Math.round((o.sizeImpactCap ?? 0.01) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, sizeImpactCap: numIn(e.target.value) / 100 } })} onBlur={() => void save({ sizeImpactCap: o.sizeImpactCap })} /></label>
        <label className="smart-field"><span className="k">Risk</span>
          <select value={o.risk} onChange={(e) => void save({ risk: e.target.value })}>
            <option value="safe">Safe</option>
            <option value="medium">Up to medium</option>
            <option value="any">Any that can trade</option>
          </select>
        </label>
        <label className="smart-field"><span className="k">Mode</span>
          <select value={o.mode} onChange={(e) => void save({ mode: e.target.value })} disabled={t.on}>
            <option value="paper">Paper</option>
            <option value="live">Live</option>
          </select>
        </label>
      </div>

      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceSizeImpact === true} onChange={(e) => void save({ enforceSizeImpact: e.target.checked })} /><span>Cap impact at the trade size</span></label>
        <span className="muted small">Off unless checked, and off changes nothing. The impact cap above still sizes the trade. When this is on, that sized trade is quoted again (V3 through the quoter) and skipped if the move is over the trade-size cap. The default cap is 1%. A quote that fails skips the buy.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.sniper.on} onChange={(e) => void save({ sniper: { ...o.sniper, on: e.target.checked } })} /><span>Sniper</span></label>
        <label className="smart-field"><span className="k">Min liquidity</span><input value={o.sniper.minLiquidityUsd} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, minLiquidityUsd: numIn(e.target.value) } } })} onBlur={() => void save({ sniper: o.sniper })} /></label>
        <label className="smart-field"><span className="k">Delay blocks</span><input value={o.sniper.delayBlocks} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, delayBlocks: numIn(e.target.value) } } })} onBlur={() => void save({ sniper: o.sniper })} /></label>
        <label className="smart-field"><span className="k">Delay seconds</span><input value={o.sniper.delaySec} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, delaySec: numIn(e.target.value) } } })} onBlur={() => void save({ sniper: o.sniper })} /></label>
        <label className="smart-field"><span className="k">Max / hour</span><input value={o.sniper.maxPerHour} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, maxPerHour: numIn(e.target.value) } } })} onBlur={() => void save({ sniper: o.sniper })} /></label>
      </div>
      <div className="tt-row">
        {chains.map((c) => (
          <label key={c.id} className="check"><input type="checkbox" checked={o.sniper.chains?.[c.id] !== false} onChange={(e) => void save({ sniper: { ...o.sniper, chains: { ...o.sniper.chains, [c.id]: e.target.checked } } })} /><span><ChainBadge c={chainOf(s, c.id)} testnet={false} /> sniper</span></label>
        ))}
      </div>
      <label className="smart-field"><span className="k">Ethereum send RPC (optional, broadcast only)</span>
        <input placeholder="https://rpc.flashbots.net" value={o.sniper.mevRpc ?? ''} onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, mevRpc: e.target.value || null } } })} onBlur={() => void save({ sniper: o.sniper })} />
      </label>

      {t.metrics && (
        <p className="small" title={t.metrics.calc}>
          Generated <b className={(t.metrics.generatedUsd ?? 0) >= 0 ? 'pos' : 'neg'}>{t.metrics.generatedUsd == null ? '—' : `${t.metrics.generatedUsd < 0 ? '−' : '+'}${usd(t.metrics.generatedUsd)}`}</b>
          <span className="muted"> from closed sells · {t.metrics.fillCount ?? 0} trades</span>
        </p>
      )}
      {t.metrics && <MoneyDetails b={t} />}
      <h3 className="small" style={{ marginTop: 14 }}>Open</h3>
      {!t.positions.length && <p className="muted small">No open positions.</p>}
      <div className="smart-bots">
        {t.positions.map((p: AnyObj) => (
          <div key={p.id} className="smart-bot" style={{ cursor: 'default' }}>
            <span className="smart-bot-name"><b>{p.label}</b> <ChainBadge c={chainOf(s, p.chainId)} testnet={false} /> <span className="tag">{p.source}</span></span>
            <span className="small muted" title="Entry = spend per token received, after the pool fee, price impact and buy tax (paper and live alike). Take profit and stops are also net of the exit fee and the sell tax measured at entry.">entry {num(p.entryPrice, 6)} after fees &amp; tax · now {num(p.price, 6)} · pool fee {feePct(p.feeBps)}{p.dynamicFee ? ' (dynamic)' : ''} · {p.exitPlan}</span>
            <span className="smart-bot-v"><b className={p.pnlUsd >= 0 ? 'pos' : 'neg'}>{pct(p.pnlPct ?? (p.spentUsd ? p.pnlUsd / p.spentUsd : null), 1, true)}</b><span className="small muted">{usd(p.pnlUsd)}</span></span>
          </div>
        ))}
      </div>

      <h3 className="small">New pools</h3>
      <ul className="smart-log">
        {(t.feed ?? []).slice(0, 12).map((f: AnyObj, i: number) => (
          <li key={i}><span className={`tag ${f.verdict === 'bought' ? 'pos' : ''}`}>{f.verdict}</span><span className="grow">{f.label}: {f.why}</span><span className="muted small">{ago(f.t)}</span></li>
        ))}
        {!t.feed?.length && <li className="muted">Nothing yet.</li>}
      </ul>

      <h3 className="small">Trades</h3>
      <ul className="smart-log">
        {(t.trades ?? []).slice(0, 12).map((tr: AnyObj, i: number) => (
          <li key={i}><b>{tr.side}</b> {tr.label}<span className="grow small">{tr.why}</span><span className="muted small">{ago(tr.t)}</span></li>
        ))}
      </ul>
    </section>
  );
}

/** bps → "0.01%", "0.05%", "0.3%", "1%" */
export function feePct(bps: number | null | undefined): string {
  return bps == null || !Number.isFinite(bps) ? '?' : `${+(bps / 100).toFixed(4)}%`;
}

function numIn(v: string) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function start(o: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<void>) {
  if (o.mode === 'live' && !confirm(`Turn the token trader on with real money? Up to $${o.perTradeUsd} a trade and $${o.totalUsd} open. The sniper is ${o.sniper.on ? 'on' : 'off'}.`)) return;
  await run(() => http('/api/token-trader/on', 'POST'));
}
