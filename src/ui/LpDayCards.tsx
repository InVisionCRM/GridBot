/**
 * The liquidity bot page's day cards, drawn from the server's `day` (src/metrics/lpDay.ts) and the bot's own status:
 * fees by hour (hover or tap a bar for its hour), today's moves (the price through each range it held, and the list),
 * start → now (what made the result), and the position's weight (its coin mix and where the price sits in the range).
 * Nothing is worked out here but where things are drawn.
 */
import { useState } from 'react';
import { px, qty } from './fmt';
import type { AnyObj } from './model';
import type { LpDay, LpDone, LpHour } from '../metrics/lpDay';

const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** Fees per hour today: a bar each, the current hour in the accent, hours to come dashed, a dot where the range moved. */
export function FeesByHour({ day, base, quote, startedAt }: { day: LpDay; base: string; quote: string; startedAt: number | null }) {
  const [on, setOn] = useState<number | null>(null);
  const past = day.hours.filter((h) => !h.future);
  const top = Math.max(0, ...past.map((h) => h.fees ?? 0));
  const cur = past.length - 1;
  const h = on != null ? day.hours[on] : null;
  const marks = [0, 6, 12, 18].map((i) => day.hours[i]).filter(Boolean);
  return (
    <section className="lpb-card" data-testid="fees-by-hour">
      <div className="lpb-head">
        <div><h3 className="lpb-label">Fees by hour · today</h3><p className="lpb-hint">hover or tap a bar · a dot marks an hour the range moved</p></div>
      </div>
      <div className="lpb-bars" onMouseLeave={() => setOn(null)}>
        {day.hours.map((x, i) => (startedAt != null && x.t + 3_600_000 <= startedAt
          // an hour before the bot started: no bar (a zero bar would read as an hour that earned nothing)
          ? <span key={x.t} className="lpb-bar before" aria-hidden="true" />
          : <button
            type="button" key={x.t} aria-label={`${hhmm(x.t)} hour`}
            className={`lpb-bar ${x.future ? 'future' : ''} ${i === cur ? 'now' : ''} ${x.fees == null && !x.future ? 'unread' : ''} ${x.moves ? 'moved' : ''} ${on === i ? 'on' : ''}`}
            style={{ height: x.future || x.fees == null ? undefined : `${top > 0 ? Math.max(2, (Math.max(0, x.fees) / top) * 100) : 2}%`, animationDelay: `${i * 0.03}s` }}
            disabled={x.future} onMouseEnter={() => setOn(i)} onFocus={() => setOn(i)} onClick={() => setOn(on === i ? null : i)}
          />))}
        {h && on != null && <HourTip h={h} i={on} n={day.hours.length} now={on === cur} base={base} quote={quote} />}
      </div>
      <div className="lpb-axis">{marks.map((x) => <span key={x.t}>{hhmm(x.t)}</span>)}<span>{hhmm(day.hours[day.hours.length - 1].t)}</span></div>
    </section>
  );
}

function HourTip({ h, i, n, now, base, quote }: { h: LpHour; i: number; n: number; now: boolean; base: string; quote: string }) {
  const left = `${((i + 0.5) / n) * 100}%`;
  return (
    <div className={`lpb-tip ${i > n * 0.66 ? 'left' : i < n * 0.2 ? 'right' : ''}`} style={{ left }} role="status">
      <b>{hhmm(h.t)}–{hhmm(h.t + 3_600_000)}{now ? ' (so far)' : ''}</b>
      {h.fees == null ? <span>no reading this hour (the bot was not running)</span> : <>
        <span>fees {qty(h.fees, quote, 4, false)}</span>
        {h.feeBase != null && h.feeQuote != null && <span>= {qty(h.feeBase, base, 4, false)} + {qty(h.feeQuote, quote, 4, false)}</span>}
      </>}
      {h.volume != null && <span>the pool traded ≈ {qty(h.volume, quote, 3, false)}</span>}
      {h.price != null && <span>price {px(h.price)}</span>}
      {h.moves > 0 && <span className="lpb-acc">range moved {h.moves === 1 ? 'once' : `${h.moves} times`}</span>}
    </div>
  );
}

const WHAT: Record<LpDone['action'], string> = { open: 'move', rerange: 'move', compound: 'compound', send: 'send', close: 'close' };

/** What a finished step did, in words; a move says which way the range went against the range before it. */
function doneText(d: LpDone, older: LpDone | undefined): string {
  if (d.action === 'open') return 'opened the position';
  if (d.action === 'close') return 'took the position out';
  if (d.action === 'send') return 'sent the fees to your address';
  if (d.action === 'compound') return 'added the fees back into the position';
  const way = older?.lower != null && d.lower != null ? (d.lower > older.lower ? ' up' : d.lower < older.lower ? ' down' : '') : '';
  return d.asked ? `moved the range${way} (you asked)` : `price left the range, moved it${way}`;
}

