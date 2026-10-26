import { describe, expect, it } from 'vitest';
import { candidates, HOLD_MS, planBudget, poolId, switchCost, type Candidate, type PlanOptions } from '../src/market/autopilot';
import { GRID_PER_SWING, LP_REPEAT, type Opportunity } from '../src/market/scan';

const NOW = 1_800_000_000_000;
const ALL: PlanOptions = { grid: true, lp: true, newTokens: true, risk: 'any', slots: 3 };

function opp(label: string, o: Partial<Opportunity> & { swing?: number; lpEarned?: number | null; gridOk?: boolean } = {}): Opportunity {
  const { swing = 0.1, lpEarned = null, gridOk = true, ...rest } = o;
  return {
    chainId: 4663, key: `robinhood:${label}`, add: null, label, spend: 'USDG', stack: label.split('/')[0], dex: 'uniswap-v3', kind: 'v3', feeBps: 30,
    risk: null, riskWhy: null, liveAllowed: true, price: 1, movePct: 0, swingPct: swing, activity: null, capital: 1000, usd: 1000,
    grid: gridOk ? { bandPct: 0.12, gridCount: 20, earnedPct: 0.01, roundTrips: 10, returnPct: 0, maxDrawdownPct: 0 } : null, gridWhy: null,
    lp: lpEarned == null ? null : { bandPct: 0.05, earnedPct: lpEarned, feesPct: lpEarned, inRangePct: 0.9, poolSharePct: 0.001, returnPct: 0 }, lpWhy: null,
    ...rest,
  };
}
const cand = (label: string, expected: number, feeBps = 30): Candidate => ({ id: `4663:robinhood:${label}:grid`, pair: `4663:${label}/USDG`, how: 'grid', expected, cost: 0, score: expected, feeBps, label, o: opp(label) });
/** USDG is the budget's coin; ETH costs 0.1% each way */
const cost = (coin: string) => (coin === 'USDG' ? 0 : coin === 'ETH' ? 0.002 : null);

describe('smart trader: which pools and which way', () => {
  it("every coin with a route (score = estimate − swapping in and out), the options' tools and risk, one way per pool, best first", () => {
    const items = [
      opp('A/USDG', { swing: 0.2, lpEarned: 0.05 }), // grid 1.4%, liquidity 3.85%: liquidity
      opp('B/USDG', { swing: 0.5 }), // grid 3.43%
      opp('C/ETH', { spend: 'ETH', swing: 0.9 }), // spends ETH: 6.17% − 0.2% for the swaps
      opp('G/DAI', { spend: 'DAI', swing: 0.9 }), // no route to DAI
      opp('D/USDG', { swing: 0.9, liveAllowed: false }), // failed the safety check
      opp('E/USDG', { swing: 0.6, risk: 'medium' }),
      opp('F/USDG', { swing: 0.7, key: null, add: { address: '0xf', quote: '0xq', pool: '0xpool' } }), // new token
    ];
    const ids = (o: Partial<PlanOptions>) => candidates(items, { ...ALL, ...o }, cost).map((c) => `${c.label}:${c.how}`);
    expect(ids({})).toEqual(['C/ETH:grid', 'F/USDG:grid', 'E/USDG:grid', 'A/USDG:lp', 'B/USDG:grid']);
    expect(ids({ risk: 'safe' })).toEqual(['C/ETH:grid', 'F/USDG:grid', 'A/USDG:lp', 'B/USDG:grid']);
    expect(ids({ newTokens: false, risk: 'medium' })).toEqual(['C/ETH:grid', 'E/USDG:grid', 'A/USDG:lp', 'B/USDG:grid']);
    expect(ids({ lp: false, newTokens: false, risk: 'safe' })).toEqual(['C/ETH:grid', 'B/USDG:grid', 'A/USDG:grid']);
    const all = candidates(items, ALL, cost);
    expect(all[0]).toMatchObject({ expected: GRID_PER_SWING * 0.9, cost: 0.002, score: GRID_PER_SWING * 0.9 - 0.002 });
    expect(all[1].expected).toBeCloseTo(GRID_PER_SWING * 0.7, 12);
    expect(all[1].id).toBe(poolId(items[6], 'grid'));
    expect(candidates([opp('A/USDG', { swing: 0.2, lpEarned: 0.05 })], ALL, cost)[0].expected).toBeCloseTo(LP_REPEAT * 0.05, 12);
  });
});

