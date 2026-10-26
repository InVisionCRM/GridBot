/** One liquidity bot: range vs price, fees earned in each coin, what it cost, its coins and pool share, settings, its own log. */
import { useEffect, useState } from 'react';
import { botApi } from './api';
import { AnimatedNumber, StatusDot } from './motion';
import { Chart, EquityChart } from './Chart';
import { ago, cls, dur, num, pct, px, qty } from './fmt';
import { ChainBadge, DexTag, chainOf, explorerTx } from './chains';
import type { ActivityEvent, Ticks } from './useStream';
import { BotLog } from './GridDetail';
import { isAddress, ProfitsField, profitsBody, type ProfitsChoice } from './NewBot';
import { T } from './theme';
import { L } from './Tip';
import { type AnyObj, type Nav } from './model';
import { Usd } from './money';

interface Props { s: AnyObj; id: string; events: ActivityEvent[]; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean }

const ACTION: Record<string, string> = { open: 'Opening', rerange: 'Moving the range', close: 'Closing', send: 'Sending fees' };
const STAGE: Record<string, string> = { exit: 'taking the position out', swap: "swapping to the range's mix", approve: 'approving the position manager', mint: 'opening the position', collect: 'collecting the fees' };

/** Out of range: when the range moves, or why it doesn't. */
function moveNote(b: AnyObj): string {
  const m = b.move, q = b.quote;
  if (!b.config?.rerange) return 'Moving the range is off: it waits for the price to come back.';
  if (m.block) return `It won't move the range now: ${m.block}.`;
  if (m.cappedUntil) return `It already moved ${m.perDay} times in 24 hours; the next move can come in ${dur(m.cappedUntil - Date.now())}.`;
  if (m.cost == null) return "It moves the range around the price once the fees it's missing pass what moving costs (working out the cost).";
  return `It moves the range around the price once the fees it's missing pass what moving costs: ${qty(m.missed, q, 3, false)} missed so far, the move costs ≈${qty(m.cost, q, 3, false)}.`;
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
      <label className="check follow">
        <input type="checkbox" checked={!!b.config?.rerange} disabled={busy || b.status === 'closed'} onChange={(e) => act(() => botApi(`lps/${b.id}/rerange`, 'PUT', { enabled: e.target.checked }))} />
        <span><b>Move the range with the price</b> <span className="muted">Moved {b.reranges} time{b.reranges === 1 ? '' : 's'}{b.lastRerangeAt ? `, last ${ago(b.lastRerangeAt)}` : ''}. Outside the range it moves once the fees it's missing pass what the move costs (gas plus the swap back to the range's mix), at most {b.move.perDay} times in any 24 hours.</span></span>
      </label>
      <div className="follow-row">
        <ProfitsField p={p} set={setP} kind="lp" />
        {changed && <button type="button" className="btn small-btn primary" disabled={busy || (p.mode === 'send' && !isAddress(p.to))}
          onClick={() => act(() => botApi(`lps/${b.id}/profits`, 'PUT', profitsBody(p)))}>Save</button>}
        {b.totals.sent > 0 && <span className="small">Sent so far: {qty(b.totals.sent, q, 5, false)}{cur.mode === 'send' ? ` to ${cur.to}` : ''}.</span>}
      </div>
    </div>
  );
}

