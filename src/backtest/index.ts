/** Public entry for the harness and for a router that scores opportunities. */
export { scoreOpportunity, quantile, maxCapitalWhereMarginalHolds, CAPITAL_MULTIPLIERS, type OpportunityScore, type ScoreRange, type CapitalPoint } from './score';
export { runBot, liveEngines, minutesFromCandles, type BotConfig, type HarnessData, type EngineDeps, type TokenRef } from './run';
export { renderMarkdown, summaryJson, unlabeledNumberLines, fmt, signed, windowFootnote, DEFAULT_WINDOW_DAYS, type BotSummary, type RunWindow, type SimFill } from './report';
export { loadAppState, calibrateBot, calibrationMarkdown, stripCredentials, defaultBots, NO_STATE_NOTE, STATE_NOTE, EMPTY_STATE_NOTE, type StateLoad, type SavedBot, type Calibration, type RecordedFill } from './state';
export { DEFAULT_FEE_K, lpShareForFeeTier, candleLpFees } from './feeModel';
export { GAS_UNITS, gasNative, gasQuote } from './gasModel';
export { loadCandles, readV3Pool, readGasPrice, decodeV3Snapshot, parseGeckoOhlcv, parseDexscreenerOhlcv, diskCache } from './adapters';
