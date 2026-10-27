/**
 * Per-day figures only for bots that have run at least a day.
 *
 * A rate from a short run says little: STONKD LP #2 showed about −2,361 USDG a day from an 8.8-hour paper run. Under a
 * day, the page shows the net for the run with its length instead ("−866 USDG over 8.8h"). Display only: the numbers
 * behind it (API fields, estimates, sorting) are unchanged.
 *
 * "Ran" is the bot's age since its current run started: `startedAt` (`openedAt` for token-trader positions), which a
 * Start or Restart sets and a Resume keeps. It is the same span every per-day figure on the page already divides by, so
 * the cut-off and the rate always agree. Bots don't store their accumulated running time (stopped spells excluded), so
 * that can't be used.
 */

export const DAY_MS = 86_400_000;

/** A run length that is missing, zero, negative or not a number: there is no rate and no length to show. */
const known = (ms: number | null | undefined): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

/** Under a day (or unknown): show the net for the run, not a per-day figure. */
export function isShortRun(runMs: number | null | undefined): boolean {
  return !known(runMs) || runMs < DAY_MS;
}

/** "45m", "8.8h", "1.5d". Rounded down, so a run just under a day never reads as a day. */
export function runLength(ms: number): string {
  if (ms < 60_000) return '<1m';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < DAY_MS) return `${(Math.floor(ms / 360_000) / 10).toFixed(1)}h`;
  return `${(Math.floor(ms / 8_640_000) / 10).toFixed(1)}d`;
}

/** What follows the net for a run under a day: "over 8.8h", or "so far" when the run length is unknown. */
export function runSpan(runMs: number | null | undefined): string {
  return known(runMs) ? `over ${runLength(runMs)}` : 'so far';
}

/**
 * The figure for a bot's net over its run:
 * - run of a day or more → `rate(net per day)` (the caller's per-day text, e.g. "−2,361 USDG a day");
 * - under a day → "<net> over <length>";
 * - run length 0 or missing → "<net> so far".
 * A missing net is "—".
 */
export function rateOrRun(net: number | null | undefined, runMs: number | null | undefined, fmtNet: (x: number) => string, rate: (perDay: number) => string): string {
  if (typeof net !== 'number' || !Number.isFinite(net)) return '—';
  if (isShortRun(runMs)) return `${fmtNet(net)} ${runSpan(runMs)}`;
  return rate(net / ((runMs as number) / DAY_MS));
}
