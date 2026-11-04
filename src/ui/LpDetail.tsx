/** One liquidity bot: range vs price, fees earned in each coin, what it cost, its coins and pool share, settings, its own log. */
import { useEffect, useState } from 'react';
import { botApi } from './api';
import { AnimatedNumber, StatusDot } from './motion';
import { Chart } from './Chart';
import { StatTable } from './StatTable';
import { MoneyDetails, type DetailRow } from './MoneyDetails';
import { ago, bagFixed, cls, dur, num, pct, pctShown, px, qty } from './fmt';
import { LP_BAND } from '../market/lp';
import { ChainBadge, DexTag, chainOf } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { isAddress, ProfitsField, profitsBody, type ProfitsChoice } from './NewBot';
import { draftFrom, LpPolicyFields, payloadFrom, type PolicyDraft } from './LpPolicyFields';
import { L } from './Tip';
import { lpName, type AnyObj, type Nav } from './model';
import { overrideText, showHalt } from './haltText';
import { SafetyChecking, heldForSafety, useSafetyChecking } from './SafetyChecking';
import { botFacts, metricsOf, unitsText } from './deskStats';
import { ask, type AskRow } from './Confirm';
import { DayMoves, FeesByHour, PositionWeight, StartToNow } from './LpDayCards';
import type { LpDay, LpDone } from '../metrics/lpDay';
import { TxProgress } from './TxProgress';
import { Calendar } from './DayCharts';
import type { DayResult } from '../metrics/daily';

