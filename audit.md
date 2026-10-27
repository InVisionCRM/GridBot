# GridBot metric audit and v2 de-dup spec

Presentation only. Nothing in the classic desk is deleted. v2 (`src/v2`, default route) shows one home per metric. Classic stays at `/?classic=1`. Every money figure on a v2 screen is a field from the server payload. Views do not add, subtract, or extrapolate.

Numbers in the prototype are **demo data**.

## Where the same number shows up today

| Metric or section | Locations (screen > file) | Single home in v2 | Other copies |
| --- | --- | --- | --- |
| Net worth / book value | Home hero `src/ui/Home.tsx` (~106); header chip `src/ui/Header.tsx` (~141); Holdings | Home secondary line: `currentValueUsd` vs `capitalInUsd` | Header does not repeat it. Holdings and classic home stay on the classic route. |
| Portfolio P&L (several formulas) | Home strip `Home.tsx` (~65–67, ~134) via `totalPnlUsd` in `botRow.tsx`; bot row P&L $ and % `botRow.tsx` `pnlParts` (~59) and columns (~279); desk table `DeskTable.tsx` (~13) via `botFacts` in `deskStats.ts` (~158) | Home headline is portfolio `dollarsMadeUsd` (live). Label **Dollars made**. | P&L % is not shown. `totalPnlUsd` lives only in the bot breakdown sheet. |
| Bot profit / ROI / overall | Grid KPIs `GridDetail.tsx` (~251–269) plus `StatTable` (~246); LP KPIs and pace `LpDetail.tsx` (~109, ~191–219) plus `StatTable` (~225); trend profit and return `TrendDetail.tsx` (~86–90) plus `StatTable` (~101) | Bot page stat strip: `dollarsMadeUsd`, labeled **Dollars made** / **Made** | Sheet holds the cost breakdown. Estimates are not repeated under the chart. |
| Fees today | Home strip `Home.tsx` (~140); `feesTodayUsd` sums `trade.feeQuote` since midnight in `botRow.tsx` | Home strip only: `feesTodayLiveUsd`, with paper on a smaller line | Not on cards, not the headline. |
| Fees, gas, swap, rebalance | Grid fee KPI; LP costs and move loss; trend fees+gas; StatTable fees earned / fees paid; desk Fees column | Breakdown sheet | Cards and the strip do not list them. |
| Estimates and APR | StatTable est. 24h / 7d / 365d (`StatTable.tsx` ~41); desk Est. APR is `est.d365.pct` (`botRow.tsx` ~286), not a simple APR | Bot strip once: `aprPct`, `est.d1`, `est.d7`, `est.d365` | Sheet may show APR again as a line in the breakdown (the strip is the home of the three estimates). |
| Age, moves, fills, range numbers | Desk columns; StatTable; detail subtitles; range bar `charts.tsx` | Range **picture** once (`RangeTrack` / chart band). Numeric bounds, age, moves, fills in the sheet | `range.tone` is a server hint. The view does not decide "near". |
| Analytics portfolio | `Analytics.tsx` (~110–153): equity, capital, realized, unrealized, return %, fees, gas | Classic analytics, reached from More | Not folded into the v2 headline. |
| Smart trader / token gain, opportunities expected %, backtest | `SmartTrader.tsx`, `TokenTrader.tsx`, `Opportunities.tsx`, `Backtest.tsx` | Stay on classic. They are not bot dollars made | Unchanged, reachable from More. |

Client formulas that disagree with each other (classic only; v2 does not use them):

- `pnlParts`: grid realized+unrealized, trend `returnPct`, LP `pnl.net` / capital, trader `pnlUsd` / `spentUsd`.
- `botFacts`: LP realized = `pnl.net`, unrealized = `pnl.price`; estimates scale that P&L (`extrapolate` in `deskStats.ts`).
- Home "30d P&L" switches label from the equity span, not from a server field.
- `rangeTone()` in `charts.tsx` infers near-edge on the client.

## Per screen (v2)

**Home.** Headline: live `portfolio.dollarsMadeUsd`, label Dollars made, rolling. Under it, smaller: `priceChangeUsd`, then value `currentValueUsd` and deposited `capitalInUsd` (both shown, not subtracted here). Paper dollars made is a separate smaller line. Equity curve is `madeSeries`. Strip, once: fees today (live, paper beside it) and bots running / total. Each card: spark, status ring, range track, **Made** = that bot's `dollarsMadeUsd`, then price change and value vs deposited. No ROI, no second P&L, no fees, age, or estimates.

