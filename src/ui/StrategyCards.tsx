/**
 * New bot → Liquidity: the three strategies as cards (market/lpStrategy.ts), each with a moving picture of what it does
 * (SVG, CSS keyframes in styles.css, still when the viewer asks for reduced motion), its settings in plain words, what
 * can go wrong, and a button that fills the form. Kyle 2026-11-08: "add some infographic animations explaining exactly
 * what the strategy does".
 */
import type { ReactNode } from 'react';
import { ORDER_STEPS, STRATEGY, patientWidth, type LpStrategyId, type OneSided, type WeekMove } from '../market/lpStrategy';
import { px } from './fmt';

export function StrategyCards({ chosen, onChoose, week, base, quote, stepPct }: {
  chosen: LpStrategyId | null; onChoose: (id: LpStrategyId) => void; week: WeekMove | null; base: string; quote: string;
  /** The pool's step as a fraction (0.006 = 0.6%), when its fee tier tells it */
  stepPct: number | null;
}) {
  const w = patientWidth(week);
  const stepTxt = stepPct != null ? `${(STRATEGY.orders.steps * stepPct * 100).toFixed(2)}%` : `${STRATEGY.orders.steps} pool steps`;
  const cards: { id: LpStrategyId; title: string; pitch: ReactNode; settings: string; risk: string; pic: ReactNode }[] = [
    {
      id: 'patient', title: STRATEGY.patient.name, pic: <PatientPic />,
      pitch: <>A range as wide as {base} moved last week, left alone. Fees build while the price wanders inside; a dip out is waited through, so no move locks a loss in. On the CASHCAT/ETH pool's own week every range left alone beat holding, and every range moved at ±8% or tighter lost.</>,
      settings: `±${(w.pct * 100).toFixed(1)}% (${w.from === 'week' ? `how far ${base} went in 7 days, from its trades` : 'until the week\'s trades are read'}) · moves only after a day outside, 3 days apart, and only when the fees pay for it · loss limit ${STRATEGY.patient.lossLimitPct * 100}%`,
      risk: `A one-way crash leaves you mostly in ${base}: your downside is about half the coin's. The loss limit pauses it; it does not sell.`,
    },
    {
      id: 'orders', title: STRATEGY.orders.name, pic: <OrdersPic base={base} quote={quote} />,
      pitch: <>One coin, one side of the price: {quote} just below it is a buy order, {base} just above it is a sell order. The pool fills it trade by trade and pays you the fee on each. When it is filled through, the bot places the opposite order at the new price. Nothing is ever swapped.</>,
      settings: `${STRATEGY.orders.steps} steps wide (${stepTxt}) from the next step edge · flips to the opposite order when filled · loss limit ${STRATEGY.orders.lossLimitPct * 100}%`,
      risk: `The same as any limit order: it fills right before a bigger move, and then you hold ${base} that fell (or ${quote} while ${base} ran). Best when the price swings in a band.`,
    },
    {
      id: 'stable', title: STRATEGY.stable.name, pic: <StablePic />,
      pitch: <>Two coins that move together (dollar coins, ETH wrappers, BTC wrappers). The price barely moves, so a hair-thin range stays inside and earns all day, with next to nothing to lock in. Lower yield per trade, no range-move losses.</>,
      settings: `±${STRATEGY.stable.bandPct * 100}% · no auto-move (a move would chase a depeg) · loss limit ${STRATEGY.stable.lossLimitPct * 100}%`,
      risk: 'A depeg: one coin breaks from the other and the position turns into the weak one. The 1% loss limit pauses it early.',
    },
  ];
  return (
    <div className="strat-cards" data-testid="strategy-cards">
      {cards.map((c) => (
        <section key={c.id} className={`strat-card ${chosen === c.id ? 'on' : ''}`} data-testid={`strategy-${c.id}`}>
          <div className="strat-pic">{c.pic}</div>
          <h3>{c.title}</h3>
          <p>{c.pitch}</p>
          <p className="small muted strat-settings">{c.settings}</p>
          <p className="small strat-risk">{c.risk}</p>
          <button type="button" className={`btn small-btn ${chosen === c.id ? 'primary' : ''}`} onClick={() => onChoose(c.id)}>{chosen === c.id ? 'Chosen' : 'Use this'}</button>
        </section>
      ))}
    </div>
  );
}

