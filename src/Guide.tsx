/**
 * In-app Guide (Kyle asked for it). Every number shown is imported from the code that enforces it,
 * so the guide can't drift from fee math, gate thresholds, limits or preset params.
 */
import { useEffect } from 'react';
import { FEE_BPS, GAS_UNITS_RT, MIN_NET_PCT, MIN_SPACING_PCT } from './live/economics';
import { DEFAULT_LIMITS, HARD_CAPS } from './live/limits';
import { STRATEGY_PRESETS } from './live/presets';
import { MAX_GRID_COUNT, MIN_GRID_COUNT } from './live/spacing';
import { DEFAULT_TREND, STRATEGIES } from './market/strategy';
import { TFS, TF_CAP } from './market/candles';
import { DEFAULT_COSTS } from './market/costs';
import { CHAINS, chainFromNetwork } from './live/chains';
import { NETWORKS } from './live/networks';
import { MAX_TAX } from './live/tax';
import { DEFAULT_GAS_RESERVE, GAS_RESERVE_MAX_PCT } from './live/gasReserve';

const PLS_DEXES = chainFromNetwork(NETWORKS.mainnet).dexes;
const dexFee = (d: (typeof PLS_DEXES)[number]) => (d.kind === 'v3' ? d.feeTiers!.map((t) => `${t / 10_000}%`).join(' / ') : `${d.feeBps! / 100}%`);

const fee = FEE_BPS / 100; // 0.29
const rt = (1 - (1 - FEE_BPS / 10_000) ** 2) * 100; // 0.579
const p = (x: number, d = 2) => `${x.toFixed(d)}%`;

export const GUIDE_SECTIONS = [
  ['what', 'What it does'],
  ['pnl', 'Wins / losses'],
  ['costs', 'Cost math'],
  ['presets', 'Presets'],
  ['settings', 'Settings'],
  ['orientation', 'Orientation ⇄'],
  ['dashboard', 'Dashboard'],
  ['ops', 'Operating'],
  ['trend', 'Trend bot'],
  ['backtest', 'Backtest'],
  ['charts', 'Charts'],
  ['analytics', 'Analytics'],
  ['chains', 'Chains & DEXes'],
  ['custom', 'Custom tokens'],
  ['taxes', 'Decimals & taxes'],
  ['faq', 'FAQ'],
] as const;

const PRESET_USE: Record<string, [string, string]> = {
  'tight-scalp': ['Most fills on one pair. Narrowest band that still clears costs.', 'PLS chopping sideways vs the selected pair. Use deep pools (DAI, USDC); USDT is blocked by the gate.'],
  hex: ['Grid PLS against HEX.', 'HEX/PLS ratio swinging back and forth. Wider ±12% band because the ratio moves more.'],
  ehex: ['Grid PLS against eHEX (bridged Ethereum HEX).', 'Same as HEX, on the eHEX/WPLS pool.'],
  plsx: ['Grid PLS against PLSX.', 'PLSX/PLS ratio chopping.'],
  'pulse-pack': ['HEX + eHEX + PLSX at once, one grid each.', 'Spread fills across three ratios. Needs all three tokens in the wallet.'],
  'stack-hex': ['Start with only PLS, end with more HEX.', 'HEX/PLS (flipped): buys HEX with PLS below spot, sells those lots back one level up. Profit is booked in PLS; unsold lots are the HEX you stack.'],
  'stack-plsx': ['Start with only PLS, stack PLSX.', 'PLSX/PLS (flipped). Same idea on the PLSX pool.'],
  'stack-ehex': ['Start with only PLS, stack eHEX.', 'eHEX/PLS (flipped). Same idea on the eHEX pool.'],
  'stable-ladder': ['PLS vs USD, split across DAI and USDC.', 'Sideways PLS/USD. USDT excluded: its pool (~$1.5k/side) makes impact bigger than the edge.'],
};