**Bot.** Same headline once in the stat strip, plus the two secondary lines. APR and est. d1 / d7 / d365 once, from the payload (based on dollars made; dash until `est.needs` says there is enough history). Chart and one range track. **Breakdown** sheet: `totalPnlUsd` = dollars made + price change, then fees collected, fees owed, gas, swap fees, taxes, rebalance loss, and realized trade profit for non-LP. Also age, moves, fills, range numbers, APR, `calc` tooltip. LP sheet includes the range/compounding slot. Estimates are not copied into the sheet.

**Activity.** Feed of fills, re-centers, and fee lines. It does not repeat the headline.

**More.** Web Push slot. Links back into every classic screen (home, bots, holdings, smart trader, opportunities, new bot, analytics, alerts, chart, backtest, markets, system, convert, friends).

**Ticker.** Pair price and `change24h`. Not bot P&L.

## BotMetrics

Server stand-in: `settle()` in `src/v2/demo-book.ts`. Typed shape: `src/v2/metrics.ts`. Intended production home (not in this branch): `src/metrics/botMetrics.ts`, on each bot in `GET /api/bot/status`, and `GET /api/bot/:id/metrics`. The prototype reads `GET /api/v2/stream` (SSE `snapshot`, then `delta`).

USD unless noted. Percents are fractions. `est.*` are USD or null.

| Field | Role |
| --- | --- |
| botId, mode, kind, status, startedAt, ageSec | Identity and age. |
| capitalInUsd, currentValueUsd | Secondary line. Both displayed. |
| realizedUsd | Realized trade profit. Grid, trend, token input. Shown in the sheet for those kinds. |
| unrealizedUsd | Kept on the payload. v2 shows `priceChangeUsd` instead. They can differ. |
| feesEarnedUsd, feesCollectedUsd, feesUncollectedUsd | Fees owed = uncollected. LP dollars made uses collected + uncollected. |
| gasUsd, swapCostUsd, tokenTaxesUsd, realizedRebalanceLossUsd | Costs. All shown in the sheet. |
| priceChangeUsd | Secondary line under the headline. |
| dollarsMadeUsd | **Headline everywhere.** |
| headline | Always `'dollarsMade'`. |
| totalPnlUsd | `dollarsMadeUsd + priceChangeUsd`. Sheet only. |
| totalPnlPct | Stored. Not shown (avoids a second ROI / P&L % label). |
| aprPct | Simple APR on dollars made. Null until age ≥ 60s and capital > 0. Not compounded. |
| est.d1, est.d7, est.d365, est.needs | Dollars made scaled to the window. Null until age ≥ 60s. |
| moveCount, fillCount | A re-center counts as one move. Fills are separate. |
| range { lower, upper, current, inRange } or null | Band and track. |
| asOf, calc | Freshness and the formula tooltip. |

Formulas, applied only in `settle()`:

- LP: `feesCollectedUsd + feesUncollectedUsd − gasUsd − swapCostUsd − tokenTaxesUsd − realizedRebalanceLossUsd`.
- Grid, trend, token: `realizedUsd − feesCollectedUsd − gasUsd − tokenTaxesUsd`.
- `totalPnlUsd = dollarsMadeUsd + priceChangeUsd`.
- APR: `(dollarsMadeUsd / capitalInUsd) * (365 days / ageSec)` when age ≥ 60s.
- Estimates: `dollarsMadeUsd * (window / ageSec)` for 1, 7, and 365 days. Otherwise null.

Rolling counters and the fee-accrual tween animate `dollarsMadeUsd`. The demo clock emits a new server value; `RollingUsd` only tweens the label. An LP with `range.inRange === false` does not accrue fees.

Portfolio fields are **not** on the per-bot object. Home must not sum bots. `PortfolioSnapshot`: `dollarsMadeUsd` (live), `paperDollarsMadeUsd`, `priceChangeUsd`, `currentValueUsd`, `capitalInUsd`, `feesTodayLiveUsd`, `feesTodayPaperUsd`, `botsRunning`, `botsTotal`, `madeSeries`.

## Fields the screens need that BotMetrics does not have

- `range.tone`: `'in' | 'near' | 'out' | 'idle'`. `inRange` cannot say "near" without client math. Lives on `BotDesk`.
- Spark, candles, fills, grid levels, `flashLevel`, pair / chain / dex, tape `price` and `change24h`.
- Activity events.
- Portfolio snapshot above, including the made series and fees today.
- Connection stale flag (client, from the stream).
- Coin amounts, win rate, time in range, spacing, drawdown, profit factor, LP fee coins, pool share, position balances, gas-wallet balance, holdings net worth, opportunity expected %. Classic screens still show these from their own payloads. The contract is USD.

`unrealizedUsd` remains on the object and is not the secondary line. `totalPnlPct` is stored and not labeled.
