/** One liquidity bot: range vs price, fees earned in each coin, what it cost, its coins and pool share, settings, its own log. */
import { useEffect, useState } from 'react';
import { botApi } from './api';
import { StatusDot } from './motion';
import { Chart } from './Chart';
import { ValueOverTime } from './ValueOverTime';
import { StatTable } from './StatTable';
import { MoneyDetails, type DetailRow } from './MoneyDetails';
import { ago, bagFixed, cls, dur, num, pct, px, qty, sameShown } from './fmt';
import { LP_BAND } from '../market/lp';
import { ChainBadge, DexTag, chainOf, explorerTx } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { isAddress, ProfitsField, profitsBody, type ProfitsChoice } from './NewBot';
import { draftFrom, LpPolicyFields, payloadFrom, type PolicyDraft } from './LpPolicyFields';
import { L } from './Tip';
import { lpName, type AnyObj, type Nav } from './model';
import { overrideText, showHalt } from './haltText';
import { SafetyChecking, heldForSafety, useSafetyChecking } from './SafetyChecking';
import { metricsOf, unitsText } from './deskStats';

interface Props { s: AnyObj; id: string; events: ActivityEvent[]; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

const ACTION: Record<string, string> = { open: 'Opening', rerange: 'Moving the range', close: 'Closing', send: 'Sending fees', compound: 'Compounding fees' };
const STAGE: Record<string, string> = { exit: 'taking the position out', swap: "swapping to the range's mix", approve: 'approving the position manager', mint: 'opening the position', collect: 'collecting the fees', increase: 'adding the fees to the position' };

/** Out of range: when the range moves, or why it doesn't. */
function moveNote(b: AnyObj): string {
  if (!b.config?.rerange) return 'Auto-move is off: it waits for the price to come back, or move it yourself below.';
  if (b.move?.block) return `It can't move the range now: ${b.move.block}.`;
  const wait = b.hold?.wait as string | undefined;
  const dwell = b.config?.range?.dwellMin ?? 0;
  const cool = b.config?.range?.cooldownMin ?? 0;
  if (wait === 'dwell') return `Auto-move is on: it waits ${dwell} minute${dwell === 1 ? '' : 's'} outside before moving.`;
  if (wait === 'cooldown') return `Auto-move is on: it waits ${cool} minute${cool === 1 ? '' : 's'} after a move before it can move again.`;
  if (wait === 'buffer') return 'The price is outside the range but still inside the buffer, so the range stays.';
  if (wait === 'cost') return 'Moving would cost more in gas and the swap than the fees it should earn, so it waits.';
  if (dwell > 0 || cool > 0) return `Auto-move is on: it moves after ${dwell > 0 ? `${dwell} minutes outside` : 'the price leaves'}${cool > 0 ? `, and not again for ${cool} minutes` : ''}${b.config?.range?.bufferPct ? `, once the price is ${(b.config.range.bufferPct * 100).toFixed(2)}% past the edge` : ''}.`;
  return 'Auto-move is on: it moves the range to the price on its next check.';
}

const WIDTHS = [0.01, 0.02, 0.05, 0.08, 0.12, 0.2];

/** Auto-move on or off, and a move now: to the price at the same width, or at a new one. */
function RangeControls({ b, act, busy }: { b: AnyObj; act: Props['act']; busy: boolean }) {
  const cur: number = b.config.bandPct;
  const [w, setW] = useState(String(+(cur * 100).toFixed(2)));
  const band = Number(w) / 100, ok = band >= LP_BAND.min && band <= LP_BAND.max, same = ok && Math.abs(band - cur) < 1e-9;
  const why = b.status !== 'running' ? 'Resume it first' : b.step ? 'Busy with a step' : !ok ? `Range must be ±${LP_BAND.min * 100}% to ±${LP_BAND.max * 100}%` : '';
  const move = () => act(async () => {
    if (b.mode === 'live' && !confirm(`${same ? 'Move the range to the price' : `Change the range to ±${+(band * 100).toFixed(2)}%`}? The position is taken out and opened again around ${px(b.price)}: gas, a swap to the new mix, and the coin mix it has now becomes final.`)) return;
    await botApi(`lps/${b.id}/move`, 'POST', { bandPct: band });
  });
  return (
    <div className="range-ctl">
      <div className="seg-field">
        <span className="k"><L tip="On: as soon as the price leaves the range, the position is taken out and opened again around the price, same width. Off: it waits for the price to come back. Each move makes the coin mix it had final (lost to range moves).">Auto-move</L></span>
        <div className="seg" role="radiogroup" aria-label="Auto-move">
          {([[true, 'On'], [false, 'Off']] as const).map(([v, t]) => (
            <button key={t} type="button" role="radio" aria-checked={!!b.config.rerange === v} className={!!b.config.rerange === v ? 'on' : ''} disabled={busy}
              onClick={() => act(() => botApi(`lps/${b.id}/rerange`, 'PUT', { enabled: v }))}>{t}</button>
          ))}
        </div>
      </div>
      <div className="seg-field">
        <span className="k"><L tip="The range's width around the price. Pick another and press Change to take the position out and open it again at that width, around today's price.">Range ±%</L></span>
        <div className="range-w">
          {WIDTHS.map((x) => <button key={x} type="button" className={`btn small-btn ${Math.abs(band - x) < 1e-9 ? 'primary' : ''}`} onClick={() => setW(String(x * 100))}>±{x * 100}%</button>)}
          <input value={w} inputMode="decimal" aria-label="Range ± %" onChange={(e) => setW(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>
      </div>
      <button type="button" className="btn primary" disabled={busy || !!why} title={why} onClick={move}>
        {same ? 'Move to the price now' : ok ? `Change to ±${+(band * 100).toFixed(2)}%` : 'Change range'}
      </button>
    </div>
  );
}

/** Range health: where the price sits in the band, fees waiting, and what a compound or a move would do. */
function RangeHealth({ b, act, busy }: { b: AnyObj; act: Props['act']; busy: boolean }) {
  const pos = b.position as { lower: number; upper: number };
  const price = b.price as number | null;
  const gen = metricsOf(b)?.generated ?? null; // to leave out a waiting figure that prints as Generated (each figure once)
  const lower = pos.lower, upper = pos.upper, span = upper - lower;
  const toEdge = price != null && span > 0 ? 1 - Math.abs(price - (lower + upper) / 2) / (span / 2) : null;
  const out = b.inRange === false;
  const pad = span * 0.25, lo = lower - pad, hi = upper + pad;
  const at = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  const q = b.quote as string, base = b.base as string;
  const need = b.hold?.compoundNeed as number | null | undefined;
  const compoundOn = !!b.config?.compound?.enabled;
  const dwell = b.config?.range?.dwellMin ?? 0;
  const cool = b.config?.range?.cooldownMin ?? 0;
  const hrs = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);
  const rule = !b.config?.rerange ? 'Move rule: off'
    : dwell > 0 && cool > 0 ? `Move rule: ${hrs(dwell)} outside, ${hrs(cool)} cooldown`
    : dwell > 0 ? `Move rule: wait ${hrs(dwell)}`
    : cool > 0 ? `Move rule: ${hrs(cool)} cooldown`
    : b.config?.range?.costCheck ? 'Move rule: fees must cover the cost'
    : 'Move rule: on the next check';
  const outFor = b.outSince ? Math.max(0, Math.round((Date.now() - b.outSince) / 60_000)) : 0;
  const widen = b.hold?.suggestedBand as number | undefined;
  const compound = () => act(async () => {
    if (b.mode === 'live' && !confirm(`Add the waiting fees back into the ${lpName(b)} position? It collects them and increases this range. Gas applies.`)) return;
    await botApi(`lps/${b.id}/compound`, 'POST');
  });
  const doWiden = () => act(async () => {
    if (widen == null) return;
    if (b.mode === 'live' && !confirm(`Widen the range to ±${(widen * 100).toFixed(1)}% around ${px(price)}? The position is taken out and opened again.`)) return;
    await botApi(`lps/${b.id}/move`, 'POST', { bandPct: widen });
  });
  return (
    <div className="lp-health">
      <div className="lp-health-top">
        <span className="small">{px(lower)} – {px(upper)} {q}/{base}</span>
        <span className={`lp-edge ${out ? 'out' : ''}`}>{out ? `out of range${outFor ? ` ${outFor}m` : ''}` : toEdge != null ? `${Math.max(0, toEdge * 100).toFixed(1)}% to edge` : ''}</span>
      </div>
      <div className="lp-health-bar" title={`range ${px(lower)} – ${px(upper)}${price != null ? ` · price ${px(price)}` : ''}`}>
        <div className="lp-health-track" />
        <div className={`lp-health-fill ${out ? 'out' : ''}`} style={{ left: at(lower), width: `calc(${at(upper)} - ${at(lower)})` }} />
        {price != null && <span className="lp-health-mark" style={{ left: at(price) }}><i>{px(price)}</i></span>}
      </div>
      {/* the edges' prices are on the line above (no number twice) */}
      <div className="lp-health-scale"><span>low</span><span>high</span></div>
      <div className="lp-health-stats">
        <div>
          <span className="k">Fees waiting</span>
          <b className="pos">{waitingText(b.owed?.base, base, gen)}</b>
          <span className="muted small">{waitingText(b.owed?.quote, q, gen)}</span>
        </div>
        <div>
          <span className="k"><L tip="With compounding on, fees are collected and added back into this range once they are worth the multiple × the estimated gas. Off, they roll in on the next range move or when the bot closes.">Compound at</L></span>
          <b>{compoundOn ? (need != null && Number.isFinite(need) ? qty(need, q, 4, false) : '…') : 'off'}</b>
          <span className="muted small">{compoundOn ? `${b.config.compound.gasMultiple ?? 10}× gas` : 'rolls in on a move'}</span>
        </div>
      </div>
      <div className="lp-actions">
        <button type="button" className="btn primary" disabled={busy || b.status !== 'running' || !!b.step || b.profits?.mode === 'send'} title={b.profits?.mode === 'send' ? 'Fees are set to be sent out' : 'Collect waiting fees and add them to this range'} onClick={compound}>Compound now</button>
        {widen != null && widen > b.config.bandPct + 1e-9 && <button type="button" className="btn" disabled={busy || b.status !== 'running' || !!b.step} onClick={doWiden}>Widen to ±{(widen * 100).toFixed(1)}%</button>}
        <span className="tag">{rule}</span>
      </div>
    </div>
  );
}

function LpSettings({ b, act, busy }: { b: AnyObj; act: Props['act']; busy: boolean }) {
  const cur: { mode: 'reinvest' | 'send'; to?: string } = b.profits ?? { mode: 'reinvest' };
  const [p, setP] = useState<ProfitsChoice>({ mode: cur.mode, to: cur.to ?? '' });
  const [pol, setPol] = useState<PolicyDraft>(() => draftFrom(b.config?.range, b.config?.compound));
  const [presetBand, setPresetBand] = useState<number | null>(null);
  const changed = p.mode !== cur.mode || (p.mode === 'send' && p.to !== (cur.to ?? ''));
  const q = b.quote;
  const saved = draftFrom(b.config?.range, b.config?.compound);
  const bandDirty = presetBand != null && Math.abs(presetBand - b.config.bandPct) > 1e-9;
  const policyDirty = JSON.stringify(payloadFrom(pol)) !== JSON.stringify(payloadFrom(saved)) || bandDirty;
  return (
    <div className="card">
      <h3>Settings</h3>
      <div className="follow-row">
        <ProfitsField p={p} set={setP} kind="lp" />
        {changed && <button type="button" className="btn small-btn primary" disabled={busy || (p.mode === 'send' && !isAddress(p.to))}
          onClick={() => act(() => botApi(`lps/${b.id}/profits`, 'PUT', profitsBody(p)))}>Save</button>}
        {b.totals.sent > 0 && <span className="small">Sent so far: {qty(b.totals.sent, q, 5, false)}{cur.mode === 'send' ? ` to ${cur.to}` : ''}.</span>}
      </div>
      <details className="more">
        <summary>Advanced</summary>
        <LpPolicyFields d={pol} set={setPol} onPreset={(bandPct) => setPresetBand(bandPct)} />
        {policyDirty && <button type="button" className="btn small-btn primary" disabled={busy}
          onClick={() => act(() => botApi(`lps/${b.id}/policy`, 'PUT', { ...payloadFrom(pol), ...(bandDirty ? { bandPct: presetBand } : {}) }))}>Save range settings</button>}
      </details>
    </div>
  );
}

/**
 * Figures the LP page already shows elsewhere, left out of the chart's stat table so no number appears twice:
 * Generated (headline), its rates and Est. 24h/7d/365d and the age (Pace), fees paid / earned (Details breakdown),
 * the range, its width and the range moves (the position card).
 */
/**
 * When the position was opened. The position opened with the bot (no range move since) is the bot's age again, which
 * the page shows once already (Pace, or the stat table under a day): then it says so instead of a second age.
 */
/**
 * A coin's waiting fees to 4 decimals; a fee too small for that prints in significant digits, never as "0". When they
 * print the same as that coin's Generated in the headline (no cost taken in that coin yet), the page says so: the
 * figure is on the screen once already (Kyle).
 */
function waitingText(owed: number | null | undefined, sym: string, gen: Record<string, number> | null | undefined): string {
  const small = owed != null && owed !== 0 && num(owed, 4) === '0';
  const txt = `${small ? Number(owed.toPrecision(3)) : num(owed, 4)} ${sym}`;
  const g = gen?.[sym];
  return g != null && owed != null && sameShown(qty(g, sym, 5), txt) ? `${sym}: all of Generated` : txt;
}

function openedText(b: AnyObj, pos: AnyObj): string {
  const start = typeof b.startedAt === 'number' ? b.startedAt : null;
  if (start != null && typeof pos.openedAt === 'number' && Math.abs(pos.openedAt - start) < 10 * 60_000) return 'Opened when the bot started';
  return `Opened ${ago(pos.openedAt)}`;
}

const LP_SHOWN_ELSEWHERE = ['Generated', 'Age', 'Est. 24h', 'Est. 7d', 'Est. 365d', 'Fees paid', 'Fees earned', 'Range', 'Spacing', 'Moves', 'Last move'] as const;

/**
 * Details' breakdown of the headline: per coin, fees earned − gas + swap fees − range moves = Generated, from the
 * server's metrics.breakdownByCoin (MoneyDetails prints those lines first; costs in the coin they were charged in).
 * A coin with no cost says its fees are all Generated instead of printing the headline's number a second time. These
 * rows add both coins' fees at today's price and what's still waiting.
 */
/** What's waiting of one coin's fees; "all the X" when none has been collected yet (the fees row already prints it). */
function waiting(owed: number | null | undefined, earned: number, sym: string): string {
  if (owed == null) return `— ${sym}`;
  return earned > 0 && Math.abs(owed - earned) <= 1e-9 * earned ? `all the ${sym}` : `${num(owed, 6)} ${sym}`;
}

function lpBreakdown(b: AnyObj): DetailRow[] {
  // the per-coin fees earned − costs = Generated lines come first, from metrics.breakdownByCoin (MoneyDetails)
  const pnl: AnyObj | null = b.pnl;
  if (!pnl?.feeCoins) return [];
  const base = b.base, q = b.quote;
  return [
    ['Fees earned, all', <>{pnl.fees != null ? `≈ ${qty(pnl.fees, q, 5)} at today's price` : '—'}</>, `Both coins' fees together, in ${q} at today's price.`],
    ['of which waiting in the position', b.position ? <>shown in the position card</> : <>{waiting(b.owed?.base, pnl.feeCoins.base, base)} + {waiting(b.owed?.quote, pnl.feeCoins.quote, q)}</>, 'Earned but not collected yet; collected on the next range move, close or fee send.'],
  ];
}

/**
 * The bot's pace: Est. a day, 7 days and 365 days (Generated ÷ age × the days, per coin, in units), straight from the
 * server's metrics (generatedRate); hidden under a day. A window botMetrics hasn't filled yet reads "—" with its
 * "needs … of history". No client-side extrapolation.
 */
function GeneratedPace({ b }: { b: AnyObj }) {
  const m = metricsOf(b);
  if (!m || !m.generated) return null;
  // Kyle (#73): only the Est. rows (no "So far": Generated is the headline), and no card at all under a day. The figures
  // are botMetrics' own generatedRate (Generated ÷ age × the days, per coin, null under a day: #86); nothing is
  // worked out here, and botMetrics' null day estimate is what hides the card.
  if (!m.generatedRate.d1) return null;
  const rows = [['Est. a day', m.generatedRate.d1, m.generatedRate.needs.d1], ['Est. 7 days', m.generatedRate.d7, m.generatedRate.needs.d7], ['Est. 365 days', m.generatedRate.d365, m.generatedRate.needs.d365]] as const;
  return (
    <div className="card pace" data-testid="generated-pace">
      <div className="card-head">
        <h3><L tip={`${m.calc}`}>Pace</L></h3>
        <span className="muted small">{m.ageSec != null ? `running ${dur(m.ageSec * 1000)}` : ''}</span>
      </div>
      <div className="pace-rows">{rows.map(([label, units, need]) => (
        <div key={label} className="pace-row">
          <span className="k">{label}</span>
          {units ? <>
            <b className={cls(m.generatedUsd)}>{unitsText(units)}</b>
            <span className="small muted" />
          </> : <>
            <b className="muted">—</b>
            <span className="small muted">{need ?? ''}</span>
          </>}
        </div>
      ))}</div>
      <p className="muted small">Generated so far carried forward at the same pace (simple, not compounded); not a forecast{b.inRange === false ? '. It is out of range now, so it earns nothing until the price is back inside or the range moves' : ''}.</p>
    </div>
  );
}

export function LpDetail({ s, id, events, ticks, nav, act, busy }: Props) {
  const b: AnyObj | undefined = (s.lps ?? []).find((x: AnyObj) => x.id === id);
  const [, tick] = useState(0);
  const chk = useSafetyChecking();
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (!b) return null;

  const m = metricsOf(b);
  const q = b.quote, base = b.base;
  const pos = b.position, step = b.step;
  const running = b.status === 'running', closed = b.status === 'closed';
  const closing = !!b.closing || step?.action === 'close';
  const close = () => {
    if (b.mode === 'live' && !confirm(`Take the ${lpName(b)} position out? The coins go back to your wallet as ${base} and ${q}. The same price-impact and slippage limits still apply.`)) return;
    act(() => botApi(`lps/${b.id}/close`, 'POST', undefined, 'row-close'));
  };
  const remove = () => act(async () => { if (confirm(`Remove the ${lpName(b)} liquidity bot and its history?`)) { await botApi(`lps/${b.id}`, 'DELETE'); nav({ v: 'home' }); } });

  return (
    <main className="stack">
      <button type="button" className="back" onClick={() => nav({ v: 'home' })}>← Home</button>
      <div className="detail-head">
        <div className="detail-id">
          <StatusDot beat={b.priceAt} state={closing ? 'closing' : b.lastError ? 'error' : b.status} />
          <h2>{lpName(b)}</h2>
          <ChainBadge c={chainOf(s, b.chainId)} testnet={false} />
          <span className="tag">Liquidity</span>
          {b.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
          <DexTag name={b.dexName} feeBps={b.feeBps} feeTier={b.feeTier} />
          <span className={`st ${closing ? 'closing' : b.status}`}>{closing ? 'Closing…' : closed ? 'Closed' : running ? 'Running' : 'Paused'}{step && !closing ? ` · ${ACTION[step.action].toLowerCase()}` : ''}</span>
        </div>
        <div className="detail-actions">
          {running && <button type="button" className="btn" disabled={busy} onClick={() => act(() => botApi(`lps/${b.id}/stop`, 'POST', undefined, 'row-pause'))}>Pause</button>}
          {b.status === 'stopped' && <button type="button" className="btn primary" disabled={busy || b.available === false} onClick={() => act(() => chk.run(b.mode === 'live', () => botApi(`lps/${b.id}/resume`, 'POST')))}>Resume</button>}
          {!closed && <button type="button" className="btn danger" disabled={busy || closing || b.available === false} title={step?.hash ? 'A transaction is still being confirmed' : 'Take everything out and end the bot'} onClick={close}>{closing ? 'Closing…' : 'Close'}</button>}
          <button type="button" className="btn danger" disabled={busy || !!pos || !!step} title={pos || step ? 'Close the position first' : ''} onClick={remove}>Remove</button>
        </div>
      </div>
      {showHalt(b, closing) && <p className="bot-why">{showHalt(b, closing)}</p>}
      {overrideText(b) && <p className="bot-why">{overrideText(b)}</p>}
      {(chk.on || heldForSafety(s, b.id)) && <SafetyChecking what={chk.on ? 'Checking safety before resuming…' : 'Checking safety after the restart… no open, re-range or send until it passes.'} />}

      <div className="notices">
        {b.lastError && <div className="banner error"><span className="grow">{b.lastError}</span></div>}
        {step && <div className="banner info"><span className="grow"><b>{ACTION[step.action]}:</b> {STAGE[step.stage]}{step.hash ? <> · <a href={explorerTx(s, b.chainId, step.hash)} target="_blank" rel="noreferrer">{step.hash.slice(0, 12)}…</a> waiting to confirm</> : '…'}</span></div>}
        {b.status === 'stopped' && pos && <div className="banner"><span className="grow"><b>Paused with the position open.</b> It keeps earning fees while the price is inside the range, but the range won't move and fees aren't sent until you resume.</span></div>}
        {pos && b.inRange === false && !step && <div className="banner"><span className="grow"><b>The price is outside the range</b>, so the position isn't earning. {moveNote(b)}</span></div>}
      </div>

      <div className="kpi-row detail-stats" data-testid="top-strip">
        {/* Kyle: the headline is Invested + Generated, in the bot's own coins (the server's capital in) */}
        <div className="kpi" data-testid="invested">
          <span><L tip="What was put into this bot at the start, coin by coin.">Invested</L></span>
          <div className="kpi-v coins2"><b>{bagFixed(m?.capitalCoins)}</b></div>
          <span className="sub">put in at the start</span>
        </div>
        <div className="kpi">
          <span><L tip={m?.calc ?? 'Generated'}>Generated</L></span>
          <div className="kpi-v coins2">{m?.generated ? <>{Object.entries(m.generated).map(([sym, u]) => <b key={sym} className={cls(u)}>{qty(u, sym, 5)}</b>)}</> : '—'}</div>
          <span className="sub">fees − gas − swap fees − range-move losses, per coin</span>
        </div>
        <div className="kpi">
          <span><L tip="The coins in the position right now (they change as the price moves inside the range), and its share of the liquidity trading at today's price, which is its share of every trade's fee. Out of range the share is 0.">Liquidity provided</L></span>
          <div className="kpi-v coins2">{b.coins ? <><b>{num(b.coins.base, 6)} {base}</b><b>{num(b.coins.quote, 6)} {q}</b></> : '—'}</div>
          <span className="sub">{b.poolShare != null ? <>{pct(b.poolShare, b.poolShare < 0.001 ? 4 : 2)} of the pool's active liquidity</> : 'once the position is open'}</span>
        </div>
      </div>
      <MoneyDetails b={b} breakdown={lpBreakdown(b)} hide={['Deposit']} note="fees earned − costs = Generated, total P&L, price change" />

      <GeneratedPace b={b} />

      <div className="split wide-left">
        <div className="card">
          <Chart status={s} ticks={ticks} pairs={[b.market]} pair={b.market} tf="1h" compact desk mid height={480} />
          <p className="muted small">The amber lines are the position's range. It earns fees while the price is between them.</p>
          <StatTable b={b} s={s} hide={metricsOf(b)?.generatedRate.d1 ? LP_SHOWN_ELSEWHERE : LP_SHOWN_ELSEWHERE.filter((k) => k !== 'Age')} />
        </div>
        <div className="stack">
          <div className="card" data-testid="position-card">
            <h3>{pos ? (b.inRange ? 'In range, earning' : 'Out of range') : closed ? 'Closed' : 'No position open'}</h3>
            {pos ? <>
              <RangeHealth b={b} act={act} busy={busy} />
              {!closed && <RangeControls key={`${b.config.bandPct}`} b={b} act={act} busy={busy} />}
              <p className="muted small">{openedText(b, pos)} · {b.mode === 'live' ? `position #${pos.id}` : 'paper position'} · ±{pct(b.config?.bandPct, 0)} wide</p>
            </> : <p className="small muted">{closed ? 'Everything went back to the wallet.' : 'Opens on the next check.'}</p>}
            {(b.idle.base > 0 || b.idle.quote > 0) && <p className="muted small">Outside the position: {num(b.idle.base, 6)} {base} + {num(b.idle.quote, 6)} {q} (left over from the mix{closed ? ', now in your wallet' : ''})</p>}
            {(b.aside?.base > 0 || b.aside?.quote > 0) && <p className="muted small">Set aside: {num(b.aside.base, 6)} {base} + {num(b.aside.quote, 6)} {q} (kept out so the position stays under 10% of the pool's active liquidity; it is counted in Value and goes back to your wallet when the bot closes)</p>}
          </div>
          <LpSettings key={`${b.profits?.mode}-${b.profits?.to ?? ''}`} b={b} act={act} busy={busy} />
        </div>
      </div>

      <div className="split">
        <ValueOverTime q={q} note="after gas, with fees sent out counted" data={b.equityHist ?? []} />
        <div className="card"><h3>Log</h3><BotLog events={events} botId={b.id} /></div>
      </div>
    </main>
  );
}
