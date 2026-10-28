/** One liquidity bot: range vs price, fees earned in each coin, what it cost, its coins and pool share, settings, its own log. */
import { useEffect, useState, type ReactNode } from 'react';
import { botApi } from './api';
import { StatusDot } from './motion';
import { Chart, EquityChart } from './Chart';
import { StatTable } from './StatTable';
import { ago, cls, dur, num, pct, px, qty } from './fmt';
import { LP_BAND } from '../market/lp';
import { ChainBadge, DexTag, chainOf, explorerTx } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { isAddress, ProfitsField, profitsBody, type ProfitsChoice } from './NewBot';
import { T } from './theme';
import { L } from './Tip';
import { type AnyObj, type Nav } from './model';
import { formatTokens, generatedOf, generatedPct, investedOf } from './generatedView';
import { showHalt } from './haltText';
import { isShortRun, runSpan } from './runRate';
import { estimates } from '../shared/generated';
import { sameFigure, type StatKey } from './StatTable';

interface Props { s: AnyObj; id: string; events: ActivityEvent[]; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

const ACTION: Record<string, string> = { open: 'Opening', rerange: 'Moving the range', close: 'Closing', send: 'Sending fees' };
const STAGE: Record<string, string> = { exit: 'taking the position out', swap: "swapping to the range's mix", approve: 'approving the position manager', mint: 'opening the position', collect: 'collecting the fees' };

/** Out of range: when the range moves, or why it doesn't. */
function moveNote(b: AnyObj): string {
  if (!b.config?.rerange) return 'Auto-move is off: it waits for the price to come back, or move it yourself below.';
  if (b.move.block) return `It can't move the range now: ${b.move.block}.`;
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
      {/* the count is on the Lost to range moves card (each figure once) */}
      <p className="muted small">{b.lastRerangeAt ? `Last moved ${ago(b.lastRerangeAt)}.` : 'Not moved yet.'}</p>
    </div>
  );
}

