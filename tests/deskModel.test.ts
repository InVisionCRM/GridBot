/** The home board's data from a real status pull: open items, banked profits, grid ladders, the funnel, the chart curve. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALMOST, bankedCurve, bankedItems, funnelOf, ladders, openItems } from '../src/ui/deskModel';
import { listBots } from '../src/ui/botRow';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const S = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const bots = listBots(S, 'all');

describe('home board data', () => {
  it('open: one card per grid level holding, priced to its sell; liquidity ranges by their distance to the edge', () => {
    for (const mode of ['live', 'paper'] as const) {
      const items = openItems(bots, null, mode);
      const grids = bots.filter((b) => b.kind === 'grid' && (b.mode === 'live' ? 'live' : 'paper') === mode && b.status !== 'closed' && b.price != null);
      const holding = grids.reduce((a, g) => a + g.intervals.filter((i: Obj) => i.status === 'holding').length, 0);
      expect(items.filter((i) => i.kind === 'grid')).toHaveLength(holding);
      for (const i of items) expect(i.close).toBeGreaterThanOrEqual(0), expect(i.close).toBeLessThanOrEqual(1);
    }
    const g = bots.find((b) => b.kind === 'grid' && b.intervals.some((i: Obj) => i.status === 'holding') && b.price != null)!;
    const iv = g.intervals.find((i: Obj) => i.status === 'holding');
    const card = openItems([g], null, g.mode === 'live' ? 'live' : 'paper').find((i) => i.key === `${g.id}:${iv.index}`)!;
    expect(card.value[0].amt).toBeCloseTo(iv.plsAmount * iv.sellPrice * (1 - g.feeBps / 10_000) - iv.buyAmount, 9);
    expect(card.close).toBeCloseTo(Math.max(0, Math.min(1, (g.price - iv.buyPrice) / (iv.sellPrice - iv.buyPrice))), 12);
    const lp = bots.find((b) => b.kind === 'lp' && b.position && b.price != null)!;
    const lc = openItems([lp], null, lp.mode === 'live' ? 'live' : 'paper')[0];
    expect(lc.kind).toBe('lp');
    expect(lc.sub).toMatch(/from the edge · earning|outside/);
  });

  it('banked: every completed round trip, newest first, in its quote coin', () => {
    const items = bankedItems(bots, null, 'paper');
    const sells = bots.filter((b) => b.kind === 'grid' && b.mode !== 'live').reduce((a, g) => a + g.trades.filter((t: Obj) => t.side === 'sell' && !t.failed && t.roundTripNet != null).length, 0);
    expect(items.filter((i) => i.kind === 'grid')).toHaveLength(sells);
    expect(items.every((x, i) => i === 0 || x.t <= items[i - 1].t)).toBe(true);
  });

  it('banked: liquidity fee collections and token trader sells', () => {
    const lp = { id: 'l1', kind: 'lp', mode: 'live', base: 'ETH', quote: 'USDG', usdPerQuote: 1, price: 2000, collections: [{ t: 5, base: 0.001, quote: 2.5, why: 'moved' }] };
    const trader = { trades: [{ t: 9, mode: 'live', side: 'sell', label: 'NEON/WETH', spendSym: 'WETH', pnl: 0.02, pnlUsd: 50, why: 'take profit', pool: '0x1' }, { t: 7, mode: 'paper', side: 'sell', label: 'X/WETH', pnl: 1, pnlUsd: 1, pool: '0x2' }] };
    const items = bankedItems([lp], trader, 'live');
    expect(items.map((i) => [i.kind, i.amounts, i.usd])).toEqual([
      ['token', [{ sym: 'WETH', amt: 0.02 }], 50],
      ['lp', [{ sym: 'ETH', amt: 0.001 }, { sym: 'USDG', amt: 2.5 }], 0.001 * 2000 + 2.5],
    ]);
    expect(items[1].sub).toBe('fees collected on a range move');
  });

  it('ladders: each grid\'s level prices (one more than its intervals), which hold, and the price', () => {
    for (const l of ladders(bots, 'paper')) {
      const g = bots.find((b) => b.id === l.botId)!;
      expect(l.prices).toHaveLength(g.intervals.length + 1);
      expect(l.prices.every((p, i) => i === 0 || p > l.prices[i - 1])).toBe(true);
      expect(l.holding.filter(Boolean)).toHaveLength(g.intervals.filter((i: Obj) => i.status === 'holding').length);
    }
  });

  it('funnel: today\'s counts and the last coin each stage decided on', () => {
    const trader = {
      funnel: { day: 'x', scouted: 120, rules: 100, checks: 12, buy: 2, bought: 3 },
      feed: [{ t: 3, label: 'A/WETH', verdict: 'bought', why: 'passed', stage: 'buy' }, { t: 2, label: 'B/WETH', verdict: 'skipped', why: 'honeypot', stage: 'checks' }, { t: 1, label: 'C/WETH', verdict: 'skipped', why: 'too new', stage: 'rules' }, { t: 0, label: 'old', verdict: 'skipped', why: 'x' }],
    };
    const f = funnelOf(trader)!;
    expect(f).toMatchObject({ scouted: 120, rules: 100, checks: 12, buy: 2, bought: 3 });
    expect(f.last).toEqual({ bought: { label: 'A/WETH', why: 'passed', t: 3 }, checks: { label: 'B/WETH', why: 'honeypot', t: 2 }, rules: { label: 'C/WETH', why: 'too new', t: 1 } });
    expect(funnelOf({ feed: [] })).toBeNull();
  });

  it('chart: banked profits in the range, cumulative in dollars, oldest first', () => {
    const mk = (t: number, usd: number | null) => ({ key: String(t), botId: 'b', kind: 'grid' as const, sym: 'X', title: '', sub: '', t, amounts: [], usd });
    expect(bankedCurve([mk(30, 2), mk(10, 1), mk(20, null), mk(5, 9)], 8).map((p) => [p.t, p.v])).toEqual([[10, 1], [30, 3]]);
    expect(ALMOST).toBe(0.8);
  });
});
