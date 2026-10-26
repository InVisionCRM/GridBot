# GridBot

Server-side grid + trend bots for EVM DEXes. Auto-signs with your key. It runs on **PulseChain, Ethereum and Robinhood
Chain**, on Uniswap-V2-style and Uniswap-V3-style DEXes, with **custom tokens on every chain**. On PulseChain a pair can trade on **PulseX V1, PulseX V2,
9mm V2 or 9mm V3**, using the best pool or one you pick. Chains run in parallel, each with its own nonce queue. Within a chain, one tx is in flight at a time.

> Tip: use a dedicated hot wallet that holds only what the bot trades, plus gas on each chain you use.

## Run

```bash
cp .env.example .env        # PRIVATE_KEY=0x…  (optional: PRIVATE_KEY_BASE=…, RPC_URL_BASE=https://…, CHAINS=pulsechain,base)
npm install
npm run build && npm start  # → http://127.0.0.1:3847
```

Headless:

```bash
pm2 start npm --name grid-bot -- start && pm2 save
pm2 logs grid-bot
```

Dev: `npm run dev` (UI :5173, API :3847).

## Using the app

- **Home**: **Earned by trading** counted in each coin (completed buy → sell trades after fees and gas, plus liquidity bots' earnings after costs) with how many trades won and lost, so a falling price never looks like a losing trade. **Right now** shows how many bots run, the last trade and the next likely one. Each grid row shows its live price gliding between its next buy and next sell, and a **Live** feed lists every buy, sell and transaction the moment it happens, with each sell's own result. With the **$** switch on, holdings at today's prices sit below as a separate line. Plus **Your wallet** (every coin the signing address holds on each chain, and how much your live bots use). Notices for anything that needs you (low gas, errors, a grid that left its range, a wallet that doesn't cover live bots). One row per bot with Stop / Resume, then **Best this week**: the two safe pools ranked first in the last scan for a grid and for liquidity, with a link to Opportunities.
- **Opportunities**: every busy pool on your chains, ranked by what a grid or a liquidity position earned from trading over the last 7 days (see *Opportunities and follow-up*).
- **New bot**: choose a grid, a trend bot or a liquidity position. Grids start from a preset or a custom range. Every amount is entered in the coin the bot spends (PLS, DAI, HEX …), with your wallet balance and a **Max** button beside the box; live starts are checked against the wallet before you press Start. One sentence tells you what each completed buy-then-sell nets after fees, impact and gas. Paper / Live sits next to the Start button; live always asks first. Limits live under *Advanced*.
- **Bot detail**: for grids, earned by trading (in the coin it spends), coins bought and not sold yet, and the two together; for trend bots, profit and what's banked; for liquidity bots, fees in each coin, costs, what range moves lost, earned after costs, the coins in the position and its share of the pool; the chart (grid levels and fills, or the trend bot's entry / stop / take-profit lines), the bot's own log, levels, fills (compact, or *All columns*), and for grids **Follow the price up** and **Change range**, which restarts a stopped grid on its own pair and mode.
- **Tools**: Charts, Backtest, Analytics, Markets (custom tokens, pool picker, chain registry), Alerts and **System** (below).
- **Paper and live are never added together.**
  - **Analytics tabs:** **Live** (real money only), **Paper** (simulated, its own value history and journal, dashed and labelled) and **Market conditions**.
  - **API:** `GET /api/analytics/overview` and `/journal(.csv)` require `?mode=live|paper`.
  - **Home:** the headline totals ("Earned by live trading", "Live holdings") count live bots only. Paper bots get their own line, and paper rows in the live feed carry a PAPER tag.
  - **History:** state version 4 keeps one value history per mode. The older single history summed both, so it can't be split, and both start over on upgrade.
- **Coins first, dollars on request.** Every result is in the coin it was earned in. The **$ off / $ on** switch in the top bar adds the dollar value beside each amount, at today's price (remembered per browser). Analytics stays in dollars: it adds up bots that spend different coins.
- **Top bar**: chain filter (All / PLS / HOOD / ETH, with a dot when gas is low), the $ switch, signing address or *Paper only*, the Activity feed, the Guide, and **Stop all** (or *Stop all on* the filtered chain). Stopping never sells holdings.
- **Guide**: a short in-app explainer. Its numbers are imported from the code (fees, start-check thresholds, limits, preset params).

## Multi-chain

- **Chains.** PulseChain, Robinhood Chain and Ethereum are on by default. `CHAINS=ethereum` (for example) limits the set; PulseChain is always on. Bots, alerts and custom tokens saved for a chain that isn't loaded stay stopped and show as unavailable until you remove them.
- **RPCs.** `RPC_URL_<SLUG>` (comma-separated list allowed) comes first, then the built-in public fallbacks. On PulseChain the legacy `RPC_URL` also works. The reader rotates endpoints on transport errors and 429s, uses a 12 s timeout, and limits concurrency per chain. A chain with one RPC (Robinhood) has nothing to rotate to: a 429 there is retried after 1 s, 2 s and 4 s, other errors after 0.4 s and 0.8 s. Robinhood's RPC rate-limits `eth_getLogs` and, while those run, refuses ordinary reads too, for seconds at a time (measured 2026-10-22: `eth_call` alone, 0 of 400 refused at up to 30 a second; with log reads at 4 a second, 2 of 75; at 8, 9 of 75). The only log reads in normal running are the liquidity replay's swap history; during it, a live liquidity bot's tick failed with *exceeded maximum retry limit … 429 Too Many Requests*. In six paired 3–4-minute runs under that load, the old 0.4 s + 0.8 s let 47 of ~3,100 bot reads fail, these waits 3. In the app, a full 7-day ETH/USDG history read alongside a ±1% paper liquidity bot then gave the bot no errors. A failed read only skips that tick: a liquidity bot's tries count mined reverts, not refused reads. Simulations with state overrides try every endpoint, because support varies by RPC.
- **Keys.** One `PRIVATE_KEY` signs on every chain (same EVM address). The optional `PRIVATE_KEY_<SLUG>` (e.g. `PRIVATE_KEY_ETHEREUM`) overrides it for that chain. Keys are read only in `src/server/env.ts`, removed from `process.env` immediately, redacted from logs, and never sent to the UI (`tests/noSecrets.test.ts`).
- **Queues.** Each chain has its own `TxGate` + nonce queue, so chains trade in parallel while one chain never has two txs in flight. **Stop all** stops everything; with a chain selected it stops only that chain.
- **Gas.** The gas balance is polled per chain, with a warning in the feed when it drops below the chain's threshold (50k PLS; 0.01 ETH on Ethereum; 0.0005 ETH on Robinhood). Gas is converted to the market's base and quote units through the chain's native/USD market. On Robinhood (an Arbitrum Orbit L2) the cost and start gates add the L1 component from `NodeInterface.gasEstimateL1Component`.
- **Markets.** The key `chain:BASE/QUOTE` (e.g. `ethereum:ETH/USDC`) is used by every feature: grids, trend bots, backtests, charts, market panels, alerts, analytics and the journal. The existing PulseChain keys (`DAI`, `HEX`, …) and `data/state.json` load unchanged as chain 369.
- **UI.** The chain filter in the top bar applies to every screen. Chain badges and explorer links per chain. Tools → Analytics shows aggregated ≈USD with a per-chain breakdown. DEX/version + fee tags appear on each grid, trend bot, pool and fill.

## DEX adapters

One interface (`src/server/dex/types.ts`): `findPools`, `state`, `quote`, `buildSwap`.

- **V2** (`v2.ts`): `factory.getPair`, `getReserves`, `router.getAmountsOut`, `swapExact{ETHForTokens,TokensForETH,TokensForTokens}`. The fee is set per DEX (PulseX V1/V2 0.29%, 9mm V2 0.25%, Uniswap V2 0.30%). `check:onchain` measures each fee from reserves against `getAmountsOut`.
- **V3** (`v3.ts`): `factory.getPool` on every configured tier, then `slot0` + `liquidity`. Quotes come from **QuoterV2** `quoteExactInputSingle` at the real size. Swaps go through `multicall(deadline, …)` on SwapRouter02 / PancakeSwap-style SmartRouter (`exactInputSingle`, `exactInput` for paths, `unwrapWETH9` for native out). Tiers: Uniswap 100/500/3000/10000, PancakeSwap 100/500/2500/10000, 9mm 100/500/2500/10000/20000.
- The profit check, trend cost check and backtests use the market's real LP fee, the chain's gas units and price, the L1 data fee and the native→USD price.

## PulseChain DEXes: PulseX V1, PulseX V2, 9mm V2, 9mm V3

Verified 2026-10-08 against the official sources below, plus on-chain reads (`npm run check:onchain` repeats every check):

