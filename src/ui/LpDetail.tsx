/** One liquidity bot: range vs price, fees earned in each coin, what it cost, its coins and pool share, settings, its own log. */
import { useEffect, useState } from 'react';
import { botApi } from './api';
import { StatusDot } from './motion';
import { Chart, EquityChart } from './Chart';
import { StatTable } from './StatTable';
import { MoneyDetails } from './MoneyDetails';
import { ago, cls, dur, num, pct, px, qty, usd } from './fmt';
import { LP_BAND } from '../market/lp';
import { ChainBadge, DexTag, chainOf, explorerTx } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { isAddress, ProfitsField, profitsBody, type ProfitsChoice } from './NewBot';
import { T } from './theme';
import { L } from './Tip';
import { type AnyObj, type Nav } from './model';
import { Usd } from './money';
import { showHalt } from './haltText';
import { metricsOf, unitsText } from './deskStats';

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
      <p className="muted small">Moved {b.reranges} time{b.reranges === 1 ? '' : 's'}{b.lastRerangeAt ? `, last ${ago(b.lastRerangeAt)}` : ''}.</p>
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

/** A coin's price in dollars: the base from the pool price, the quote from its own (null when it has none). */
function usdPrices(b: AnyObj, k: number | null): { base: number | null; quote: number | null } {
  return { base: k != null && b.price != null ? b.price * k : null, quote: k };
}

/**
 * The bot's pace: Generated so far carried to a day, a week and a month, straight from the server's metrics
 * (generatedRate / est). Same min-history rule as every estimate (window ÷ 365/7): a day needs ~28 min, a week ~3.2h,
 * a month ~13.8h; until then a dash and "needs … of history". No client-side extrapolation.
 */
