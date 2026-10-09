/**
 * In-app Guide. Every number is imported from the code that enforces it, so the guide can't drift from the fee
 * math, start-check thresholds, limits or preset params.
 */
import { useEffect } from 'react';
import { FEE_BPS, MIN_NET_PCT, MIN_SPACING_PCT } from './live/economics';
import { DEFAULT_LIMITS, HARD_CAPS } from './live/limits';
import { STRATEGY_PRESETS } from './live/presets';
import { MAX_GRID_COUNT, MIN_GRID_COUNT } from './live/spacing';
import { DEFAULT_TREND, STRATEGIES } from './market/strategy';
import { CHAINS, chainFromNetwork } from './live/chains';
import { NETWORKS } from './live/networks';
import { MAX_TAX } from './live/tax';
import { DEFAULT_GAS_RESERVE } from './live/gasReserve';

const PLS_DEXES = chainFromNetwork(NETWORKS.mainnet).dexes;
const dexFee = (d: (typeof PLS_DEXES)[number]) => (d.kind === 'v3' ? d.feeTiers!.map((t) => `${t / 10_000}%`).join(' / ') : `${d.feeBps! / 100}%`);

const fee = FEE_BPS / 100; // 0.29
const rt = (1 - (1 - FEE_BPS / 10_000) ** 2) * 100; // 0.579
const p = (x: number, d = 2) => `${x.toFixed(d)}%`;

export const GUIDE_SECTIONS = [
  ['what', 'How a grid works'],
  ['pnl', 'Wins and losses'],
  ['costs', 'What a trade costs'],
  ['presets', 'Presets'],
  ['trend', 'Trend bot'],
  ['safety', 'Paper, live & safety'],
  ['faq', 'FAQ'],
] as const;

const PRESET_USE: Record<string, string> = {
  'tight-scalp': 'The pair you pick, chopping sideways. Use deep pools such as DAI or USDC.',
  hex: 'The HEX/PLS ratio swinging back and forth.',
  ehex: 'Same as HEX, on the bridged eHEX pool.',
  plsx: 'The PLSX/PLS ratio swinging back and forth.',
  'pulse-pack': 'HEX, eHEX and PLSX at once. Needs all three tokens in the wallet.',
  'stack-hex': 'Start with only PLS and end with more HEX.',
  'stack-plsx': 'Start with only PLS and end with more PLSX.',
  'stack-ehex': 'Start with only PLS and end with more eHEX.',
  'stable-ladder': 'PLS against dollars, split across DAI and USDC.',
};