| DEX | Kind | Factory | Router | Quoter | Fee | On-chain checks |
|---|---|---|---|---|---|---|
| PulseX V2 | V2 | `0x29eA7545DEf87022BAdc76323F373EA1e707C523` | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` | — | 0.29% | router.factory() = factory; WPLS(); fee measured 29.0 bps |
| **PulseX V1** | V2 | `0x1715a3E4A142d8b698131108995174F37aEBA10D` | `0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02` | — | 0.29% | separate contracts and pairs from V2 (65k pairs, own INIT_CODE_PAIR_HASH `0x59ff…5d62`); router.factory() = V1 factory; WPLS(); fee measured 29.0 bps on WPLS/DAI, HEX, PLSX, USDC |
| **9mm V2** | V2 | `0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b` | `0xcC73b59F8D7b7c532703bDfea2808a28a488cF47` | — | 0.25% | router.factory() = factory; WPLS(); fee measured 25.0 bps |
| **9mm V3** | V3 (PancakeSwap-V3 fork) | `0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68` | SmartRouter `0xa9444246d80d6E3496C9242395213B4f22226a59` | QuoterV2 `0x500260dD7C27eCE20b89ea0808d05a13CF867279` | 0.01 / 0.05 / 0.25 / 1 / 2% | SmartRouter + QuoterV2 report factory, pool deployer `0x00f3…177b` and WPLS; `feeAmountTickSpacing`: 100→1, 500→10, 2500→50, 10000→200, 20000→400, 3000→0 (disabled) |

Sources:
- PulseX V1 + V2: the V1 router is labelled **Official** on [PulseScan](https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02) and was deployed by the same deployer (`0x30e22a…c72539`) as the V2 router/factory. The V1/V2 router + factory list is in the community [PulseChain docs (PulseX page)](https://hexikani.github.io/pulsechain-docs/pulsex.html). The official [docs.pulsex.com](https://docs.pulsex.com) did not respond from the build machine (empty/500), so its address page could not be read directly.
- 9mm: official deployments repo [9mm-exchange/deployments `pulsechain/v2.json`](https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json) and [`pulsechain/v3.json`](https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json). The V3 `SwapRouter` (`0x7bE8…1bEA`, older Pancake interface with deadline in the struct) is verified but not used. The bot uses the SmartRouter (IV3SwapRouter interface).

**Pool selection.** Every market has a **Pools** button in Tools → Markets. It lists every pool for that pair across all DEXes on the chain (both 9mm V3 tiers included): TVL, mid price, output for a ≈$250 buy, % vs best, impact.
- **Auto: best quote** picks the pool with the largest output at that size, which accounts for both fee and depth (TVL breaks ties).
- **Use** sets a manual override.
- **Reset to default** returns a built-in market to its registry pool. Built-in PulseChain markets default to PulseX V2, so existing grids behave exactly as before until you switch.
- Overrides are saved in `data/custom.json` (`pools`) and restored on boot. Running bots follow the switch immediately: the market's Quoter resolves the adapter of the current pool, and approvals are checked against the new router.
- A switch is refused while a tx on that market is in flight. Candles stay on the original pool so a series never mixes pools.
- Custom-token discovery searches the same DEXes and defaults to the deepest pool. The radio buttons override it.
- Example live read (Oct 8 2026, 1M PLS → DAI): PulseX V1 8.853 DAI (its WPLS/DAI pair holds ~46B WPLS vs ~4.4B on V2), PulseX V2 8.855, 9mm V3 0.25% 8.859, 9mm V2 0.71 (thin).

## Opportunities and follow-up

**Opportunities** (its own tab) are found by `src/server/market/scanner.ts` once a day (checked every 30 min; results in `data/picks.json`), or by **Scan now**. For each chain (PulseChain, Ethereum, Robinhood):

1. **Busiest pools of the DEXes this app trades.** GeckoTerminal `/networks/{slug}/dexes/{dex}/pools?sort=h24_volume_usd_desc`, up to 5 pages of 20 for each tradable DEX (ids in `src/live/chains.ts`, field `gecko`; PulseChain: pulsex-v2, pulsex (V1), 9mm-v2, 9mm-v3; Robinhood: uniswap-v3/v2-robinhood, pancakeswap-v3-robinhood; Ethereum: uniswap_v3, uniswap_v2). The chain-wide list was the wrong input: on 2026-10-17, 33 of Robinhood's 40 busiest pools were Uniswap V4 (not tradable here, most reported with $0 liquidity), which crowded out the real Uniswap V3 stock pools (NVDA ~6.7k trades/day, SPCX ~11k). A 429 or 5xx is retried once. The background candle download pauses while a scan runs.
2. **Filter** (`pickTokens` in `src/market/scan.ts`). Volume alone is misleading: on 2026-10-17 the top Ethereum list had $53M of "volume" on a $45 pool and stablecoin/stablecoin pairs that never move, and Robinhood had $30–60M "volume" pools with ~19 trades. A pool is kept only if:
   - one side is something the bot can spend (wrapped native or a stablecoin; the zero address and `0xEeee…` count as the native coin);
   - it has at least $10,000 of liquidity and 50 trades in 24 h;
   - its volume is at most 20× its liquidity (more is likely wash trading).

   One pool per coin, up to 100 coins per chain. Every market already in the app is tested too: PLS/HEX is turned around to HEX/PLS so it spends PLS.
3. **Safety, every level kept.** New tokens go through the same `hub.inspect` as Markets → Add (deepest pool on a DEX the app trades, honeypot / tax simulation). Each result is labelled *safe*, *risk medium/high* (with why), or *paper only* when it failed: such a token can still be added for paper trading, never live.
4. **Test, both ways, at your test size** (default $1,000 of the spend coin; set it next to Scan now to what you plan to put in, since price impact and your share of a pool depend on it). The last 7 days of hourly candles, with the pool's real fee, depth (V3 active range) and gas (`Quoter.market()` → `costModelOf`):
   - **Grid:** ranges ±5/8/12/18/25% × 6/10/14/20/30/40 levels. The setup kept is the one whose completed buy → sell trades **earned** the most after costs, and it must have sold in at least 3 different hours (one spike isn't a pattern: the first real scan ranked USDG/USDC first at +1.99% from a single stablecoin wick). One-off price spikes are clipped first (see Backtester).
   - **Liquidity** (`src/market/lp.ts`), only on a V3 pool whose DEX has a verified position manager (where a liquidity bot can run): ranges ±5/8/12/18/25/50%, kept by what the position earned = fees − the opening swap's fee and impact − gas to open and close. It earns `volume × pool fee × LP share × your share of the pool's active liquidity` for the part of each hour the price is inside its range; the pool's liquidity is today's, held constant over the week.
   - **Swing:** the hourly high-low ranges added up, per day (`dailySwing`).
   - GeckoTerminal leaves out hours with no trades, so a quiet pool's last 168 candles can span weeks. The candles are filled hour by hour up to the last closed hour first, so the test is always the last 7 days. Markets already in the app reuse their saved hourly candles when they cover the week up to the last 2 hours.
5. **Rank** (`gridRank`, `lpRank`; the walk-forward below): **grids by swing**, among pools where a grid earned from its trades at your size; **liquidity by what it earned after costs**. The coin's own price change is shown on each pool but never ranks it.
6. **The page:** Grid / Liquidity tabs, Safety (Safe / Up to medium / All), Pool size and a coin search; the top bar's chain buttons pick the chain. Each pool shows what it earned last week in the spend coin (dollars with the $ switch), its setting, the swing or time in range and pool share, its liquidity and volume, and **Try grid / Try liquidity**, which adds the market if it is new (safety re-checked) and opens New bot with that pool and setting, centred on today's price. Nothing is started for you. *Pools left out* lists every skip with its reason. Home shows **Best this week**: the two safe pools ranked first for each.

While it runs, the page shows the chain and step ("Scanning Robinhood Chain (2 of 3): testing pairs 5 of 11…"). A full scan takes a while: each new token's safety simulation takes ~5 s and each pool needs one GeckoTerminal request, which allows only a few a minute from one address. The scan is off with `CANDLES_GECKO=off`. API: `GET /api/opportunities`, `POST /api/opportunities/scan {testUsd}`, `POST /api/opportunities/use {chainId, address, quote, pool}`.

### Which ranking predicts next week (walk-forward, October 2026)

`scripts/walkForward.ts` takes each chain's busiest pools (GeckoTerminal, one pool per coin, ≥ $10k liquidity, ≥ 20 trades a day, volume ≤ 20× liquidity), 4 weeks of hourly candles, the depth the app's quoter reads (V2 reserves; V3 active liquidity from `slot0` and `liquidity()`), today's gas and the fee share LPs keep, and runs every grid and liquidity setup on each week at $1,000. Each score is measured on one week and checked against what the setup chosen that week earned the **next** week (re-centred), for 92 pools (25 PulseChain, 26 Robinhood, 41 Ethereum, after skipping pools with under 2 weeks of history; 273 grid and 141 liquidity pool-weeks).

