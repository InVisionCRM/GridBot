/**
 * In-app Guide. Every number is imported from the code that enforces it, so the guide can't drift from the fee
 * math, start-check thresholds, limits or preset params.
 */
import { useEffect } from 'react';
import { FEE_BPS, MIN_NET_PCT } from './live/economics';
import { DEFAULT_LIMITS, HARD_CAPS } from './live/limits';
import { STRATEGY_PRESETS } from './live/presets';
import { MAX_GRID_COUNT, MIN_GRID_COUNT } from './live/spacing';
import { DEFAULT_TREND, STRATEGIES } from './market/strategy';
import { CHAINS, chainFromNetwork } from './live/chains';
import { NETWORKS } from './live/networks';
import { MAX_TAX } from './live/tax';
import { DEFAULT_GAS_RESERVE } from './live/gasReserve';
import { RECENTER_AFTER_MS, RECENTER_COOLDOWN_MS } from './live/recenter';
import { PAYOUT_MIN_GAS_MULTIPLE } from './live/payout';
import { LP_BAND } from './market/lp';
import { MIN_SELL_HOURS, SCAN_CANDLES, SCAN_PAGES, SCAN_RULES, SETUP_BANDS, SETUP_LEVELS, TEST_USD } from './market/scan';

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
  ['auto', 'Opportunities & follow-up'],
  ['trend', 'Trend bot'],
  ['lp', 'Liquidity bot'],
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
  // levels below the start price wait for a buy, the ones above get their coins from one start-up buy;
  // a lot bought at level k sells on the cross of level k+1).
  const marks: { x: number; l: number; s: 'B' | 'S' }[] = [{ x: path[0][0], l: path[0][1], s: 'B' }];
  const waiting = new Set<number>(), holding = new Set<number>();
  for (let k = 0; k < n - 1; k++) (k < path[0][1] ? waiting : holding).add(k);
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
                <li>Your amount is split over <b>every</b> level. Levels below the price wait to buy; for the levels above it the bot buys their coins <b>at the start</b> (the first B), so they sell as the price rises.</li>
                <li>Profit is <b>reinvested</b> (added to that level's next buy) unless you choose to <b>send it to an address</b>.</li>
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
                  <li><b>Levels too close or amounts too small:</b> costs eat the gap. New bot warns you before you start.</li>
                </ul>
              </div>
            </div>
            <p className="muted small">Each grid shows two numbers separately. <b>Earned by trading</b> is what completed buy → sell trades made, after fees and gas, in the coin the grid spends; price moves no longer change it. <b>Bought, not sold yet</b> is the coins waiting for the next level up, which go up and down with the price until they sell. Everything is shown in coins first; the <b>$</b> switch in the top bar adds the dollar value beside each amount, at today's price.</p>
          </section>

          <section id="g-costs">
            <h2>What a trade costs</h2>
            <div className="guide-grid3">
              <div className="stat"><b>{p(fee)}</b><span>PulseX pool fee per swap</span></div>
              <div className="stat"><b>{p(rt, 3)}</b><span>per completed trade (buy + sell)</span></div>
              <div className="stat"><b>0.01–0.05%</b><span>Uniswap pool fee per swap on Ethereum and Robinhood's main pairs</span></div>
            </div>
            <ul className="tight">
              <li><b>Price impact</b> grows with the size of each level compared to the pool. Small pools make it large.</li>
              <li><b>Gas</b> is a fixed cost per swap, so tiny levels lose most of their gap to it. PulseChain gas is the cheapest; Robinhood (an L2) is next; Ethereum gas swings a lot, so read the profit sentence before starting there.</li>
              <li><b>Lower pool fees allow closer levels.</b> A grid on a 0.05% pool keeps money with levels well under 1% apart, where PulseX's 0.29% fee needs about 0.85% or more.</li>
              <li><b>Profit check:</b> using today's pool fee, depth and gas price, New bot tells you in one sentence what each completed trade nets in the coin you spend. Keeping less than {p(MIN_NET_PCT * 100)} after costs is flagged. It never stops you from starting.</li>
            </ul>
          </section>

          <section id="g-presets">
            <h2>Presets</h2>
            <div className="table-wrap"><table className="gtable">
              <thead><tr><th>Preset</th><th>Range × levels</th><th>Use when</th></tr></thead>
              <tbody>
                {STRATEGY_PRESETS.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b></td>
                    <td>±{(s.legs[0].bandPct * 100).toFixed(0)}% × {s.legs[0].gridCount}</td>
                    <td className="muted">{PRESET_USE[s.id]}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="muted small">A preset sets the range and number of levels. You choose how much of each pair's coin to use; the box shows your wallet balance and has a Max button. "Stack" presets spend PLS and pick the best pool across PulseX and 9mm.</p>
          </section>

          <section id="g-auto">
            <h2>Opportunities & follow-up</h2>
            <p><b>Opportunities</b> (its own tab) are found once a day, or when you press Scan now:</p>
            <ol className="tight">
              <li>Read the busiest pools of every DEX the app trades on each chain from GeckoTerminal ({SCAN_PAGES} pages of 20 per DEX).</li>
              <li>Drop pools that don't pair a token with PLS/ETH or a stablecoin, hold less than ${SCAN_RULES.minLiquidityUsd.toLocaleString('en-US')} of liquidity, had fewer than {SCAN_RULES.minTx24} trades in 24 hours, or are newer than {SCAN_RULES.minPoolAgeMs / 3600_000} hours when the pool's age is known. Volume over {SCAN_RULES.maxVolumeToLiquidity}× liquidity is flagged, not dropped: a grid skips it (wash trades are not swings) and a liquidity position is ranked on fees the pool paid on-chain, not that volume. If those fees weren't measured, the pool isn't ranked for liquidity. Up to {SCAN_RULES.maxTokens} coins per chain are kept.</li>
              <li>Run new tokens through the same honeypot and tax check as Markets → Add. Every result is kept and labelled: <i>safe</i>, <i>risk medium/high</i>, or <i>paper only</i> for a token that failed.</li>
              <li>Replay the last {SCAN_CANDLES / 24} days of hourly prices with the pool's real fee, price impact and gas, at about ${TEST_USD.toLocaleString('en-US')} (you can change it): as a grid (ranges ±{SETUP_BANDS.map((b) => b * 100).join('/')}% with {SETUP_LEVELS.join('/')} levels) and, on a V3 pool, as a liquidity position.</li>
              <li>Rank. <b>Liquidity</b> by what the position earned after swap and gas costs. <b>Grids</b> by how much the price swings back and forth, among pools where a grid earned from its trades (sold in at least {MIN_SELL_HOURS} different hours, because one price spike isn't a pattern). Tested on 92 real pools over 4 weeks of October 2026: last week's liquidity earnings predicted the next week's closely; for grids the swing predicted next week's earnings better than last week's grid result, and the price change predicted nothing. The coin's price move is shown but never ranks a pool.</li>
            </ol>
            <p>Filter by strategy, safety and pool size, or type a coin; the chain buttons in the top bar pick the chain. <b>Try grid</b> or <b>Try liquidity</b> opens New bot with that pool and setting, centred on today's price. You still choose the amount and paper or live. A good last week doesn't promise the next one. Home shows the two safe pools ranked first for each.</p>
            <p><b>Token trader</b> (on the Smart trader page) buys new and trending pools itself, sized from the pool's depth so the entry stays under the price-impact cap and a share of the pool you set. Scan picks respect the minimum pool age (24 hours unless you lower it). The sniper watches factory logs for a new pool and acts when liquidity is added; it ignores that age and still runs the safety check. Paper and live use the same rules. Live is off until you turn it on.</p>
            <p><b>Follow the price up</b> is on for new grids and can be switched on any grid's page. When the price has stayed above the range for {RECENTER_AFTER_MS / 3600_000} hours and every level has sold, the range moves up around the price: same width, levels and amount, at most once every {RECENTER_COOLDOWN_MS / 3600_000} hours. It never moves down. Below the range the grid keeps what it bought and waits for the price to come back.</p>
          </section>

          <section id="g-trend">
            <h2>Trend bot</h2>
            <p>A trend bot is either holding nothing (waiting in the quote token) or holding the coin. It buys when its signal fires on a <b>closed</b> candle, so signals never repaint, and sells at the stop-loss, take-profit, trailing stop or exit signal.</p>
            <ul className="tight">
              {STRATEGIES.map((x) => <li key={x.id}><b>{x.label}</b>{x.id === 'lines' ? ': draw trend lines (two clicks) and levels (one click) on the chart, exactly where you click, drag them to move them, and give each a rule: buy when a candle closes above it, buy when the price dips to it and closes back above, sell when a candle closes below it, or sell when the price reaches it. Lines can be changed on a running bot; a trend line only trades from its second point on.' : ''}</li>)}
              <li>Default exits: stop-loss {DEFAULT_TREND.stopAtr}× ATR below entry, take-profit at {DEFAULT_TREND.tpR}× that distance above. Stops are checked on every price read, not just at candle close.</li>
              <li><b>Cost check:</b> a buy only happens if the expected move beats the {p(rt, 3)} round-trip fee plus price impact, gas and a {p(DEFAULT_TREND.minEdgePct * 100)} margin. Skipped signals appear in the bot's log.</li>
              <li>Longer candles (4h, 1d) mean fewer trades, so fees take a smaller share. Try settings in <b>Tools → Backtest</b> first.</li>
            </ul>
          </section>

          <section id="g-lp">
            <h2>Liquidity bot</h2>
            <p>A liquidity bot puts both coins into a V3 pool (Uniswap V3 on Ethereum and Robinhood, 9mm V3 on PulseChain; on PulseChain, type a coin in the pair box and pick a 9mm V3 pool) between two prices around today's price. Every trade that happens inside that range pays it a share of the pool fee. It doesn't buy and sell on its own: the traders do, and as the price moves the position ends up holding more of whichever coin fell, much like a grid.</p>
            <ul className="tight">
              <li><b>Opening:</b> part of your amount is swapped to the other coin (about half; the exact mix depends on where the price sits in the range), then the position is opened. Ranges from ±{LP_BAND.min * 100}% to ±{LP_BAND.max * 100}%. Narrower earns more per coin while the price stays inside, and leaves the range sooner.</li>
              <li><b>Moving the range:</b> with <i>Auto-move</i> on, as soon as the price leaves the range (up or down) the position is taken out and reopened around the price with the same width. Each move locks in the coin mix it had (lost to range moves). With it off, the range waits for the price to come back. On a bot's page you can also move it to the price yourself, or change its width: it reopens around the price at the new width. A move isn't started when its swap would go over the price-impact cap.</li>
              <li><b>Fees:</b> <i>Reinvest</i> (default) rolls them into the next position when the range moves or you close. <i>Send to an address</i> collects them there once they're worth {PAYOUT_MIN_GAS_MULTIPLE}× the collect's gas.</li>
              <li><b>Before you start:</b> the form replays the pool's real trades from the last 7 days, every range from ±1% to ±20% with moving on and off, using the bot's own rules. For each one it shows what it would have earned after costs (in total and per day), the fees in each coin, the moves and what they lost, the time in range, and the coins and share of the pool a position opened now with your amount would have. Price moves are left out. Click a row to use it. The first time, reading a busy pool's trades takes a few minutes.</li>
              <li><b>What the numbers mean:</b> <i>Fees earned</i> is the pool's fees it collected, in the coins they were paid in. <i>Costs</i> is gas plus the swaps to the range's mix. <i>Lost to range moves</i>: inside the range the position sells the coin as it rises and buys it as it falls, so it ends up with more of whichever coin fell; taking it out (to move the range, or to close) makes that final, and this is how much less those coins were worth than the ones put in, at the same price. <i>Earned after costs</i> = fees − costs − lost to range moves. A narrow range that moves often can earn the most fees and still lose them to moves: on 9mm V3 HEX/PLS in the week to 26 October 2026, ±1% moving (under the earlier, slower move rule) earned the most fees (23.2M PLS) and lost 45.2M PLS to its 27 moves, while ±3% staying put earned 4.4M PLS (about $23 on $1,000) after costs. <i>Liquidity provided</i> is the coins in the position now and its share of the pool, which is its share of every trade's fee.</li>
              <li><b>Pause</b> keeps the position open and earning but stops moving the range and sending fees. <b>Close</b> takes everything out and the coins go back to your wallet. A paper bot leaves the list immediately. A live bot shows closing until the withdrawal finishes, with the same price-impact and slippage limits. <b>Clear closed</b> hides stopped bots from this page without sending a transaction. A live trend or liquidity bot that still holds a position stays until Close. History and profit stay in Tools → Analytics.</li>
            </ul>
          </section>

          <section id="g-safety">
            <h2>Paper, live and safety</h2>
            <table className="gtable">
              <tbody>
                <tr><td><b>Paper</b></td><td>Real prices from the chain, simulated fills and estimated gas. No funds move and no key is needed.</td></tr>
                <tr><td><b>Close</b></td><td>A paper bot leaves the list immediately. A live bot shows closing until its swap or withdrawal finishes, under the same price-impact and slippage limits. Clear closed hides stopped bots from this page without sending a transaction. A live position that still has to be unwound stays until Close. History and profit stay in Tools → Analytics.</td></tr>
                <tr><td><b>Live</b></td><td>Signs and sends real swaps. Only available when the server has a signing key, and it always asks before starting. The key stays on the server and never reaches this page.</td></tr>
                <tr><td><b>Levels</b></td><td>{MIN_GRID_COUNT}–{MAX_GRID_COUNT} per grid.</td></tr>
                <tr><td><b>Max price impact</b></td><td>A trade is skipped if it would move the pool more than this. Default {p(DEFAULT_LIMITS.maxPriceImpact * 100, 0)}, max {p(HARD_CAPS.maxPriceImpact * 100, 0)}.</td></tr>
                <tr><td><b>Slippage</b></td><td>If the price moves more than this before the swap is mined, it reverts and only gas is lost. Default {p(DEFAULT_LIMITS.slippageBps / 100, 0)}, max {p(HARD_CAPS.slippageBps / 100, 0)}.</td></tr>
                <tr><td><b>Gas reserve</b></td><td>When a bot spends the gas coin (PLS or ETH), at least {(DEFAULT_GAS_RESERVE.pct * 100).toFixed(0)}% of its capital is kept aside for gas and never traded.</td></tr>
                <tr><td><b>Custom tokens</b></td><td>Tools → Markets checks a token before it trades: it simulates a buy, a transfer and a sell. Taxed tokens can trade live on V2 pools up to {(MAX_TAX * 100).toFixed(0)}% per side; honeypots, paused tokens and unverifiable ones stay paper-only.</td></tr>
                <tr><td><b>Pair search</b></td><td>Type in any pair box to search every pool on the DEXes this app trades (from DexScreener). Picking a new one runs the same safety check as a custom token; a honeypot, a tax over {(MAX_TAX * 100).toFixed(0)}% or a coin that can't be checked is not added. A coin using the name of one you already trade, at another address, is marked as a different coin.</td></tr>
                <tr><td><b>Convert</b></td><td>Tools → Convert swaps the coins a chain's wallet holds into one coin. It leaves alone what your live bots use, some of the chain's coin for gas, coins named like a website (scam airdrops), coins that fail the safety check, swaps over the price-impact cap and coins worth less than twice their gas. You see the plan first; it runs one coin at a time through the bots' own transaction queue, and Stop never leaves a coin halfway.</td></tr>
                <tr><td><b>Chains</b></td><td>{CHAINS.map((c) => c.name).join(', ')}. One wallet address signs on every chain; each chain has its own transaction queue.</td></tr>
                <tr><td><b>PulseChain DEXes</b></td><td>{PLS_DEXES.map((d) => `${d.name} (${d.kind.toUpperCase()}, ${dexFee(d)})`).join(' · ')}. Tools → Markets → Pools lists every pool for a pair; <b>Auto: best quote</b> picks the one that pays the most.</td></tr>
              </tbody>
            </table>
          </section>

          <section id="g-faq">
            <h2>FAQ</h2>
            <dl className="faq">
              <dt>No fills?</dt>
              <dd>Each grid on Home shows its next buy and next sell with the price moving between them: it trades when the price reaches one. If it looks stuck, open <b>Tools → System</b>: the self-test checks every chain, your wallet and every bot, and says what to fix.</dd>
              <dt>Is my app up to date?</dt>
              <dd>The pill at the top says so. It compares the running server with your built copy, your downloaded code and GitHub, and gives the exact commands when one is behind (pull, build, restart).</dd>
              <dt>Why did the total value drop?</dt>
              <dd>Coins went down in price. <b>Earned by trading</b> on Home is counted in the coins themselves, so only a losing trade lowers it, and every trade in the Live feed shows its own result.</dd>
              <dt>Start refused?</dt>
              <dd>The message says why: usually not enough of the coin in your wallet for a live bot (the amount, plus the gas set-aside when it spends PLS or ETH), or the price is below the range. Use a smaller amount or Max, or start it in paper mode.</dd>
              <dt>Price left the range?</dt>
              <dd>With Follow the price up on, a grid that sold everything moves its range up on its own. Otherwise stop the grid, open Change range, centre it on today's price and start it again: it keeps the coins it holds.</dd>
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