function GridDiagram() {
  // 7 levels; the price zig-zags inside the range: buy on a cross down, sell one level up.
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
      <text x="6" y={top + 2} className="g-lbl">highest price</text>
      <text x="6" y={bot + 14} className="g-lbl">lowest price</text>
    </svg>
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
          <button type="button" className="btn ghost small-btn" onClick={onClose} aria-label="Close guide">Close</button>
        </header>

        <div className="guide-body">
          <section id="g-what">
            <h2>How a grid works</h2>
            <div className="guide-cols">
              <GridDiagram />
              <ul className="tight">
                <li>You pick a <b>range</b> (lowest to highest price) and split it into equal <b>levels</b>.</li>
                <li>When the price drops to a level, the bot <span className="buy">buys</span> with that level's share of your money.</li>
                <li>When the price rises to the <b>next level up</b>, it <span className="sell">sells</span> exactly what it bought there.</li>
                <li>Each buy followed by its sell is one <b>completed trade</b>. Its profit is the gap between levels minus costs.</li>
                <li>At the start only levels <b>below</b> the current price get money; levels above stay idle.</li>
              </ul>
            </div>
          </section>

          <section id="g-pnl">
            <h2>Wins and losses</h2>
            <div className="guide-grid2">
              <div className="gcard ok">
                <h4>Makes money</h4>
                <ul className="tight">
                  <li>The price <b>swings sideways inside the range</b>: lots of small dips and bounces.</li>
                  <li>Each completed trade banks roughly the level gap minus costs.</li>
                </ul>
              </div>
              <div className="gcard bad">
                <h4>Loses or lags</h4>
                <ul className="tight">
                  <li><b>Falls below the range:</b> every level has bought, and the coins are worth less than they cost.</li>
                  <li><b>Rises above the range:</b> everything is sold early, so you miss the rally. Holding would have done better.</li>
                  <li><b>Levels too close:</b> costs eat the gap. The start check blocks this.</li>
                </ul>
              </div>
            </div>
            <p className="muted small">Home and every bot show "If you'd held" next to the profit, so you can see whether the bot is actually beating just holding.</p>
          </section>

          <section id="g-costs">
            <h2>What a trade costs</h2>
            <div className="guide-grid3">
              <div className="stat"><b>{p(fee)}</b><span>PulseX pool fee per swap</span></div>
              <div className="stat"><b>{p(rt, 3)}</b><span>per completed trade (buy + sell)</span></div>
              <div className="stat"><b>{p(MIN_SPACING_PCT * 100, 1)}</b><span>minimum gap between levels</span></div>
            </div>
            <ul className="tight">
              <li><b>Price impact</b> grows with the size of each level compared to the pool. Small pools make it large.</li>
              <li><b>Gas</b> is a fixed cost per swap, so tiny levels lose most of their gap to it. On Ethereum, gas usually makes small grids unprofitable.</li>
              <li><b>Start check:</b> using today's pool and gas price, the worst level needs a gap of at least {p(MIN_SPACING_PCT * 100, 1)} and must keep at least {p(MIN_NET_PCT * 100)} of the level size after every cost. Live bots can't start otherwise; paper bots need "Simulate anyway".</li>
              <li>The New bot form shows the result as one sentence: what each completed trade nets in dollars.</li>
            </ul>
          </section>

          <section id="g-presets">
            <h2>Presets</h2>
            <div className="table-wrap"><table className="gtable">
              <thead><tr><th>Preset</th><th>Range × levels</th><th>Dollars</th><th>Use when</th></tr></thead>
              <tbody>
                {STRATEGY_PRESETS.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td>±{(s.legs[0].bandPct * 100).toFixed(0)}% × {s.legs[0].gridCount}</td>
                    <td>${s.legs[0].capitalUsd}{s.legs.length > 1 ? ' each' : ''}</td>
                    <td className="muted">{PRESET_USE[s.id]}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="muted small">Each pair is re-checked against live pool prices before it starts. If any pair fails, nothing starts. "Stack" presets spend PLS and pick the best pool across PulseX and 9mm.</p>
          </section>

          <section id="g-trend">
            <h2>Trend bot</h2>
            <p>A trend bot is either holding nothing (waiting in the quote token) or holding the coin. It buys when its signal fires on a <b>closed</b> candle, so signals never repaint, and sells at the stop-loss, take-profit, trailing stop or exit signal.</p>
            <ul className="tight">
              {STRATEGIES.map((x) => <li key={x.id}><b>{x.label}</b></li>)}
              <li>Default exits: stop-loss {DEFAULT_TREND.stopAtr}× ATR below entry, take-profit at {DEFAULT_TREND.tpR}× that distance above. Stops are checked on every price read, not just at candle close.</li>
              <li><b>Cost check:</b> a buy only happens if the expected move beats the {p(rt, 3)} round-trip fee plus price impact, gas and a {p(DEFAULT_TREND.minEdgePct * 100)} margin. Skipped signals appear in the bot's log.</li>
              <li>Longer candles (4h, 1d) mean fewer trades, so fees take a smaller share. Try settings in <b>Tools → Backtest</b> first.</li>
            </ul>
          </section>

          <section id="g-safety">
            <h2>Paper, live and safety</h2>
            <table className="gtable">
              <tbody>
                <tr><td><b>Paper</b></td><td>Real prices from the chain, simulated fills and estimated gas. No funds move and no key is needed.</td></tr>
                <tr><td><b>Live</b></td><td>Signs and sends real swaps. Only available when the server has a signing key, and it always asks before starting. The key stays on the server and never reaches this page.</td></tr>
                <tr><td><b>Levels</b></td><td>{MIN_GRID_COUNT}–{MAX_GRID_COUNT} per grid.</td></tr>
                <tr><td><b>Max price impact</b></td><td>A trade is skipped if it would move the pool more than this. Default {p(DEFAULT_LIMITS.maxPriceImpact * 100, 0)}, max {p(HARD_CAPS.maxPriceImpact * 100, 0)}.</td></tr>
                <tr><td><b>Slippage</b></td><td>If the price moves more than this before the swap is mined, it reverts and only gas is lost. Default {p(DEFAULT_LIMITS.slippageBps / 100, 0)}, max {p(HARD_CAPS.slippageBps / 100, 0)}.</td></tr>
                <tr><td><b>Gas reserve</b></td><td>When a bot spends the gas coin (PLS or ETH), at least {(DEFAULT_GAS_RESERVE.pct * 100).toFixed(0)}% of its capital is kept aside for gas and never traded.</td></tr>
                <tr><td><b>Custom tokens</b></td><td>Tools → Markets checks a token before it trades: it simulates a buy, a transfer and a sell. Taxed tokens can trade live on V2 pools up to {(MAX_TAX * 100).toFixed(0)}% per side; honeypots, paused tokens and unverifiable ones stay paper-only.</td></tr>
                <tr><td><b>Chains</b></td><td>{CHAINS.map((c) => c.name).join(', ')}. One wallet address signs on every chain; each chain has its own transaction queue.</td></tr>
                <tr><td><b>PulseChain DEXes</b></td><td>{PLS_DEXES.map((d) => `${d.name} (${d.kind.toUpperCase()}, ${dexFee(d)})`).join(' · ')}. Tools → Markets → Pools lists every pool for a pair; <b>Auto: best quote</b> picks the one that pays the most.</td></tr>
              </tbody>
            </table>
          </section>

          <section id="g-faq">
            <h2>FAQ</h2>
            <dl className="faq">
              <dt>No fills?</dt>
              <dd>The price hasn't dropped a full level yet, it's above the range, or the bot is stopped. The bot's log shows any skipped trades and why.</dd>
              <dt>Start blocked?</dt>
              <dd>The message gives the reason: levels too close, too little money per level for the pool and gas, or no levels below the price. Widen the range, use fewer levels, add money or pick a deeper pair.</dd>
              <dt>Price left the range?</dt>
              <dd>Nothing moves it automatically. Stop the grid, open Change range, centre it on today's price and restart. Coins the old levels still hold stay in that grid's totals.</dd>
              <dt>Why do I need HEX for PLS/HEX?</dt>
              <dd>In PLS/HEX the bot spends HEX to buy PLS. Press ⇄ to get HEX/PLS, which spends PLS to buy HEX, or use a "Stack" preset.</dd>
              <dt>Swap reverted?</dt>
              <dd>The price moved past the slippage limit or the deadline passed. Only gas is lost, and the trade is retried with a fresh quote.</dd>
              <dt>Computer went to sleep?</dt>
              <dd>Nothing trades while it sleeps. On wake, any swap that was in flight is checked by its transaction hash and never sent twice. For unattended runs use an always-on machine with pm2.</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