/** Range on a line: the band is the position, the marker is the price (the line reaches 25% of the width past each end). */
function RangeGauge({ lower, upper, price }: { lower: number; upper: number; price: number | null }) {
  const pad = (upper - lower) * 0.25, lo = lower - pad, hi = upper + pad;
  const at = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))}%`;
  return (
    <div className="gauge" title={`range ${px(lower)} – ${px(upper)}${price != null ? ` · price ${px(price)}` : ''}`}>
      <div className="gauge-track" />
      <span className="gauge-band" style={{ left: at(lower), width: `calc(${at(upper)} - ${at(lower)})` }} />
      {price != null && <span className="gauge-price" style={{ left: at(price) }} />}
    </div>
  );
}

function LpSettings({ b, act, busy }: { b: AnyObj; act: Props['act']; busy: boolean }) {
  const cur: { mode: 'reinvest' | 'send'; to?: string } = b.profits ?? { mode: 'reinvest' };
  const [p, setP] = useState<ProfitsChoice>({ mode: cur.mode, to: cur.to ?? '' });
  const changed = p.mode !== cur.mode || (p.mode === 'send' && p.to !== (cur.to ?? ''));
  const q = b.quote;
  return (
    <div className="card">
      <h3>Settings</h3>
      <div className="follow-row">
        <ProfitsField p={p} set={setP} kind="lp" />
        {changed && <button type="button" className="btn small-btn primary" disabled={busy || (p.mode === 'send' && !isAddress(p.to))}
          onClick={() => act(() => botApi(`lps/${b.id}/profits`, 'PUT', profitsBody(p)))}>Save</button>}
        {b.totals.sent > 0 && <span className="small">Sent so far: {qty(b.totals.sent, q, 5, false)}{cur.mode === 'send' ? ` to ${cur.to}` : ''}.</span>}
      </div>
    </div>
  );
}

/**
 * What the open position earns at its own pace: its fees since it opened (collected + waiting), per hour, carried to a
 * day, a week and a month. Only this position's history; the time it spent out of range is in the pace.
 */
/** Two moments that are the same event (within 2 minutes): the position opening and the run starting or the last move. */
const sameTime = (a: number | null | undefined, c: number | null | undefined) => typeof a === 'number' && typeof c === 'number' && Math.abs(a - c) < 120_000;
/**
 * When the open position opened, said without repeating a time already on the page: at the run's start (its age is the
 * run's, on the headline net card or in the table) or at the last range move ("Last moved 19h ago").
 */
function openedWhen(b: AnyObj, at: number, words: [start: string, move: string], opened: (ms: number) => string): string {
  if (sameTime(at, b.startedAt)) return words[0];
  if (sameTime(at, b.lastRerangeAt)) return words[1];
  return opened(at);
}

function PositionPace({ b }: { b: AnyObj }) {
  const pf = b.positionFees, base = b.base, q = b.quote;
  if (!b.position || !pf) return null;
  // its fees so far are all the bot's fees (the Fees earned card): say so rather than repeat the coins
  const allFees = b.pnl?.feeCoins && sameFigure(pf.coins.base, b.pnl.feeCoins.base) && sameFigure(pf.coins.quote, b.pnl.feeCoins.quote);
  const ms = Date.now() - pf.since;
  const coins = [{ symbol: base, amount: pf.coins.base }, { symbol: q, amount: pf.coins.quote }];
  // per token ÷ days open × 1, 7, 365 (shared estimates); none under a day. Crypto units only.
  const est = estimates(coins, ms / 1000);
  const pace = est.h24 && est.d7 && est.d365 ? { d1: est.h24, d7: est.d7, d365: est.d365 } : null;
  return (
    <div className="card pace">
      <div className="card-head">
        <h3><L tip={`Fees this position has earned since it opened (collected plus waiting), in each coin, carried forward at the same pace: an estimate, not a forecast. It counts only this position: a range move starts a new one. Time the price spent outside the range is in the pace, so a pace from a calm stretch can run high.`}>This position's pace</L></h3>
        <span className="muted small">open {openedWhen(b, pf.since, ['since the start', 'since the last move'], () => dur(ms))}</span>
      </div>
      {allFees
        ? <p className="small">So far: the fees in Generated and Details above (this is the bot's first position).</p>
        : <p className="small">So far: <b>{formatTokens(coins, false, 4)}</b></p>}
      {!pace
        ? <p className="small muted">The estimate (a day, 7 days, 365 days) shows once the position has been open a day.</p>
        : <div className="pace-rows">{([['Est. a day', pace.d1], ['Est. 7 days', pace.d7], ['Est. 365 days', pace.d365]] as const).map(([label, x]) => (
            <div key={label} className="pace-row">
              <span className="k">{label}</span>
              <b className="pos">{formatTokens(x, false, 4)}</b>
            </div>
          ))}</div>}
      <p className="muted small">If it keeps earning as it has since it opened{b.inRange === false ? '. It is out of range now, so it earns nothing until the price is back inside or the range moves' : ''}.</p>
    </div>
  );
}

/**
 * What the headline Generated is made of, collapsed under it: fees earned (and how much is still waiting), costs paid,
 * what range moves lost, and Generated as a share of what was put in. Crypto units only; no price-move lines.
 */
/** Equal coin amounts (relative, so tiny amounts of a pricey coin aren't all "the same"). */
const sameCoins = (a: unknown, c: unknown) => typeof a === 'number' && typeof c === 'number' && Math.abs(a - c) <= 1e-12 + 1e-6 * Math.abs(c);

function NetDetails({ b, pnl, q, base }: { b: AnyObj; pnl: AnyObj; q: string; base: string }) {
  const share = generatedPct(b);
  const rows: [string, ReactNode][] = [
    // the base-coin fees are Generated's base amount above (no cost comes out of them): named, not repeated
    ['Fees earned', <><b className={cls(pnl.feeCoins.quote)}>{qty(pnl.feeCoins.quote, q, 5, false)}</b><span className="muted"> + the {base} in Generated above</span></>],
    // nothing collected yet: the waiting fees are all of them, said in words rather than the same coins again
    ['Of those, still waiting in the position', sameCoins(b.owed?.base, pnl.feeCoins.base) && sameCoins(b.owed?.quote, pnl.feeCoins.quote)
      ? 'all of them (none collected yet)'
      : `${num(b.owed?.base, 6)} ${base} + ${num(b.owed?.quote, 6)} ${q}`],
    // the two costs on their own rows: a total beside them repeats whichever one is most of it
    ['Costs paid: gas', qty(-pnl.gas, q, 4)],
    [`Costs paid: swaps to the range's mix (pool fee and price impact)`, qty(-pnl.swapCost, q, 4)],
    [`Lost to range moves (${b.reranges} move${b.reranges === 1 ? '' : 's'})`, qty(-pnl.moveLoss, q, 4)],
    ['Generated as a share of what you put in', share == null ? '—' : pct(share, 2, true)],
  ];
  return (
    <details className="card net-details">
      <summary>Details: what Generated is made of</summary>
      <table className="net-table"><tbody>
        {rows.map(([label, v]) => <tr key={label}><th>{label}</th><td className="mono">{v}</td></tr>)}
      </tbody></table>
    </details>
  );
}