/** The order's settings for strategy "orders": its side, its width in pool steps, and whether it flips when filled. */
export function OrderFields({ o, set, base, quote, stepPct, spot }: { o: OneSided; set: (o: OneSided) => void; base: string; quote: string; stepPct: number | null; spot: number | null }) {
  const span = stepPct != null ? o.steps * stepPct : null;
  return (
    <div className="order-fields" data-testid="order-fields">
      <div className="quick">
        <span className="muted small">Order:</span>
        <button type="button" className={`btn small-btn ${o.side === 'buy' ? 'primary' : ''}`} onClick={() => set({ ...o, side: 'buy' })}>Buy {base} below the price · places {quote}</button>
        <button type="button" className={`btn small-btn ${o.side === 'sell' ? 'primary' : ''}`} onClick={() => set({ ...o, side: 'sell' })}>Sell {base} above the price · places {base}</button>
      </div>
      <div className="quick">
        <span className="muted small">Width:</span>
        {[1, 2, 3, 5].filter((n) => n >= ORDER_STEPS.min && n <= ORDER_STEPS.max).map((n) => (
          <button key={n} type="button" className={`btn small-btn ${o.steps === n ? 'primary' : ''}`} onClick={() => set({ ...o, steps: n })}>{n} step{n === 1 ? '' : 's'}{stepPct != null ? ` · ${(n * stepPct * 100).toFixed(2)}%` : ''}</button>
        ))}
      </div>
      <label className="check follow">
        <input type="checkbox" checked={o.flip} onChange={(e) => set({ ...o, flip: e.target.checked })} />
        <span><b>Flip when filled</b> <span className="muted">After a buy fills, place a sell order just above the new price with the {base} it bought, and the other way round. Off: fill once and pause with the coins; Resume places the opposite order.</span></span>
      </label>
      {spot != null && span != null && (
        <p className="small muted">
          {o.side === 'buy' ? `Buys ${base} between about ${px(spot * (1 - span))} and ${px(spot)} ${quote}/${base}` : `Sells ${base} between about ${px(spot)} and ${px(spot * (1 + span))} ${quote}/${base}`}, earning the pool fee on every trade that fills it. Nothing is swapped.
        </p>
      )}
    </div>
  );
}

/* ── the moving pictures: price over time, left to right; the band is the position ── */

function Captions({ lines }: { lines: string[] }) {
  return <g className="sx-cap">{lines.map((t, i) => <text key={i} x="10" y="16" className={`c${i + 1}`}>{t}</text>)}</g>;
}

/** A wide band that stays put: the price wanders inside, dips out, comes back; the fee bar grows while inside. */
export function PatientPic() {
  return (
    <svg viewBox="0 0 320 150" className="sx sx-p" role="img" aria-label="A wide range stays put while the price wanders inside it, dips out and comes back; fees build while it is inside">
      <rect x="10" y="38" width="300" height="74" className="sx-band" />
      <text x="14" y="50" className="sx-lbl">range ±10%</text>
      <path d="M10 80 C40 60, 60 100, 90 70 S140 50, 170 85 S200 125, 220 120 S250 90, 270 60 S300 70, 310 76" className="sx-price" />
      <rect x="10" y="134" height="6" width="300" className="sx-fees" />
      <text x="10" y="128" className="sx-lbl">fees</text>
      <Captions lines={['fees build while the price wanders inside', 'it dips out: nothing is sold, the range waits', 'back inside, earning again']} />
    </svg>
  );
}

/** A buy order below the price fills as the price falls through it and turns into the other coin; a sell order follows above. */
export function OrdersPic({ base, quote }: { base: string; quote: string }) {
  return (
    <svg viewBox="0 0 320 150" className="sx sx-o" role="img" aria-label="A buy order waits just below the price; the price falls through it and it fills; a sell order is placed just above the new price and fills as the price rises">
      <defs>
        <clipPath id="sx-o-fill1"><rect x="10" y="70" width="160" height="30" className="sx-fill1" /></clipPath>
        <clipPath id="sx-o-fill2"><rect x="170" y="72" width="130" height="26" className="sx-fill2" /></clipPath>
      </defs>
      <rect x="10" y="70" width="160" height="30" className="sx-buy" />
      <rect x="10" y="70" width="160" height="30" className="sx-got" clipPath="url(#sx-o-fill1)" />
      <text x="14" y="89" className="sx-lbl">buy · {quote} waits</text>
      <g className="sx-sell-g">
        <rect x="170" y="72" width="130" height="26" className="sx-sell" />
        <rect x="170" y="72" width="130" height="26" className="sx-sold" clipPath="url(#sx-o-fill2)" />
        <text x="174" y="89" className="sx-lbl">sell · {base} waits</text>
      </g>
      <path d="M10 40 L90 40 C120 40, 130 110, 170 112 L200 112 C230 112, 250 30, 300 30" className="sx-price" />
      <Captions lines={[`${quote} waits just below the price`, `filled trade by trade: ${base} + the fee`, 'a sell order goes just above the new price', `sold higher, paid again: ${quote} back`]} />
    </svg>
  );
}

/** Two coins that move together: a thin band earns all day; a depeg at the end, and the loss limit stops it. */
export function StablePic() {
  return (
    <svg viewBox="0 0 320 150" className="sx sx-s" role="img" aria-label="Two coins that move together stay inside a thin range that earns all day; when one breaks away, the loss limit stops the bot">
      <rect x="10" y="70" width="300" height="12" className="sx-band" />
      <text x="14" y="64" className="sx-lbl">range ±0.2%</text>
      <path d="M10 76 C30 73, 50 79, 70 75 S110 78, 130 76 S170 74, 190 77 S230 75, 250 76 C260 77, 270 100, 280 118 L310 130" className="sx-price" />
      <rect x="10" y="134" height="6" width="240" className="sx-fees" />
      <text x="10" y="128" className="sx-lbl">fees</text>
      <g className="sx-stop"><line x1="283" y1="40" x2="283" y2="140" /><text x="278" y="120" textAnchor="end">loss limit −1%: paused</text></g>
      <Captions lines={['barely moving: a thin range earns all day', 'a depeg: one breaks away; paused at −1%']} />
    </svg>
  );
}