/**
 * Today's moves: the price line through each range the bot held (a band per range, hover one for its edges), a marker
 * at each move, then every step today with what it cost and what it collected.
 */
export function DayMoves({ day, all, base, quote }: { day: LpDay; all: LpDone[]; base: string; quote: string }) {
  // from midnight, or from the first range or price today when the bot started later (else it all sits in the last sliver)
  const from = Math.max(day.dayStart, Math.min(day.ranges[0]?.from ?? Infinity, day.prices[0]?.[0] ?? Infinity));
  const end = day.prices.length ? day.prices[day.prices.length - 1][0] : day.dayStart;
  const span = Math.max(1, end - from);
  const ys = [...day.prices.map(([, p]) => p), ...day.ranges.flatMap((r) => [r.lower, r.upper])];
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.08 || lo * 0.01 || 1;
  const y = (p: number) => 100 - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const x = (t: number) => ((t - from) / span) * 100;
  const path = day.prices.map(([t, p], i) => `${i ? 'L' : 'M'}${(x(t) * 10).toFixed(1)} ${(y(p) * 1.6).toFixed(1)}`).join(' ');
  const moves = day.moves.filter((d) => d.action === 'rerange');
  const counts = (['rerange', 'compound', 'send', 'open', 'close'] as const).map((a) => [a, day.moves.filter((d) => d.action === a).length] as const).filter(([, n]) => n > 0);
  const name: Record<string, [string, string]> = { rerange: ['range move', 'range moves'], compound: ['compound', 'compounds'], send: ['fee send', 'fee sends'], open: ['open', 'opens'], close: ['close', 'closes'] };
  return (
    <section className="lpb-card" data-testid="day-moves">
      <div className="lpb-head">
        <div>
          <h3 className="lpb-label">Today’s moves{counts.length ? ` · ${counts.map(([a, n]) => `${n === 1 ? 'one' : n} ${name[a][n === 1 ? 0 : 1]}`).join(' · ')}` : ''}</h3>
          <p className="lpb-hint">the price line through each range the bot held · hover a band for its edges</p>
        </div>
      </div>
      {day.prices.length > 1 ? (
        <div className="lpb-moves">
          {day.ranges.map((r) => (
            <div key={r.from} className="lpb-rng" title={`${hhmm(r.from)}–${hhmm(r.to)} · ${px(r.lower)} to ${px(r.upper)} ${quote}/${base}`}
              style={{ left: `${x(r.from)}%`, width: `${Math.max(0.4, x(r.to) - x(r.from))}%`, top: `${y(r.upper)}%`, height: `${Math.max(1, y(r.lower) - y(r.upper))}%` }} />
          ))}
          <svg viewBox="0 0 1000 160" preserveAspectRatio="none" aria-hidden="true"><path className="lpb-px" d={path} pathLength={1} /></svg>
          {moves.map((d) => <span key={d.t} className="lpb-mk" style={{ left: `${x(d.t)}%` }}>{hhmm(d.t)}</span>)}
        </div>
      ) : <p className="lpb-empty">The price line starts with the next readings (one every 5 minutes).</p>}
      {day.moves.length ? (
        <div className="lpb-list">
          {day.moves.map((d) => {
            const i = all.indexOf(d), older = all.slice(i + 1).find((o) => o.lower != null);
            const got = d.fees.base > 0 || d.fees.quote > 0;
            return (
              <div key={`${d.t}-${d.action}`} className="lpb-row">
                <span className="lpb-t">{hhmm(d.t)}</span>
                <span className="lpb-what">{doneText(d, older)}{got && d.action !== 'compound' && d.action !== 'send' ? ', fees collected' : ''}</span>
                <span className="lpb-amt">
                  {got && <span className="pos">+{qty(d.fees.base, base, 5, false)} + {qty(d.fees.quote, quote, 5, false)}</span>}
                  {d.cost > 0 && <span className="neg">cost {qty(d.cost, quote, 5, false)}</span>}
                </span>
                <span className={`lpb-pill ${WHAT[d.action]}`}>{d.action === 'rerange' ? 'move' : d.action}</span>
              </div>
            );
          })}
        </div>
      ) : <p className="lpb-empty">No moves today: the range has held since midnight.</p>}
    </section>
  );
}

/**
 * Start → now: what was put in, plus the fees, minus gas and swap fees, plus what the coins' price did, is what the bot
 * holds now (with fees sent out, after gas). Bars on one scale; the axis starts near the smaller total so the steps show.
 * Each step's figure shows on hover or tap: they are the Details breakdown and the Invested tile in other words, and a
 * figure is printed once per screen (Kyle). What it holds now is printed.
 */