export function LpDetail({ s, id, events, ticks, nav, act, busy }: Props) {
  const b: AnyObj | undefined = (s.lps ?? []).find((x: AnyObj) => x.id === id);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (!b) return null;

  const q = b.quote, base = b.base, k: number | null = b.usdPerQuote ?? null;
  const pnl: AnyObj | null = b.pnl;
  const pos = b.position, step = b.step;
  const running = b.status === 'running', closed = b.status === 'closed';
  // a daily rate only once it has run a full day: the first minutes' costs scaled to a day say nothing
  const days = b.startedAt ? (Date.now() - b.startedAt) / 86_400_000 : null;
  const close = () => act(async () => { if (confirm(`Take the ${b.label} position out? The coins go back to your wallet as ${base} and ${q}.`)) await botApi(`lps/${b.id}/close`, 'POST'); });
  const remove = () => act(async () => { if (confirm(`Remove the ${b.label} liquidity bot and its history?`)) { await botApi(`lps/${b.id}`, 'DELETE'); nav({ v: 'home' }); } });

  return (
    <main className="stack">
      <button type="button" className="back" onClick={() => nav({ v: 'home' })}>← Home</button>
      <div className="detail-head">
        <StatusDot beat={b.priceAt} state={b.lastError ? 'error' : b.status} />
        <ChainBadge c={chainOf(s, b.chainId)} testnet={false} />
        <h2>{b.label}</h2>
        <span className="tag">Liquidity</span>
        {b.mode === 'live' ? <span className="tag live">Live</span> : <span className="tag">Paper</span>}
        <DexTag name={b.dexName} feeBps={b.feeBps} feeTier={b.feeTier} />
        <span className={`st ${b.status}`}>{closed ? 'Closed' : running ? 'Running' : 'Paused'}{step ? ` · ${ACTION[step.action].toLowerCase()}` : ''}</span>
        <span className="grow" />
        {running && <button type="button" className="btn" disabled={busy} onClick={() => act(() => botApi(`lps/${b.id}/stop`, 'POST'))}>Pause</button>}
        {b.status === 'stopped' && <button type="button" className="btn primary" disabled={busy || b.available === false} onClick={() => act(() => botApi(`lps/${b.id}/resume`, 'POST'))}>Resume</button>}
        {!closed && <button type="button" className="btn" disabled={busy || !!step?.hash || b.available === false} title={step?.hash ? 'A transaction is still being confirmed' : 'Take everything out and end the bot'} onClick={close}>Close position</button>}
        <button type="button" className="btn danger" disabled={busy || !!pos || !!step} title={pos || step ? 'Close the position first' : ''} onClick={remove}>Remove</button>
      </div>

      <div className="notices">
        {b.lastError && <div className="banner error"><span className="grow">{b.lastError}</span></div>}
        {step && <div className="banner info"><span className="grow"><b>{ACTION[step.action]}:</b> {STAGE[step.stage]}{step.hash ? <> · <a href={explorerTx(s, b.chainId, step.hash)} target="_blank" rel="noreferrer">{step.hash.slice(0, 12)}…</a> waiting to confirm</> : '…'}</span></div>}
        {b.status === 'stopped' && pos && <div className="banner"><span className="grow"><b>Paused with the position open.</b> It keeps earning fees while the price is inside the range, but the range won't move and fees aren't sent until you resume.</span></div>}
        {pos && b.inRange === false && !step && <div className="banner"><span className="grow"><b>The price is outside the range</b>, so the position isn't earning. {moveNote(b)}</span></div>}
      </div>

      <div className="kpi-row">
        <div className="kpi">
          <span><L tip={`Your share of the pool's trading fees, in the coins they were paid in: collected so far plus what's waiting in the position. A trade selling ${base} pays its fee in ${base}; one buying it pays in ${q}. The coins' price doesn't change these amounts.`}>Fees earned</L></span>
          <div className="kpi-v coins2">{pnl ? <><b className={cls(pnl.feeCoins.base)}>{qty(pnl.feeCoins.base, base, 5)}</b><b className={cls(pnl.feeCoins.quote)}>{qty(pnl.feeCoins.quote, q, 5)}</b></> : '—'}</div>
          <span className="sub">{pnl ? <>waiting in the position: {num(b.owed?.base, 6)} {base} + {num(b.owed?.quote, 6)} {q}<Usd v={pnl.fees} k={k} /></> : 'measuring…'}</span>
        </div>
        <div className="kpi">
          <span><L tip={`Gas for every open, range move, close and fee collect, plus what the swaps to the range's mix lost to the pool fee and price impact. Counted in ${q}.`}>Costs</L></span>
          <div className="kpi-v">{pnl ? qty(-(pnl.gas + pnl.swapCost), q, 4) : '—'}</div>
          <span className="sub">{pnl ? <>gas {qty(pnl.gas, q, 3, false)} · swaps {qty(pnl.swapCost, q, 3, false)}<Usd v={-(pnl.gas + pnl.swapCost)} k={k} /></> : ''}</span>
        </div>
        <div className="kpi">
          <span><L tip={`While the price is inside the range, the position sells ${base} as it rises and buys it as it falls, so it ends up with more of whichever coin fell. Taking it out (to move the range, or to close) makes that final. This is how much less those coins were worth than the ones put in, at the same price.`}>Lost to range moves</L></span>
          <div className={`kpi-v ${pnl?.moveLoss ? 'neg' : ''}`}>{pnl ? qty(-pnl.moveLoss, q, 4) : '—'}</div>
          <span className="sub">{b.reranges} range move{b.reranges === 1 ? '' : 's'}<Usd v={pnl ? -pnl.moveLoss : null} k={k} /></span>
        </div>
        <div className="kpi">
          <span><L tip={`Fees earned minus costs and what range moves lost, in ${q}. The coins' own price move isn't in it: that happens whether or not the bot runs.`}>Earned after costs</L></span>
          <div className={`kpi-v ${cls(pnl?.net)}`}>{pnl ? <AnimatedNumber value={pnl.net} format={(x) => qty(x, q, 5)} /> : '—'}</div>
          <span className="sub">{pnl && b.startValue ? <>{pct(pnl.net / b.startValue, 2, true)} of what you put in{days != null && days >= 1 ? ` · ${qty(pnl.net / days, q, 3)} a day` : ''}<Usd v={pnl.net} k={k} /></> : ''}</span>
        </div>
        <div className="kpi">
          <span><L tip="The coins in the position right now (they change as the price moves inside the range), and its share of the liquidity trading at today's price, which is its share of every trade's fee. Out of range the share is 0.">Liquidity provided</L></span>
          <div className="kpi-v coins2">{b.coins ? <><b>{num(b.coins.base, 6)} {base}</b><b>{num(b.coins.quote, 6)} {q}</b></> : '—'}</div>
          <span className="sub">{b.poolShare != null ? <>{pct(b.poolShare, b.poolShare < 0.001 ? 4 : 2)} of the pool's active liquidity</> : 'once the position is open'}<Usd v={b.coins && b.price != null ? b.coins.base * b.price + b.coins.quote : null} k={k} sign={false} /></span>
        </div>
      </div>

      <div className="split wide-left">
        <div className="card">
          <Chart status={s} ticks={ticks} pairs={[b.market]} pair={b.market} tf="1h" compact height={400} />
          <p className="muted small">The amber lines are the position's range. It earns fees while the price is between them.</p>
        </div>
        <div className="stack">
          <div className="card">
            <h3>{pos ? (b.inRange ? 'In range, earning' : 'Out of range') : closed ? 'Closed' : 'No position open'}</h3>
            {pos ? <>
              <p className="small">{px(pos.lower)} – {px(pos.upper)} {q}/{base} · price {px(b.price)}</p>
              <RangeGauge lower={pos.lower} upper={pos.upper} price={b.price} />
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
