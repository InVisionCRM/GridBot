/** How drawn lines look (Night Desk): buy lines green, sell lines red; solid = close-through rules, dashed = touch rules. */
import { LINE_RULES, type DrawnLine, type LineRule } from '../market/strategy';
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