export function StartToNow({ b, quote }: { b: AnyObj; quote: string }) {
  const [on, setOn] = useState<number | null>(null);
  const p = b.pnl as AnyObj | null, start = b.startValue as number | null;
  const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  // every step needs its figure (a payload without one, like a closed bot's, has no chart rather than a broken one)
  if (!p || !ok(start) || ![p.fees, p.gas, p.swapCost, p.price, p.equity].every(ok)) return null;
  const steps: [string, number, 'tot' | 'up' | 'dn', string][] = [
    ['Put in', start!, 'tot', 'what went in, at the start price'], ['Fees', p.fees, 'up', "both coins' fees, at today's price"],
    ['Gas', -p.gas, 'dn', 'every transaction'], ['Swap fees', -p.swapCost, 'dn', "pool fee and price impact of the swaps to the range's mix"],
    ['Price move', p.price, p.price >= 0 ? 'up' : 'dn', "what the coins' own price did (impermanent loss and the market)"], ['Now', p.equity, 'tot', 'what it holds, with fees sent out, after gas'],
  ];
  let run = 0;
  const bars = steps.map(([n, v, k, why]) => {
    const from = k === 'tot' ? 0 : run, to = k === 'tot' ? v : run + v;
    run = to;
    return { n, v, k, why, top: Math.max(from, to), bot: Math.min(from, to) };
  });
  const tops = bars.map((x) => x.top), bots = bars.filter((x) => x.k !== 'tot').map((x) => x.bot);
  const hi = Math.max(...tops), floor = Math.min(start!, p.equity, ...bots);
  const lo = Math.max(0, floor - (hi - floor) * 0.6);
  const yy = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  const last = bars.length - 1;
  return (
    <section className="lpb-card" data-testid="start-to-now">
      <div className="lpb-head"><div><h3 className="lpb-label">Start → now</h3><p className="lpb-hint">what made the result, in {quote} · hover or tap a bar · the scale starts above zero so the steps show</p></div></div>
      <div className="lpb-wf" onMouseLeave={() => setOn(null)}>
        {bars.map((x, i) => (
          <button type="button" key={x.n} className={`lpb-wf-c ${on === i ? 'on' : ''}`} onMouseEnter={() => setOn(i)} onFocus={() => setOn(i)} onClick={() => setOn(on === i ? null : i)}>
            <span className="lpb-wf-slot">
              {(i === last || on === i) && <span className={`lpb-wf-v ${x.k === 'up' ? 'pos' : x.k === 'dn' ? 'neg' : ''}`} style={{ bottom: `${yy(x.top)}%` }}>
                {x.k === 'tot' ? qty(x.v, quote, 5, false) : qty(x.v, quote, 4)}
              </span>}
              <span className={`lpb-wf-b ${x.k}`} style={{ bottom: `${yy(Math.max(lo, x.bot))}%`, height: `${Math.max(0.8, yy(x.top) - yy(Math.max(lo, x.bot)))}%`, animationDelay: `${i * 0.1}s` }} />
            </span>
            <span className="lpb-wf-n">{x.n}</span>
          </button>
        ))}
      </div>
      <p className="lpb-hint lpb-wf-why">{on != null ? `${bars[on].n}: ${bars[on].why}` : '\u00a0'}</p>
    </section>
  );
}

/**
 * The position's weight: how much of its value is in each coin now (a bar that slides as the price moves), the coins,
 * and where the price sits between the range's edges (all the base coin at the low edge, all the quote coin at the high).
 */
export function PositionWeight({ b }: { b: AnyObj }) {
  const c = b.coins as { base: number; quote: number } | null, price = b.price as number | null, pos = b.position as AnyObj;
  if (!c || price == null || !pos) return null;
  const vb = c.base * price, total = vb + c.quote;
  const wb = total > 0 ? vb / total : 0;
  const at = Math.max(0, Math.min(1, (price - pos.lower) / (pos.upper - pos.lower)));
  return (
    <div className="lpb-weight" data-testid="position-weight">
      <div className="lpb-wbar">
        {/* one percent: the other side is the rest (two halves would print 50% twice) */}
        <div className="b" style={{ flexBasis: `${wb * 100}%` }}>{Math.round(wb * 100)}% {b.base}</div>
        <div className="q" style={{ flexBasis: `${(1 - wb) * 100}%` }}>{b.quote}</div>
      </div>
      <div className="lpb-kv">
        <span>{qty(c.base, b.base, 6, false)}</span><span className="muted">worth ≈ {qty(vb, b.quote, 4, false)}</span>
        <span>{qty(c.quote, b.quote, 6, false)}</span><span />
      </div>
      <h4 className="lpb-label">Where the price sits in the range</h4>
      <div className={`lpb-scale ${b.inRange === false ? 'out' : ''}`}>
        <div className="track" />
        <div className="knob" style={{ left: `${at * 100}%` }} title={`price ${px(price)}`} />
      </div>
      <div className="lpb-ends"><span>{px(pos.lower)} · all {b.base}</span><span>all {b.quote} · {px(pos.upper)}</span></div>
    </div>
  );
}