describe('smart trader: one review of a budget', () => {
  const cands = [cand('A', 0.05), cand('B', 0.04), cand('C', 0.03), cand('D', 0.02)];
  const held = (label: string, ageMs: number, feeBps = 30) => ({ id: `bot-${label}`, pool: `4663:robinhood:${label}:grid`, pair: `4663:${label}/USDG`, label, openedAt: NOW - ageMs, feeBps });

  it('opens the best pools in the free slots, the money split evenly', () => {
    const d = planBudget({ now: NOW, budget: 900, cash: 900, slots: 3, cands, held: [] });
    expect(d.map((x) => x.kind === 'open' && [x.cand.label, x.capital])).toEqual([['A', 300], ['B', 300], ['C', 300]]);
  });

  it('keeps a bot in its first week whatever its rank', () => {
    const d = planBudget({ now: NOW, budget: 900, cash: 0, slots: 3, cands, held: [held('D', HOLD_MS - 1)] });
    expect(d).toEqual([{ kind: 'keep', id: 'bot-D', why: expect.stringMatching(/first week/) }]);
  });

  it('after its first week: kept while among the best, replaced when a pool beats it by more than switching costs', () => {
    const week = HOLD_MS + 1;
    // C is #3 of 3 slots: kept
    expect(planBudget({ now: NOW, budget: 900, cash: 0, slots: 3, cands, held: [held('A', week), held('B', week), held('C', week)] }).map((x) => x.kind)).toEqual(['keep', 'keep', 'keep']);
    // D is #4 of 3 slots: C, not run, earns 1 point more, over the 0.6% switching costs → D is retired
    const d = planBudget({ now: NOW, budget: 900, cash: 0, slots: 3, cands, held: [held('A', week), held('B', week), held('D', week)] });
    expect(d[2]).toEqual({ kind: 'retire', id: 'bot-D', why: expect.stringMatching(/C is expected to earn \+3\.0% a week against \+2\.0% here/) });
    expect(switchCost(30, 30)).toBeCloseTo(0.006, 12);
    // switching costs 2% (two 1% pools): 1 point better isn't enough
    const dear = planBudget({ now: NOW, budget: 900, cash: 0, slots: 3, cands: cands.map((c) => ({ ...c, feeBps: 100 })), held: [held('A', week), held('B', week), held('D', week, 100)] });
    expect(dear[2]).toEqual({ kind: 'keep', id: 'bot-D', why: expect.stringMatching(/only \+1\.0% more, under the \+2\.0% switching costs/) });
  });

  it('a bot whose pool no longer earns is retired after its first week; a retiring bot keeps its slot until its money is back', () => {
    const d = planBudget({ now: NOW, budget: 900, cash: 0, slots: 3, cands, held: [held('A', HOLD_MS + 1), held('Z', HOLD_MS + 1)] });
    expect(d[1]).toEqual({ kind: 'retire', id: 'bot-Z', why: expect.stringMatching(/no longer earns; B is expected/) });
    // 300 waiting, one slot free (Z is still retiring): it opens B with it
    const d2 = planBudget({ now: NOW, budget: 900, cash: 300, slots: 3, cands, held: [held('A', HOLD_MS + 1), held('Z', HOLD_MS + 1)] });
    expect(d2.filter((x) => x.kind === 'open').map((x) => x.kind === 'open' && [x.cand.label, x.capital])).toEqual([['B', 300]]);
  });

  it('one bot per coin pair: the best pool of a pair, and never a second pool of a pair it runs', () => {
    const items = [
      opp('PLS/DAI', { spend: 'DAI', swing: 0.5, key: 'DAI' }), // PulseX V1
      opp('DAI/PLS', { spend: 'PLS', swing: 0.4, key: null, add: { address: '0xdai', quote: '0xwpls', pool: '0xv2' } }), // PulseX V2: same coins
    ];
    const c = candidates(items, ALL, () => 0);
    expect(c.map((x) => x.label)).toEqual(['PLS/DAI']);
    const other = candidates([items[1]], ALL, () => 0);
    expect(planBudget({ now: NOW, budget: 900, cash: 300, slots: 3, cands: other, held: [{ id: 'b', pool: c[0].id, pair: c[0].pair, label: 'PLS/DAI', openedAt: NOW, feeBps: 30 }] }))
      .toEqual([{ kind: 'keep', id: 'b', why: expect.any(String) }, { kind: 'wait', why: 'every pool expected to earn is already run' }]);
  });

  it('waits when the money left is too little for a bot, or nothing is expected to earn', () => {
    expect(planBudget({ now: NOW, budget: 900, cash: 50, slots: 3, cands, held: [] })).toEqual([{ kind: 'wait', why: expect.stringMatching(/too little/) }]);
    expect(planBudget({ now: NOW, budget: 900, cash: 900, slots: 3, cands: [], held: [] })).toEqual([{ kind: 'wait', why: 'no pool is expected to earn with these options' }]);
    // fewer good pools than slots: all of the money goes to the ones there are
    expect(planBudget({ now: NOW, budget: 900, cash: 900, slots: 3, cands: cands.slice(0, 1), held: [] }).map((x) => x.kind === 'open' && x.capital)).toEqual([900]);
  });
});
