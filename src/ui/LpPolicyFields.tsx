/** Optional LP range-move and compound settings. Every control defaults off. */
import { LP_MOVE_PRESETS, type LpCompoundPolicy, type LpMovePreset, type LpRangePolicy } from '../market/lpPolicy';
import { L } from './Tip';

export interface PolicyDraft {
  dwellMin: string;
  cooldownMin: string;
  /** Percent, so 0.3 means 0.3% past the edge. */
  bufferPct: string;
  atrMult: string;
  atrPeriod: string;
  costCheck: boolean;
  feeHorizonH: string;
  /** Percent of the centre-to-edge distance. 20 = warn in the outer 20%. 0 = off. */
  nearEdgePct: string;
  compound: boolean;
  gasMultiple: string;
}

export const EMPTY_POLICY: PolicyDraft = {
  dwellMin: '0', cooldownMin: '0', bufferPct: '0', atrMult: '0', atrPeriod: '14', costCheck: false, feeHorizonH: '24', nearEdgePct: '0', compound: false, gasMultiple: '10',
};

export function draftFrom(range?: Partial<LpRangePolicy> | null, compound?: Partial<LpCompoundPolicy> | null): PolicyDraft {
  return {
    dwellMin: String(range?.dwellMin ?? 0),
    cooldownMin: String(range?.cooldownMin ?? 0),
    bufferPct: String(+((range?.bufferPct ?? 0) * 100).toPrecision(6)),
    atrMult: String(range?.atrMult ?? 0),
    atrPeriod: String(range?.atrPeriod ?? 14),
    costCheck: range?.costCheck === true,
    feeHorizonH: String(range?.feeHorizonH ?? 24),
    nearEdgePct: String(+((range?.nearEdgeFrac ?? 0) * 100).toPrecision(6)),
    compound: compound?.enabled === true,
    gasMultiple: String(compound?.gasMultiple ?? 10),
  };
}

export function payloadFrom(d: PolicyDraft): { range: LpRangePolicy; compound: LpCompoundPolicy } {
  return {
    range: {
      dwellMin: Number(d.dwellMin) || 0,
      cooldownMin: Number(d.cooldownMin) || 0,
      bufferPct: (Number(d.bufferPct) || 0) / 100,
      atrMult: Number(d.atrMult) || 0,
      atrPeriod: Math.round(Number(d.atrPeriod) || 14),
      costCheck: d.costCheck,
      feeHorizonH: Number(d.feeHorizonH) || 24,
      nearEdgeFrac: (Number(d.nearEdgePct) || 0) / 100,
    },
    compound: { enabled: d.compound, gasMultiple: Number(d.gasMultiple) || 10 },
  };
}

/** Nothing set: omit the objects so a new bot is saved in the same shape as before. */
export function optionalPayload(d: PolicyDraft): { range?: LpRangePolicy; compound?: LpCompoundPolicy } {
  const p = payloadFrom(d);
  const rangeOff = p.range.dwellMin === 0 && p.range.cooldownMin === 0 && p.range.bufferPct === 0 && p.range.atrMult === 0 && !p.range.costCheck && p.range.nearEdgeFrac === 0;
  return { ...(rangeOff ? {} : { range: p.range }), ...(p.compound.enabled ? { compound: p.compound } : {}) };
}

const num = (v: string) => v.replace(/[^\d.]/g, '');

const presetText = (p: LpMovePreset) =>
  `${p.label} · ±${p.bandPct * 100}% · ${p.dwellMin / 60}h outside · ${p.cooldownMin / 60}h cooldown`;

