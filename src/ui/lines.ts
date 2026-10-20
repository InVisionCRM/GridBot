/** How drawn lines look (Night Desk): buy lines green, sell lines red; solid = close-through rules, dashed = touch rules. */
import { LINE_RULES, lineValue, type DrawnLine, type LineRule } from '../market/strategy';
import type { Candle } from '../market/candles';
import { T } from './theme';

export const lineSide = (r: LineRule) => LINE_RULES.find((x) => x.id === r)!.side;
export const lineColor = (r: LineRule) => (lineSide(r) === 'buy' ? T.profit : T.loss);
/** Touch rules (dip & hold, reached) are dashed; close-through rules are solid. */
export const lineDashed = (r: LineRule) => r === 'buy_bounce' || r === 'sell_reach';
export const RULE_TAG: Record<LineRule, string> = {
  buy_break: '▲ close above', buy_bounce: '▲ dip & hold', sell_break: '▼ close below', sell_reach: '▼ reached',
};
/** "2 ▲ close above": the line's number on the chart and in the list. */
export const lineTitle = (l: DrawnLine, i: number) => `${i + 1} ${RULE_TAG[l.rule]}`;

/** A new line's rule from where it sits: above the price it waits for a breakout, below it for a bounce. */
export function defaultRule(g: Pick<DrawnLine, 'kind' | 'a' | 'b'>, last: Candle): LineRule {
  return lineValue({ ...g, id: '', rule: 'buy_break' }, last.t) >= last.c ? 'buy_break' : 'buy_bounce';
}

/**
 * The chart's bar index at time t: candle i is index i, a time between two candles is the matching fraction between
 * them, and past either end the index runs on at one bar per timeframe. Inverse of timeAt.
 */
export function logicalAt(k: readonly Pick<Candle, 't'>[], tfSec: number, t: number): number {
  const n = k.length;
  if (t <= k[0].t) return (t - k[0].t) / tfSec;
  if (t >= k[n - 1].t) return n - 1 + (t - k[n - 1].t) / tfSec;
  let lo = 0, hi = n - 1; // k[lo].t <= t < k[hi].t
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
  return lo + (t - k[lo].t) / (k[hi].t - k[lo].t);
}

/** The time at a chart bar index, including fractions between candles. Inverse of logicalAt. */
export function timeAt(k: readonly Pick<Candle, 't'>[], tfSec: number, l: number): number {
  const n = k.length;
  if (l <= 0) return k[0].t + l * tfSec;
  if (l >= n - 1) return k[n - 1].t + (l - (n - 1)) * tfSec;
  const i = Math.floor(l);
  return k[i].t + (l - i) * (k[i + 1].t - k[i].t);
}
