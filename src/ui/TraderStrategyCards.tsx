/**
 * The two auto traders' strategies as cards (Kyle 2026-11-08: "develop strategies the same way where I don't have to set
 * every individual setting ... an animated, well documented way to understand what kind of tokens it plans to execute on
 * and what the potential gains are"). Each card has a moving picture of what the strategy does (SVG, CSS keyframes in
 * styles.css, still under reduced motion), the coins or pools it goes for, its settings in words, what can go wrong,
 * and a button that sets everything.
 *
 *  Smart trader (market/smartStrategy.ts): the pools it would open RIGHT NOW with the budget typed in, from today's scan
 *  through the same planner that runs when it is on (GET /api/autopilot/preview), each with its estimate for the week.
 *  Token trader (market/tokenStrategy.ts): the gate's rules in words with their numbers, and one ladder for all three,
 *  since every trade runs under the same exit rules: what a trade is worth when it runs, and what it loses when it drops.
 */
import type { ReactNode } from 'react';
import { num, pct } from './fmt';
import { inEth, useEthUsd } from './units';
import { Captions } from './StrategyCards';
import { SMART_STRATEGY, SMART_STRATEGY_IDS, WALK_FORWARD, type SmartOptions, type SmartPreview, type SmartStrategyId } from '../market/smartStrategy';
import { LADDER, TOKEN_STRATEGIES, ladderOutcome, stopsPaidFor, tokenProfile, tokenStrategyOf, type SniperTiming, type TokenApply, type TokenStrategyId } from '../market/tokenStrategy';

/* ── Smart trader ─────────────────────────────────────────────────────── */

/** A budget row of the setup form, as the cards need it */
export interface PreviewRow { chainId: number; chain: string; coin: string; amount: number }
/** One chain's preview: the three strategies' plans, an error, or still loading (undefined) */
export type PreviewState = Record<SmartStrategyId, SmartPreview> | { error: string };

export function SmartStrategyCards({ chosen, onChoose, rows, previews }: {
  chosen: SmartStrategyId | null; onChoose: (o: SmartOptions) => void; rows: PreviewRow[]; previews: Record<number, PreviewState | undefined>;
}) {
  const cards: { id: SmartStrategyId; pitch: ReactNode; picks: string; risk: string; pic: ReactNode }[] = [
    {
      id: 'farmer', pic: <FarmerPic />,
      pitch: <>Liquidity ranges only, on coins already in the app that passed the safety check with low risk. A range earns the pool's fee on every trade inside it; the trader keeps each a week and swaps the weakest for a better earner when that pays. Ranking ranges by what they earned last week is the best predictor the app has measured.</>,
      picks: `What it picks: V3 pools where a range earned after costs last week, best first. In the walk-forward the top tenth was expected to earn ${pct(WALK_FORWARD.lp.topExpected, 1)} a week and earned ${pct(WALK_FORWARD.lp.topEarned, 1)} (rank correlation ${WALK_FORWARD.lp.rank}).`,
      risk: 'A coin that trends one way leaves the range holding the weaker coin: the week\'s fees against the move. The 10% loss limit closes everything to cash.',
    },
    {
      id: 'swing', pic: <SwingPic />,
      pitch: <>Grids only, where the price swings back and forth the most, coins not in the app yet included, up to medium risk. A grid buys each dip and sells each rip between its levels; the swing is the income, whichever way the price ends. Four pools, so one dud is a quarter of the money.</>,
      picks: `What it picks: pools whose hourly swing is largest, where a grid earned last week. The swing predicts next week's grid earnings: the top tenth was expected to earn ${pct(WALK_FORWARD.grid.topExpected, 1)} a week and earned ${pct(WALK_FORWARD.grid.topEarned, 1)} (rank correlation ${WALK_FORWARD.grid.rank}).`,
      risk: 'A one-way fall fills the grid\'s buys and leaves it holding the coin. Medium risk lets in taxed and upgradeable coins. The 15% loss limit closes everything to cash.',
    },
    {
      id: 'wide', pic: <WidePic />,
      pitch: <>Everything the safety check lets trade live, as grids and ranges, six pools at once, each ranked by its estimate after the swaps to reach it. The most bets and the widest spread: the week's winners carry the losers.</>,
      picks: 'What it picks: the six best estimates on the chain, whatever the coin\'s risk label, grid or range by whichever is expected to earn more. Everything the two other strategies see, plus the coins they refuse.',
      risk: 'Any-risk coins can be taxed, upgradeable, or thin: a bad one costs a sixth of the money. The 20% loss limit closes everything to cash.',
    },
  ];
  return (
    <div className="strat-cards" data-testid="smart-strategy-cards">
      {cards.map((c) => {
        const st = SMART_STRATEGY[c.id], o = st.options;
        const uses = [o.lp && 'liquidity ranges', o.grid && 'grids'].filter(Boolean).join(' and ');
        const settings = `${uses} · ${o.newTokens ? 'new coins from the scan too' : 'coins already in the app'} · risk ${o.risk === 'safe' ? 'low only' : o.risk === 'medium' ? 'up to medium' : 'any that can trade live'} · ${o.slots} pools · loss limit ${Math.round(o.stopLossPct * 100)}%`;
        return (
          <section key={c.id} className={`strat-card ${chosen === c.id ? 'on' : ''}`} data-testid={`smart-strategy-${c.id}`}>
            <div className="strat-pic">{c.pic}</div>
            <h3>{st.name}</h3>
            <p>{c.pitch}</p>
            <p className="small strat-picks">{c.picks}</p>
            <p className="small muted strat-settings">{settings}</p>
            <p className="small strat-risk">{c.risk}</p>
            <PreviewBlock id={c.id} rows={rows} previews={previews} />
            <button type="button" className={`btn small-btn ${chosen === c.id ? 'primary' : ''}`} onClick={() => onChoose({ ...o })}>{chosen === c.id ? 'Chosen' : 'Use this'}</button>
          </section>
        );
      })}
    </div>
  );
}