export function LpPolicyFields({ d, set, onPreset }: {
  d: PolicyDraft;
  set: (next: PolicyDraft) => void;
  /** Also sets the range width. The position already open is not moved. */
  onPreset?: (bandPct: number) => void;
}) {
  const apply = (p: LpMovePreset) => {
    set({ ...d, dwellMin: String(p.dwellMin), cooldownMin: String(p.cooldownMin) });
    onPreset?.(p.bandPct);
  };
  return (
    <div className="lp-policy">
      <p className="muted small">Off unless you change them. At zero, the range still moves on the first reading outside it, and fees still roll in only when the range moves or the bot closes.</p>
      <div className="quick" role="group" aria-label="Dwell and cooldown presets">
        {LP_MOVE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="btn small-btn" onClick={() => apply(p)}>{presetText(p)}</button>
        ))}
      </div>
      <p className="muted small">A preset fills the wait and the width. It does not move a position that is already open: the next move uses the new width.</p>
      <div className="form-row">
        <label><L tip="How long the price has to stay outside the move boundary before the range moves. 0 moves on the first reading, which is what the bot does today.">Wait outside (minutes)</L>
          <input value={d.dwellMin} inputMode="decimal" aria-label="Wait outside minutes" onChange={(e) => set({ ...d, dwellMin: num(e.target.value) })} /></label>
        <label><L tip="How long to wait after a move before another auto-move. 0 is today: the next time the price leaves, it can move immediately. The first move is never held by this.">Cooldown after a move (minutes)</L>
          <input value={d.cooldownMin} inputMode="decimal" aria-label="Cooldown after a move" onChange={(e) => set({ ...d, cooldownMin: num(e.target.value) })} /></label>
        <label><L tip="The price must pass the edge by this much before a move starts. 0 uses the edge itself. A brief poke just outside the range then no longer moves it.">Buffer past the edge (%)</L>
          <input value={d.bufferPct} inputMode="decimal" aria-label="Buffer past the edge" onChange={(e) => set({ ...d, bufferPct: num(e.target.value) })} /></label>
        <label><L tip="0 keeps the width you set. Above 0, a new range is at least this many hourly ATRs wide (Wilder), and never narrower than the width you set. It only widens.">ATR multiple</L>
          <input value={d.atrMult} inputMode="decimal" aria-label="ATR multiple" onChange={(e) => set({ ...d, atrMult: num(e.target.value) })} /></label>
        <label><L tip="Wilder ATR period, in hourly candles. Used only when the ATR multiple is above 0.">ATR period</L>
          <input value={d.atrPeriod} inputMode="numeric" aria-label="ATR period" onChange={(e) => set({ ...d, atrPeriod: num(e.target.value) })} /></label>
      </div>
      <label className="check follow">
        <input type="checkbox" checked={d.costCheck} onChange={(e) => set({ ...d, costCheck: e.target.checked })} />
        <span><b>Move only when the fees would cover it</b> <span className="muted">Estimated gas plus the swap back to the mix, against the recent fee pace carried over the horizon below. Until the position has a pace (10 minutes), it waits.</span></span>
      </label>
      <div className="form-row">
        <label><L tip="How many hours of the recent fee pace to compare with the cost of a move.">Fee horizon (hours)</L>
          <input value={d.feeHorizonH} inputMode="decimal" aria-label="Fee horizon hours" onChange={(e) => set({ ...d, feeHorizonH: num(e.target.value) })} /></label>
        <label><L tip="Warn once when the price is inside but this close to leaving, measured from the centre to the edge. 20 warns in the outer 20%. 0 sends no warning.">Near-edge warning (%)</L>
          <input value={d.nearEdgePct} inputMode="decimal" aria-label="Near-edge warning" onChange={(e) => set({ ...d, nearEdgePct: num(e.target.value) })} /></label>
        <label><L tip="Collect waiting fees and add them back into this same range once they are worth this many times the collect-and-add gas. 10 is the suggested multiple. Off, fees wait until the range moves or the bot closes.">Compound at × gas</L>
          <input value={d.gasMultiple} inputMode="decimal" aria-label="Compound gas multiple" onChange={(e) => set({ ...d, gasMultiple: num(e.target.value) })} /></label>
      </div>
      <label className="check follow">
        <input type="checkbox" checked={d.compound} onChange={(e) => set({ ...d, compound: e.target.checked })} />
        <span><b>Compound fees into the position</b> <span className="muted">Only while profits are set to reinvest. Sending fees out is unchanged.</span></span>
      </label>
    </div>
  );
}
