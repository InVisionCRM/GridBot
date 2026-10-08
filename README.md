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

- **Home**: total value, bot profit and what the same money would have made by just holding. Notices for anything that needs you (low gas, errors, a grid that left its range, a wallet that doesn't cover live bots). One row per bot with Stop / Resume.
- **New bot**: choose a grid or a trend bot. Grids start from a preset or a custom range; capital is entered in dollars. One sentence tells you what each completed buy-then-sell nets after fees, impact and gas. Paper / Live sits next to the Start button; live always asks first. Limits live under *Advanced*.
- **Bot detail**: profit vs holding, the chart (grid levels and fills, or the trend bot's entry / stop / take-profit lines), the bot's own log, levels, fills (compact, or *All columns*), and for grids **Change range**, which restarts a stopped grid on its own pair and mode.
- **Tools**: Charts, Backtest, Analytics, Markets (custom tokens, pool picker, chain registry) and Alerts.
- **Top bar**: chain filter (All / PLS / HOOD / ETH, with a dot when gas is low), signing address or *Paper only*, the Activity feed, the Guide, and **Stop all** (or *Stop all on* the filtered chain). Stopping never sells holdings.
- **Guide**: a short in-app explainer. Its numbers are imported from the code (fees, start-check thresholds, limits, preset params).

## Multi-chain

- **Chains.** PulseChain, Robinhood Chain and Ethereum are on by default. `CHAINS=ethereum` (for example) limits the set; PulseChain is always on. Bots, alerts and custom tokens saved for a chain that isn't loaded stay stopped and show as unavailable until you remove them.
- **RPCs.** `RPC_URL_<SLUG>` (comma-separated list allowed) comes first, then the built-in public fallbacks. On PulseChain the legacy `RPC_URL` also works. The reader rotates endpoints on transport errors and 429s, uses a 12 s timeout, and limits concurrency per chain. Simulations with state overrides try every endpoint, because support varies by RPC.
- **Keys.** One `PRIVATE_KEY` signs on every chain (same EVM address). The optional `PRIVATE_KEY_<SLUG>` (e.g. `PRIVATE_KEY_ETHEREUM`) overrides it for that chain. Keys are read only in `src/server/env.ts`, removed from `process.env` immediately, redacted from logs, and never sent to the UI (`tests/noSecrets.test.ts`).
- **Queues.** Each chain has its own `TxGate` + nonce queue, so chains trade in parallel while one chain never has two txs in flight. **Stop all** stops everything; with a chain selected it stops only that chain.
- **Gas.** The gas balance is polled per chain, with a warning in the feed when it drops below the chain's threshold (50k PLS; 0.01 ETH on Ethereum; 0.0005 ETH on Robinhood). Gas is converted to the market's base and quote units through the chain's native/USD market. On Robinhood (an Arbitrum Orbit L2) the cost and start gates add the L1 component from `NodeInterface.gasEstimateL1Component`.
- **Markets.** The key `chain:BASE/QUOTE` (e.g. `ethereum:ETH/USDC`) is used by every feature: grids, trend bots, backtests, charts, market panels, alerts, analytics and the journal. The existing PulseChain keys (`DAI`, `HEX`, …) and `data/state.json` load unchanged as chain 369.
- **UI.** The chain filter in the top bar applies to every screen. Chain badges and explorer links per chain. Tools → Analytics shows aggregated ≈USD with a per-chain breakdown. DEX/version + fee tags appear on each grid, trend bot, pool and fill.

## DEX adapters

One interface (`src/server/dex/types.ts`): `findPools`, `state`, `quote`, `buildSwap`.

- **V2** (`v2.ts`): `factory.getPair`, `getReserves`, `router.getAmountsOut`, `swapExact{ETHForTokens,TokensForETH,TokensForTokens}`. The fee is set per DEX (PulseX V1/V2 0.29%, 9mm V2 0.25%, Uniswap V2 0.30%). `check:onchain` measures each fee from reserves against `getAmountsOut`.
- **V3** (`v3.ts`): `factory.getPool` on every configured tier, then `slot0` + `liquidity`. Quotes come from **QuoterV2** `quoteExactInputSingle` at the real size. Swaps go through `multicall(deadline, …)` on SwapRouter02 / PancakeSwap-style SmartRouter (`exactInputSingle`, `exactInput` for paths, `unwrapWETH9` for native out). Tiers: Uniswap 100/500/3000/10000, PancakeSwap 100/500/2500/10000, 9mm 100/500/2500/10000/20000.
- The cost gate, start gate, trend cost gate and backtests use the market's real LP fee, the chain's gas units and price, the L1 data fee and the native→USD price.

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

## Custom tokens + safety

Tools → Markets → *Add custom token*: pick a chain, paste an address, optionally pick the quote token (default: whichever of wrapped native / stables / existing tokens has the deepest pool).

1. **Metadata.** Code exists at the address; `decimals()` is **always read on-chain** (uint8 or uint256 return; missing / >36 refused; 0 and >18 warned; cached per chain+address; a mismatch with the stored market refuses to quote). `symbol()`/`name()` (bytes32 fallback), `totalSupply()`, `balanceOf()`. Proxies are flagged: EIP-1967 (incl. beacon), EIP-1822, OpenZeppelin legacy, EIP-1167 minimal proxies and small non-standard delegatecall proxies. Common views for `maxTxAmount` / `maxWallet` / `paused` / `tradingEnabled` / `isBlacklisted` are probed too.
2. **Pools.** V2 `getPair` on every V2 DEX, V3 `getPool` on every tier of every V3 DEX. Each pool shows TVL (valued at one reference price so a broken pool can't report a huge TVL), mid price and impact. Off-market pools are marked.
3. **Simulation.** A buy → wallet-to-wallet transfer → sell round trip runs through `eth_call` with a state override: a small probe contract (`contracts/SafetyProbe.sol`) is injected at a fixed address with ETH and executes the real router swaps. It measures buy, transfer and sell tax against the quotes, and detects honeypots (sell or transfer reverts). If the RPC rejects state overrides, every endpoint is tried and the result is *unknown*.
4. **Depth.** Buy/sell impact at $100, $500 and $1k.
5. **Risk badge.** `low` · `medium` (proxy, modest pool) · `high` (thin pool, $100 moves price >3%) · `blocked` · `unknown`.

**Fee-on-transfer policy: support on V2, prove-or-block on V3.** Buy / transfer / sell taxes are measured separately. On V2 forks (PulseX V1/V2, 9mm V2, Uniswap V2) a tax up to `MAX_TOKEN_TAX_PCT` (default 10%) per side is allowed live: swaps use the router's `*SupportingFeeOnTransferTokens` methods, `amountOutMin` is set **after** tax, both taxes are part of every cost / start / spacing / trend / backtest gate, and PnL is booked from the wallet's balance change (actual received). On V3, a taxed token is live only if the simulated buy → transfer → sell through that exact pool succeeded (`v3-proven`); otherwise paper-only. A tax above the cap, a honeypot, paused trading, or an unverifiable simulation is paper-only. While a bot runs on a custom token the tax test re-runs every `TAX_RECHECK_MIN` minutes (default 30) and immediately after a reverted swap or a fill short of the post-tax quote; a rising tax (or honeypot / pause) pauses every bot on that market with an alert. Tested in `tests/decimalsTaxes.test.ts` + `tests/multichain.test.ts`; on-chain, STA (Statera, Ethereum) is measured as a 1% tax token.

Custom markets persist in `data/custom.json` and work in grids, trend bots, backtests (GeckoTerminal with on-chain V2/V3 rebuild fallback), charts, market panels, alerts and analytics. **Re-check** re-runs the safety probe. **Remove** works once no bot or alert uses the market.

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
| Default market ETH/USDG pool (uniswap-v3) | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` | 0.01% |

RPC fallbacks: `https://rpc.mainnet.chain.robinhood.com` · explorer https://robinhoodchain.blockscout.com

Sources: [Robinhood Chain — connecting (chain ID, RPC, explorer)](https://docs.robinhood.com/chain/connecting) · [Robinhood Chain — contracts (WETH, USDG)](https://docs.robinhood.com/chain/contracts) · [Uniswap v3 Robinhood deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments) · [Uniswap/contracts deployments/4663.md (v2 + v3)](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) · [PancakeSwap v3 addresses (Robinhood column)](https://developer.pancakeswap.finance/contracts/v3/addresses) · [Uniswap V3](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments) · [Uniswap V2](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md) · [PancakeSwap V3](https://developer.pancakeswap.finance/contracts/v3/addresses)

### Ethereum — chain 1 · L1 · gas ETH · `RPC_URL_ETHEREUM` / `PRIVATE_KEY_ETHEREUM`

L1 gas makes small grids uneconomic — the start gate will usually block them.

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
| Default market ETH/USDC pool (uniswap-v3) | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | 0.05% |

RPC fallbacks: `https://ethereum-rpc.publicnode.com`, `https://eth.drpc.org`, `https://cloudflare-eth.com` · explorer https://etherscan.io

Sources: [Uniswap v3 Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments) · [Uniswap v2 deployments](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments) · [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) · [Tether supported protocols](https://tether.to/en/supported-protocols) · [Uniswap V3](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments) · [Uniswap V2](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments)

## Strategies

Every preset is net-positive per completed round-trip after the 2×0.29% LP fee (0.579%), price impact at the
level size from current pool reserves, and gas. There is no tight-spacing override. Capital is in **USD** and is
converted to quote units from live prices.

| Preset | Params | Live check (Oct 2026): step / net per RT (worst level) |
|--------|--------|-----------------------------------|
| **Tight scalp** | Selected pair · ±8% · 12 grids · $100 | 1.25% / ~0.58% on DAI |
| **HEX / eHEX / PLSX** | Each · ±12% · 12 · $100 (≈45k HEX / ≈120k eHEX / ≈14.5M PLSX) | 1.82% / ~1.2% |
| **HEX+eHEX+PLSX** | All three at once, $100 each | same |
| **Stable ladder** | DAI+USDC · ±10% · 12 · $50 each | 1.54% / ~0.88% DAI, ~0.79% USDC |
| **Stack HEX / PLSX / eHEX with PLS** ⇄ | Flipped (HEX/PLS …) · ±12% · 12 · $100 → ≈11.6M PLS · best pool | 1.82% / ~1.20% HEX (PulseX V1), ~1.30% PLSX (9mm V3 0.25%), ~1.19% eHEX (PulseX V2) |

USDT is left out of the ladder because its WPLS pool is only about $1.5k per side. At $8–20 per level, impact (0.8–2.5% per round-trip) is bigger than the edge.
`npm run check:onchain` re-checks every preset against live reserves (read-only).

## Orientation ⇄ (base/quote flip): start with only PLS, stack HEX

Every market trades either way round. Labels show the base first, plus what the bot spends and stacks.

| Orientation | Price | Capital | Buys / sells | PnL |
|---|---|---|---|---|
| **PLS/HEX** (classic, key `HEX`) | HEX per PLS | HEX | spend HEX for PLS / sell that PLS for HEX | HEX |
| **HEX/PLS** (flipped, key `HEX~`) | PLS per HEX | PLS | spend PLS for HEX / sell only that level's HEX lot for PLS | PLS (≈USD shown) |

- **How to start:** New bot → Grid → Custom → Pair **PLS/HEX** → press **⇄** → **HEX/PLS** · Spends: PLS · Stacks: HEX. Capital is entered in dollars and converted to PLS.
  Or use the **Stack HEX with PLS** preset (also PLSX, eHEX): ±12% × 12, $100 converted to PLS, checked on the best-quoting pool across PulseX V1/V2 and 9mm (the market switches to that pool, Auto mode, when started).
- **Gas reserve:** when the bot spends the gas token, a reserve is kept aside: max(2% of capital, fixed PLS). Set it in the form ("2%", "50000", or "3% 50000") or through the limits `gasReservePct` / `gasReserveNative`. A live start is blocked if capital + reserve (+ PLS other live bots already use) is more than the PLS balance.
- **Swaps:** PLS goes in as `msg.value` (`swapExactETHForTokens`) and comes out unwrapped (`swapExactTokensForETH`). Taxed tokens use the `…SupportingFeeOnTransferTokens` variants. On V3 the router wraps PLS from `msg.value` and unwraps with `unwrapWETH9`. Buys need no approval; sells approve the token.
- **Exact inversion:** amounts stay in each token's own units (HEX 8, PLS 18). Flipped prices come from on-chain quotes in the flipped direction, so they include the fee the other way and are not just 1/x. Candles are inverted (o=1/o, h=1/l, l=1/h, c=1/c; volume ÷ typical price). Charts, indicators, backtests, market panels, alerts, the cost gate, the start gate and the units guard all run on the flipped series.
- The flip toggle is on the pair picker in New bot, Backtest, Charts, Markets (per row and for all rows) and Alerts.
- **Existing grids keep their orientation.** Stored keys never contain `~`, so every saved grid/bot/alert loads exactly as before.
- **Custom markets** (e.g. `pulse:TOKEN/WPLS`) are already token-first: they spend WPLS and stack the token, and they trade WPLS as an ERC-20, as before. ⇄ turns them into WPLS/TOKEN. For these markets, keep **WPLS** (not native PLS) in the wallet. The gas reserve applies only to markets that spend native PLS or ETH.

## Economics gate (pre-start)

New bot (custom range and every preset) shows, for the **worst** interval, as one plain sentence plus a detail line:
- per-level size
- spacing %
- round-trip fee
- price impact at that size from current reserves
- gas in quote units: approve (exact mode) + 2 swaps at the current gas price
- **net profit per completed round-trip**

Required: spacing ≥ 1.0% **and** net ≥ 0.25% of level size.

- **Live:** hard block, no override (server-side, in `GridEngine.start`).
- **Paper:** blocked unless you tick *Simulate anyway* under Advanced; the grid then carries a `PAPER ONLY` warning.
- **Legacy live grids:** a live grid saved before this gate with spacing under 1.0% (e.g. the old ±2.5%×36 tight scalp) is stopped on load and cannot be resumed.

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

- One grid per pair and range: PLS/DAI, PLS/USDC, PLS/USDT, **PLS/HEX**, **PLS/eHEX**, **PLS/PLSX**, the Ethereum and Robinhood markets, and custom tokens. Each has its own range, level count (2–50) and capital (entered in dollars, converted to the quote token at today's rate). The default custom range is ±8% × 12 (1.25% between levels).
- Per-grid **Stop** / **Resume**. **Stop all** halts every bot. One tx is in flight per chain.
- **Change range** (bot detail) restarts a stopped grid on its own pair and mode; the server refuses a pair change, and a live restart re-checks that the wallet covers it.
- State lives in `data/state.json` (all grids). A restart resumes them.
- Paper mode needs no key. Live needs `PRIVATE_KEY` in `.env` (never sent to the UI).

Limits: price-impact cap (≤5%), slippage, deadline. No dollar limits.

## Trend bot (long-only)

Trend bots run next to the grids (New bot → Trend bot; default 4h candles, $100). They share the server, signing key, tx queue and nonce.

- **Strategies.** EMA cross, EMA+RSI, MACD, Donchian breakout, plus an optional higher-timeframe EMA filter. Signals are evaluated once per newly closed candle, never on the forming one, so they don't repaint.
- **Exits.** ATR stop and TP at an R multiple, both checked on every poll price; trailing ATR stop (ratchets on closed highs); max hold; signal exit; cooldown; manual Close.
- **Sizing.** % of the bot's capital, or risk % (equity × risk ÷ stop distance).
- **Cost gate.** The expected move (TP distance, or k×ATR) must clear the 0.579% round-trip fee + impact both ways from live reserves + gas + slippage allowance + min edge. Blocked signals are logged with the numbers.
- **Safety checks.** The same units guard, impact cap, slippage, deadline and decimals handling as the grids. A broadcast tx is reconciled by hash.
- **Inventory.** Separate from the grids: a bot only spends its own cash and only sells PLS it bought. A live start checks that the address balance covers every live allocation (grids + trend bots).
- **State.** Persisted in `data/state.json` (v3; migrates v1/v2) and resumed on boot. Stop is per bot; Stop all stops grids and trend bots.

## Candles

| Source | How | Limits |
|---|---|---|
| GeckoTerminal (primary, background `CandleSync`) | `/networks/pulsechain/pools/{pool}/ohlcv`, per timeframe | Public API: 30 calls/min, ≤1000 candles/call, ~6 months history. 429 → 65 s backoff. Disable with `CANDLES_GECKO=off`. |
| On-chain rebuild (fallback, trustless) | PulseX pair `Sync` (price) + `Swap` (volume) logs → 1m candles → all timeframes | Slow: 5k-block `eth_getLogs` chunks, about 10 min per 90 days on the public RPC. Block times are interpolated. |
| Live poll | each poll price updates the open candle of every timeframe | No volume |

- Prices use the grid's units: quote per PLS, sell side (× (1 − 0.29%)).
- Storage: `data/candles/<PAIR>.json`, capped per timeframe: 1m 3000 (~2 days), 5m 4000 (~14 days), 15m 4000 (~42 days), 1h 5000 (~208 days), 4h 3000, 1d 1500. Long history therefore lives in 1h and up.
- Gaps (no trades) are filled with flat candles (greyed in the chart).

```bash
npm run candles:backfill -- --pair DAI --days 90 --source onchain   # stop the server first
npm run candles:backfill -- --pair HEX --source gecko
```

Tools → Charts also has backfill buttons when a pair has no data.

## Backtester

- **No look-ahead.** A signal at close *i* fills at the open of *i+1*. Stop/TP are intrabar; a gap through the stop fills at the open; stop and TP in the same candle → stop.
- **Costs.** 0.29% fee per swap, impact from the **current** reserves re-centred at each historical price (an approximation), gas at today's gas price, 10 bps slippage.
- **Metrics.** Return vs buy & hold PLS (same costs), CAGR, max DD, win rate, PF, expectancy, Sharpe/Sortino, exposure, fees/gas, entries blocked by the gate, plus the trade list.
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
