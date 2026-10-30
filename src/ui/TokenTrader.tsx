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
 * A number setting, typed in the unit it is shown in (stored = shown × scale). What is typed stays until the box is
 * left, then it is saved; the page's refresh every 2 s can't overwrite it (2026-10-30: it did, so an edit such as the
 * minimum pool age was replaced by the old value before it was saved).
 */
export function NumField({ label, value, scale = 1, onSave }: { label: string; value: number; scale?: number; onSave: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(+(value / scale).toFixed(2));
  return (
    <label className="smart-field"><span className="k">{label}</span>
      <input value={shown} inputMode="decimal" onChange={(e) => setText(e.target.value.replace(/[,\s]/g, ''))}
        onBlur={() => { const n = Number(text); setText(null); if (text != null && text !== '' && Number.isFinite(n) && n >= 0 && n * scale !== value) onSave(n * scale); }} />
    </label>
  );
}

/** The Ethereum send RPC, kept as typed until the box is left (like NumField); empty = none */
function RpcField({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="smart-field"><span className="k">Ethereum send RPC (optional, broadcast only)</span>
      <input placeholder="https://rpc.flashbots.net" value={text ?? value ?? ''} onChange={(e) => setText(e.target.value)}
        onBlur={() => { const v = text?.trim() || null; setText(null); if (text != null && v !== value) onSave(v); }} />
    </label>
  );
}

/**
 * Every setting the trader has, for the page's Advanced section (the page itself sets the style, the amounts, the
 * chains and the venues). `t` is the status; each change is saved when its box is left or its switch is tapped.
 */
export function TokenAdvanced({ s, t, save }: { s: AnyObj; t: AnyObj; save: (patch: AnyObj) => void }) {
  const ethUsd = useEthUsd();
  const o = t.options;
  const chains: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const liqEth = (usd: number) => inEth(usd, ethUsd);
  const sn = (patch: AnyObj) => save({ sniper: patch });
  return (
    <div className="tk-adv">
      <div className="tt-grid">
        <EthLimit label="Per trade" usd={o.perTradeUsd} ethUsd={ethUsd} onSave={(v) => save({ perTradeUsd: v })} />
        <EthLimit label="Total open" usd={o.totalUsd} ethUsd={ethUsd} onSave={(v) => save({ totalUsd: v })} />
        <NumField label="Min pool age (hours)" value={o.minPoolAgeSec} scale={3600} onSave={(v) => save({ minPoolAgeSec: v })} />
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={!!o.enforceWashAndAge} onChange={(e) => save({ enforceWashAndAge: e.target.checked })} /><span>Wash and pool age</span></label>
        <NumField label="Max pool share %" value={o.maxPoolShare} scale={0.01} onSave={(v) => save({ maxPoolShare: v })} />
        <NumField label="Impact cap %" value={o.maxImpact} scale={0.01} onSave={(v) => save({ maxImpact: v })} />
        <NumField label="Trade-size cap %" value={o.sizeImpactCap ?? 0.01} scale={0.01} onSave={(v) => save({ sizeImpactCap: v })} />
        <NumField label={`Min liquidity (≈ ${liqEth(o.minLiquidityUsd ?? 0)})`} value={o.minLiquidityUsd ?? 0} onSave={(v) => save({ minLiquidityUsd: v })} />
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
        <span className="muted small">Off leaves the gate as it is. On, safe and medium skip when a non-renounced owner can blacklist, pause, or change tax or limits, or a live admin can upgrade the contract. A mint function is shown but never skips a coin. A failed read skips those modes too.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.enforceLiquidityFloor} onChange={(e) => save({ enforceLiquidityFloor: e.target.checked })} /><span>{`Enforce liquidity floor (≈ ${liqEth(ENFORCED_LIQUIDITY_FLOOR_USD)})`}</span></label>
        <span className="muted small">{`In force ${liqEth(shownMinLiquidityUsd(t))}. Scan buys and the safety gate use this. A snipe still has to clear its own minimum when that is higher.`}</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceHolderCheck === true} onChange={(e) => save({ enforceHolderCheck: e.target.checked })} /><span>Holder concentration</span></label>
        <NumField label="Max holder %" value={o.maxHolderShare ?? 0.1} scale={0.01} onSave={(v) => save({ maxHolderShare: v })} />
        <NumField label="Max top 10 %" value={o.maxTop10Share ?? 0.4} scale={0.01} onSave={(v) => save({ maxTop10Share: v })} />
        <NumField label="Min coverage %" value={o.minHolderCoverage ?? 0.9} scale={0.01} onSave={(v) => save({ minHolderCoverage: v })} />
        <span className="muted small">Off unless checked, and off changes nothing. When on, safe and medium skip a largest holder over the max holder % (default 10) or a top 10 over the max top 10 % (default 40), after ignoring pools, burn addresses and known lockers. No holder source, or a failed read, skips those modes and says which. On Robinhood Chain the holder read came back unverified or thin for each of 3 launcher coins tested (2026-10-30), so with this on those coins are skipped.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={o.enforceSizeImpact === true} onChange={(e) => save({ enforceSizeImpact: e.target.checked })} /><span>Cap impact at the trade size</span></label>
        <span className="muted small">Off unless checked, and off changes nothing. The impact cap above still sizes the trade. When this is on, that sized trade is quoted again through the same pool the safety check read (V2, V3 and V4) and skipped if the move is over the trade-size cap. The default cap is 1%. A quote that fails skips the buy.</span>
      </div>
      <div className="tt-row" style={{ marginTop: 10 }}>
        <label className="check"><input type="checkbox" checked={!!o.sniper.on} onChange={(e) => sn({ on: e.target.checked })} /><span>Sniper</span></label>
        <EthLimit label="Min liquidity" usd={o.sniper.minLiquidityUsd} ethUsd={ethUsd} onSave={(v) => sn({ minLiquidityUsd: v })} />
        <NumField label="Delay blocks" value={o.sniper.delayBlocks} onSave={(v) => sn({ delayBlocks: Math.round(v) })} />
        <NumField label="Delay seconds" value={o.sniper.delaySec} onSave={(v) => sn({ delaySec: v })} />
        <NumField label="Max / hour" value={o.sniper.maxPerHour} onSave={(v) => sn({ maxPerHour: Math.round(v) })} />
        <span className="muted small">The sniper watches the chains picked under Where.</span>
      </div>
      <RpcField value={o.sniper.mevRpc ?? null} onSave={(v) => sn({ mevRpc: v })} />
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

export async function offCompletely(t: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<unknown>) {
  const n = t.positions?.length ?? 0;
  if (!confirm(`Turn the token trader off completely? Nothing will run: no buys, no snipes and no exits.${n ? ` The stop-losses and take-profits of its ${n} open position(s) will NOT be watched until you turn it on or back to "Off for new buys".` : ''}`)) return;
  await run(() => http('/api/token-trader/off', 'POST', { mode: 'full' }));
}

export async function startTrader(o: AnyObj, run: (fn: () => Promise<AnyObj>) => Promise<unknown>, ethUsd: number | null) {
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
