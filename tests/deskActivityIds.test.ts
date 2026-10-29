/**
 * a005: an activity row's id must follow the event, not its place in the ring. When the 400-line ring drops its
 * oldest line, the fills still in it are the same fills: the next delta must not send them again (the desk prepends
 * every delta row, so a re-sent fill shows twice).
 */
import { describe, expect, it } from 'vitest';
import { deskDelta, deskFromStatus } from '../src/server/v2Desk';
import type { ActivityEvent } from '../src/server/bot/activity';

const fill = (id: number): ActivityEvent => ({ id, t: 1_700_000_000_000 + id * 1000, type: 'filled', level: 'success', kind: 'grid', botId: 'g1', msg: `Grid A/B: SOLD ${id} A` });
const status = { spotsAt: 1_700_000_100_000, grids: [], lps: [], trends: [] };

describe('desk activity ids', () => {
  it('the ring dropping its oldest fill re-sends nothing; a new fill is sent once', () => {
    const a = deskFromStatus(status, [fill(1), fill(2), fill(3)]);
    const b = deskFromStatus(status, [fill(2), fill(3), fill(4)]);
    const d = deskDelta(a, b);
    expect(d.activity.map((x) => x.text)).toEqual(['Grid A/B: SOLD 4 A']);
  });
  it('two fills in the same millisecond keep distinct ids', () => {
    const same = [fill(1), { ...fill(2), t: fill(1).t }];
    const ids = deskFromStatus(status, same).activity.map((x) => x.id);
    expect(new Set(ids).size).toBe(2);
  });
});