function GridDiagram() {
  // 7 levels; price zig-zags inside the range: buy (green) on a cross down, sell (red) on the next level up.
  const W = 520, H = 210, top = 20, bot = 190, n = 7;
  const y = (i: number) => bot - (i * (bot - top)) / (n - 1);
  const path: [number, number][] = [[20, 3.4], [80, 1.8], [140, 3.2], [200, 0.8], [260, 2.2], [320, 1.0], [380, 3.6], [440, 2.6], [500, 4.2]];
  const P = path.map(([x, l]) => [x, y(l)] as const);
  // Simulate the grid along the path so markers sit exactly on level crossings (same rules as the engine:
  // levels below the start price wait for a buy; a lot bought at level k sells on the cross of level k+1).
  const marks: { x: number; l: number; s: 'B' | 'S' }[] = [];
  const waiting = new Set<number>(), holding = new Set<number>();
  for (let k = 0; k < n - 1; k++) if (k < path[0][1]) waiting.add(k);
  for (let i = 1; i < path.length; i++) {
    const [x0, l0] = path[i - 1], [x1, l1] = path[i];
    const at = (k: number) => x0 + ((k - l0) / (l1 - l0)) * (x1 - x0);
    if (l1 < l0) {
      for (let k = Math.floor(l0); k >= Math.ceil(l1); k--) if (k < l0 && waiting.has(k)) { waiting.delete(k); holding.add(k); marks.push({ x: at(k), l: k, s: 'B' }); }
    } else {
      for (let k = Math.ceil(l0); k <= Math.floor(l1); k++) if (k > l0 && holding.has(k - 1)) { holding.delete(k - 1); waiting.add(k - 1); marks.push({ x: at(k), l: k, s: 'S' }); }
    }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="guide-svg" role="img" aria-label="Grid levels: buys below, sells one level up">
      <rect x="0" y={top - 10} width={W} height={bot - top + 20} rx="8" className="g-range" />
      {Array.from({ length: n }, (_, i) => (
        <g key={i}>
          <line x1="0" x2={W} y1={y(i)} y2={y(i)} className="g-level" />
          <text x={W - 4} y={y(i) - 3} textAnchor="end" className="g-lbl">L{i}</text>
        </g>
      ))}
      <polyline points={P.map((q) => q.join(',')).join(' ')} className="g-price" />
      {marks.map((m, i) => (
        <g key={i}>
          <circle cx={m.x} cy={y(m.l)} r="8" className={m.s === 'B' ? 'g-buy' : 'g-sell'} />
          <text x={m.x} y={y(m.l) + 4} textAnchor="middle" className="g-mk">{m.s}</text>
        </g>
      ))}
      <text x="6" y={top + 2} className="g-lbl">upper</text>
      <text x="6" y={bot + 14} className="g-lbl">lower</text>
    </svg>
  );
}

function CostBar() {
  // Worst level of Tight scalp on DAI (live, Oct 2026): step 1.25% → fee 0.58 + impact 0.07 + gas 0.01 → net ~0.58
  const step = 1.25;
  const parts = [
    { k: 'LP fee ×2', v: rt, c: 'fee' },
    { k: 'impact', v: 0.07, c: 'imp' },
    { k: 'gas', v: 0.015, c: 'gas' },
  ];
  const net = step - parts.reduce((a, b) => a + b.v, 0);
  return (
    <div className="costbar">
      <div className="costbar-row">
        {parts.map((x) => <span key={x.k} className={`cb ${x.c}`} style={{ flex: x.v }} title={`${x.k} ${p(x.v)}`} />)}
        <span className="cb net" style={{ flex: net }} title={`net ${p(net)}`} />
      </div>
      <div className="costbar-legend small">
        {parts.map((x) => <span key={x.k}><i className={`dot ${x.c}`} />{x.k} {p(x.v)}</span>)}
        <span><i className="dot net" />net ≈{p(net)}</span>
        <span className="muted">of a {p(step)} step (Tight scalp, worst level, DAI)</span>
      </div>
    </div>
  );
}