function GeneratedPace({ b }: { b: AnyObj }) {
  const m = metricsOf(b);
  if (!m || !m.generated) return null;
  const rows = [['A day', m.generatedRate.d1, m.est.d1, m.generatedRate.needs.d1], ['A week', m.generatedRate.d7, m.est.d7, m.generatedRate.needs.d7], ['A month', m.generatedRate.d30, m.est.d30, m.generatedRate.needs.d30]] as const;
  return (
    <div className="card pace" data-testid="generated-pace">
      <div className="card-head">
        <h3><L tip={`${m.calc}`}>Pace</L></h3>
        <span className="muted small">{m.ageSec != null ? `running ${dur(m.ageSec * 1000)}` : ''}</span>
      </div>
      <p className="small">Generated so far: <b>{unitsText(m.generated)}</b>{m.generatedUsd != null && <span className="muted"> ≈ {usd(m.generatedUsd, true)}</span>}</p>
      <div className="pace-rows">{rows.map(([label, units, dollars, need]) => (
        <div key={label} className="pace-row">
          <span className="k">{label}</span>
          {units ? <>
            <b className={cls(dollars)}>{unitsText(units)}</b>
            <span className="small muted">{dollars == null ? '' : `≈ ${usd(dollars, true)}`}</span>
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
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (!b) return null;

  const m = metricsOf(b);
  const q = b.quote, base = b.base, k: number | null = m?.quote.usdPerQuote ?? b.usdPerQuote ?? null;
  const prices = usdPrices(b, k);
  const pnl: AnyObj | null = b.pnl;
  const pos = b.position, step = b.step;
  const running = b.status === 'running', closed = b.status === 'closed';
  const closing = !!b.closing || step?.action === 'close';
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
          {prices.base != null && <span className="pill mono" title={`Today's prices in dollars${prices.quote != null ? ` (${q} at ${usd(prices.quote)})` : ''}`}>{base} {usd(prices.base)}{prices.quote != null && Math.abs(prices.quote - 1) > 0.02 ? ` · ${q} ${usd(prices.quote)}` : ''}</span>}
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

      <div className="kpi-row detail-stats">
        <div className="kpi">
          <span><L tip={m?.calc ?? 'Generated'}>Generated</L></span>
          <div className="kpi-v coins2">{m?.generated ? <>{Object.entries(m.generated).map(([sym, u]) => <b key={sym} className={cls(u)}>{qty(u, sym, 5)}</b>)}</> : '—'}</div>
          <span className="sub">fees − gas − swap fees − range-move losses, per coin{m?.generatedUsd != null && <span className="usd"> ≈ {usd(m.generatedUsd, true)} at today's price</span>}</span>
        </div>
        <div className="kpi">
          <span><L tip={`Your share of the pool's trading fees, in the coins they were paid in: collected so far plus what's waiting in the position. A trade selling ${base} pays its fee in ${base}; one buying it pays in ${q}. The coins' price doesn't change these amounts.`}>Fees earned</L></span>
          <div className="kpi-v coins2">{pnl ? <><b className={cls(pnl.feeCoins.base)}>{qty(pnl.feeCoins.base, base, 5)}</b><b className={cls(pnl.feeCoins.quote)}>{qty(pnl.feeCoins.quote, q, 5)}</b></> : '—'}</div>
          <span className="sub">{pnl ? <>waiting in the position: {num(b.owed?.base, 6)} {base} + {num(b.owed?.quote, 6)} {q}<Usd v={pnl.fees} k={k} /></> : 'measuring…'}</span>
        </div>
        <div className="kpi">
          <span><L tip={`Everything that came off the fees, in ${q}: gas for every open, range move, close and fee collect; what the swaps to the range's mix lost to the pool fee and price impact; and what each range move locked in. While the price is inside the range the position sells ${base} as it rises and buys it as it falls, so it ends up with more of whichever coin fell; taking it out (to move the range, or to close) makes that final, and the shortfall against the coins put in, at the same price, is the range-move loss.`}>Costs</L></span>
          <div className={`kpi-v ${pnl && pnl.gas + pnl.swapCost + pnl.moveLoss > 0 ? 'neg' : ''}`}>{pnl ? qty(-(pnl.gas + pnl.swapCost + pnl.moveLoss), q, 4) : '—'}</div>
          <span className="sub">{pnl ? <>gas {qty(pnl.gas, q, 3, false)} · swaps {qty(pnl.swapCost, q, 3, false)} · range moves {qty(pnl.moveLoss, q, 3, false)} ({b.reranges} move{b.reranges === 1 ? '' : 's'})<Usd v={-(pnl.gas + pnl.swapCost + pnl.moveLoss)} k={k} /></> : ''}</span>
        </div>
        <div className="kpi">
          <span><L tip="The coins in the position right now (they change as the price moves inside the range), and its share of the liquidity trading at today's price, which is its share of every trade's fee. Out of range the share is 0.">Liquidity provided</L></span>
          <div className="kpi-v coins2">{b.coins ? <><b>{num(b.coins.base, 6)} {base}</b><b>{num(b.coins.quote, 6)} {q}</b></> : '—'}</div>
          <span className="sub">{b.poolShare != null ? <>{pct(b.poolShare, b.poolShare < 0.001 ? 4 : 2)} of the pool's active liquidity</> : 'once the position is open'}<Usd v={b.coins && b.price != null ? b.coins.base * b.price + b.coins.quote : null} k={k} sign={false} /></span>
        </div>
      </div>
      <MoneyDetails b={b} />

      <GeneratedPace b={b} />

      <div className="split wide-left">
        <div className="card">
          <Chart status={s} ticks={ticks} pairs={[b.market]} pair={b.market} tf="1h" compact desk mid height={480} />
          <p className="muted small">The amber lines are the position's range. It earns fees while the price is between them.</p>
          <StatTable b={b} s={s} />
        </div>
        <div className="stack">
          <div className="card">
            <h3>{pos ? (b.inRange ? 'In range, earning' : 'Out of range') : closed ? 'Closed' : 'No position open'}</h3>
            {pos ? <>
              <p className="small">{px(pos.lower)} – {px(pos.upper)} {q}/{base} · price {px(b.price)}</p>
              <RangeGauge lower={pos.lower} upper={pos.upper} price={b.price} />
              {!closed && <RangeControls key={`${b.config.bandPct}`} b={b} act={act} busy={busy} />}
              <p className="small">In the position: <b>{num(b.coins?.base, 6)} {base}</b> + <b>{num(b.coins?.quote, 6)} {q}</b></p>
              <p className="small">Fees waiting: {num(b.owed?.base, 8)} {base} + {num(b.owed?.quote, 8)} {q}</p>
              <p className="muted small">Opened {ago(pos.openedAt)} · {b.mode === 'live' ? `position #${pos.id}` : 'paper position'} · ±{pct(b.config?.bandPct, 0)} wide</p>
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