export function LpDetail({ s, id, events, ticks, nav, act, busy }: Props) {
  const b: AnyObj | undefined = (s.lps ?? []).find((x: AnyObj) => x.id === id);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (!b) return null;

  const q = b.quote, base = b.base;
  const lpb = { ...b, kind: 'lp' };
  const gen = generatedOf(lpb), inv = investedOf(lpb);
  const pnl: AnyObj | null = b.pnl;
  const pos = b.position, step = b.step;
  const running = b.status === 'running', closed = b.status === 'closed';
  const closing = !!b.closing || step?.action === 'close';
  // a daily rate only once it has run a full day; under a day, the net over the run (runRate.ts)
  const runMs = b.startedAt ? Date.now() - b.startedAt : null;
  // Each figure once per screen: the cards above have Invested and Generated, Details the fees, costs and moves, the range
  // card the range and width.
  const omit: StatKey[] = ['invested', 'net', 'feesEarned', 'feesPaid', 'moves', 'range', 'spacing', 'lastMove'];
  // the headline cards have the run length under a day ("over 8.8h")
  if (isShortRun(runMs)) omit.push('age');
  const close = () => {
    if (b.mode === 'live' && !confirm(`Take the ${b.label} position out? The coins go back to your wallet as ${base} and ${q}. The same price-impact and slippage limits still apply.`)) return;
    act(() => botApi(`lps/${b.id}/close`, 'POST', undefined, 'row-close'));
  };
  const remove = () => act(async () => { if (confirm(`Remove the ${b.label} liquidity bot and its history?`)) { await botApi(`lps/${b.id}`, 'DELETE'); nav({ v: 'home' }); } });

  return (
    <main className="stack">
      <button type="button" className="back" onClick={() => nav({ v: 'home' })}>← Home</button>
      <div className="detail-head">
        <div className="detail-id">
          <StatusDot beat={b.priceAt} state={closing ? 'closing' : b.lastError ? 'error' : b.status} />
          <h2>{b.label}</h2>
          <ChainBadge c={chainOf(s, b.chainId)} testnet={false} />
          <span className="tag">Liquidity</span>
          {b.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
          <DexTag name={b.dexName} feeBps={b.feeBps} feeTier={b.feeTier} />
          <span className={`st ${closing ? 'closing' : b.status}`}>{closing ? 'Closing…' : closed ? 'Closed' : running ? 'Running' : 'Paused'}{step && !closing ? ` · ${ACTION[step.action].toLowerCase()}` : ''}</span>
          {b.price != null && <span className="pill mono" title={`The pool's price now, in ${q} per ${base}`}>{base} {px(b.price)} {q}</span>}
        </div>
        <div className="detail-actions">
          {running && <button type="button" className="btn" disabled={busy} onClick={() => act(() => botApi(`lps/${b.id}/stop`, 'POST', undefined, 'row-pause'))}>Pause</button>}
          {b.status === 'stopped' && <button type="button" className="btn primary" disabled={busy || b.available === false} onClick={() => act(() => botApi(`lps/${b.id}/resume`, 'POST'))}>Resume</button>}
          {!closed && <button type="button" className="btn danger" disabled={busy || closing || b.available === false} title={step?.hash ? 'A transaction is still being confirmed' : 'Take everything out and end the bot'} onClick={close}>{closing ? 'Closing…' : 'Close'}</button>}
          <button type="button" className="btn danger" disabled={busy || !!pos || !!step} title={pos || step ? 'Close the position first' : ''} onClick={remove}>Remove</button>
        </div>
      </div>
      {showHalt(b, closing) && <p className="bot-why">{showHalt(b, closing)}</p>}

      <div className="notices">
        {b.lastError && <div className="banner error"><span className="grow">{b.lastError}</span></div>}
        {step && <div className="banner info"><span className="grow"><b>{ACTION[step.action]}:</b> {STAGE[step.stage]}{step.hash ? <> · <a href={explorerTx(s, b.chainId, step.hash)} target="_blank" rel="noreferrer">{step.hash.slice(0, 12)}…</a> waiting to confirm</> : '…'}</span></div>}
        {b.status === 'stopped' && pos && <div className="banner"><span className="grow"><b>Paused with the position open.</b> It keeps earning fees while the price is inside the range, but the range won't move and fees aren't sent until you resume.</span></div>}
        {pos && b.inRange === false && !step && <div className="banner"><span className="grow"><b>The price is outside the range</b>, so the position isn't earning. {moveNote(b)}</span></div>}
      </div>

      {/* Headline (Kyle): Invested + Generated, net of costs, in tokens. What Generated is made of sits in the collapsed
          Details below. No price-move figures, no dollars. */}
      <div className="kpi-row detail-stats">
        <div className="kpi">
          <span><L tip={`What the bot put in, in ${q}.`}>Invested</L></span>
          <div className="kpi-v">{inv ? formatTokens([inv], false) : '—'}</div>
          <span className="sub">{isShortRun(runMs) ? runSpan(runMs) : 'since it started'}</span>
        </div>
        <div className="kpi">
          <span><L tip={`The fees earned in each coin, with the costs paid and what range moves lost taken out of the ${q} side. The coins' own price move isn't in it: that happens whether or not the bot runs. Details below shows each part.`}>Generated, net of costs</L></span>
          <div className={`kpi-v coins2 ${cls(pnl?.net)}`}>{gen ? gen.tokens.map((t) => <b key={t.symbol} className={cls(t.amount)}>{formatTokens([t], true)}</b>) : '—'}</div>
        </div>
        <div className="kpi">
          <span><L tip="The coins in the position right now (they change as the price moves inside the range), and its share of the liquidity trading at today's price, which is its share of every trade's fee. Out of range the share is 0.">Liquidity provided</L></span>
          <div className="kpi-v coins2">{b.coins ? <><b>{num(b.coins.base, 6)} {base}</b><b>{num(b.coins.quote, 6)} {q}</b></> : '—'}</div>
          <span className="sub">{b.poolShare != null ? <>{pct(b.poolShare, b.poolShare < 0.001 ? 4 : 2)} of the pool's active liquidity</> : 'once the position is open'}</span>
        </div>
      </div>
      {pnl?.feeCoins && <NetDetails b={lpb} pnl={pnl} q={q} base={base} />}

      <PositionPace b={b} />

      <div className="split wide-left">
        <div className="card">
          <Chart status={s} ticks={ticks} pairs={[b.market]} pair={b.market} tf="1h" compact desk height={480} />
          <p className="muted small">The amber lines are the position's range. It earns fees while the price is between them.</p>
          <StatTable b={b} s={s} omit={omit} />
        </div>
        <div className="stack">
          <div className="card">
            <h3>{pos ? (b.inRange ? 'In range, earning' : 'Out of range') : closed ? 'Closed' : 'No position open'}</h3>
            {pos ? <>
              <p className="small">{px(pos.lower)} – {px(pos.upper)} {q}/{base}</p>
              <RangeGauge lower={pos.lower} upper={pos.upper} price={b.price} />
              {!closed && <RangeControls key={`${b.config.bandPct}`} b={b} act={act} busy={busy} />}
              {/* the coins in it and the fees waiting are on the Liquidity provided and Fees earned cards */}
              <p className="muted small">Opened {openedWhen(b, pos.openedAt, ['at the start', 'at the last move'], (t) => ago(t))} · {b.mode === 'live' ? `position #${pos.id}` : 'paper position'} · ±{pct(b.config?.bandPct, 0)} wide</p>
            </> : <p className="small muted">{closed ? 'Everything went back to the wallet.' : 'Opens on the next check.'}</p>}
            {(b.idle.base > 0 || b.idle.quote > 0) && <p className="muted small">Outside the position: {num(b.idle.base, 6)} {base} + {num(b.idle.quote, 6)} {q} (left over from the mix{closed ? ', now in your wallet' : ''})</p>}
          </div>
          <LpSettings key={`${b.profits?.mode}-${b.profits?.to ?? ''}`} b={b} act={act} busy={busy} />
        </div>
      </div>

      <div className="split">
        <div className="card">
          <h3>Value over time <span className="muted small">{q}, after gas, with fees sent out counted</span></h3>
          <EquityChart series={[{ name: `value ${q}`, data: b.equity ?? [], color: T.text }]} />
        </div>
        <div className="card"><h3>Log</h3><BotLog events={events} botId={b.id} /></div>
      </div>
    </main>
  );
}