/** What this strategy would open now with each budget typed in: the planner's picks and the week they add up to */
function PreviewBlock({ id, rows, previews }: { id: SmartStrategyId; rows: PreviewRow[]; previews: Record<number, PreviewState | undefined> }) {
  const live = rows.filter((r) => r.amount > 0 && r.coin);
  if (!live.length) return <p className="small muted strat-now" data-testid={`preview-${id}`}>Enter a budget above to see the pools it would open now, and their week.</p>;
  return (
    <div className="strat-now" data-testid={`preview-${id}`}>
      {live.map((r) => {
        const p = previews[r.chainId];
        const v = p && !('error' in p) ? p[id] : null;
        return (
          <div key={r.chainId} className="strat-now-chain">
            <b>{r.chain} · {num(r.amount, r.amount >= 1000 ? 0 : 2)} {r.coin}</b>
            {!p && <span className="muted">reading today's scan…</span>}
            {p && 'error' in p && <span className="neg">{p.error}</span>}
            {v && !v.ready && <span className="muted">no preview: {v.why}</span>}
            {v && v.ready && (
              <>
                {v.opens.length ? (
                  <ul>
                    {v.opens.map((x) => (
                      <li key={`${x.label}:${x.how}`}>
                        <span>{x.label} as a {x.how === 'lp' ? 'range' : 'grid'}</span>
                        <span className="muted"> · {num(x.capital, x.capital >= 1000 ? 0 : 2)} {r.coin} · ≈ {pct(x.score, 1, true)} a week{x.cost + x.entry > 0 ? ` after ${pct(x.cost + x.entry, 1)} to get in and out` : ''}{x.risk && x.risk !== 'low' ? ` · risk ${x.risk}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                ) : <span className="muted">nothing opens now{v.waitWhy ? `: ${v.waitWhy}` : ''} ({v.allowed} of {v.pools} pools allowed)</span>}
                {v.opens.length > 0 && v.waiting > 0 && <span className="muted">{num(v.waiting, v.waiting >= 1000 ? 0 : 2)} {r.coin} waits{v.waitWhy ? `: ${v.waitWhy}` : ''}</span>}
                {v.weekPct != null && <span className="strat-week">≈ {pct(v.weekPct, 1, true)} on the budget this week, if the estimates hold</span>}
              </>
            )}
          </div>
        );
      })}
      <span className="muted small">An estimate is what the pool's own last week says about the next one; the coin's price move is never in it, and your money moves the pool too.</span>
    </div>
  );
}

/* ── Token trader ─────────────────────────────────────────────────────── */

export function TokenStrategyCards({ o, onChoose }: { o: { minPoolAgeSec?: number; sniper?: Partial<SniperTiming> } & Record<string, unknown>; onChoose: (apply: TokenApply) => void }) {
  const chosen = tokenStrategyOf(o);
  const ethUsd = useEthUsd();
  const money = (usd: number) => inEth(usd, ethUsd);
  const sniper: SniperTiming = { delayBlocks: o.sniper?.delayBlocks ?? 2, delaySec: o.sniper?.delaySec ?? 15, maxPerHour: o.sniper?.maxPerHour ?? 3, minLiquidityUsd: o.sniper?.minLiquidityUsd ?? LADDER.sniperMinLiqUsd };
  const pitch: Record<TokenStrategyId, { text: string; risk: string; gates: string[] }> = {
    careful: {
      text: 'Coins that have already proved something: a day of real trading, nothing an owner can still do to them, holders spread, and a pool deep enough that your buy barely moves it. The fewest buys and the fewest surprises.',
      risk: 'Few coins pass, so it can sit idle for days; the ones that pass can still fall. Each trade risks 25% of its size.',
      gates: ['1 day old', 'no tax, no owner powers', 'holders spread', 'deep pool'],
    },
    balanced: {
      text: 'Coins hours old, from the launch venues too: a tax within the cap and a renounced upgradeable contract are fine. The age, wash-volume, owner-power and size checks stay on. More buys, earlier in a coin\'s life, with the tax paid on the way in and out.',
      risk: 'A launcher coin can die the same day; the tax eats into every exit. Each trade risks 25% of its size plus the tax.',
      gates: ['1 h old', 'tax ok, no owner powers', 'size fits'],
    },
    wild: {
      text: 'Brand-new pools, bought a couple of blocks after their liquidity lands, and anything else the safety check lets trade. The biggest runs start here, and so do most of the rugs the safety check can\'t see yet.',
      risk: 'Most new pools go to zero; a hard stop at −25% can still fill lower in a thin pool. Each trade risks all of its size in the worst case.',
      gates: ['liquidity lands', '2 blocks', 'sell works'],
    },
  };
  return (
    <>
      <div className="strat-cards" data-testid="token-strategy-cards">
        {TOKEN_STRATEGIES.map((st) => {
          const age = chosen === st.id ? (o.minPoolAgeSec ?? st.apply.minPoolAgeSec) : st.apply.minPoolAgeSec;
          return (
            <section key={st.id} className={`strat-card tk-strat ${st.id} ${chosen === st.id ? 'on' : ''}`} data-testid={`token-strategy-${st.id}`}>
              <div className="strat-pic"><FunnelPic id={st.id} gates={pitch[st.id].gates} /></div>
              <h3><b>{st.name}</b> <small className="muted">{st.tag}</small></h3>
              <p>{pitch[st.id].text}</p>
              <ul className="small strat-rules">{tokenProfile(st.id, age, sniper, money).map((line, i) => <li key={i}>{line}</li>)}</ul>
              <p className="small strat-risk">{pitch[st.id].risk}</p>
              <button type="button" className={`btn small-btn ${chosen === st.id ? 'primary' : ''}`} onClick={() => onChoose(st.apply)}>{chosen === st.id ? 'Chosen' : 'Use this'}</button>
            </section>
          );
        })}
      </div>
      <LadderPanel />
    </>
  );
}

/** What one trade can make or lose: the exit rules are the same for every strategy, so this is one panel under the three cards */
export function LadderPanel() {
  const run100 = ladderOutcome(1), run200 = ladderOutcome(2), short = ladderOutcome(0.4);
  const pc = (x: number) => pct(x, 0, true);
  return (
    <section className="strat-card strat-ladder" data-testid="ladder-panel">
      <div className="strat-pic"><LadderPic /></div>
      <h3>What one trade can make or lose</h3>
      <p>Every buy runs under the same exit rules, whatever the strategy; the strategies only change which coins get in. From the entry, after fees:</p>
      <ul className="small strat-rules">
        <li><b>Drops:</b> everything is sold at −{pct(LADDER.stop, 0)}. A pool with no trades for {LADDER.deadH} h, a sell that stops working, a rising tax or liquidity down {pct(LADDER.liqPull, 0)} from its peak sells at once, whatever the price.</li>
        <li><b>Goes nowhere:</b> after {LADDER.timeStopH} h under +{pct(LADDER.timeStopMinGain, 0)} it is sold, between the stop and that.</li>
        <li><b>Runs to +{pct(0.4, 0)} and turns:</b> the trailing stop arms at +{pct(LADDER.trailArm, 0)} and sells {pct(LADDER.trailGap, 0)} under the peak: {pc(short.total)}.</li>
        <li><b>Runs to +100% and turns:</b> {run100.sold.map((s) => `${s.why} (${pc(s.at)})`).join(', ')}: <b>{pc(run100.total)}</b> on the trade. One such run pays for {stopsPaidFor(1).toFixed(1)} trades that stopped out.</li>
        <li><b>Runs to +200% and turns:</b> <b>{pc(run200.total)}</b>; one pays for {stopsPaidFor(2).toFixed(1)} stops.</li>
      </ul>
      <p className="small muted">These are what the rules make a trade worth. How often a coin runs is the whole game, and nothing here can forecast it: the Scorecard below is this trader's own record, and the only number to trust.</p>
    </section>
  );
}

/* ── the moving pictures (320 × 150; price left to right) ─────────────── */

/** Three pools, a thin range on each; the fee bars grow all week; at the review the weakest is swapped for a better earner */
export function FarmerPic() {
  const rows = [{ y: 34, d: 'M70 44 C100 38, 120 50, 150 43 S200 36, 230 46 S280 50, 310 42' }, { y: 74, d: 'M70 84 C100 90, 130 78, 160 86 S210 92, 240 82 S280 80, 310 86' }, { y: 114, d: 'M70 124 C100 118, 130 130, 160 122 S210 118, 240 128 S280 126, 310 120' }];
  return (
    <svg viewBox="0 0 320 150" className="sx sx-f" role="img" aria-label="Three pools, each with a thin range that earns fees all week; at the weekly review the weakest range is swapped for a better earner">
      {rows.map((r, i) => (
        <g key={i} className={`sx-f-row r${i + 1}`}>
          <text x="10" y={r.y + 13} className="sx-lbl">pool {i + 1}</text>
          <rect x="70" y={r.y} width="240" height="20" className="sx-band" />
          <path d={r.d} className="sx-price sx-f-price" />
          <rect x="70" y={r.y + 23} height="3" width="240" className="sx-fees" />
        </g>
      ))}
      <g className="sx-f-swap"><rect x="70" y="114" width="240" height="20" rx="3" /><text x="190" y="128" textAnchor="middle">swapped for a better earner</text></g>
      <Captions lines={['three pools, a thin range on each', 'fees build all week on every trade inside', 'review: keep the earners, swap the weakest']} />
    </svg>
  );
}

/** A grid: levels across a range; the price zigzags; a buy dot at each dip, a sell dot at each rip; the round trips count up */
export function SwingPic() {
  const levels = [40, 58, 76, 94, 112];
  const pts: [number, number, 'b' | 's'][] = [[40, 112, 'b'], [80, 58, 's'], [120, 94, 'b'], [160, 40, 's'], [200, 94, 'b'], [240, 58, 's'], [280, 112, 'b']];
  return (
    <svg viewBox="0 0 320 150" className="sx sx-g" role="img" aria-label="A grid of levels across a range: the price zigzags, a buy at each dip and a sell at each rip; the swing itself is the income">
      {levels.map((y) => <line key={y} x1="10" y1={y} x2="310" y2={y} className="sx-g-level" />)}
      <text x="12" y="34" className="sx-lbl">levels</text>
      <path d="M10 80 L40 112 L80 58 L120 94 L160 40 L200 94 L240 58 L280 112 L310 80" className="sx-price sx-g-price" />
      {pts.map(([x, y, k], i) => <circle key={i} cx={x} cy={y} r="4" className={`sx-g-dot ${k === 'b' ? 'buy' : 'sell'} d${i + 1}`} />)}
      <rect x="10" y="134" height="6" width="300" className="sx-fees sx-g-trips" />
      <text x="10" y="128" className="sx-lbl">round trips</text>
      <Captions lines={['levels across the range', 'buys each dip, sells each rip', 'the swing is the income, whichever way it ends']} />
    </svg>
  );
}

/** Six bets in a row, ranked; a review sweep each week; the weakest is replaced by a better pool */
export function WidePic() {
  const chips = ['grid', 'range', 'grid', 'range', 'grid', 'grid'];
  return (
    <svg viewBox="0 0 320 150" className="sx sx-n" role="img" aria-label="Six pools held at once, ranked by what each is expected to earn; each week the weakest is replaced by a better pool">
      {chips.map((k, i) => (
        <g key={i} className={`sx-n-chip c${i + 1}`} transform={`translate(${12 + i * 50} 58)`}>
          <rect width="44" height="40" rx="6" className={k === 'range' ? 'rng' : 'grd'} />
          <text x="22" y="17" textAnchor="middle" className="sx-lbl">#{i + 1}</text>
          <text x="22" y="32" textAnchor="middle">{k}</text>
        </g>
      ))}
      <g className="sx-n-new" transform="translate(262 58)"><rect width="44" height="40" rx="6" /><text x="22" y="17" textAnchor="middle" className="sx-lbl">new</text><text x="22" y="32" textAnchor="middle">range</text></g>
      <rect x="10" y="118" width="300" height="4" className="sx-n-week" />
      <text x="10" y="112" className="sx-lbl">a week's hold</text>
      <line x1="10" y1="50" x2="10" y2="106" className="sx-n-sweep" />
      <Captions lines={['six bets, ranked by what each should earn', 'each is kept a week: switching costs money', 'then the weakest goes, when a better pool pays for the switch']} />
    </svg>
  );
}

/** Coins drop in at the top; each gate knocks some out; what passes is bought. The gates are the strategy's own rules. */
export function FunnelPic({ id, gates }: { id: TokenStrategyId; gates: string[] }) {
  const n = gates.length, top = 30, drop = 88;
  // the gates sit where the coins' fall keyframes stop (styles.css sx-k25/k50/k75): a quarter, half, three quarters of the drop
  const at = n === 3 ? [0.25, 0.5, 1] : gates.map((_, i) => (i + 1) / n);
  const fade = n === 3 ? ['f25', 'f50', 'f50', 'pass', 'f50', 'f25'] : ['f25', 'f50', 'f75', 'pass', 'f50', 'f25'];
  const coins = [40, 85, 130, 175, 220, 265];
  return (
    <svg viewBox="0 0 320 150" className={`sx sx-t sx-t-${id}`} role="img" aria-label={`Coins the radar finds fall through the strategy's gates: ${gates.join(', ')}; what passes every gate is bought`}>
      {gates.map((g, i) => {
        const y = top + at[i] * drop - 4, inset = 10 + i * 28;
        return (
          <g key={g} className={`sx-t-gate g${i + 1}`}>
            <line x1={inset} y1={y} x2={310 - inset} y2={y} />
            <text x={inset} y={y - 4}>{g}</text>
          </g>
        );
      })}
      {coins.map((x, i) => <circle key={i} cx={x} cy={top} r="5" className={`sx-t-coin ${fade[i]}`} />)}
      <g className="sx-t-buy"><rect x="162" y="124" width="84" height="20" rx="4" /><text x="214" y="138" textAnchor="middle">bought</text></g>
      <Captions lines={[`${id === 'wild' ? 'new pools as they appear' : 'coins the radar finds'}: ${n} gates, in this order`, 'most coins drop out at a gate', 'what passes every gate is bought and put on the ladder']} />
    </svg>
  );
}

/** The exit ladder: a run sells a third at +50%, a third at +100%, the rest 20% under the peak; a drop is all out at −25% */
export function LadderPic() {
  return (
    <svg viewBox="0 0 320 150" className="sx sx-l" role="img" aria-label="A trade's exits: on a run a third is sold at +50%, a third at +100% and the rest 20% under the peak; on a drop everything is sold at −25%">
      {[['+100%', 30], ['+50%', 60], ['entry', 90], ['−25%', 120]].map(([t, y]) => (
        <g key={t as string} className="sx-l-level"><line x1="46" y1={y as number} x2="310" y2={y as number} /><text x="10" y={(y as number) + 3}>{t}</text></g>
      ))}
      <path d="M46 90 C80 92, 100 70, 130 60 S180 30, 210 30 S250 46, 270 54" className="sx-price sx-l-run" />
      <path d="M46 90 C70 92, 90 104, 110 120" className="sx-price sx-l-drop" />
      <circle cx="130" cy="60" r="4.5" className="sx-l-sell s1" /><text x="136" y="56" className="sx-l-txt s1">⅓ sold</text>
      <circle cx="205" cy="30" r="4.5" className="sx-l-sell s2" /><text x="211" y="26" className="sx-l-txt s2">⅓ sold</text>
      <circle cx="270" cy="54" r="4.5" className="sx-l-sell s3" /><text x="300" y="72" textAnchor="end" className="sx-l-txt s3">rest, 20% under the peak</text>
      <circle cx="110" cy="120" r="4.5" className="sx-l-stop" /><text x="118" y="124" className="sx-l-txt stop">all out</text>
      <Captions lines={['a run: a third sold at +50%, a third at +100%', 'the rest rides, sold 20% under the peak', 'a drop: everything out at −25%']} />
    </svg>
  );
}

export { SMART_STRATEGY_IDS };