interface Props { s: AnyObj; id: string; events: ActivityEvent[]; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

const ACTION: Record<string, string> = { open: 'Opening', rerange: 'Moving the range', close: 'Closing', send: 'Sending fees', compound: 'Compounding fees' };

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

/** The confirmation's preview: the fees waiting in the position, collected by the step (live readings only). */
function feeRows(b: AnyObj): AskRow[] {
  const o = b.owed as { base: number; quote: number } | null;
  if (!o || !(o.base > 0 || o.quote > 0)) return [];
  return [{ k: 'fees collected', v: `${qty(o.base, b.base, 5)} + ${qty(o.quote, b.quote, 5)}`, tone: 'pos' }];
}
/** Closing: what goes back to the wallet, coin by coin (the position, its fees, and the coins outside it). */
function closeRows(b: AnyObj): AskRow[] {
  const sum = (k: 'base' | 'quote') => (b.coins?.[k] ?? 0) + (b.owed?.[k] ?? 0) + (b.idle?.[k] ?? 0) + (b.aside?.[k] ?? 0);
  return [
    { k: 'back to your wallet, about', v: `${qty(sum('base'), b.base, 6, false)} + ${qty(sum('quote'), b.quote, 6, false)}` },
    ...feeRows(b).map((r) => ({ ...r, k: 'of which fees' })),
  ];
}

/** Auto-move on or off, and a move now: to the price at the same width, or at a new one. */
function RangeControls({ b, act, busy }: { b: AnyObj; act: Props['act']; busy: boolean }) {
  const cur: number = b.config.bandPct;
  const [w, setW] = useState(String(+(cur * 100).toFixed(2)));
  const band = Number(w) / 100, ok = band >= LP_BAND.min && band <= LP_BAND.max, same = ok && Math.abs(band - cur) < 1e-9;
  const why = b.status !== 'running' ? 'Resume it first' : b.step ? 'Busy with a step' : !ok ? `Range must be ±${LP_BAND.min * 100}% to ±${LP_BAND.max * 100}%` : '';
  const move = () => act(async () => {
    if (b.mode === 'live' && !(await ask({
      title: same ? `Move ${lpName(b)} to the price` : `Change ${lpName(b)} to ±${+(band * 100).toFixed(2)}%`,
      body: 'The position is taken out and opened again around the price: gas, a swap to the new mix, and the coin mix it has now becomes final.',
      rows: [
        { k: 'range now', v: `${px(b.position.lower)} – ${px(b.position.upper)}` },
        { k: 'new range', v: `±${+(band * 100).toFixed(2)}% around ${px(b.price)}` },
        ...feeRows(b),
      ],
      action: same ? 'Move the range' : 'Change the range', money: true,
    }))) return;
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
    if (b.mode === 'live' && !(await ask({
      title: `Compound ${lpName(b)}`, body: 'The waiting fees are collected and added back into this range. Gas applies.',
      rows: feeRows(b), action: 'Compound the fees', money: true,
    }))) return;
    await botApi(`lps/${b.id}/compound`, 'POST');
  });
  const doWiden = () => act(async () => {
    if (widen == null) return;
    if (b.mode === 'live' && !(await ask({
      title: `Widen ${lpName(b)} to ±${(widen * 100).toFixed(1)}%`, body: 'The position is taken out and opened again, wider, around the price.',
      rows: [{ k: 'range now', v: `${px(pos.lower)} – ${px(pos.upper)}` }, { k: 'new range', v: `±${(widen * 100).toFixed(1)}% around ${px(price)}` }, ...feeRows(b)],
      action: 'Widen the range', money: true,
    }))) return;
    await botApi(`lps/${b.id}/move`, 'POST', { bandPct: widen });
  });
  return (
    <div className="lp-health">
      <PositionWeight b={b} />
      <div className="lp-health-top">
        {/* how near an edge it is: the knob on the range scale above (a "% to edge" figure could print as the weight's) */}
        <span className={`lp-edge ${out ? 'out' : ''}`}>{out ? `out of range${outFor ? ` ${outFor}m` : ''}` : toEdge != null && toEdge < 0.2 ? 'near the edge' : 'inside the range'}</span>
        <span className="small muted">{b.poolShare != null ? <><L tip="The position's share of the liquidity trading at today's price, which is its share of every trade's fee. Out of range the share is 0.">{pct(b.poolShare, b.poolShare < 0.001 ? 4 : 2)}</L> of the pool's active liquidity</> : ''}</span>
      </div>
      <div className="lp-health-stats">
        <div>
          <span className="k">Fees waiting</span>
          <b className="pos">{waitingText(b.owed?.base, base, gen)}</b>
          <span className="muted small">{waitingText(b.owed?.quote, q, gen)}</span>
        </div>
        <div>
          <span className="k"><L tip="With compounding on, fees are collected and added back into this range once they are worth √(2 × the gas of a compound × the position's value): the point where the gas and the fees lost by waiting balance. Off, they roll in on the next range move or when the bot closes.">Compound at</L></span>
          <b>{compoundOn ? (need != null && Number.isFinite(need) ? qty(need, q, 4, false) : '…') : 'off'}</b>
          <span className="muted small">{compoundOn ? 'sized to the position' : 'rolls in on a move'}</span>
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
/**
 * The fees waiting in one coin. It reads "all of Generated" only when the two amounts are the same number, never when two
 * roundings happen to print alike (0.000188 waiting next to 0.000167 Generated printed as one).
 */
function waitingText(owed: number | null | undefined, sym: string, gen: Record<string, number> | null | undefined): string {
  if (owed == null) return `— ${sym}`;
  // 5 significant digits, as Generated prints: a 4-decimal rounding (0.0113) read as Generated's 0.011276
  const txt = qty(owed, sym, 5, false);
  const g = gen?.[sym];
  const same = g != null && owed !== 0 && Math.abs(owed - g) <= 1e-9 * Math.max(Math.abs(owed), Math.abs(g));
  return same ? `${sym}: all of Generated` : txt;
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
    ['Fees earned, all', <>the Fees bar of Start → now</>, `Both coins' fees together, in ${q} at today's price.`],
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
    <div className="lpb-card pace" data-testid="generated-pace">
      <div className="lpb-head">
        <h3 className="lpb-label"><L tip={`${m.calc}`}>Projection at its pace so far</L></h3>
        <span className="lpb-hint">{m.ageSec != null ? `running ${dur(m.ageSec * 1000)}` : ''}</span>
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

/**
 * The top strip: Generated (per coin, rolling), today's fees against yesterday by this time, the APR at Generated's
 * pace (botMetrics; none under a day), the pool's last 24 hours, and what was put in with what it is worth now.
 */
function Hero({ b }: { b: AnyObj }) {
  const m = metricsOf(b);
  const q = b.quote as string;
  const day = (b.day ?? null) as LpDay | null;
  const today = day?.today ?? null, y = day?.yesterdayByNow ?? null;
  const vsY = today != null && y != null && y > 0 ? today / y - 1 : null;
  const f = botFacts(b, Date.now(), { chain: null, dex: null, pool: null });
  const apr = f.aprPct;
  const pool = day?.pool ?? null;
  return (
    <div className="lpb-hero" data-testid="top-strip">
      <div className="lpb-card" data-testid="invested">
        <span className="lpb-label"><L tip="What was put into this bot at the start, coin by coin.">Invested</L></span>
        <div className="lpb-big coins">{bagFixed(m?.capitalCoins)}</div>
        <span className="lpb-sub">put in at the start</span>
        {b.value != null && <span className="lpb-sub">worth {qty(b.value, q, 5, false)} now</span>}
      </div>
      <div className="lpb-card lead">
        <span className="lpb-label"><L tip={m?.calc ?? 'Generated'}>Generated</L></span>
        {m?.generated ? Object.entries(m.generated).map(([sym, u], i) => <div key={sym} className={`lpb-big ${i ? 'second' : ''} ${cls(u)}`}><AnimatedNumber value={u} format={(x) => qty(x, sym, 5)} chip={false} /></div>) : <div className="lpb-big">—</div>}
        <span className="lpb-sub">since the start: fees − gas − swap fees, per coin</span>
      </div>
      <div className="lpb-card">
        <span className="lpb-label">Today</span>
        <div className="lpb-big"><AnimatedNumber value={today} format={(x) => qty(x, q, 5)} /></div>
        <span className="lpb-sub">fees since midnight</span>
        {vsY != null && pctShown(vsY, 2) !== '—' && <span className={`lpb-delta ${vsY < 0 ? 'down' : ''}`}>{vsY >= 0 ? '▲' : '▼'} {pctShown(vsY, 2, true)} vs yesterday by now</span>}
      </div>
      <div className="lpb-card">
        <span className="lpb-label"><L tip={f.calc ?? 'APR'}>APR</L></span>
        <div className={`lpb-big ${cls(apr)}`}><AnimatedNumber value={apr} format={(x) => pctShown(x, 2, true)} chip={false} /></div>
        <span className="lpb-sub">{apr != null ? "a year at Generated's pace so far" : f.estHint.d365 ?? 'shows after a day'}</span>
      </div>
      <div className="lpb-card">
        <span className="lpb-label"><L tip="Read from the pool's own fee counters at every check: the fees it paid its liquidity providers, divided by its fee rate to them, is what traded. Only while this bot runs.">Pool · last {pool && pool.hours < 23.9 ? `${pool.hours.toFixed(1)} h` : '24 h'}</L></span>
        <div className="lpb-big">{pool?.volume != null ? <AnimatedNumber value={pool.volume} format={(x) => `≈ ${qty(x, q, 3, false)}`} chip={false} /> : <AnimatedNumber value={pool?.lpFees} format={(x) => qty(x, q, 4, false)} chip={false} />}</div>
        <span className="lpb-sub">{pool?.volume != null ? 'traded in the pool' : pool ? `paid to its liquidity providers${pool.volumeError ? ` (volume: ${pool.volumeError})` : ''}` : 'measured from the next hour of readings'}</span>
        {pool?.share != null && <span className="lpb-sub">your fees: {pctShown(pool.share, 2)} of what it paid</span>}
      </div>
    </div>
  );
}

export function LpDetail({ s, id, events, ticks, nav, act, busy }: Props) {
  const b: AnyObj | undefined = (s.lps ?? []).find((x: AnyObj) => x.id === id);
  const [, tick] = useState(0);
  const chk = useSafetyChecking();
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (!b) return null;

  const q = b.quote, base = b.base;
  const day = (b.day ?? null) as LpDay | null;
  const pos = b.position, step = b.step;
  const running = b.status === 'running', closed = b.status === 'closed';
  const closing = !!b.closing || step?.action === 'close';
  const close = () => act(async () => {
    if (b.mode === 'live' && !(await ask({
      title: `Close ${lpName(b)}`, body: 'The position is taken out and the coins go back to your wallet. The same price-impact and slippage limits still apply.',
      rows: closeRows(b), action: 'Close the position', money: true, danger: true,
    }))) return;
    await botApi(`lps/${b.id}/close`, 'POST', undefined, 'row-close');
  });
  const remove = () => act(async () => {
    if (!(await ask({ title: `Remove ${lpName(b)}`, body: 'The bot and its history are removed. Nothing is sent.', action: 'Remove', danger: true }))) return;
    await botApi(`lps/${b.id}`, 'DELETE'); nav({ v: 'home' });
  });

  return (
    <main className="stack lpb">
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
        <TxProgress b={b} s={s} />
        {b.status === 'stopped' && pos && <div className="banner"><span className="grow"><b>Paused with the position open.</b> It keeps earning fees while the price is inside the range, but the range won't move and fees aren't sent until you resume.</span></div>}
        {pos && b.inRange === false && !step && <div className="banner"><span className="grow"><b>The price is outside the range</b>, so the position isn't earning. {moveNote(b)}</span></div>}
      </div>

      <Hero b={b} />

      {/* the price chart and the position first, side by side, as before the day cards (Kyle 2026-11-04) */}
      <div className="split wide-left">
        <div className="lpb-card">
          <h3 className="lpb-label">Price and range</h3>
          <Chart status={s} ticks={ticks} pairs={[b.market]} pair={b.market} only={b.id} tf="1h" compact desk mid height={420} />
          <p className="muted small">The amber lines are the position's range. It earns fees while the price is between them.</p>
          <StatTable b={b} s={s} hide={[...(metricsOf(b)?.generatedRate.d1 ? LP_SHOWN_ELSEWHERE : LP_SHOWN_ELSEWHERE.filter((k) => k !== 'Age')), 'APR']} />
        </div>
        <div className="lpb-card" data-testid="position-card">
          <h3 className="lpb-label">{pos ? (b.inRange ? 'Position · in range, earning' : 'Position · out of range') : closed ? 'Closed' : 'No position open'}</h3>
          {pos ? <>
            <RangeHealth b={b} act={act} busy={busy} />
            {!closed && <RangeControls key={`${b.config.bandPct}`} b={b} act={act} busy={busy} />}
            <p className="muted small">{openedText(b, pos)} · {b.mode === 'live' ? `position #${pos.id}` : 'paper position'} · ±{+((b.config?.bandPct ?? 0) * 100).toFixed(2)}% wide</p>
          </> : <p className="small muted">{closed ? 'Everything went back to the wallet.' : 'Opens on the next check.'}</p>}
          {(b.idle.base > 0 || b.idle.quote > 0) && <p className="muted small">Outside the position: {num(b.idle.base, 6)} {base} + {num(b.idle.quote, 6)} {q} (left over from the mix{closed ? ', now in your wallet' : ''})</p>}
          {(b.aside?.base > 0 || b.aside?.quote > 0) && <p className="muted small">Set aside: {num(b.aside.base, 6)} {base} + {num(b.aside.quote, 6)} {q} (kept out so the position stays under 10% of the pool's active liquidity; it is counted in Value and goes back to your wallet when the bot closes)</p>}
        </div>
      </div>

      <div className="lpb-main">
        <div className="lpb-col">
          {day ? <FeesByHour day={day} base={base} quote={q} startedAt={typeof b.startedAt === 'number' ? b.startedAt : null} /> : null}
          {day ? <DayMoves day={day} all={(b.done ?? []) as LpDone[]} base={base} quote={q} /> : null}
          <StartToNow b={b} quote={q} />
        </div>
        <div className="lpb-col">
          <GeneratedPace b={b} />
          <Calendar days={(b.daily ?? []) as DayResult[]} />
          <LpSettings key={`${b.profits?.mode}-${b.profits?.to ?? ''}`} b={b} act={act} busy={busy} />
        </div>
      </div>

      <MoneyDetails b={b} breakdown={lpBreakdown(b)} hide={['Deposit', 'Value now', 'Price change', 'Open positions']} note="fees earned − costs = Generated, total P&L, price change" />

      <div className="lpb-card"><h3 className="lpb-label">Log</h3><BotLog events={events} botId={b.id} /></div>
    </main>
  );
}