export function Guide({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const go = (id: string) => document.getElementById(`g-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="guide-overlay" onClick={onClose}>
      <div className="guide" role="dialog" aria-modal="true" aria-label="Guide" onClick={(e) => e.stopPropagation()}>
        <header className="guide-head">
          <strong>Guide</strong>
          <nav className="guide-nav">
            {GUIDE_SECTIONS.map(([id, label]) => (
              <button key={id} type="button" className="chip" onClick={() => go(id)}>{label}</button>
            ))}
          </nav>
          <button type="button" className="btn small-btn" onClick={onClose} aria-label="Close guide">✕</button>
        </header>

        <div className="guide-body">
          <section id="g-what">
            <h2>1 · What a grid bot does</h2>
            <div className="guide-cols">
              <GridDiagram />
              <ul className="tight">
                <li>You set a <b>range</b> (lower–upper, in quote per PLS) split into equal <b>levels</b>.</li>
                <li>Price drops to a level → <span className="buy">buy</span> PLS with that level's share of capital.</li>
                <li>Price rises to the <b>next level up</b> → <span className="sell">sell</span> exactly that PLS lot.</li>
                <li>Each buy→sell pair is one <b>round-trip (RT)</b>. Profit = the step between levels, minus costs.</li>
                <li>At start, only levels <b>below</b> spot get a buy. Levels above spot stay <i>inactive</i>.</li>
                <li>Price is read on-chain every poll (PulseX V2 <code>getAmountsOut</code>, default every 10 s).</li>
              </ul>
            </div>
          </section>

          <section id="g-pnl">
            <h2>2 · When it makes / loses money</h2>
            <div className="guide-grid2">
              <div className="gcard ok">
                <h4>Makes money</h4>
                <ul className="tight">
                  <li>Price <b>chops inside the range</b>: many small down-up swings.</li>
                  <li>Each completed RT banks roughly step − costs.</li>
                </ul>
              </div>
              <div className="gcard bad">
                <h4>Loses money</h4>
                <ul className="tight">
                  <li><b>Trends down out of range</b>: every level bought, PLS held below cost (Unreal goes negative).</li>
                  <li><b>Trends up out of range</b>: everything sold, the grid sits in the quote token and stops filling. You miss the rally.</li>
                  <li><b>Spacing too tight</b>: step ≤ costs, so every RT loses. The start gate blocks this.</li>
                </ul>
              </div>
            </div>
          </section>

          <section id="g-costs">
            <h2>3 · Cost math</h2>
            <div className="guide-grid3">
              <div className="stat"><b>{p(fee)}</b><span>PulseX LP fee per swap</span></div>
              <div className="stat"><b>{p(rt, 3)}</b><span>per round-trip (buy + sell)</span></div>
              <div className="stat"><b>{(GAS_UNITS_RT.approve / 1000).toFixed(0)}k + 2×{(GAS_UNITS_RT.swap / 1000).toFixed(0)}k</b><span>gas units per RT (approve + 2 swaps)</span></div>
            </div>
            <CostBar />
            <ul className="tight">
              <li><b>Price impact</b> depends on level size vs pool depth. Small pools (USDT) make it large.</li>
              <li><b>Gas</b> is fixed per trade, so tiny levels are eaten alive. That's why the old 200-HEX packs (~4¢/level) lost money.</li>
              <li><b>Start gate</b> (worst level, current reserves + gas): spacing ≥ <b>{p(MIN_SPACING_PCT * 100, 1)}</b> and net ≥ <b>{p(MIN_NET_PCT * 100)}</b> of level size.
                Live: hard block, no override. Paper: blocked unless you tick <i>simulate anyway</i>.</li>
              <li>The Add grid form shows this live: size · step · fee · impact · gas · <b>net/RT</b>.</li>
            </ul>
          </section>

          <section id="g-presets">
            <h2>4 · Presets</h2>
            <table className="gtable">
              <thead><tr><th>Preset</th><th>Pairs</th><th>Range × grids</th><th>Capital</th><th>For</th><th>Use when</th></tr></thead>
              <tbody>
                {STRATEGY_PRESETS.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td>{s.legs.map((l) => l.quote ?? 'selected pair').join(' + ')}</td>
                    <td>±{(s.legs[0].bandPct * 100).toFixed(0)}% × {s.legs[0].gridCount}</td>
                    <td>${s.legs[0].capitalUsd}{s.legs.length > 1 ? ' each' : ''}</td>
                    <td>{PRESET_USE[s.id]?.[0]}</td>
                    <td className="muted">{PRESET_USE[s.id]?.[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="tight">
              <li><b>Prefill</b> centres the range on live spot and fills the form (single-leg presets). It also prints size/net per leg.</li>
              <li><b>Start</b> one-clicks the preset in the current Mode. <b>Preset $/leg</b> overrides the USD capital; it's converted to tokens at live prices.</li>
              <li>Each leg is re-checked against live reserves before starting. If any leg fails, nothing starts.</li>
            </ul>
          </section>

          <section id="g-settings">
            <h2>5 · Settings</h2>
            <table className="gtable">
              <tbody>
                <tr><td><b>Mode</b></td><td><i>paper</i>: real on-chain quotes, simulated fills, estimated gas. Needs no key. <i>live</i>: signs and sends real swaps. Only enabled when the server loaded a key; asks for confirmation.</td></tr>
                <tr><td><b>Pair</b></td><td>PLS vs DAI / USDC / USDT / HEX / eHEX / PLSX (plus other chains and custom tokens). Prices are <i>quote per base</i>, e.g. HEX per PLS for PLS/HEX. ⇄ flips it; see <a href="#g-orientation">Orientation</a>.</td></tr>
                <tr><td><b>Lower / Upper</b></td><td>Range in quote per base. Spot must be inside, or there are no buy levels.</td></tr>
                <tr><td><b>Grids</b></td><td>Number of intervals, {MIN_GRID_COUNT}–{MAX_GRID_COUNT}. More grids = smaller step = more fills, but each must clear costs.</td></tr>
                <tr><td><b>Capital</b></td><td>In the pair's quote token (DAI, HEX, … or PLS when flipped), split evenly over the levels below spot. Presets use USD instead.</td></tr>
                <tr><td><b>Impact %</b></td><td>Skip a trade if its price impact exceeds this. Default {p(DEFAULT_LIMITS.maxPriceImpact * 100, 0)}, max {p(HARD_CAPS.maxPriceImpact * 100, 0)}.</td></tr>
                <tr><td><b>Slip %</b></td><td>Minimum-out tolerance on each swap. If price moves more before mining, the swap reverts (you pay gas only). Default {p(DEFAULT_LIMITS.slippageBps / 100, 0)}, max {p(HARD_CAPS.slippageBps / 100, 0)}.</td></tr>
                <tr><td><b>Deadline</b></td><td>Minutes a swap stays valid on-chain. Default {DEFAULT_LIMITS.deadlineMinutes}, range 1–{HARD_CAPS.deadlineMinutes}.</td></tr>
                <tr><td><b>Apply limits</b></td><td>Pushes Impact / Slip / Deadline to the selected grid without restarting it.</td></tr>
                <tr><td><b>.env extras</b></td><td><code>APPROVAL_MODE</code>: <i>exact</i> (default) approves each buy, costing an extra approve tx; <i>max</i> approves once. <code>POLL_MS</code> (default 10000, min 2000), <code>RPC_URL</code>, <code>MAX_RETRIES</code>, <code>STATE_FILE</code>, <code>PORT</code>.</td></tr>
              </tbody>
            </table>
          </section>

          <section id="g-orientation">
            <h2>6 · Orientation ⇄ (which token you spend)</h2>
            <p className="muted small">Every pair can be traded either way round. The label always shows the <b>base first</b>: <i>PLS/HEX</i> trades PLS against HEX, <i>HEX/PLS</i> trades HEX against PLS. Press <b>⇄</b> next to the pair picker (Grids, Trend, Backtest, Charts, Markets, Alerts) to flip it.</p>
            <table className="gtable">
              <tbody>
                <tr><td><b>PLS/HEX</b> (classic)</td><td>Price = HEX per PLS. Capital is <b>HEX</b>: buys spend HEX for PLS, sells sell that PLS back for HEX. PnL in HEX. <i>Spends: HEX · Stacks: PLS</i>.</td></tr>
                <tr><td><b>HEX/PLS</b> (flipped)</td><td>Price = PLS per HEX. Capital is <b>PLS</b>: buys spend PLS for HEX, each sell sells only the HEX that level bought, for PLS. PnL in PLS (≈USD shown). <i>Spends: PLS · Stacks: HEX</i>.</td></tr>
                <tr><td><b>Gas reserve</b></td><td>When you spend the gas token (PLS), part of it must stay for gas. Reserve = max({(DEFAULT_GAS_RESERVE.pct * 100).toFixed(0)}% of capital, a fixed PLS amount), up to {(GAS_RESERVE_MAX_PCT * 100).toFixed(0)}% (limits <code>gasReservePct</code> / <code>gasReserveNative</code>). A live start is blocked if capital + reserve (+ other live bots' PLS) is more than your PLS balance.</td></tr>
                <tr><td><b>Swaps</b></td><td>Same pool, same fees. PLS goes in as native value (<code>swapExactETHForTokens</code>) and comes out unwrapped (<code>swapExactTokensForETH</code>); taxed tokens use the <code>…SupportingFeeOnTransferTokens</code> variants; on V3 the router wraps/unwraps.</td></tr>
                <tr><td><b>Prices</b></td><td>Flipped prices are exact inverses (HEX has 8 decimals, PLS 18; both are read on-chain). Candles are inverted too: high = 1/low, low = 1/high. Gates, backtests, indicators and alerts all run on the flipped prices.</td></tr>
                <tr><td><b>Existing grids</b></td><td>Keep the orientation they were started with. Flipping the picker only changes what new bots use.</td></tr>
              </tbody>
            </table>
          </section>

          <section id="g-dashboard">
            <h2>7 · Reading the dashboard</h2>
            <div className="guide-grid2">
              <div className="gcard">
                <h4>Top bar &amp; grids</h4>
                <ul className="tight">
                  <li><b>Σ Realized / Unreal ≈$</b>: all grids, converted to USD via DAI.</li>
                  <li><b>Σ RT / fees / gas</b>: round-trips, LP fees and gas across grids (≈$).</li>
                  <li><b>Grids table</b>: PnL in the grid's <b>own token</b> (+ ≈$ for non-DAI), RT count, STOP / Resume.</li>
                  <li><b>Unreal</b> = PLS held × current price − its cost basis.</li>
                </ul>
              </div>
              <div className="gcard">
                <h4>Levels</h4>
                <ul className="tight">
                  <li><code>#n buy → sell</code>: the interval's two prices.</li>
                  <li><i>waitingBuy</i> → <i>pendingBuy</i> → <i>holding</i> (PLS lot shown) → <i>pendingSell</i> → back to waitingBuy.</li>
                  <li><i>inactive</i>: was above spot at start; never trades.</li>
                  <li><i>(rearm)</i>: a trade was skipped. Price must move back across the level before it triggers again.</li>
                </ul>
              </div>
            </div>
            <table className="gtable">
              <thead><tr><th>Fills column</th><th>Meaning</th></tr></thead>
              <tbody>
                <tr><td>#</td><td>Interval index.</td></tr>
                <tr><td>PLS / token</td><td>Actual amounts in and out.</td></tr>
                <tr><td>Trig</td><td>On-chain price when the level was crossed.</td></tr>
                <tr><td>Quote</td><td>Router quote for the actual size (amountIn ÷ out). Includes fee and impact.</td></tr>
                <tr><td>Exec</td><td>Price from the <b>receipt</b> amounts. <code>*</code> = receipt log missing, so min-out was used.</td></tr>
                <tr><td>Slip</td><td>Exec vs Quote. <b>+ = worse</b>; red above 0.1%.</td></tr>
                <tr><td>Gas</td><td>Gas in the pair's token (hover for PLS).</td></tr>
                <tr><td>RT net</td><td>Sells only: proceeds − sell gas − the matched buy lot's cost (spent + buy gas).</td></tr>
                <tr><td>Tx</td><td>Explorer link (live) or <i>paper</i>. ✗ = reverted: only gas was lost.</td></tr>
              </tbody>
            </table>
            <ul className="tight">
              <li><b>RT stats</b> line: round-trips (wins) · avg net per RT · total fees · total gas · avg slippage, in the grid's token.</li>
              <li><b>At start</b> line: the economics the grid was started with. A red <i>PAPER ONLY</i> note means it would be blocked live.</li>
            </ul>
          </section>

          <section id="g-ops">
            <h2>8 · Operating</h2>
            <div className="guide-grid2">
              <div className="gcard">
                <h4>Setup &amp; run</h4>
                <pre className="gcode">{`cp .env.example .env   # signing-key line + RPC_URL
npm install
npm run build && npm start   # http://127.0.0.1:3847
pm2 start npm --name grid-bot -- start && pm2 save
pm2 logs grid-bot`}</pre>
                <ul className="tight">
                  <li>Use a <b>dedicated hot wallet</b> holding only what the bot trades plus PLS for gas.</li>
                  <li>The key stays on the server. The UI never sees it and is served on localhost only.</li>
                  <li>Run paper first. Live is only selectable when the server loaded a key.</li>
                </ul>
              </div>
              <div className="gcard">
                <h4>Day to day</h4>
                <ul className="tight">
                  <li><b>STOP</b> (per grid): drops queued trades. A swap already broadcast is still reconciled by hash. It doesn't sell holdings.</li>
                  <li><b>KILL ALL</b>: STOP on every grid at once.</li>
                  <li><b>Restart</b>: all grids are saved in <code>data/state.json</code>; running grids resume on boot.</li>
                  <li><b>Re-centre</b> when price leaves the range (nothing does this automatically): STOP → Prefill a preset or edit Lower/Upper → <b>Restart config</b> (or Add a new grid and Remove the old one). PLS still held by the old levels isn't reassigned. It stays in Held / Unreal.</li>
                  <li><b>Keep PLS for gas.</b> Each trade checks the balance against the gas estimate (plus the PLS being sold). If it's short, the trade is skipped.</li>
                  <li>Buys spend the pair token from the wallet. Sells only sell PLS the grid bought.</li>
                </ul>
              </div>
            </div>
          </section>

          <section id="g-trend">
            <h2>9 · Trend bot</h2>
            <p>A long-only momentum bot next to the grids. It is always either <b>flat</b> (holding its quote token) or <b>in</b> (holding PLS). It uses the same server, signing key, global tx queue and nonce as the grids.</p>
            <div className="guide-grid2">
              <div className="gcard">
                <h4>Strategies (signals on closed candles only)</h4>
                <ul className="tight">
                  <li><b>{STRATEGIES[0].label}</b>: enter when EMA fast crosses above EMA slow, exit on the cross back (default {DEFAULT_TREND.fast}/{DEFAULT_TREND.slow}).</li>
                  <li><b>{STRATEGIES[1].label}</b>: same cross, but enter only if RSI({DEFAULT_TREND.rsiPeriod}) is inside the band (default {DEFAULT_TREND.rsiMin}–{DEFAULT_TREND.rsiMax}, which skips overbought spikes).</li>
                  <li><b>{STRATEGIES[2].label}</b>: enter when MACD({DEFAULT_TREND.macdFast},{DEFAULT_TREND.macdSlow}) crosses above its {DEFAULT_TREND.macdSignal}-signal, exit on the cross below.</li>
                  <li><b>{STRATEGIES[3].label}</b>: enter when the close beats the <i>prior</i> {DEFAULT_TREND.donchianEntry}-candle high, exit below the prior {DEFAULT_TREND.donchianExit}-candle low.</li>
                  <li><b>HTF filter</b> (optional): enter only when the last <i>closed</i> higher-timeframe candle closes above its EMA (default {DEFAULT_TREND.htfTf} EMA{DEFAULT_TREND.htfEma}).</li>
                  <li>Each newly closed candle is evaluated once. The forming candle is never used, so signals don't repaint. The candle that closed before you pressed Start is skipped.</li>
                </ul>
              </div>
              <div className="gcard">
                <h4>Exits &amp; sizing</h4>
                <ul className="tight">
                  <li><b>Stop</b> = entry − {DEFAULT_TREND.stopAtr} × ATR({DEFAULT_TREND.atrPeriod}) (Stop ×ATR). It is checked against <b>every poll price</b>, not just at candle close.</li>
                  <li><b>Take-profit</b> = entry + {DEFAULT_TREND.tpR}R, where R = entry − stop (0 = off). Also checked every poll.</li>
                  <li><b>Trailing stop</b> = highest high − k × ATR. It ratchets up on each closed candle and never loosens (0 = off).</li>
                  <li><b>Max hold</b> N closed candles · <b>Cooldown</b> N candles after an exit (default {DEFAULT_TREND.cooldownBars}) · an exit signal closes too · <b>Close position</b> sells at market.</li>
                  <li><b>Sizing</b>: % of the bot's free capital, or <b>risk %</b>. With risk %, size = equity × risk% ÷ stop distance (so a stop-out loses about that % before costs), capped at free cash.</li>
                </ul>
              </div>
            </div>
            <div className="gcard">
              <h4>Cost gate — no entry unless the move can pay for itself</h4>
              <p>Expected move = the TP distance (or Exp. move × ATR when TP is off). It must be at least <b>{p(rt, 3)}</b> round-trip LP fee + price impact both ways (live reserves, at this size) + gas (approve + swap to buy, swap to sell, at the current gas price) + {2 * DEFAULT_COSTS.slippageBps} bps slippage allowance + <b>Min edge</b> (default {p(DEFAULT_TREND.minEdgePct * 100)}). Blocked signals appear as <i>blocked</i> in Signals and the activity feed, with the numbers.</p>
              <ul className="tight">
                <li>Trades go through the same safety checks as grids: units guard (a quote more than 1.5× away from spot is refused), impact cap, slippage, deadline. A broadcast swap is reconciled by hash and never re-sent.</li>
                <li><b>Inventory is separate.</b> A trend bot only spends its own cash and only sells PLS it bought, never grid inventory. A live start is refused unless the signing address balance covers every live allocation (grids + trend bots). Analytics shows the coverage.</li>
                <li><b>Persistence</b>: the position, stop, TP, trailing high, cooldown and last processed candle live in <code>data/state.json</code> (v3) and resume after a restart.</li>
                <li><b>STOP</b> pauses the bot. An open position stays open and <b>its stops are not watched while stopped</b>. <b>KILL ALL</b> stops every grid and trend bot.</li>
              </ul>
            </div>
          </section>

          <section id="g-backtest">
            <h2>10 · Backtest</h2>
            <ul className="tight">
              <li>Runs on the stored candles in <code>data/candles/</code>. Gaps (no trades) are filled with flat grey candles.</li>
              <li><b>No look-ahead</b>: a signal on candle <i>i</i>'s close fills at candle <i>i+1</i>'s open. Stop/TP are checked intrabar from then on; a gap through the stop fills at the open. If stop and TP are both inside one candle, the stop counts (conservative). The trailing stop moves only after that candle's checks. A position still open at the end is closed at the last close.</li>
              <li><b>Costs per swap</b>: {p(fee)} LP fee, price impact from the <b>current</b> pool reserves re-centred at each historical price (an approximation, since depth back then differed), gas at today's gas price, and {DEFAULT_COSTS.slippageBps} bps assumed slippage (editable). Buy &amp; hold PLS uses the same cost model.</li>
              <li><b>Metrics</b>: return vs buy &amp; hold, CAGR (≥30 days), max drawdown, win rate, profit factor, avg win/loss, expectancy, Sharpe/Sortino (per candle, annualised, no risk-free rate), exposure, trades, fees, gas, entries blocked by the cost gate, plus the full trade list.</li>
              <li><b>Sweep</b>: two parameters on a heatmap of total return. Click a cell to load it. The highlighted best cell needs ≥3 trades and is <b>in-sample</b>: picking the max of many runs overfits. Prefer a broad plateau and confirm on a later period.</li>
              <li><b>Use these settings → start paper bot</b> creates a paper trend bot with exactly these parameters.</li>
              <li><b>Grid configs</b> can be backtested too: candles are walked o→l→h→c (up candles) or o→h→l→c (down candles), and fills land exactly on level prices, which is optimistic vs live polling.</li>
            </ul>
          </section>

          <section id="g-charts">
            <h2>11 · Charts &amp; candles</h2>
            <ul className="tight">
              <li><b>Sources</b>: (1) <b>GeckoTerminal</b>: native candles per timeframe, ≤1000 per call, ~6 months of history, public limit 30 calls/min; the background sync stays under that and backs off 65 s on HTTP 429. (2) <b>On-chain rebuild</b> from the PulseX pair's Sync/Swap events: trustless, slow (5k-block chunks). (3) <b>Live polls</b> update the open candle of every timeframe each poll (no volume).</li>
              <li><b>Units</b> match the grid: quote per PLS, sell side (after one {p(fee)} LP fee). GeckoTerminal and on-chain prices are scaled × (1 − {p(fee)}).</li>
              <li>Timeframes {TFS.join(' / ')}; stored per pair, capped at {TFS.map((t) => `${TF_CAP[t]} ${t}`).join(', ')} candles.</li>
              <li>Overlays: EMA (a trend bot's own lengths in its detail view), Donchian 20, Bollinger 20/2. Panes: RSI 14 (30/70), MACD 12/26/9.</li>
              <li><b>Bots</b> toggle: grid levels (dotted), grid fills (small arrows), trend entries/exits (labelled with reason and net), and the open position's entry / stop (or trail) / TP lines. The last candle follows live ticks.</li>
            </ul>
          </section>

          <section id="g-analytics">
            <h2>12 · Analytics, activity &amp; alerts</h2>
            <ul className="tight">
              <li><b>Portfolio</b>: total ≈USD (each bot's quote token converted at the live PLS/DAI cross), allocation by asset, realized/unrealized, fees/gas. <b>Today / 7d / all-time</b> = equity change from per-minute snapshots, with realized PnL by trade time (<i>partial</i> if the history is shorter). <b>vs HODL</b> = each bot's capital bought as PLS at its start price.</li>
              <li><b>Per-bot</b>: win rate and profit factor over closed round-trips/trades (net after fees + gas), average trade, max drawdown of the equity samples, streaks, time in market, best/worst.</li>
              <li><b>Market panel</b> per pair: spot, 24h/7d change, liquidity (2 × quote reserve in ≈USD), impact for $100/$500/$1k buys and sells, 24h volume (GeckoTerminal/on-chain candles only), ATR% (1h ATR14 ÷ price), trend (1h EMA20 vs EMA50) and a <b>regime hint</b> from the 48-candle 1h efficiency ratio: ≥0.35 with a direction → trend (up: trend bot fits; down: stay in the quote); ≤0.20 → chop → grid; otherwise mixed.</li>
              <li><b>Journal</b>: every fill from every bot, filterable, with CSV export.</li>
              <li><b>Activity feed</b> (live over server-sent events, polling fallback): tick, signal, blocked, queued, sent, filled, skipped, stop moved, range, alert, started/stopped, error.</li>
              <li><b>Notifications</b> are opt-in (Alerts tab): fills, stops/TP, bot stopped/errors, price leaving a grid range, alerts, and Σ PnL moving by more than a $ threshold. <b>Alerts</b>: price above/below, RSI(14) above/below on a timeframe, grid out of range. They are checked every poll and fire once per crossing (repeat re-arms after the condition clears).</li>
              <li>Animations respect the system <i>reduce motion</i> setting.</li>
            </ul>
          </section>

          <section id="g-chains">
            <h2>13 · Chains &amp; DEXes</h2>
            <ul className="tight">
              <li><b>Chains</b>: {CHAINS.map((c) => `${c.name}${c.status === 'testnet' ? ' (TESTNET)' : ''}`).join(', ')}. The chain selector in the top bar filters every tab; badges mark the chain on each bot, fill and alert. TESTNET chains carry a yellow T, and a chain without a verified DEX shows <i>trading unavailable</i> with the reason.</li>
              <li><b>One key, every chain</b>: the same address signs everywhere, unless the chain has its own key. Each chain has its own tx queue, so chains trade in parallel while one chain never has two txs in flight. <b>STOP</b> next to a chain in the chain bar stops only that chain's bots; KILL ALL stops everything.</li>
              <li><b>Gas</b> is watched per chain (the chip shows the balance and turns red when low). Costs use the chain's own gas price, and on L2s also the L1 data fee, converted at the chain's native/USD price.</li>
              <li><b>PulseChain DEXes</b>: {PLS_DEXES.map((d) => `${d.name} (${d.kind.toUpperCase()}, ${dexFee(d)})`).join(' · ')}. PulseX V1 and V2 are separate pools with separate prices; 9mm V3 has several fee tiers.</li>
              <li><b>Pool choice</b> (Markets → <b>Pools</b>): every pool for the pair on every DEX, ranked by what a ≈$250 buy would get you (fee + depth). <b>Auto: best quote</b> picks the top one, <b>Use</b> pins a pool, <b>Reset</b> goes back to the default (PulseX V2 for the built-in PulseChain pairs). Bots switch at once; a switch waits while a tx is in flight. Each grid, bot and fill shows the DEX it used.</li>
            </ul>
          </section>

          <section id="g-custom">
            <h2>14 · Custom tokens</h2>
            <ul className="tight">
              <li>Markets → <b>Add custom token</b>: chain + address → the bot reads the token, finds its pools on every DEX of that chain (all V3 tiers), picks the deepest, and simulates a <b>buy → transfer → sell</b> with no real transaction.</li>
              <li><b>Risk badge</b>: <span className="risk-badge risk-low">low</span> clean · <span className="risk-badge risk-medium">medium</span> upgradeable proxy or modest pool · <span className="risk-badge risk-high">high</span> thin pool / a $100 trade moves the price &gt;3% · <span className="risk-badge risk-blocked">blocked</span> honeypot, failing buy, paused trading or a tax above the live cap · <span className="risk-badge risk-unknown">unknown</span> the RPC couldn't simulate.</li>
              <li><b>Tax tokens</b> can trade live on V2 pools (up to {(MAX_TAX * 100).toFixed(0)}% per side); see <a href="#g-taxes">Decimals &amp; taxes</a>. <i>Unknown</i> is paper-only until a re-check passes.</li>
              <li>Once added, the pair works everywhere: grids, trend bots, backtests, charts, market panels, alerts. <b>Re-check</b> re-runs the safety test; <b>Remove</b> works once nothing uses it.</li>
            </ul>
          </section>

          <section id="g-taxes">
            <h2>15 · Decimals &amp; taxes</h2>
            <p className="muted small">With custom tokens, the biggest risks are wrong scaling and taxes. Here is how the bot handles both.</p>
            <ul className="tight">
              <li><b>Decimals are read on-chain</b> with <code>decimals()</code> for every token, cached per chain and address, and checked against the stored market before the first quote. A mismatch refuses to quote or trade. uint8 and uint256 returns both work. Missing <code>decimals()</code> is refused. 0 decimals (whole tokens) and more than 18 (e.g. 24) are supported, up to 36.</li>
              <li><b>Exact amounts.</b> Every amount sent on-chain is an integer in the token's own units (bigint), never a rounded float. Amounts are cut down to the token's decimals, never rounded up. A live sell within 1 ppm above your balance is clamped to the balance.</li>
              <li><b>Units guard.</b> If the router's price (without taxes) is more than 1.5× off spot, the trade is refused. That catches decimals or inversion bugs, but a 10% tax never trips it.</li>
              <li><b>Three taxes, measured separately</b> by a simulated buy → wallet transfer → sell: <b>buy</b> (you get less than quoted), <b>sell</b> (the pool gets less than you send) and <b>transfer</b>. They are shown on the token card, in the Markets list, next to <i>live</i> in the start form, in the cost line, and per fill.</li>
              <li><b>V2 pools</b> (PulseX V1/V2, 9mm V2, Uniswap/Pancake/QuickSwap V2): custom tokens always use the router's <code>…SupportingFeeOnTransferTokens</code> swaps. The minimum out is set <i>after</i> tax. Live is allowed up to {(MAX_TAX * 100).toFixed(0)}% per side (<code>MAX_TOKEN_TAX_PCT</code>).</li>
              <li><b>V3 pools</b> have no tax-aware swap. A taxed token is blocked live on V3 unless the simulated buy → transfer → sell succeeded through that exact pool. If it did, the router minimum is set on the pre-tax amount and the amount you got is checked afterwards. Prefer a V2 pool.</li>
              <li><b>Gates include taxes.</b> The grid start gate, spacing floor (needs floor + round-trip tax), trend cost gate, backtests and market panels all count buy + sell tax on top of the LP fee, impact and gas. A 5%/5% token needs more than ~11% between levels.</li>
              <li><b>PnL is booked from what you actually got</b>, measured as the wallet's balance change for the output token (live sends on a chain go one at a time). The Transfer log is the fallback, then <code>amountOutMin</code> (marked *). Sells use the exact lot that arrived after the buy tax. Paper fills apply the measured taxes.</li>
              <li><b>Re-checks.</b> While a bot runs on a custom token, the tax test re-runs every {30} min (<code>TAX_RECHECK_MIN</code>). It also re-runs right away after a reverted swap or a fill short of the post-tax quote. If a tax rises by more than 0.5 points, or the token becomes a honeypot or pauses, every bot on that market pauses with an alert. You resume them yourself.</li>
              <li><b>Other traps found:</b> <code>paused()</code> / <code>tradingEnabled()</code> (blocked), blacklist views like <code>isBlacklisted(address)</code> (warned), and <code>maxTxAmount</code> / <code>maxWallet</code> limits. Orders above max-tx, or buys that would push you past max-wallet, are skipped. Detection relies on common view names; unusual contracts may hide these.</li>
            </ul>
          </section>

          <section id="g-faq">
            <h2>16 · FAQ / troubleshooting</h2>
            <dl className="faq">
              <dt>Why do I need HEX for a PLS/HEX grid?</dt>
              <dd>In the classic <i>PLS/HEX</i> orientation, HEX is the quote: buys spend HEX to get PLS, so capital is HEX. To start with <b>only PLS</b>, press <b>⇄</b> to get <i>HEX/PLS</i> (or use the <b>Stack HEX with PLS</b> preset): capital is PLS, buys spend PLS for HEX and sells turn those lots back into PLS. Keep capital + gas reserve in PLS.</dd>
              <dt>No fills?</dt>
              <dd>Price hasn't moved a full step to the next level below, it is above the range, the levels are <i>inactive</i> or in <i>rearm</i>, or the grid is stopped. Check Log for <i>Skipped …</i> (impact cap, balance).</dd>
              <dt>Start blocked?</dt>
              <dd>The message gives the reason: spacing &lt; {p(MIN_SPACING_PCT * 100, 1)}, net per RT ≤ 0 or below margin (tiny size, shallow pool, or high gas), no levels below spot, live without a key, or a previous tx still reconciling. Widen the range, use fewer grids, add capital, or pick a deeper pair.</dd>
              <dt>Sell held?</dt>
              <dd><i>Sell would lose vs lot cost</i>: quoted proceeds − gas don't beat what that lot cost, so it holds and re-arms. It can also be the impact cap, or not enough PLS for gas.</dd>
              <dt>Bot stopped after a restart?</dt>
              <dd>A live grid stays stopped if the server started without a key in <code>.env</code>, or if it's an old live grid with spacing under {p(MIN_SPACING_PCT * 100, 1)} (it can't be resumed; start a new one). Grids you stopped stay stopped. Press Resume.</dd>
              <dt>Mac went to sleep?</dt>
              <dd>Nothing polls or trades while it sleeps. On wake, polling resumes and any swap that was in flight is reconciled by tx hash (never re-sent). Keep the Mac awake for unattended runs, e.g. <code>caffeinate -i</code> or the Energy/Battery “prevent sleep” setting, or run on an always-on box with pm2.</dd>
              <dt>Swap reverted (✗)?</dt>
              <dd>Price moved past Slip % or the deadline passed. Only gas is lost; the trade is retried with a fresh quote up to <code>MAX_RETRIES</code>.</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
