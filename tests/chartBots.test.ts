/**
 * A bot's page charts that bot alone. Kyle's SCHIFFY grid page drew the B/S fills of every grid on the pair (an earlier
 * grid's two sells beside this bot's one), so the chart and "Completed trades 1" disagreed. The Charts tab still shows
 * every bot on the pair, with its own toggles.
 */
import { describe, expect, it } from 'vitest';
import { botsOnPair } from '../src/ui/Chart';

const status = {
  grids: [
    { id: 'g-old', stable: 'robinhood:SCHIFFY/ETH', config: { lowerPrice: 1, upperPrice: 2 }, trades: [{ side: 'sell' }, { side: 'sell' }] },
    { id: 'g-new', stable: 'robinhood:SCHIFFY/ETH', config: { lowerPrice: 1, upperPrice: 2 }, trades: [{ side: 'sell' }] },
    { id: 'g-other', stable: 'pulsechain:PLS/DAI', config: { lowerPrice: 1, upperPrice: 2 }, trades: [] },
  ],
  trends: [{ id: 't1', quote: 'robinhood:SCHIFFY/ETH' }],
  lps: [{ id: 'l1', market: 'robinhood:SCHIFFY/ETH', position: { lower: 1, upper: 2 } }, { id: 'l-closed', market: 'robinhood:SCHIFFY/ETH', position: null }],
};

describe('which bots a chart draws', () => {
  it('the Charts tab: every bot on the pair', () => {
    const b = botsOnPair(status, 'robinhood:SCHIFFY/ETH');
    expect(b.grids.map((g) => g.id)).toEqual(['g-old', 'g-new']);
    expect(b.trends.map((t) => t.id)).toEqual(['t1']);
    expect(b.lps.map((l) => l.id)).toEqual(['l1']);
  });
  it("a bot's page: that bot only", () => {
    const b = botsOnPair(status, 'robinhood:SCHIFFY/ETH', 'g-new');
    expect(b.grids.map((g) => g.id)).toEqual(['g-new']);
    expect(b.trends).toEqual([]);
    expect(b.lps).toEqual([]);
    expect(botsOnPair(null, 'robinhood:SCHIFFY/ETH', 'g-new')).toEqual({ grids: [], trends: [], lps: [] });
  });
});
