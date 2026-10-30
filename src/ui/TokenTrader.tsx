/**
 * Token trader pieces: every setting (TokenAdvanced, on its page's Advanced section), the app-wide choice banner, and
 * the helpers its page and tests share.
 */
import { useCallback, useEffect, useState } from 'react';
import { SCAN_RULES } from '../market/scan';
import { http } from './api';
import { ago } from './fmt';
import { ChainBadge, chainOf } from './chains';
import { errMsg, type AnyObj } from './model';
import { unitsText } from './deskStats';
import { ENFORCED_LIQUIDITY_FLOOR_USD, shownMinLiquidityUsd } from '../market/liquidityFloor';
import { coinNum, ethToUsd, inEth, usdToEth, useEthUsd } from './units';
import { VENUES } from '../live/venues';

/**
 * A limit the server keeps in dollars, typed and shown in ETH (units.tsx: which ETH price). Saved on blur as
 * ETH × price; with no ETH price it is read-only.
 */
export function EthLimit({ label, usd, ethUsd, onSave }: { label: string; usd: number; ethUsd: number | null; onSave: (usd: number) => void }) {
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

/**
 * Every setting the trader has, for the page's Advanced section (the page itself sets the style, the amounts, the
 * chains and the venues). `t` is the status; `setT` edits a field before it is saved on blur.
 */
export function TokenAdvanced({ s, t, setT, save }: { s: AnyObj; t: AnyObj; setT: (t: AnyObj) => void; save: (patch: AnyObj) => void }) {
  const ethUsd = useEthUsd();
  const o = t.options;
  const chains: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const liqEth = (usd: number) => inEth(usd, ethUsd);
  return (
    <div className="tk-adv">
      <div className="tt-grid">
        <EthLimit label="Per trade" usd={o.perTradeUsd} ethUsd={ethUsd} onSave={(v) => save({ perTradeUsd: v })} />
        <EthLimit label="Total open" usd={o.totalUsd} ethUsd={ethUsd} onSave={(v) => save({ totalUsd: v })} />
        <label className="smart-field"><span className="k">Min pool age (hours)</span><input value={Math.round(o.minPoolAgeSec / 3600)} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, minPoolAgeSec: numIn(e.target.value) * 3600 } })} onBlur={() => save({ minPoolAgeSec: o.minPoolAgeSec })} /></label>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!o.enforceWashAndAge} onChange={(e) => save({ enforceWashAndAge: e.target.checked })} /><span>Wash and pool age</span></label>
        <label className="smart-field"><span className="k">Max pool share %</span><input value={Math.round(o.maxPoolShare * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxPoolShare: numIn(e.target.value) / 100 } })} onBlur={() => save({ maxPoolShare: o.maxPoolShare })} /></label>
        <label className="smart-field"><span className="k">Impact cap %</span><input value={Math.round(o.maxImpact * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxImpact: numIn(e.target.value) / 100 } })} onBlur={() => save({ maxImpact: o.maxImpact })} /></label>
        <label className="smart-field"><span className="k">Trade-size cap %</span><input value={Math.round((o.sizeImpactCap ?? 0.01) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, sizeImpactCap: numIn(e.target.value) / 100 } })} onBlur={() => save({ sizeImpactCap: o.sizeImpactCap })} /></label>
        <label className="smart-field"><span className="k">{`Min liquidity (≈ ${liqEth(o.minLiquidityUsd ?? 0)})`}</span><input value={o.minLiquidityUsd ?? 0} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, minLiquidityUsd: numIn(e.target.value) } })} onBlur={() => save({ minLiquidityUsd: o.minLiquidityUsd ?? 0 })} /></label>
        <label className="smart-field"><span className="k">Risk</span>
          <select value={o.risk} onChange={(e) => save({ risk: e.target.value })}>
            <option value="safe">Safe</option>
            <option value="medium">Up to medium</option>
            <option value="any">Any that can trade</option>
          </select>
        </label>
        <label className="smart-field"><span className="k">Mode</span>
          <select value={o.mode} onChange={(e) => save({ mode: e.target.value })} disabled={t.on}>
            <option value="paper">Paper</option>
            <option value="live">Live</option>
          </select>
        </label>
      </div>
      <p className="muted small">Wash and pool age off leaves the gate as it is. On, safe and medium enforce the minimum age above, skip a pool whose age is unknown, and skip volume over {SCAN_RULES.maxVolumeToLiquidity}× liquidity. A failed read skips those modes too. Snipes are brand-new pools, so they get only the volume check, never the age check.</p>

      <div className="tt-row" style={{ marginTop: 10 }}>
        <span className="k">Buy on</span>
        {VENUES.filter((v) => chains.some((c) => c.id === v.chainId)).map((v) => (
          <label key={v.id} className="check"><input type="checkbox" checked={o.venues?.[v.id] !== false} onChange={(e) => save({ venues: { [v.id]: e.target.checked } })} /><span><ChainBadge c={chainOf(s, v.chainId)} testnet={false} /> {v.name}</span></label>
        ))}
        <span className="muted small">Launch venues on top of each chain's own DEXes. Launcher pools (Pons V2 Dex, Long.xyz, Bankr, Frontier) trade through the launcher's own hook, which takes a cut of each swap; the safety check measures that cut as a tax, so at Safe risk a taxed coin is skipped.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.enforceOwnerPowers} onChange={(e) => save({ enforceOwnerPowers: e.target.checked })} /><span>Owner powers</span></label>
        <span className="muted small">Off leaves the gate as it is. On, safe and medium skip when a non-renounced owner can mint, blacklist, pause, or change tax or limits, or a live admin can upgrade the contract. A failed read skips those modes too.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.enforceLiquidityFloor} onChange={(e) => save({ enforceLiquidityFloor: e.target.checked })} /><span>{`Enforce liquidity floor (≈ ${liqEth(ENFORCED_LIQUIDITY_FLOOR_USD)})`}</span></label>
        <span className="muted small">{`In force ${liqEth(shownMinLiquidityUsd(t))}. Scan buys and the safety gate use this. A snipe still has to clear its own minimum when that is higher.`}</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceHolderCheck === true} onChange={(e) => save({ enforceHolderCheck: e.target.checked })} /><span>Holder concentration</span></label>
        <label className="smart-field"><span className="k">Max holder %</span><input value={Math.round((o.maxHolderShare ?? 0.1) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxHolderShare: numIn(e.target.value) / 100 } })} onBlur={() => save({ maxHolderShare: o.maxHolderShare })} /></label>
        <label className="smart-field"><span className="k">Max top 10 %</span><input value={Math.round((o.maxTop10Share ?? 0.4) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, maxTop10Share: numIn(e.target.value) / 100 } })} onBlur={() => save({ maxTop10Share: o.maxTop10Share })} /></label>
        <label className="smart-field"><span className="k">Min coverage %</span><input value={Math.round((o.minHolderCoverage ?? 0.9) * 1000) / 10} inputMode="decimal" onChange={(e) => setT({ ...t, options: { ...o, minHolderCoverage: numIn(e.target.value) / 100 } })} onBlur={() => save({ minHolderCoverage: o.minHolderCoverage })} /></label>
        <span className="muted small">Off unless checked, and off changes nothing. When on, safe and medium skip a largest holder over the max holder % (default 10) or a top 10 over the max top 10 % (default 40), after ignoring pools, burn addresses and known lockers. No holder source, or a failed read, skips those modes and says which.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceSizeImpact === true} onChange={(e) => save({ enforceSizeImpact: e.target.checked })} /><span>Cap impact at the trade size</span></label>
        <span className="muted small">Off unless checked, and off changes nothing. The impact cap above still sizes the trade. When this is on, that sized trade is quoted again (V3 through the quoter) and skipped if the move is over the trade-size cap. The default cap is 1%. A quote that fails skips the buy.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.sniper.on} onChange={(e) => save({ sniper: { ...o.sniper, on: e.target.checked } })} /><span>Sniper</span></label>
        <EthLimit label="Min liquidity" usd={o.sniper.minLiquidityUsd} ethUsd={ethUsd} onSave={(v) => save({ sniper: { ...o.sniper, minLiquidityUsd: v } })} />
        <label className="smart-field"><span className="k">Delay blocks</span><input value={o.sniper.delayBlocks} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, delayBlocks: numIn(e.target.value) } } })} onBlur={() => save({ sniper: o.sniper })} /></label>
        <label className="smart-field"><span className="k">Delay seconds</span><input value={o.sniper.delaySec} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, delaySec: numIn(e.target.value) } } })} onBlur={() => save({ sniper: o.sniper })} /></label>
        <label className="smart-field"><span className="k">Max / hour</span><input value={o.sniper.maxPerHour} inputMode="numeric" onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, maxPerHour: numIn(e.target.value) } } })} onBlur={() => save({ sniper: o.sniper })} /></label>
      </div>
      <div className="tt-row">
        {chains.map((c) => (
          <label key={c.id} className="check"><input type="checkbox" checked={o.sniper.chains?.[c.id] !== false} onChange={(e) => save({ sniper: { ...o.sniper, chains: { ...o.sniper.chains, [c.id]: e.target.checked } } })} /><span><ChainBadge c={chainOf(s, c.id)} testnet={false} /> sniper</span></label>
        ))}
      </div>
      <label className="smart-field"><span className="k">Ethereum send RPC (optional, broadcast only)</span>
        <input placeholder="https://rpc.flashbots.net" value={o.sniper.mevRpc ?? ''} onChange={(e) => setT({ ...t, options: { ...o, sniper: { ...o.sniper, mevRpc: e.target.value || null } } })} onBlur={() => save({ sniper: o.sniper })} />
      </label>

    </div>
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

export async function offCompletely(t: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<void>) {
  const n = t.positions?.length ?? 0;
  if (!confirm(`Turn the token trader off completely? Nothing will run: no buys, no snipes and no exits.${n ? ` The stop-losses and take-profits of its ${n} open position(s) will NOT be watched until you turn it on or back to "Off for new buys".` : ''}`)) return;
  await run(() => http('/api/token-trader/off', 'POST', { mode: 'full' }));
}

export async function startTrader(o: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<void>, ethUsd: number | null) {
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
export function SpendDetails({ t, ethUsd }: { t: AnyObj; ethUsd: number | null }) {
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
