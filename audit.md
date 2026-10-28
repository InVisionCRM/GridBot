# GridBot metric audit and v2 de-dup spec

Presentation only. Nothing in the classic desk is deleted. v2 (`src/v2`, default route) shows one home per metric. Classic stays at `/?classic=1`. Every money figure on a v2 screen is a field from the server payload. Views do not add, subtract, or extrapolate.

Numbers in the prototype are **demo data**.

## Where the same number shows up today

| Metric or section | Locations (screen > file) | Single home in v2 | Other copies |
| --- | --- | --- | --- |
| Net worth / book value | Home hero `src/ui/Home.tsx` (~106); header chip `src/ui/Header.tsx` (~141); Holdings | Home secondary line: `currentValueUsd` vs `capitalInUsd` | Header does not repeat it. Holdings and classic home stay on the classic route. |
| Portfolio P&L (several formulas) | Home strip `Home.tsx` (~65–67, ~134) via `totalPnlUsd` in `botRow.tsx`; bot row P&L $ and % `botRow.tsx` `pnlParts` (~59) and columns (~279); desk table `DeskTable.tsx` (~13) via `botFacts` in `deskStats.ts` (~158) | Home headline is live `generatedUsd`, labeled **Generated**, plus per-token chips. | P&L % is not shown. `totalPnlUsd` lives only in the breakdown sheet. |
| Bot profit / ROI / overall | Grid KPIs `GridDetail.tsx` (~251–269) plus `StatTable` (~246); LP KPIs and pace `LpDetail.tsx` (~109, ~191–219) plus `StatTable` (~225); trend profit and return `TrendDetail.tsx` (~86–90) plus `StatTable` (~101) | Bot page stat strip: generated token units, USD underneath. | Sheet holds price change, value versus deposited, and the cost breakdown. |
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

**Home.** Headline: live `generatedUsd`, label Generated. Under it, per-token chips from live bots. Paper generated dollars and paper chips are a separate row. Price change and value versus deposited are not on the hero. A generated-over-time curve is drawn only when the snapshot has real points. Strip: bots running / total. Each card: spark when fills exist, status ring, range track, **Generated** in token units, USD in small text. No second P&L.

**Bot.** Headline once: generated token units, USD underneath. APR is `generatedUsd / capitalInUsd`. D1, D7, and D365 are generation rates in token units, with USD in small text, and a dash until about 28 minutes, 3.2 hours, and 7 days. Chart only when candles exist. **Breakdown** sheet: `totalPnlUsd` = generated + price change, then price change, value, deposited, fees collected, fees owed, gas, swap fees, taxes, rebalance loss, and realized trade profit for non-LP. Also age, moves, fills, range numbers, APR, `calc`. LP sheet includes the range/compounding slot.

**Activity.** Feed of fills, re-centers, and fee lines. It does not repeat the headline.

**More.** Web Push slot. Links back into every classic screen (home, bots, holdings, smart trader, opportunities, new bot, analytics, alerts, chart, backtest, markets, system, convert, friends).

**Ticker.** Pair price and `change24h`. Not bot P&L.

## BotMetrics

Adapter: `adaptStatus()` in `src/v2/adapt-status.ts`. Typed shape: `src/v2/metrics.ts`. It is replaced by `GET /api/bot/:id/metrics` and `metrics` on `GET /api/bot/status` when that endpoint lands. The prototype reads `GET /api/v2/stream`.

Null means the figure was not in the payload. Percents are fractions. Estimates are token units plus a USD companion.

| Field | Role |
| --- | --- |
| generated, generatedUsd | Headline. Token units, dollars underneath. |
| headline | Always `'generated'`. |
| est.d1, d7, d365 | Same units scaled to the window. Null until ~28 min, ~3.2 h, and 7 days. |
| aprPct | `generatedUsd / capitalInUsd`. Not annualized. |
| priceChangeUsd, currentValueUsd, capitalInUsd | Breakdown only. |
| totalPnlUsd | `generatedUsd + priceChangeUsd` when both are known. Sheet only. |
| feesCollected, feesOwed, gasUsd, swapCostUsd, tokenTaxesUsd, realizedRebalanceLossUsd | Sheet. Taxes stay null when the payload has no tax field. |

Mapping from the current status payload (not invented):

- LP token units: fee coins in each token. Gas, swap fees, and rebalance loss are in the quote coin, so they come out of that leg. `generatedUsd` is engine `pnl.net` times `usdPerQuote`.
- Grid token units: `pnl.realized` in the quote coin. That figure is already net of pool fees and gas, so fees are not subtracted again. `generatedUsd` is realized times `usdPerQuote`.
- No dollar rate (`usdPerQuote` missing or not positive) leaves the dollar fields null.

Portfolio fields are not summed in the view. `PortfolioSnapshot` carries live `generatedUsd`, `paperGeneratedUsd`, `tokens`, `paperTokens`, and the context totals. `madeSeries` stays empty unless a real path exists. Fees today stays null: the snapshot has no single live-plus-LP figure for the day.

## Fields the screens need that BotMetrics does not have

- `range.tone`: `'in' | 'near' | 'out' | 'idle'`. `inRange` cannot say "near" without client math. Lives on `BotDesk`.
- Spark, candles, fills, grid levels, `flashLevel`, pair / chain / dex, tape `price` and `change24h`.
- Activity events.
- Portfolio snapshot above, including the made series and fees today.
- Connection stale flag (client, from the stream).
- Coin amounts, win rate, time in range, spacing, drawdown, profit factor, LP fee coins, pool share, position balances, gas-wallet balance, holdings net worth, opportunity expected %. Classic screens still show these from their own payloads. The contract is USD.

`change24h` is null when the snapshot has no 24h change. The tape then shows the price only. Activity clocks use America/Detroit.