| Score on week *w* | Grid: rank correlation with week *w+1* earned | top 10% earned in *w+1* | Liquidity: rank correlation | top 10% in *w+1* |
|---|---|---|---|---|
| Earned from trading (grid trades / fees − costs) | 0.36 | +5.5% | **0.85** | **+13.4%** (all positive) |
| Total return, price included (the old Today's picks) | −0.08 | +3.0% | 0.13 | +5.9% |
| Swing (hourly ranges per day) | **0.53** | **+6.9%** | 0.77 | +10.1% |
| Volume ÷ depth | 0.46 | +5.7% | 0.78 | +10.4% |

- **Grid:** swing came out ahead on each half of the pools separately too (0.50 and 0.54, against 0.34 and 0.37 for last week's grid earnings). Last week's best grid figure overstates the next week: the same setup earned 0.65× of it (it is the best of 30 tries). Choosing the setup by earned or by total return made no difference the next week (+2.27% vs +2.31%).
- **Liquidity:** last week's earned after costs is the best guide (the next week brought 0.77× of it, and 79% of pool-weeks were positive); choosing the range by it beat choosing by total return (+2.51% vs +2.21% the next week).
- Across all pools the next week's price moves averaged −1.8% (grid) and −1.5% (liquidity), while the earned figures were +2.3% and +2.5%: the price is a separate matter, which is why it isn't counted.
- Four weeks of one month: a lead, not a promise. A coin that swings hard can also fall hard, and a grid then ends up holding more of it (its *bought, not sold yet*).

**Follow the price up** (auto-recenter, `GridEngine.followUp`) is on for grids started from New bot and can be switched on any grid's page. When the price has stayed above the range for 2 h with every level sold (nothing held, queued or in flight), the range moves up around the price. The width, level count and amount stay the same, and trades and profit carry over. It moves at most once every 6 h. It **never moves down**: below the range the grid keeps what it bought and waits. Each move is logged and notified.

## Custom tokens + safety

Tools → Markets → *Add custom token*: pick a chain, paste an address, optionally pick the quote token (default: whichever of wrapped native / stables / existing tokens has the deepest pool).

1. **Metadata.** Code exists at the address; `decimals()` is **always read on-chain** (uint8 or uint256 return; missing / >36 refused; 0 and >18 warned; cached per chain+address; a mismatch with the stored market refuses to quote). `symbol()`/`name()` (bytes32 fallback), `totalSupply()`, `balanceOf()`. Proxies are flagged: EIP-1967 (incl. beacon), EIP-1822, OpenZeppelin legacy, EIP-1167 minimal proxies and small non-standard delegatecall proxies. Common views for `maxTxAmount` / `maxWallet` / `paused` / `tradingEnabled` / `isBlacklisted` are probed too.
2. **Pools.** V2 `getPair` on every V2 DEX, V3 `getPool` on every tier of every V3 DEX. Each pool shows TVL (valued at one reference price so a broken pool can't report a huge TVL), mid price and impact. Off-market pools are marked.
3. **Simulation.** A buy → wallet-to-wallet transfer → sell round trip runs through `eth_call` with a state override: a small probe contract (`contracts/SafetyProbe.sol`) is injected at a fixed address with ETH and executes the real router swaps. It measures buy, transfer and sell tax against the quotes, and detects honeypots (sell or transfer reverts). If the RPC rejects state overrides, every endpoint is tried and the result is *unknown*.
4. **Depth.** Buy/sell impact at $100, $500 and $1k.
5. **Risk badge.** `low` · `medium` (proxy, modest pool) · `high` (thin pool, $100 moves price >3%) · `blocked` · `unknown`.

**Fee-on-transfer policy: support on V2, prove-or-block on V3.** Buy / transfer / sell taxes are measured separately. On V2 forks (PulseX V1/V2, 9mm V2, Uniswap V2) a tax up to `MAX_TOKEN_TAX_PCT` (default 10%) per side is allowed live: swaps use the router's `*SupportingFeeOnTransferTokens` methods, `amountOutMin` is set **after** tax, both taxes are part of every cost / start / spacing / trend / backtest gate, and PnL is booked from the wallet's balance change (actual received). On V3, a taxed token is live only if the simulated buy → transfer → sell through that exact pool succeeded (`v3-proven`); otherwise paper-only. A tax above the cap, a honeypot, paused trading, or an unverifiable simulation is paper-only. While a bot runs on a custom token the tax test re-runs every `TAX_RECHECK_MIN` minutes (default 30) and immediately after a reverted swap or a fill short of the post-tax quote; a rising tax (or honeypot / pause) pauses every bot on that market with an alert. Tested in `tests/decimalsTaxes.test.ts` + `tests/multichain.test.ts`; on-chain, STA (Statera, Ethereum) is measured as a 1% tax token.

Custom markets persist in `data/custom.json` and work in grids, trend bots, backtests (GeckoTerminal with on-chain V2/V3 rebuild fallback), charts, market panels, alerts and analytics. **Re-check** re-runs the safety probe. **Remove** works once no bot or alert uses the market. A pool that is already a pair can't be added a second time (before, re-adding a coin's second pool made a duplicate pair).

## Pair search (every pair picker)

The pair picker in New bot (grid, trend, liquidity, presets), Backtest and Alerts is a search box (`PairPicker` in `src/ui/chains.tsx`, `src/server/market/poolSearch.ts`). Typing filters your pairs; from 2 letters, or a coin or pool address, it also lists pools DexScreener knows on the DEXes this app trades, deepest first, with their liquidity and 24-hour volume. Picking one runs the safety check and, if it passes, adds it as a pair and selects it.

- **Finding pools.** `/latest/dex/search` finds coins by symbol, name or address (30 pools across every chain DexScreener knows). The 3 best-matching coins on the app's chains then get all their pools from `/token-pairs/v1/{chain}/{coin}`: a search for "DAI" returned only 3 PulseChain pools out of 30, the rest Ethereum.
- **Only DEXes the app trades.** Each DEX has DexScreener's name for it (`DexConfig.screener`: `pulsex:v1`, `pulsex:v2`, `9mm:v2`, `9mm:v3`, `uniswap:v2`, `uniswap:v3`, `pancakeswap:v3`). Each was matched to the app's DEX by reading a pool's `factory()` on-chain (2026-10-22); pools of other DEXes (9inch, Liberty Swap, Uniswap V4 …) are left out. A V3 pool's fee tier is read on-chain (DexScreener doesn't give it).
- **Which way round.** Like a market: the quote is the chain's wrapped coin (shown as PLS / ETH, since markets trade it as the chain's own coin), else a stablecoin, else a coin of your pairs. A pool with neither is left out.
- **Names.** A coin the app knows keeps the app's name (bridged HEX shows as eHEX, though its `symbol()` says HEX). A coin the app doesn't know that uses a known coin's name is marked *same name as HEX, a different coin*: on 2026-10-22 a "HEX" at `0x55C5…12C6` traded on PulseX V2 and 9mm V3, and PulseChain's fork-copy DAI (`0x6B17…1d0F`) is a different coin from the bridged DAI your pairs use. Every row shows the coin's address.
- **Picking.** A pool that is already a pair just selects it (V3 by pool address, V2 by DEX and coin pair, so the built-in PulseX pairs are found too). Otherwise `POST /api/markets/pool` runs the same check as *Add custom token* (a simulated buy, transfer and sell) on exactly that pool: a honeypot, a tax over the cap or a coin that can't be checked is **not added** and the reason shows in the row. The liquidity form lists only V3 pools whose DEX has a verified position manager.
- **Requests.** One DexScreener answer is kept for 60 s (its own cache time). A 429 waits 1 s, then 2 s, then shows the error; the first request after a pause got one on 2026-10-22.
- **API.** `GET /api/pools/search?q=&chain=<id|all>` · `POST /api/markets/pool {chainId, pool, base, quote}`.
- **Checked.** `tests/poolSearch.test.ts` (DexScreener answers in their real shape): pools kept and left out, the way round, the V3 fee tier from the chain, a pool already a pair, known names and a copied name, the 60 s cache and the 429 waits, a pick added on exactly its pool, a honeypot not added. On real data (2026-10-22): "HEX" on PulseChain listed 25 pools across PulseX V1/V2 and 9mm V2/V3 with the built-in HEX pair matched; picking 9mm V3 HEX/WPLS added *HEX/PLS* (low risk, 6 s); its replay and a paper liquidity bot ran on it; switching its pool and removing it were refused while the bot held a position.

## Convert to one coin (Tools → Convert)

Swaps everything the wallet holds on one chain into a single coin: the chain's own coin or any coin of the app's markets there (`src/server/convert`, `src/market/convertRoute.ts`). **Check my coins** builds a plan and sends nothing; **Convert** sends it after a confirm.

- **Which coins.** The chain's own coin, its wrapped form (WPLS / WETH), every coin of the app's markets, and on PulseChain and Ethereum every ERC-20 the chain's Blockscout explorer lists for the wallet (`ChainConfig.tokenApi`). Robinhood's explorer blocks servers (Cloudflare challenge), so there only the app's market coins are listed. Every balance and every `decimals()` is read on-chain; the explorer only says where to look. A listed coin whose `balanceOf` or `decimals()` reverts is shown with the error and left alone; the rest of the plan goes ahead.
- **What's left alone, and why (shown under each coin):**
  - coins your **live bots** use (`MultiBot.allocations`: a grid's coins, a trend bot's cash and position, a liquidity bot's spare coins; a position's coins are in the pool, not the wallet);
  - **gas**: of the chain's own coin, *Keep for gas* stays (default twice the low-gas warning: 100,000 PLS, 0.001 ETH on Robinhood, 0.02 ETH on Ethereum);
  - coins **named like a website** (`https://…`, `www.`, `.com`, `.xyz`, `.gd` …): the scam-airdrop pattern that lures you to a wallet-draining site. Never quoted, never touched;
  - a coin the app doesn't know that **fails the safety check** (the same honeypot/tax simulation as *Add custom token*), or has no pool on a DEX the app trades;
  - a swap over **Max price impact** (default 3%);
  - **dust**: worth less than twice the gas of converting it.
- **Route.** Straight through one of the app's markets, else two swaps through a coin both sides trade against (the chain's own coin first): HEX → PLS → DAI. A coin the app doesn't know gets its best pool from the safety check. Wrapped native is unwrapped first (`withdraw`). Each route is quoted live for the plan: expected result, price impact and gas.
- **Running.** One coin at a time. Every transaction goes through the chain's transaction queue and nonce, the same ones the bots use, so the two never collide. Before each coin its amount is checked again: the balance now, less what bots use now, less the gas keep. Each swap is quoted again, and refused if the impact has gone over the cap. A coin's second swap spends what its first one actually returned. **Stop** leaves the coins not started yet. A coin whose first transaction is already out is finished all the way to the target, never left halfway in the middle coin. A plan expires after 10 minutes.
- **API.** `GET /api/convert/targets?chainId=` · `POST /api/convert/plan {chainId, target, keepNative?, maxImpact?}` · `POST /api/convert/run {planId, coins[]}` · `GET /api/convert/job` · `POST /api/convert/stop`.
- **Checked.** `tests/convert.test.ts`: routes, scam names, bots' coins, the impact cap, dust; a full run on the mock chain (unwrap, approve, both swaps, nonces in order); explorer decimals that disagree with the chain; a listed coin that reverts; a bot that takes a coin after the plan; Stop between coins and in the middle of one (on an unwrap, on an approve). Read-only against the real PulseChain wallet: the plan listed 10 coins, 7 were convertible, the website-named airdrop was skipped and two dust coins were skipped; the check took about 50 s.

## Friends' copies (Tools → Friends)

Friends get their own copy of the app on your computer and open it on their phone: their own bots, key, history and log-in (`src/server/friends`). Your app and your key are unchanged and stay on 127.0.0.1; friends only ever reach the friends' gateway.

**Set up (once, on your computer)**
1. `npm run friends:setup` adds `FRIENDS_SECRET` to `.env`. It locks friends' keys and signs their log-ins. Keep it: a new one makes the saved keys unreadable.
2. `npm run build`, then `npm start`. Friends' copies run from the built app; `npm run dev` leaves them off.
3. Install [Tailscale](https://tailscale.com/download) and log in, then run `tailscale funnel --bg 3850` once. It prints `https://<computer>.<tailnet>.ts.net`. Funnel needs HTTPS and the Funnel attribute turned on for your tailnet (the admin console asks the first time). See the [Funnel guide](https://tailscale.com/kb/1223/funnel).
4. Tools → Friends: your name and that address, then **Make invite link** and text it to the friend.

**A friend, on their phone**: opens the link, chooses a password, and pastes their key if they want to trade live (it can be added later under **Account**). Then they log in with their name and password; the page can be added to the home screen like an app. A forgotten password gets a **New password link** from you; their bots and key stay.

**How it is kept apart**
- **One process per friend**, in its own folder (`data/friends/<id>/`), running the same built server. Its environment is an allow-list (`SHARED_ENV` in `copies.ts`: chains, poll and safety settings) plus the friend's own key. Your `PRIVATE_KEY*`, `RPC_URL_*` (they can hold API keys) and `FRIENDS_SECRET` never reach it. Checked on a running copy: its whole environment was `CHAINS FRIEND_NAME HOST_NAME HOST_URL NODE_CHANNEL_* NODE_ENV PORT PRIVATE_KEY`.
- **Keys at rest**: AES-256-GCM under a key derived from `FRIENDS_SECRET` (in `.env`, not `data/`), each box bound to its friend. A key that is yours or another friend's is refused. The friend is told plainly that you run the computer that holds it.
- **The gateway** (port `FRIENDS_PORT`, default 3850, on 127.0.0.1 for Funnel to reach) serves log-in, invite and account pages and passes a logged-in friend to their own copy only. It drops the friend's cookie, Origin and forwarding headers, and refuses any change that doesn't come from your address. Log-ins are scrypt-hashed and last 30 days, in a signed cookie (HttpOnly, Secure, SameSite=Lax) that survives restarts. A name locks for 15 min after 5 wrong passwords, and all log-ins pause while more than 30 failed in the last minute. Invite links work once, for 7 days; only their hash is kept.
- **Restarts**: copies start with your app and their bots carry on; a crashed copy restarts after 2 s, backing off to 60 s. A copy stops when your app stops, even when it is killed (the IPC channel closes; checked with SIGKILL).
- **Live bots protect the key**: a friend can't change or remove their key while they have live bots, and you can't remove a friend whose copy has live bots, so no coins are left with a bot nobody runs.

**Shared, so friends don't multiply the load**: GeckoTerminal limits by IP, so a copy fetches candles through your app (`GET /api/host/gecko`, candle URLs only). There one client paces every call from this computer, and a request another copy just made comes from a cache (6 h for history, 60 s for the newest candles). While your daily scan runs, copies are told to wait. The Opportunities scan is yours: copies show it and can't start one. Each copy reads the chains through the public RPCs and keeps its own candles and pool histories.

**API (your app only)**: `GET /api/friends` · `PUT /api/friends/host {name?, address?}` · `POST /api/friends/invites {name}` · `DELETE /api/friends/invites/:id` · `POST /api/friends/:id/reset|start|stop|restart` · `DELETE /api/friends/:id`.

**Checked**: `tests/friends.test.ts` covers key boxes, invites (once, expiry), lockout, new-password links ending old log-ins, cookie forgery and expiry, a copy's environment, and the gateway (no log-in → /login or 401, the forwarded request is local with no cookie or Origin, changes from another site refused, the live stream passing through, a copy that is down). It also covers the relay (candle URLs only, cache, waits while the scan runs) and a copy's candles round-tripping through the relay route. In the sandbox, an end-to-end run on a 390 px phone screen: invite → sign up with a key → app → Account. The copy's environment was checked as above, your app was killed and restarted, and the copy came back with the friend still logged in.

## Chains, DEXes & sources (verified 2026-10-08)

Every address below was checked on-chain (code, `router.factory()`, `quoter.factory()`, token `symbol()`/`decimals()`, a live quote). `npm run check:onchain` re-runs all of it read-only. Nothing is guessed: chains or DEXes without an official deployment are left out or marked unavailable.

### PulseChain Mainnet — chain 369 · L1 · gas PLS · `RPC_URL_PULSECHAIN` / `PRIVATE_KEY_PULSECHAIN`

| Contract | Address | Fee |
|---|---|---|
| Wrapped native WPLS | `0xA1077a294dDE1B09bB078844df40758a5D0f9a27` | |
| DAI (18 dec) | `0xefD766cCb38EaF1dfd701853BFCe31359239F305` | |
| USDC (6 dec) | `0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07` | |
| USDT (6 dec) | `0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f` | |
| PulseX V2 factory | `0x29eA7545DEf87022BAdc76323F373EA1e707C523` | 0.29% |
| PulseX V2 router | `0x165C3410fC91EF562C50559f7d2289fEbed552d9` | |
| PulseX V1 factory | `0x1715a3E4A142d8b698131108995174F37aEBA10D` | 0.29% |
| PulseX V1 router | `0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02` | |
| 9mm V2 factory | `0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b` | 0.25% |
| 9mm V2 router | `0xcC73b59F8D7b7c532703bDfea2808a28a488cF47` | |
| 9mm V3 factory | `0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68` | tiers 100 / 500 / 2500 / 10000 / 20000 |
| 9mm V3 router (IV3SwapRouter: SwapRouter02 / SmartRouter) | `0xa9444246d80d6E3496C9242395213B4f22226a59` | |
| 9mm V3 QuoterV2 | `0x500260dD7C27eCE20b89ea0808d05a13CF867279` | |

RPC fallbacks: `https://rpc.pulsechain.com`, `https://pulsechain-rpc.publicnode.com`, `https://rpc-pulsechain.g4mm4.io` · explorer https://scan.pulsechain.com

Sources: [PulseChain docs](https://docs.pulsechain.com) · [PulseX docs](https://docs.pulsex.com) · [PulseX V1/V2 router + factory list (community PulseChain docs)](https://hexikani.github.io/pulsechain-docs/pulsex.html) · [PulseX V1 router on PulseScan (Official label)](https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02) · [9mm deployments (official GitHub): pulsechain/v2.json](https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json) · [9mm deployments (official GitHub): pulsechain/v3.json](https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json) · [PulseScan](https://scan.pulsechain.com) · [PulseX V2](https://scan.pulsechain.com/address/0x165C3410fC91EF562C50559f7d2289fEbed552d9) · [PulseX V1](https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02) · [9mm V2](https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json) · [9mm V3](https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json)

### Robinhood Chain — chain 4663 · Arbitrum/Orbit L2 · gas ETH · `RPC_URL_ROBINHOOD` / `PRIVATE_KEY_ROBINHOOD`

Arbitrum Orbit L2, mainnet since 2026-07-01, ETH gas. An Alchemy endpoint (needs your API key) can be added via RPC_URL_ROBINHOOD.

| Contract | Address | Fee |
|---|---|---|
| Wrapped native WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | |
| USDG (6 dec) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | |
| Uniswap V3 factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | tiers 100 / 500 / 3000 / 10000 |
| Uniswap V3 router (IV3SwapRouter: SwapRouter02 / SmartRouter) | `0xCaf681a66D020601342297493863E78C959E5cb2` | |
| Uniswap V3 QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | |
| Uniswap V2 factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` | 0.3% |
| Uniswap V2 router | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | |
| PancakeSwap V3 factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` | tiers 100 / 500 / 2500 / 10000 |
| PancakeSwap V3 router (IV3SwapRouter: SwapRouter02 / SmartRouter) | `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` | |
| PancakeSwap V3 QuoterV2 | `0x8553AA1615549A86882151784b329B017aA7c832` | |
| Built-in ETH/USDG pool (uniswap-v3, the chain's USD reference) | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` | 0.01% |
| Built-in NVDA/USDG · SPY/USDG · GOOGL/USDG · SPCX/USDG (uniswap-v3) | `0xd4EB…14a3` · `0xa7Bb…9167` · `0x34D0…19b7` · `0xc612…0029` | 0.05% |
| Built-in CRCL/USDG · USO/USDG (uniswap-v3) | `0x654E…95a8` · `0x0217…D915` | 0.3% |

The stock tokens are Robinhood-issued, upgradeable (EIP-1967 beacon) ERC-20s: risk **medium**, no tax, not paused, verified 2026-10-17 with the safety simulation. Like custom tokens they are re-checked before every live start and watched while bots run.

RPC fallbacks: `https://rpc.mainnet.chain.robinhood.com` · explorer https://robinhoodchain.blockscout.com

Sources: [Robinhood Chain — connecting (chain ID, RPC, explorer)](https://docs.robinhood.com/chain/connecting) · [Robinhood Chain — contracts (WETH, USDG)](https://docs.robinhood.com/chain/contracts) · [Uniswap v3 Robinhood deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments) · [Uniswap/contracts deployments/4663.md (v2 + v3)](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) · [PancakeSwap v3 addresses (Robinhood column)](https://developer.pancakeswap.finance/contracts/v3/addresses) · [Uniswap V3](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments) · [Uniswap V2](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) · [PancakeSwap V3](https://developer.pancakeswap.finance/contracts/v3/addresses)

### Ethereum — chain 1 · L1 · gas ETH · `RPC_URL_ETHEREUM` / `PRIVATE_KEY_ETHEREUM`

L1 gas makes small grids uneconomic: New bot will usually warn that each trade loses money.

| Contract | Address | Fee |
|---|---|---|
| Wrapped native WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | |
| USDC (6 dec) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | |
| USDT (6 dec) | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | |
| DAI (18 dec) | `0x6B175474E89094C44Da98b954EedeAC495271d0F` | |
| Uniswap V3 factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | tiers 100 / 500 / 3000 / 10000 |
| Uniswap V3 router (IV3SwapRouter: SwapRouter02 / SmartRouter) | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | |
| Uniswap V3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | |
| Uniswap V2 factory | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 0.3% |
| Uniswap V2 router | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` | |
| Built-in ETH/USDC pool (uniswap-v3, the chain's USD reference) | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | 0.05% |
| Built-in WBTC/USDT · WBTC/ETH · LINK/ETH (uniswap-v3) | `0x5653…83b2` · `0xe6ff…e718` · `0x5d4F…8c83` | 0.05% · 0.01% · 0.05% |
| Built-in PEPE/ETH · HEX/ETH (uniswap-v2) | `0xA43f…Ec9f` · `0x55D5…4DBa` | 0.3% |

Token pairs verified 2026-10-17 (deepest pool for a ≈$1,000 trade, decimals on-chain, safety simulation: risk low, no tax). /ETH pairs spend native ETH. Full addresses in `src/live/markets.ts`.

RPC fallbacks: `https://ethereum-rpc.publicnode.com`, `https://eth.drpc.org`, `https://cloudflare-eth.com` · explorer https://etherscan.io

Sources: [Uniswap v3 Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments) · [Uniswap v2 deployments](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments) · [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) · [Tether supported protocols](https://tether.to/en/supported-protocols) · [Uniswap V3](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments) · [Uniswap V2](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments)

## Strategies

A preset is a range and a level count per pair. It carries no amount: you enter how much of each pair's spend coin to use (New bot shows the wallet balance and a Max button per pair). The live check below used ≈$100 worth of each coin (100 DAI, 45k HEX, 120k eHEX, 14.5M PLSX, 10M PLS), the sample amounts in `npm run check:onchain`; at those sizes every preset clears the 2×0.29% LP fee (0.579%), price impact and gas.

| Preset | Params | Live check (Oct 2026): step / net per RT (worst level) |
|--------|--------|-----------------------------------|
| **Tight scalp** | Selected pair · ±8% · 12 grids | 1.25% / ~0.58% on DAI |
| **HEX / eHEX / PLSX** | Each · ±12% · 12 | 1.82% / ~1.2% |
| **HEX+eHEX+PLSX** | All three at once | same |
| **Stable ladder** | DAI+USDC · ±10% · 12 | 1.54% / ~0.88% DAI, ~0.79% USDC |
| **Stack HEX / PLSX / eHEX with PLS** ⇄ | Flipped (HEX/PLS …) · ±12% · 12 · spends PLS · best pool | 1.82% / ~1.20% HEX (PulseX V1), ~1.30% PLSX (9mm V3 0.25%), ~1.19% eHEX (PulseX V2) |

USDT was left out of the ladder when it traded on a PulseX V2 pool of about $1.5k per side, where impact at $8–20 per level (0.8–2.5% per round-trip) was bigger than the edge. Built-in stables trade on PulseX V1 since 2026-10-18 (about $228k USDT per side), so it could be added back.
`npm run check:onchain` re-checks every preset against live reserves (read-only).

## Orientation ⇄ (base/quote flip): start with only PLS, stack HEX

Every market trades either way round. Labels show the base first, plus what the bot spends and stacks.

| Orientation | Price | Capital | Buys / sells | PnL |
|---|---|---|---|---|
| **PLS/HEX** (classic, key `HEX`) | HEX per PLS | HEX | spend HEX for PLS / sell that PLS for HEX | HEX |
| **HEX/PLS** (flipped, key `HEX~`) | PLS per HEX | PLS | spend PLS for HEX / sell only that level's HEX lot for PLS | PLS (≈USD shown) |

- **How to start:** New bot → Grid → Custom → Pair **PLS/HEX** → press **⇄** → **HEX/PLS** · Spends: PLS · Stacks: HEX. The amount is entered in PLS.
  Or use the **Stack HEX with PLS** preset (also PLSX, eHEX): ±12% × 12 with the PLS amount you enter, checked on the best-quoting pool across PulseX V1/V2 and 9mm (the market switches to that pool, Auto mode, when started).
- **Gas reserve:** when the bot spends the gas token, a reserve is kept aside: max(2% of capital, fixed PLS). Set it in the form ("2%", "50000", or "3% 50000") or through the limits `gasReservePct` / `gasReserveNative`. A live start is blocked if capital + reserve (+ PLS other live bots already use) is more than the PLS balance.
- **Swaps:** PLS goes in as `msg.value` (`swapExactETHForTokens`) and comes out unwrapped (`swapExactTokensForETH`). Taxed tokens use the `…SupportingFeeOnTransferTokens` variants. On V3 the router wraps PLS from `msg.value` and unwraps with `unwrapWETH9`. Buys need no approval; sells approve the token.
- **Exact inversion:** amounts stay in each token's own units (HEX 8, PLS 18). Flipped prices come from on-chain quotes in the flipped direction, so they include the fee the other way and are not just 1/x. Candles are inverted (o=1/o, h=1/l, l=1/h, c=1/c; volume ÷ typical price). Charts, indicators, backtests, market panels, alerts, the cost gate, the start gate and the units guard all run on the flipped series.
- The flip toggle is on the pair picker in New bot, Backtest, Charts, Markets (per row and for all rows) and Alerts.
- **Existing grids keep their orientation.** Stored keys never contain `~`, so every saved grid/bot/alert loads exactly as before.
- **Custom markets** (e.g. `pulse:TOKEN/WPLS`) are already token-first: they spend WPLS and stack the token, and they trade WPLS as an ERC-20, as before. ⇄ turns them into WPLS/TOKEN. For these markets, keep **WPLS** (not native PLS) in the wallet. The gas reserve applies only to markets that spend native PLS or ETH.

## Trade sizes and profits

- **Every level gets an equal share:** amount ÷ levels (e.g. $500 over 10 levels = $50). The levels below the start price wait to buy. The ones at or above it get their coins from **one start-up buy** when the grid starts, so they sell as the price rises; on a live restart, coins the grid already holds are used first and only the rest is bought. If the price has already risen past those levels' first sell price when the start-up buy runs, it is skipped and they buy on the way back down. A start below the range is refused. "Follow the price up" does the same start-up buy for its new range.
- **Profits: reinvest (default)** adds each completed trade's profit (after fees and gas) to that level's next buy, so buys grow as the grid earns. **Send to an address** keeps buys the same size and sends the profit, in the spend coin, once what's waiting is worth at least 10× the transfer's gas (ERC-20 65k / native 21k gas). A sent transfer is tracked by hash and never resent until it's settled; a failed one is retried after 10 minutes. Paper mode only books it. Change it any time on the grid page.
- The backtester and the daily scan use the same rules (reinvest on), so their results match what a live grid would do.

## Profit check (never blocks)

New bot (custom range and every preset) and Change range show, for the **worst** interval, as one plain sentence plus a detail line:
- per-level size (amount ÷ levels)
- spacing %
- round-trip fee
- price impact at that size from current reserves
- gas in quote units: approve (exact mode) + 2 swaps at the current gas price
- **net profit per completed round-trip**

A grid that keeps under 0.25% of level size per round trip after this pool's fee, token tax, impact and gas is flagged ("each completed buy-then-sell loses about …" / "nets only …"), but it **starts anyway**, in paper and live alike, and carries that warning on its page. There is no fixed spacing floor: the old 1% floor was tuned for PulseX's 0.29% fee and flagged profitable grids on 0.01–0.05% Uniswap pools. Saved grids resume on load whatever their spacing.

What does stop a **live** start: not enough of the spend coin in the wallet for the amount, plus the gas set-aside when it spends PLS/ETH, plus what your running live bots already use. The message names all three in readable amounts (e.g. "needs 16.55M PLS (16.23M to trade + 324.5K kept for gas) and the wallet has 10.75M PLS").

## Fills and diagnostics

Each fill records:
- trigger price (`getPrice` at the cross)
- router quote price
- executed price from the receipt amounts (`*` = receipt log missing, `amountOutMin` used)
- slippage vs quote (+ = worse)
- gas in quote units
- LP fee
- for sells: the matched lot's cost and the **round-trip net** (proceeds − sell gas − lot cost)

Per-grid stats: round-trips, wins, average net per round-trip, total fees, total gas, average slippage.

Safety at execution:
- **Lot guard:** a grid sell is only sent if quoted proceeds − sell gas > that interval's lot cost. Otherwise it holds and re-arms.
- **Units guard:** if the router's **tax-free** pool price differs from spot by more than 1.5× (decimals or inversion bug), the trade is refused before signing. A 10% tax never trips it.
- **Decimals & taxes:** see *Custom tokens + safety* above. Every on-chain amount is a bigint in the token's own units; 0 / 6 / 8 / 9 / 18 / 24 decimals are covered by tests on both sides, both token orders, V2 and V3.
- Paper charges approve gas the same way live does.

PnL is shown in ≈USD (each bot's quote converted at today's rate), with the quote-token amount where no USD route exists.

## Multi-pair

- One grid per pair and range: PLS/DAI, PLS/USDC, PLS/USDT, **PLS/HEX**, **PLS/eHEX**, **PLS/PLSX**, the Ethereum and Robinhood markets, and custom tokens. Each has its own range, level count (2–50) and amount (entered in the coin it spends). The default custom range is ±8% × 12 (1.25% between levels).
- Per-grid **Stop** / **Resume**. **Stop all** halts every bot. One tx is in flight per chain.
- **Change range** (bot detail) restarts a stopped grid on its own pair and mode; the server refuses a pair change, and a live restart re-checks that the wallet covers it.
- State lives in `data/state.json` (all grids). A restart resumes them.
- Paper mode needs no key. Live needs `PRIVATE_KEY` in `.env` (never sent to the UI).

Limits: price-impact cap (≤5%), slippage, deadline. No dollar limits.

## System: version check and self-test

The pill in the top bar and **Tools → System** answer "is the app running the latest code, and is everything working?"

- **Version.** Four commits are compared: GitHub `main` (`git ls-remote`, using your own git access), your checkout (`git rev-parse HEAD`), the build (`dist/server/build.json`, written by `npm run build`) and the running server (the build it started from). The first gap is named with its exact fix: *Update available* → `git pull && npm install && npm run build` and restart; *Pulled but not built* → `npm run build` and restart; *Built but not restarted* → restart. It also notes a checkout that isn't on `main` or has hand-edited files.
- **Self-test** (`GET /api/system/check`):
  - Each chain's RPC is timed, and the wallet and gas are read.
  - Each running bot's pool is read the way a trade would read it.
  - Every bot is checked for: reading prices (no price for 3 polls = not ticking), errors, stuck transactions and range.
  - Grids are also checked for **levels that can never trade**: left empty by an older version, or whose start-up buy didn't happen. Each says where the grid trades next.
  - **GeckoTerminal 429s on this machine in the last hour** are counted. Trading never uses GeckoTerminal; charts and the daily scan do.

## Liquidity bot (V3 positions)

New bot → **Liquidity**, or **Try liquidity** on a pool in Opportunities (opens the form with that week's best range). Any pair on a V3 pool whose DEX has a verified position manager can hold one: Uniswap V3 on Ethereum (`0xC36442b4a4522E871399CD717aBDD847Ab11FE88`) and Robinhood (`0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`), 9mm V3 on PulseChain (`0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2`); each was checked on-chain (its `factory()` and `WETH9()` match the DEX). On PulseChain: type a coin in the form's pair picker (e.g. HEX) and pick a 9mm V3 pool (see *Pair search*). It becomes its own pair, so a grid on the coin's PulseX pair stays where it is.

- **The pool stays put while a position is in it.** A pair's pool can't be switched, and the pair can't be removed, while a liquidity bot on it holds a position: the position lives in that pool, and the bot reads the pair's pool. Before this, switching (by hand, or a PulseChain preset's best-pool switch) left the bot reading another pool's price and fees for its position, and removing the pair left a position the app could no longer close.

- **Open.** The amount is in the coin the bot spends, optionally plus base coins you already hold (*Also use ETH you hold*): only the difference to the range's mix at today's price is swapped (nothing when it's under 1% of the value), and a live start checks the wallet holds both. Then the position manager is approved for the ERC-20 side(s), and the position is minted. A native side (ETH, PLS) is paid with the tx value (`mint` + `refundETH`); enough of it for gas stays in the wallet (the gas set-aside when the bot spends the native coin, otherwise twice the open's gas).
- **Earn.** Fees owed come from the pool's own counters (fee growth inside the range), the same numbers `collect()` pays out. This was checked against `collect()` on live positions on all three chains.
- **Move the range (both ways).** Exit (`decreaseLiquidity` + `collect` + `burn` in one multicall), swap back to the mix, and open around the price.
  - **Auto-move (on by default):** as soon as the price is outside the range at a fresh reading, the range moves to the price at the same width. Off: it waits for the price to come back.
  - **By hand (the bot's page):** *Move to the price now*, or pick another width and *Change to ±X%*: the position is taken out and opened again around the price at that width (`POST /api/bot/lps/:id/move {bandPct}`). Only while it runs and no other step is under way.
  - **What a move costs:** gas to exit, approve and re-open, the swap back to the mix, and the coin mix it had becoming final (*lost to range moves*). Measured on Robinhood ETH/USDG (7 days to 2026-10-26, ±1%): gas for 23 moves was 1.12 USDG, the coin mix they locked in 84.23 USDG.
  - **Blocked:** a move whose swap would exceed the price-impact cap isn't started (it would stop halfway, out of the position); the page says why.
  - **Stale data:** a pool reading with lower fee counters than the last one (a node behind the chain) is skipped entirely.
- **Profits.** *Reinvest* (default) rolls fees into the next position when the range moves or the bot closes, with no extra transactions. *Send* collects fees to the payout address once they're worth 10× the collect's gas.
- **Money view** (state version 5, `LpEngine.pnl`):
  - **Fees earned** in the coins they were paid in (collected + waiting in the position).
  - **Costs:** gas, plus what the swaps to the range's mix lost to the pool fee and price impact.
  - **Lost to range moves:** inside the range the position sells the coin as it rises and buys it as it falls, so it ends up with more of whichever coin fell. Taking it out (to move the range, or to close) makes that final. This is what those coins were worth less than the ones put in, at the same price (`putIn` is saved at every open).
  - **Earned after costs** = fees − costs − lost to range moves, in the spend coin. The price move of coins still in the position isn't in it; it happens whether or not the bot runs.
  - **Liquidity provided:** the coins in the position now and its share of the pool's active liquidity, which is its share of every trade's fee (0 out of range; a paper position is added to the pool, as its fees are).
  - On Home, earned after costs counts as *Earned by trading*. There is no "vs holding" figure any more: it mixed the coin's price into the result.
  - **Bots from before version 5:** fees earned until then count in the spend coin; an open position's coins are taken at its next reading, and lost-to-moves counts from its next move or close.
- **What it would have earned last week (New bot → Liquidity).** The form replays the pool's own trades from the last 7 days through the bot's rules, for ranges ±1, 2, 3, 5, 8, 12 and 20% with moving on and off, at the amount you typed (or $1,000 of the spend coin). For each: earned after costs (total and per day), fees in each coin, costs, moves and what they lost, time in range, and the coins and pool share a position opened now with that money would have. Price moves are left out. The best row by earned after costs is starred; click a row to use it.
  - **Data:** every `Swap` event of the pool, folded into minutes (`src/server/lp/poolHistory.ts`, saved in `data/pool-history/<chain>-<pool>.json` and topped up on each request). A swap's fee is its amount in × the fee tier × the share liquidity providers keep, per unit of the pool's active liquidity at that swap. Checked against the live Robinhood ETH/USDG positions: fees within 0.4% swap by swap, about 5% folded into minutes; the saved minutes matched an independent download to 3 swaps in 184,017.
  - **Rules** (`src/market/lpReplay.ts`): the same as the bot. Fees while the price is inside the range; with moves on, the range moves to the price as soon as a minute ends outside it; a swap over the price-impact cap blocks the move. Gas is at today's price.
  - **Reading a busy pool takes minutes the first time:** Robinhood's ETH/USDG 0.01% pool had about 200,000 swaps a day (1.4 M in the 7 days); with the pacing below 2.7 M blocks took 5.5 minutes, so all 7 days take about 10. Requests go one at a time, 250 ms apart (on Robinhood they still make the RPC refuse some of the bots' reads for a few seconds, which the reader waits out: see *RPCs*); a 429 waits 1, 2, 4, 8, 16 s; a request with too many logs (Robinhood: over 10,000) asks for half the blocks. Later requests read only the new swaps, and the week already read is shown while they do (a history read to the head once says so in its file, so this holds after a restart; a first read stopped half way is finished before anything is shown).
  - **Not modelled:** your own position counts as other people's liquidity (on a pool you're a big part of, the replay's fee share comes out low), and price impact is worked out inside one tick range (low on a thin pool).
  - **What it showed on PulseChain (9mm V3 HEX/PLS 0.25%, 11,764 swaps in the 7 days to 2026-10-26, 189.5M PLS ≈ $1,000; LPs keep 0.68 of the fee; moving under the earlier rule, once the missed fees passed the move's cost — Auto-move now moves sooner, so more often):** the ±1% range that moved earned the most fees, 23.2M PLS (51,367 HEX + 11.9M PLS), and lost 45.2M PLS to its 27 moves: −29.7M PLS after costs. The best was ±3% staying put: +4.4M PLS (≈ $23) after costs, in range 23% of the time, 4.6% of the pool. Moving ranges lost in every width up to ±12%; ±20% never had to move (+2.6M PLS). Gas is about 300 PLS an open. One week of data: a lead, not a promise.
  - **What it showed (Robinhood ETH/USDG 0.01%, 1,234,950 swaps in the 7 days to 2026-10-26, 1,000 USDG; moving under the earlier rule, as above):** the ±1% range that moved earned the most fees, 70.38 USDG (0.0147 ETH + 35.12 USDG), and lost 84.23 USDG to its 23 moves: −16.22 USDG after costs. The same ±1% range staying put was the best: +27.24 USDG, though in range only 40% of the time; ±2% staying +24.04, ±5% +15.06 (it never had to move). Moving cost more than it won back at every width that moved.
- **Pause / Close / Remove.** Pause keeps the position open (still measured and earning, but not moved and no fees sent). Close takes everything out to the wallet. Remove only works once the position is closed.
- **Restarts.** Every on-chain step is saved with its tx hash before waiting for it. A restart settles that step by its receipt and never sends it twice. A step that reverts 3 times stops the bot, and nothing is lost: the coins are in the wallet or the position.
- **Paper.** Paper runs the same steps on a simulated position. It earns the pool's real global fee growth between two readings when the earlier one was in range, scaled by the share of the pool it would have been. That matches what a real position earns: on Oct 20 2026 the live ETH/USDG position earned 0.00854 USDG in two minutes in range, and the pool's global growth × its liquidity gave the same 0.00854.
  - Why not the pool's fee-inside counters: a paper position's range ticks usually don't exist in the pool, so they read 0 and never flip. Out of range, Uniswap's fee-inside formula then wraps to about 2^128 × liquidity. A paper ETH/USDG bot showed a value of about 10^48 USDG for the 8 minutes the price was below its range (Oct 20 2026, 01:10–01:18 UTC). Live positions mint their ticks and keep using the pool's own counters.
  - Paper bots saved before this fix start earning again from their next reading, and their value history starts over.

## Trend bot (long-only)

Trend bots run next to the grids (New bot → Trend bot; default 4h candles; the amount is entered in the coin it spends). They share the server, signing key, tx queue and nonce.

- **Strategies.** EMA cross, EMA+RSI, MACD, Donchian breakout and **my drawn lines**, plus an optional higher-timeframe EMA filter. Signals are evaluated once per newly closed candle, never on the forming one, so they don't repaint.
- **My drawn lines** (`strategy: 'lines'`, `cfg.lines`).
  - **Drawing:** click **Trend line** and two points, or **Level** and one price, on the chart in New bot, Backtest or a running bot's page. Each point lands exactly where you click or tap, between candles too (stored to the second), and the line follows the pointer while you draw. A channel is two trend lines; a zone is two levels.
  - **Moving:** drag a line to move it, or either end of a trend line to change its angle; levels move up and down. The chart doesn't pan during the drag, and a running bot saves once per drop (if the save fails, the line goes back).
  - **Rules:** each line gets one, chosen from where it's drawn and changeable in one click.
    - Buy when a candle closes above it (`buy_break`).
    - Buy when the price dips to it and closes back above (`buy_bounce`).
    - Sell when a candle closes below it (`sell_break`).
    - Sell when the price reaches it (`sell_reach`).
    - "Dips to" and "reaches" allow a touch distance, 0.2% by default.
  - **Look on the chart:** green lines buy, red lines sell; dashed lines need a touch, solid ones a close through.
  - **Shared rails:** the stop-loss, take-profit, trailing stop, sizing and cost check still apply.
  - **Running bots:** `PUT /api/bot/trends/:id/lines` replaces the lines, from the next closed candle.
  - **Backtests:** a trend line only trades from its later point (it couldn't have been drawn sooner); a level trades over the whole test. The result says that lines drawn today with hindsight look better in a backtest than they will live.
  - **How the chart handles it:** the chart paints the lines itself (a series primitive, `src/ui/drawnLines.ts`), so they follow every pan and zoom.
    - **Exact positions:** lightweight-charts only converts whole bars (`coordinateToLogical` rounds up to a bar; `logicalToCoordinate` returns 0 for a fraction). The position between two candles is worked out from the bar spacing (`logicalAt` / `timeAt` in `src/ui/lines.ts`).
    - **Placing points:** a point goes down on a press-and-release that didn't move, not on the click event. The chart drops a click that follows another within about half a second (measured in Chromium). On touch the browser's click never comes, because the chart cancels the tap.
    - **Minute refresh:** it updates the chart's data in place, so your zoom, pan and any drag survive it.
- **Exits.** ATR stop and TP at an R multiple, both checked on every poll price; trailing ATR stop (ratchets on closed highs); max hold; signal exit; cooldown; manual Close.
- **Sizing.** % of the bot's capital, or risk % (equity × risk ÷ stop distance).
- **Cost gate.** The expected move (TP distance, or k×ATR) must clear the 0.579% round-trip fee + impact both ways from live reserves + gas + slippage allowance + min edge. Blocked signals are logged with the numbers.
- **Safety checks.** The same units guard, impact cap, slippage, deadline and decimals handling as the grids. A broadcast tx is reconciled by hash.
- **Inventory.** Separate from the grids: a bot only spends its own cash and only sells PLS it bought. A live start checks that the address balance covers every live allocation (grids + trend bots).
- **State.** Persisted in `data/state.json` (v3; migrates v1/v2) and resumed on boot. Stop is per bot; Stop all stops grids and trend bots.

## Candles

| Source | How | Limits |
|---|---|---|
| GeckoTerminal (primary, background `CandleSync`) | `/networks/pulsechain/pools/{pool}/ohlcv`, per timeframe | Public API: documented 30 calls/min, but measured 2026-10-17 from a cloud IP at 6–7 requests then a 429, at both 2.5 s and 7 s spacing. Adaptive pace: 2.5 s to start, each 429 doubles the spacing (max 12 s) and waits 65 s, 20 successes in a row shorten it by 0.5 s. ≤1000 candles/call, ~6 months history. Disable with `CANDLES_GECKO=off`. |
| On-chain rebuild (fallback, trustless) | PulseX pair `Sync` (price) + `Swap` (volume) logs → 1m candles → all timeframes | Slow: 5k-block `eth_getLogs` chunks, about 10 min per 90 days on the public RPC. Block times are interpolated. |
| Live poll | each poll price updates the open candle of every timeframe | No volume |

- Prices use the grid's units: quote per PLS, sell side (× (1 − 0.29%)).
- Storage: `data/candles/<PAIR>.json`, capped per timeframe: 1m 3000 (~2 days), 5m 4000 (~14 days), 15m 4000 (~42 days), 1h 5000 (~208 days), 4h 3000, 1d 1500. Long history therefore lives in 1h and up.
- Gaps (no trades) are filled with flat candles (greyed in the chart).
- **What the background sync keeps:** every timeframe for pairs in use (a bot, an alert, or a chart opened in the last 30 min); only 1h / 4h / 1d for the rest (their 1m–15m candles build up from the live poll). A saved series recent enough for one refresh (100 candles) is not downloaded again after a restart. Measured (simulated clock): with all 19 built-in pairs synced on every timeframe the sync wanted ~20.5 GeckoTerminal requests a minute, nearly the whole ~24/min budget it shares with the daily scan, which then crawled through 429 back-offs; now ~0.7/min with nothing in use, ~2.8/min with two pairs in use.

```bash
npm run candles:backfill -- --pair DAI --days 90 --source onchain   # stop the server first
npm run candles:backfill -- --pair HEX --source gecko
```

Tools → Charts also has backfill buttons when a pair has no data.

## Backtester

- **No look-ahead.** A signal at close *i* fills at the open of *i+1*. Stop/TP are intrabar; a gap through the stop fills at the open; stop and TP in the same candle → stop.
- **Costs.** The pool's fee on every swap, plus price impact from the coins the pool holds near **today's** price, re-centred at each historical price. That's an approximation: for a trade bigger than the liquidity near the price, a V3 pool's real cost is higher than shown. Plus gas at today's gas price and 10 bps slippage.
- **Metrics.** **Earned by trading** (what the completed buy → sell trades made after every cost, in the coin; coins a grid still holds at the end aren't in it), return (the end value, price included), per-year return, worst drop, win rate, profit factor, average result per trade, Sharpe/Sortino, time holding, one trade's price impact, entries blocked by the gate, and the trade list. Every input and number has an ⓘ explaining it.
- **Where the result came from.** Price moves, pool fees, price impact, slippage and gas, in the coin. These are totalled over every swap, including buys of coins still held, and they add up to the result exactly.
- **Too big for this pool.** When one trade moves the price more than 2%, or is over a quarter of the coins the pool holds near the price, the result says so. It gives the size that keeps impact under 1%. Example (Oct 20 2026): 10,000 ETH (≈ $24M) in the WBTC/ETH 0.01% pool. That pool holds ≈ 2,600 ETH near the price, so one buy of the whole amount loses about 79% to impact. The real Uniswap quoter showed the pool runs dry after about 92 ETH's worth.
- **One-off price spikes are clipped** (`trimSpikes` in `src/market/candles.ts`, used by every backtest and the daily scan). One big trade in a thin pool prints a price far from the real one, and arbitrage puts the pool straight back within the block. A replay that fills there books trades no bot could have made. Each close is checked against its two neighbours: a jump that comes straight back is a print, a move that stays is real. The candle is then held within 20× the pair's usual hourly move (median close-to-close change) of that path. The result says how many candles were clipped, and the chart still shows them as printed.
  - Evidence (Oct 20 2026): the WBTC/ETH 0.01% pool's 2026-10-18 03:00 UTC candle printed a high of 42.67, +26% over the real market (Crypto.com ETH/BTC moved 0.2% that hour). 16 of that week's 169 hourly candles reached far outside the real range.
  - Every round trip the grid backtest showed was in one of those hours. The 10,000 ETH test went from −68.58% (20 phantom trades, each paying huge impact) to −32.63% with 0 trades: what's left is the start-up buy's impact. 1 ETH went from +18.96% to +0.83%.
  - The 20× limit comes from 44 real exchange series (BTC, ETH, SOL, DOGE, PEPE, LINK vs USDT, ETH/BTC and USDT/USD, 1m to 1D, 13,200 candles). They never reached past 17.7×, so no real candle is touched.
- **Sweep.** Two-parameter heatmap with an in-sample/overfitting warning. "Use these settings" starts a paper bot.
- **Grid configs.** Can be backtested too; fills at exact level prices are optimistic.

### Real backtest: PLS/DAI, Oct 8 2026

**Data.** On-chain rebuild of the PulseX V2 WPLS/DAI pair: blocks ~26.99M–27.74M, 66,551 1m candles. That gives 2,184 1h candles (Jul 9 04:00 → Oct 8 03:00 EDT, 1 empty hour) and 546 4h candles.

**Costs.** 0.29% fee/swap, impact from the current reserves (39.6k DAI / 4.39B PLS, about $79k liquidity), current gas, 10 bps slippage. Defaults: ATR14, stop 2×ATR, TP 2R, cooldown 2, 100% of capital.

| Strategy | $1,000 capital | $100 capital | $1,000, impact off |
|---|---|---|---|
| 1h EMA 9/21 | −55.8% (28 trades, PF 0.27, DD 59%) | −7.9% (36, PF 0.90) | +9.6% (36, PF 1.13) |
| 1h EMA+RSI | −58.1% | −17.1% | −2.6% |
| 1h MACD 12/26/9 | −77.9% | −37.6% | −14.4% |
| 1h Donchian 20/10 | −67.7% | −20.7% | −4.5% |
| 1h EMA + 4h HTF | −39.8% | −9.1% | +0.3% |
| 4h EMA 9/21 | −32.1% | +15.6% (13 trades, PF 1.25) | +25.4% |
| 4h Donchian 20/10 | −17.9% | +10.4% (7 trades, PF 1.36) | +14.8% |
| Buy & hold PLS | +44.8% (1h) / +52.9% (4h) | +48.9% / +57.3% | +49.3% / +57.8% |

**Takeaways.**
- At $1k, impact on this pool is about 2.5% per side, so each round trip costs about 5.8% and swamps the signal.
- At $100 (about 0.25% per side) only the 4h strategies made money, and none beat holding PLS in this up-trending window.
- The 1h EMA sweep's best cell at $100 (fast 20 / slow 80: +8.7%, 15 trades) is in-sample.
- `pool impact` is computed from today's reserves for all history.

### Candle data notes

- If GeckoTerminal and on-chain candles are both stored, the newest import wins for each candle. In testing, one GeckoTerminal 1h page (1000 candles) replaced on-chain candles; closes differed by 0.05–0.3% from the on-chain Sync price.
- A poll price more than 20% away from the last 1m close is ignored until 3 polls in a row confirm it. This guards candles and trend stops against bad RPC reads.

## Charts, analytics, engagement

- **Charts.** lightweight-charts v5 with pair/timeframe switches; EMA/Donchian/Bollinger overlays; RSI/MACD panes; grid levels and fills; trend entries/exits; stop/TP/trail lines; equity + drawdown per bot and for the whole portfolio. The last candle follows live ticks.
- **Analytics.** Portfolio ≈USD (live PLS/DAI cross), today/7d/all-time, vs HODL, allocation, funds coverage, per-bot stats, journal with filters and `/api/analytics/journal.csv`. Market panels show depth, volume, ATR%, trend and a regime hint (efficiency ratio).
- **Live.** Server-sent events (`/api/bot/stream`) with a 3 s polling fallback; Activity drawer; status dots that dim when a price read is stale; a short highlight when a fill lands. Routine price ticks update quietly.
- **Notifications and alerts.** Opt-in browser notifications (tab must be open). Alerts: price above/below, RSI above/below, grid out of range. All motion respects `prefers-reduced-motion`.

## Checks

```bash
npm test                # unit + integration (mocked chains: multi-DEX V2/V3 mock, PulseX mock)
npm run check:onchain   # read-only, no key: PulseChain presets; PulseX V1/V2 + 9mm V2/V3 (factory links, fee measured,
                        # tiers, quotes, best-pool + override per DEX); every chain (chainId, DEX contracts, default
                        # market price + L1 fee); custom tokens: PAXG + STA (1% tax) on Ethereum, PLSX on PulseChain;
                        # flipped HEX/PLS, PLSX/PLS, eHEX/PLS buy + sell quotes on the deepest pool (native legs) + Stack presets
npm run build
```

## Known limitations

- **Single-hop only.** Each market trades one pool directly, with no multi-hop routing or split orders. A best-quote pick is per market and is not re-evaluated on every trade (use Auto again, or the Pools view, to re-pick).
- **Fee-on-transfer tokens trade live on V2** (SupportingFee methods, min-out after tax, taxes in every gate, PnL from actuals) and on V3 only when proven. Rebasing tokens are not detected beyond the transfer test. Unusual maxTx / blacklist views may be missed.
- **Safety simulation needs `eth_call` state overrides.** Some public RPCs reject them; the token is then `unknown` (paper-only) until an RPC that supports them is configured.
- **Backtests** model V3 impact from today's virtual reserves of the active range only. Tick liquidity outside the range is not modelled.
- **GeckoTerminal** history depends on the pool being indexed. Otherwise the on-chain rebuild is used, which is slow on public RPCs.
- **The PulseX official docs site** could not be fetched from the build machine. PulseX V1 is backed by PulseScan's Official label, the shared deployer, a community docs mirror and on-chain checks.


## Verified quote tokens (mainnet)

| Symbol | Address | Dec | Pair used | Why |
|--------|---------|------|-----------|-----|
| HEX | `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | 8 | WPLS | ~35B WPLS depth; DAI pool ~$243 |
| eHEX | `0x57fde0a71132198BBeC939B98976993d8D89D225` | 8 | WPLS | ~14.5B WPLS; on-chain symbol is `HEX` |
| PLSX | `0x95B303987A60C71504D99Aa1b13B4DA07b0790ab` | 18 | WPLS | ~41B WPLS; DAI pool ~$18k |

Checked 2026-10-07 via `factory.getPair`, `symbol()`/`decimals()`, `getAmountsOut` on PulseX V2. Sources: PulseChain FAQ, PulseX docs, scan.pulsechain.com.
