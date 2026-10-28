/**
 * Token trader on the Smart trader page: limits, sniper, open positions, the decision log, and the new-pool feed.
 */
import { useCallback, useEffect, useState } from 'react';
import { SCAN_RULES } from '../market/scan';
import { http } from './api';
import { ago, num, pct, qty } from './fmt';
import { ChainBadge, chainOf } from './chains';
import { errMsg, type AnyObj } from './model';
import { haltText } from './haltText';
import { MoneyDetails } from './MoneyDetails';
import { unitsText } from './deskStats';
import { ENFORCED_LIQUIDITY_FLOOR_USD, shownMinLiquidityUsd } from '../market/liquidityFloor';
import { coinNum, ethToUsd, inEth, usdToEth, useEthUsd } from './units';

/**
 * A limit the server keeps in dollars, typed and shown in ETH (units.tsx: which ETH price). Saved on blur as
 * ETH × price; with no ETH price it is read-only.
 */
function EthLimit({ label, usd, ethUsd, onSave }: { label: string; usd: number; ethUsd: number | null; onSave: (usd: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const eth = usdToEth(usd, ethUsd);
  const shown = text ?? (eth == null ? '' : coinNum(eth, 4).replace(/,/g, ''));
  return (
    <label className="smart-field"><span className="k">{label} (ETH)</span>
      <input value={shown} inputMode="decimal" disabled={!ethUsd} onChange={(e) => setText(e.target.value.replace(/[,\s]/g, ''))}
        onBlur={() => { const v = ethToUsd(Number(text), ethUsd); setText(null); if (text != null && v != null && v > 0) onSave(v); }} />
    </label>
  );
}

/** Banner text for an update that loaded live positions off completely (server: TokenTrader.migrateOffMode). */
export function choiceText(c: { livePositions: number }): string {
  return `Token trader has ${c.livePositions} live positions unwatched — choose: run exits / keep fully off`;
}

/** The confirm before "Run exits" restarts live selling on positions nobody watched since the update. */
export function runExitsConfirmText(n: number): string {
  return `Run exits now? ${n} live position${n === 1 ? '' : 's'} will be sold by ${n === 1 ? 'its' : 'their'} exit rules (take profit, trailing stop, stop-loss, time stop) with real money, starting on the next tick. No new buys.`;
}

/**
 * The banner's choice. "Run exits" resumes real sells on positions nobody watched since the update, so it asks first;
 * "Keep fully off" changes nothing and needs no confirm. null = cancelled (nothing posted).
 */
export async function pickChoice(mode: 'exits' | 'full', livePositions: number,
  d: { confirm: (msg: string) => boolean; post: (mode: 'exits' | 'full') => Promise<AnyObj> }): Promise<AnyObj | null> {
  if (mode === 'exits' && !d.confirm(runExitsConfirmText(livePositions))) return null;
  return d.post(mode);
}

/**
 * App-wide, until chosen: an old "off" token-trader file with LIVE positions loads off completely, so no real sell
 * goes out before Kyle picks. "Run exits" = off for new buys (exits running); "Keep fully off" = off completely.
 * Either choice is a POST /api/token-trader/off, so it is in the stop audit, and it clears the banner.
 */
export function TokenTraderChoiceBanner() {
  const [c, setC] = useState<{ livePositions: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => http('/api/token-trader').then((x) => setC(x?.pendingChoice ?? null)).catch(() => setC(null)), []);
  useEffect(() => { void load(); const id = setInterval(load, 10_000); return () => clearInterval(id); }, [load]);
  if (!c) return null;
  const pick = async (mode: 'exits' | 'full') => {
    setBusy(true);
    try {
      const x = await pickChoice(mode, c.livePositions, { confirm: (m) => confirm(m), post: (m) => http('/api/token-trader/off', 'POST', { mode: m }) });
      if (x) { setC(x?.pendingChoice ?? null); setErr(null); }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="banner error" role="alert">
      <span className="grow">{choiceText(c)}{err ? ` (${err})` : ''}</span>
      <button type="button" className="btn small-btn" disabled={busy} onClick={() => void pick('exits')}>Run exits</button>
      <button type="button" className="btn small-btn" disabled={busy} onClick={() => void pick('full')}>Keep fully off</button>
    </div>
  );
}

/** `seed`: a first status (tests render it without the network); the panel polls its own. */
export function TokenTraderPanel({ s, seed }: { s: AnyObj; seed?: AnyObj }) {
  const [t, setT] = useState<AnyObj | null>(seed ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => http('/api/token-trader').then((x) => { setT(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, [load]);
  const run = async (fn: () => Promise<AnyObj>) => {
    setBusy(true);
    try { setT(await fn()); setErr(null); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const ethUsd = useEthUsd();
  if (err && !t) return <section className="card"><p className="neg">{err}</p></section>;
  if (!t) return null;
  const o = t.options;
  const chains: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const save = (patch: AnyObj) => run(() => http('/api/token-trader', 'PUT', patch));
  const liqEth = (usd: number) => inEth(usd, ethUsd);

  return (
    <section className="card" id="token-trader">
      <div className="card-head">
        <h2>Token trader</h2>
        <span className={`tag ${t.on ? (o.mode === 'live' ? 'live' : 'pos') : ''}`}>{modeLabel(t, o)}</span>
        <span className="muted small">{inEth(t.openUsd ?? 0, ethUsd)} open of {inEth(o.totalUsd, ethUsd)}</span>
        <span className="grow" />
        {t.runMode !== 'exits' && <button type="button" className="btn small-btn" disabled={busy} title="No new buys, discovery or snipes. Stop-loss and take-profit exits keep running." onClick={() => void run(() => http('/api/token-trader/off', 'POST', { mode: 'exits' }))}>Off for new buys</button>}
        {t.runMode !== 'full' && <button type="button" className="btn small-btn" disabled={busy} title="Runs nothing: no exits, no discovery, no buys." onClick={() => void offCompletely(t, run)}>Off completely, no exits</button>}
        {!t.on && <button type="button" className="btn small-btn primary" disabled={busy} onClick={() => void start(o, run, ethUsd)}>On</button>}
      </div>
      <p className="small">New and trending pools, sized from the pool's depth, under your per-trade and total limits. Exits: a third at +50%, a third at +100%, a 20% trail after +30%, a hard stop at −25% (all measured from the effective entry, spend per token received after the pool fee, impact and tax, to what a token fetches after the exit fee and sell tax: with 1% each way, break-even is +2.03%, +7.40% with a 5% sell tax), plus liquidity pulled, a tax that appears, a failed sell, a 6h time stop and volume dying. The sniper buys a pool when liquidity is added and ignores the minimum age. Paper fills the same way, with the pool's fee, impact and tax.</p>
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

      <div className="tt-grid">
        <EthLimit label="Per trade" usd={o.perTradeUsd} ethUsd={ethUsd} onSave={(v) => void save({ perTradeUsd: v })} />
        <EthLimit label="Total open" usd={o.totalUsd} ethUsd={ethUsd} onSave={(v) => void save({ totalUsd: v })} />
        <label className="smart-field"><span className="k">Min pool age (hours)</span><input value={Math.round(o.minPoolAgeSec / 3600)} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, minPoolAgeSec: numIn(e.target.value) * 3600 } })} onBlur={() => void save({ minPoolAgeSec: o.minPoolAgeSec })} /></label>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!o.enforceWashAndAge} onChange={(e) => void save({ enforceWashAndAge: e.target.checked })} /><span>Wash and pool age</span></label>
        <label className="smart-field"><span className="k">Max pool share %</span><input value={Math.round(o.maxPoolShare * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxPoolShare: numIn(e.target.value) / 100 } })} onBlur={() => void save({ maxPoolShare: o.maxPoolShare })} /></label>
        <label className="smart-field"><span className="k">Impact cap %</span><input value={Math.round(o.maxImpact * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxImpact: numIn(e.target.value) / 100 } })} onBlur={() => void save({ maxImpact: o.maxImpact })} /></label>
        <label className="smart-field"><span className="k">Trade-size cap %</span><input value={Math.round((o.sizeImpactCap ?? 0.01) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, sizeImpactCap: numIn(e.target.value) / 100 } })} onBlur={() => void save({ sizeImpactCap: o.sizeImpactCap })} /></label>
        <label className="smart-field"><span className="k">{`Min liquidity (≈ ${liqEth(o.minLiquidityUsd ?? 0)})`}</span><input value={o.minLiquidityUsd ?? 0} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, minLiquidityUsd: numIn(e.target.value) } })} onBlur={() => void save({ minLiquidityUsd: o.minLiquidityUsd ?? 0 })} /></label>
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
      <p className="muted small">Wash and pool age off leaves the gate as it is. On, safe and medium enforce the minimum age above, skip a pool whose age is unknown, and skip volume over {SCAN_RULES.maxVolumeToLiquidity}× liquidity. A failed read skips those modes too. Snipes are brand-new pools, so they get only the volume check, never the age check.</p>

      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.enforceLiquidityFloor} onChange={(e) => void save({ enforceLiquidityFloor: e.target.checked })} /><span>{`Enforce liquidity floor (≈ ${liqEth(ENFORCED_LIQUIDITY_FLOOR_USD)})`}</span></label>
        <span className="muted small">{`In force ${liqEth(shownMinLiquidityUsd(t))}. Scan buys and the safety gate use this. A snipe still has to clear its own minimum when that is higher.`}</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceHolderCheck === true} onChange={(e) => void save({ enforceHolderCheck: e.target.checked })} /><span>Holder concentration</span></label>
        <label className="smart-field"><span className="k">Max holder %</span><input value={Math.round((o.maxHolderShare ?? 0.1) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxHolderShare: numIn(e.target.value) / 100 } })} onBlur={() => void save({ maxHolderShare: o.maxHolderShare })} /></label>
        <label className="smart-field"><span className="k">Max top 10 %</span><input value={Math.round((o.maxTop10Share ?? 0.4) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxTop10Share: numIn(e.target.value) / 100 } })} onBlur={() => void save({ maxTop10Share: o.maxTop10Share })} /></label>
        <label className="smart-field"><span className="k">Min coverage %</span><input value={Math.round((o.minHolderCoverage ?? 0.9) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, minHolderCoverage: numIn(e.target.value) / 100 } })} onBlur={() => void save({ minHolderCoverage: o.minHolderCoverage })} /></label>
        <span className="muted small">Off unless checked, and off changes nothing. When on, safe and medium skip a largest holder over the max holder % (default 10) or a top 10 over the max top 10 % (default 40), after ignoring pools, burn addresses and known lockers. No holder source, or a failed read, skips those modes and says which.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceSizeImpact === true} onChange={(e) => void save({ enforceSizeImpact: e.target.checked })} /><span>Cap impact at the trade size</span></label>
        <span className="muted small">Off unless checked, and off changes nothing. The impact cap above still sizes the trade. When this is on, that sized trade is quoted again (V3 through the quoter) and skipped if the move is over the trade-size cap. The default cap is 1%. A quote that fails skips the buy.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.sniper.on} onChange={(e) => void save({ sniper: { ...o.sniper, on: e.target.checked } })} /><span>Sniper</span></label>
        <EthLimit label="Min liquidity" usd={o.sniper.minLiquidityUsd} ethUsd={ethUsd} onSave={(v) => void save({ sniper: { ...o.sniper, minLiquidityUsd: v } })} />
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
          Generated <b className={(t.metrics.generatedUsd ?? 0) >= 0 ? 'pos' : 'neg'} data-testid="tt-generated">{generatedText(t.metrics, ethUsd)}</b>
          <span className="muted"> from closed sells · {t.metrics.fillCount ?? 0} trades</span>
        </p>
      )}
      {t.metrics && t.metrics.quote?.symbol !== 'USD' && <MoneyDetails b={t} />}
      {t.metrics && t.metrics.quote?.symbol === 'USD' && <SpendDetails t={t} ethUsd={ethUsd} />}
      <h3 className="small" style={{ marginTop: 14 }}>Open</h3>
      {!t.positions.length && <p className="muted small">No open positions.</p>}
      <div className="smart-bots">
        {t.positions.map((p: AnyObj) => (
          <div key={p.id} className="smart-bot" style={{ cursor: 'default' }}>
            <span className="smart-bot-name"><b>{p.label}</b> <ChainBadge c={chainOf(s, p.chainId)} testnet={false} /> <span className="tag">{p.source}</span></span>
            <span className="small muted" title="Entry = spend per token received, after the pool fee, price impact and buy tax (paper and live alike). Take profit and stops are also net of the exit fee and the sell tax measured at entry.">entry {num(p.entryPrice, 6)} after fees &amp; tax · now {num(p.price, 6)} · pool fee {feePct(p.feeBps)}{p.dynamicFee ? ' (dynamic)' : ''} · {p.exitsBlocked ? <b className="neg" role="alert">{blockedNote(p)}</b> : p.exitPlan}</span>
            <span className="smart-bot-v"><b className={p.pnlUsd >= 0 ? 'pos' : 'neg'}>{pct(p.pnlPct ?? (p.spentUsd ? p.pnlUsd / p.spentUsd : null), 1, true)}</b><span className="small muted">{p.pnl != null && p.spendSym ? qty(p.pnl, p.spendSym, 5) : inEth(p.pnlUsd, ethUsd, true)}</span></span>
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

/** A live position whose exits are blocked until the wallet balance can be read: shown on its row until it clears. */
export function blockedNote(p: AnyObj): string | null {
  if (!p.exitsBlocked) return null;
  return `${p.exitsBlocked}${p.blockedSince ? ` since ${ago(p.blockedSince)}` : ''}`;
}

function numIn(v: string) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * "On · paper" / "Off for new buys · exits running (N)" / "Off completely, no exits".
 * Each number once per card: when the new-buys-stopped banner is up it carries "Exits still managed: N", so the tag
 * drops its (N).
 */
export function modeLabel(t: AnyObj, o: AnyObj): string {
  if (t.runMode === 'on' || (t.runMode == null && t.on)) return `On · ${o.mode}`;
  if (t.runMode === 'full') return 'Off completely, no exits';
  return t.entriesHalt ? 'Off for new buys · exits running' : `Off for new buys · exits running (${t.exitsManaged ?? 0})`;
}

async function offCompletely(t: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<void>) {
  const n = t.positions?.length ?? 0;
  if (!confirm(`Turn the token trader off completely? Nothing will run: no buys, no snipes and no exits.${n ? ` The stop-losses and take-profits of its ${n} open position(s) will NOT be watched until you turn it on or back to "Off for new buys".` : ''}`)) return;
  await run(() => http('/api/token-trader/off', 'POST', { mode: 'full' }));
}

async function start(o: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<void>, ethUsd: number | null) {
  if (o.mode === 'live' && !confirm(`Turn the token trader on with real money? Up to ${inEth(o.perTradeUsd, ethUsd)} a trade and ${inEth(o.totalUsd, ethUsd)} open. The sniper is ${o.sniper.on ? 'on' : 'off'}.`)) return;
  await run(() => http('/api/token-trader/on', 'POST'));
}

/** Generated in the coins the trader spends; an old log with only dollars is shown in ETH. */
export function generatedText(m: AnyObj, ethUsd: number | null): string {
  const g = m.generated as Record<string, number> | null;
  if (!g) return '—';
  if (!('USD' in g)) return unitsText(g, 3);
  return inEth(m.generatedUsd, ethUsd, true);
}

/** Positions spending several coins: the money figures per coin (server tokenSpendTotals), else in ETH. */
function SpendDetails({ t, ethUsd }: { t: AnyObj; ethUsd: number | null }) {
  const by = t.spendTotals as Record<string, { bought: number; sold: number; fromSells: number; open: number; openCost: number }> | null;
  const m = t.metrics;
  const rows: [string, string][] = by
    ? [
      ['Bought with', unitsText(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.bought])), 4, false)],
      ['Sold for', unitsText(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.sold])), 4, false)],
      ['Open positions', unitsText(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.open])), 4)],
      ['Value now', unitsText(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.openCost + v.open])), 4, false)],
    ]
    : [
      ['Total P&L', inEth(m.totalPnlUsd, ethUsd, true)],
      ['Open positions', inEth(m.unrealizedUsd, ethUsd, true)],
      ['Value vs deposit', `${inEth(m.currentValueUsd, ethUsd)} now · ${inEth(m.capitalInUsd, ethUsd)} in`],
    ];
  return (
    <details className="more money-details" data-testid="money-details">
      <summary>Details <span className="muted small">{by ? 'per coin spent' : 'in ETH (older trades have no coin amount)'}</span></summary>
      <table className="stat-table"><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td className="mono">{v}</td></tr>)}</tbody></table>
    </details>
  );
}
