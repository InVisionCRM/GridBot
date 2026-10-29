/**
 * Audit a007: one word per real state. A bot that isn't running is Paused (it resumes; "Stop all" is the kill switch),
 * the Bots page's Paused chip finds it, and no chip matches nothing.
 */
import { describe, expect, it } from 'vitest';
import { emptyQuery, matchItem, statusOf, type DeskItem } from '../src/ui/deskTableModel';

const item = (status: string) => ({ b: { status, kind: 'grid' }, name: 'x', chain: 'c', chainId: 1, group: 'live', facts: {} } as unknown as DeskItem);

describe('bot status words', () => {
  it('a stopped engine reads Paused and the Paused chip finds it', () => {
    expect(statusOf({ status: 'stopped' })).toBe('paused');
    expect(matchItem(item('stopped'), { ...emptyQuery(), status: 'paused' })).toBe(true);
    expect(matchItem(item('running'), { ...emptyQuery(), status: 'paused' })).toBe(false);
  });
  it('every listed bot matches exactly one status chip', () => {
    for (const s of ['running', 'stopped']) {
      const hits = (['running', 'paused'] as const).filter((c) => matchItem(item(s), { ...emptyQuery(), status: c }));
      expect(hits).toHaveLength(1);
    }
  });
});
