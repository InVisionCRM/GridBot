import { describe, expect, it } from 'vitest';
import { candidates, HOLD_MS, planBudget, poolId, switchCost, type Candidate, type Held, type PlanOptions, type Retiring } from '../src/market/autopilot';
import { GRID_PER_SWING, LP_REPEAT, type Opportunity } from '../src/market/scan';

const NOW = 1_800_000_000_000;
const ALL: PlanOptions = { grid: true, lp: true, newTokens: true, risk: 'any', slots: 3 };

function opp(label: string, o: Partial<Opportunity> & { swing?: number; lpEarned?: number | null; gridOk?: boolean } = {}): Opportunity {
  const { swing = 0.1, lpEarned = null, gridOk = true, ...rest } = o;
  return {
    chainId: 4663, key: `robinhood:${label}`, ref: { address: `0x${label}`, quote: '0xusdg', pool: `0xpool${label}` }, label, spend: 'USDG', stack: label.split('/')[0], dex: 'uniswap-v3', kind: 'v3', feeBps: 30,
    risk: null, riskWhy: null, liveAllowed: true, price: 1, movePct: 0, swingPct: swing, activity: null, capital: 1000, usd: 1000,
    grid: gridOk ? { bandPct: 0.12, gridCount: 20, earnedPct: 0.01, roundTrips: 10, returnPct: 0, maxDrawdownPct: 0 } : null, gridWhy: null,
    lp: lpEarned == null ? null : { bandPct: 0.05, earnedPct: lpEarned, feesPct: lpEarned, inRangePct: 0.9, poolSharePct: 0.001, returnPct: 0 }, lpWhy: null,
    ...rest,
  };
}
const cand = (label: string, expected: number, o: Partial<Candidate> = {}): Candidate => {
  const how = o.how ?? 'grid', cost = o.cost ?? 0;
  return { id: `4663:robinhood:${label}:${how}`, pair: `4663:${label}/USDG`, how, expected, cost, score: expected - cost, feeBps: 30, label, maxCapital: 1e9, o: opp(label), ...o };
};
/** USDG is the budget's coin; ETH costs 0.1% each way and is 3,000 USDG */
const reach = (coin: string) => (coin === 'USDG' ? { cost: 0, rate: 1 } : coin === 'ETH' ? { cost: 0.002, rate: 3000 } : null);
const held = (label: string, ageMs: number, o: Partial<Held> = {}): Held => ({ id: `bot-${label}`, pool: `4663:robinhood:${label}:grid`, pair: `4663:${label}/USDG`, label, openedAt: NOW - ageMs, feeBps: 30, ...o });
const plan = (p: { cash?: number; slots?: number; cands: Candidate[]; held?: Held[]; retiring?: Retiring[]; gone?: Map<string, string> }) =>
  planBudget({ now: NOW, budget: 900, cash: p.cash ?? 0, slots: p.slots ?? 3, cands: p.cands, gone: p.gone ?? new Map(), held: p.held ?? [], retiring: p.retiring ?? [] });
const opens = (d: ReturnType<typeof planBudget>) => d.flatMap((x) => (x.kind === 'open' ? [[x.cand.label, x.capital]] : []));
const WEEK = HOLD_MS + 1;

describe('smart trader: which pools and which way', () => {
  it("every way with an estimate (score = estimate − swapping in and out), the options' tools and risk, best first; the rest with why", () => {
    const items = [
      opp('A/USDG', { swing: 0.2, lpEarned: 0.05 }), // liquidity 3.85%, grid 1.37%: both are ways to use it
      opp('B/USDG', { swing: 0.5 }), // grid 3.43%
      opp('C/ETH', { spend: 'ETH', swing: 0.9 }), // spends ETH: 6.17% − 0.2% for the swaps
      opp('G/DAI', { spend: 'DAI', swing: 0.9 }), // no route to DAI
      opp('D/USDG', { swing: 0.9, liveAllowed: false }), // failed the safety check
      opp('E/USDG', { swing: 0.6, risk: 'medium' }),
      opp('F/USDG', { swing: 0.7, key: null, ref: { address: '0xf', quote: '0xq', pool: '0xpoolF' } }), // new token
    ];
    const ids = (o: Partial<PlanOptions>) => candidates(items, { ...ALL, ...o }, reach).cands.map((c) => `${c.label}:${c.how}`);
    expect(ids({})).toEqual(['C/ETH:grid', 'F/USDG:grid', 'E/USDG:grid', 'A/USDG:lp', 'B/USDG:grid', 'A/USDG:grid']);
    expect(ids({ risk: 'safe' })).toEqual(['C/ETH:grid', 'F/USDG:grid', 'A/USDG:lp', 'B/USDG:grid', 'A/USDG:grid']);
    expect(ids({ newTokens: false, risk: 'medium' })).toEqual(['C/ETH:grid', 'E/USDG:grid', 'A/USDG:lp', 'B/USDG:grid', 'A/USDG:grid']);
    expect(ids({ lp: false, newTokens: false, risk: 'safe' })).toEqual(['C/ETH:grid', 'B/USDG:grid', 'A/USDG:grid']);
    const { cands, gone } = candidates(items, ALL, reach);
    expect(cands[0]).toMatchObject({ expected: GRID_PER_SWING * 0.9, cost: 0.002, score: GRID_PER_SWING * 0.9 - 0.002, maxCapital: 3_000_000 });
    expect(cands[1].expected).toBeCloseTo(GRID_PER_SWING * 0.7, 12);
    expect(cands[1].id).toBe(poolId(items[6], 'grid'));
    expect(cands[1].id).toBe('4663:0xpoolF:grid');
    expect(cands.find((c) => c.how === 'lp')!.expected).toBeCloseTo(LP_REPEAT * 0.05, 12);
    expect(gone.get(poolId(items[3], 'grid'))).toMatch(/no route or price .* DAI/);
    expect(gone.get(poolId(items[4], 'grid'))).toBe('it failed its latest safety check');
    expect(gone.get(poolId(items[1], 'lp'))).toBe('it earned nothing in the test week');
    expect(candidates(items, { ...ALL, risk: 'safe' }, reach).gone.get(poolId(items[5], 'grid'))).toBe('its risk is medium, above what you allowed');
  });
});

describe('smart trader: one review of a budget', () => {
  const cands = [cand('A', 0.05), cand('B', 0.04), cand('C', 0.03), cand('D', 0.02)];

  it('opens the best pools in the free slots, the money split evenly', () => {
    expect(opens(plan({ cash: 900, cands }))).toEqual([['A', 300], ['B', 300], ['C', 300]]);
  });

  it('a bot is at most the size its pool was tested at; the rest waits', () => {
    const d = plan({ cash: 900, cands: cands.map((c) => ({ ...c, maxCapital: 100 })) });
    expect(opens(d)).toEqual([['A', 100], ['B', 100], ['C', 100]]);
    expect(d[0]).toMatchObject({ why: expect.stringMatching(/100 is the size it was tested at, so the rest waits/) });
  });

  it('keeps a bot in its first week whatever its rank', () => {
    expect(plan({ cands, held: [held('D', HOLD_MS - 1)] })).toEqual([{ kind: 'keep', id: 'bot-D', why: expect.stringMatching(/first week/) }]);
  });

  it('after its first week: kept while among the best, replaced when a pool beats it by more than switching costs', () => {
    expect(plan({ cands, held: [held('A', WEEK), held('B', WEEK), held('C', WEEK)] }).map((x) => x.kind)).toEqual(['keep', 'keep', 'keep']);
    // D is #4 of 3 slots: C, not run, earns 1 point more, over the 0.6% switching costs → D is retired for C
    const d = plan({ cands, held: [held('A', WEEK), held('B', WEEK), held('D', WEEK)] });
    expect(d[2]).toEqual({ kind: 'retire', id: 'bot-D', alt: cands[2].id, why: expect.stringMatching(/C is expected to earn \+3\.0% a week as a grid against \+2\.0% here/) });
    expect(switchCost(30, 30)).toBeCloseTo(0.006, 12);
    // switching costs 2% (two 1% pools): 1 point better isn't enough
    const dear = plan({ cands: cands.map((c) => ({ ...c, feeBps: 100 })), held: [held('A', WEEK), held('B', WEEK), held('D', WEEK, { feeBps: 100 })] });
    expect(dear[2]).toEqual({ kind: 'keep', id: 'bot-D', why: expect.stringMatching(/only \+1\.0% more, under the \+2\.0% switching costs/) });
  });

  it("a pool tested and not earning is replaced after the first week; one missing from today's scan (its test failed) is kept", () => {
    const gone = new Map([['4663:robinhood:Z:grid', 'it earned nothing in the test week']]);
    const d = plan({ cands, gone, held: [held('A', WEEK), held('Z', WEEK), held('Y', WEEK)] });
    expect(d[1]).toEqual({ kind: 'retire', id: 'bot-Z', alt: cands[1].id, why: expect.stringMatching(/^it earned nothing in the test week; B is expected/) });
    expect(d[2]).toEqual({ kind: 'keep', id: 'bot-Y', why: expect.stringMatching(/isn't in today's scan/) });
  });

  it('a bot being closed keeps its slot and its pool (not reopened); the way it was replaced for waits for its money', () => {
    // 300 waiting, slots 3: A held, Z closing (replaced for B) → one free slot, and it goes to C, not B
    const z: Retiring = { pool: '4663:robinhood:Z:grid', pair: '4663:Z/USDG', alt: cands[1].id };
    expect(opens(plan({ cash: 300, cands: [...cands, cand('Z', 0.06)], held: [held('A', WEEK)], retiring: [z] }))).toEqual([['C', 300]]);
    // no free slot while it closes: nothing opens, Z's own pool included
    expect(opens(plan({ cash: 300, cands: [...cands, cand('Z', 0.06)], held: [held('A', WEEK), held('C', WEEK)], retiring: [z] }))).toEqual([]);
    // and no other bot is replaced for B meanwhile
    const d = plan({ cands, held: [held('A', WEEK), held('D', WEEK)], retiring: [z] });
    expect(d[1]).toEqual({ kind: 'retire', id: 'bot-D', alt: cands[2].id, why: expect.stringMatching(/^C is expected/) });
  });

  it("ranks with the slots set, not those left while another bot closes (a #3 of 3 isn't pushed out)", () => {
    // slots 3: A in its first week, B past it (#3), R closing. Before: planned with 2 slots, B was replaced for C.
    const cs = [cand('A', 0.05), cand('C', 0.04), cand('B', 0.03)];
    const d = plan({ cash: 0, cands: cs, held: [held('A', HOLD_MS - 1), held('B', WEEK)], retiring: [{ pool: '4663:robinhood:R:grid', pair: '4663:R/USDG', alt: null }] });
    expect(d[1]).toEqual({ kind: 'keep', id: 'bot-B', why: expect.stringMatching(/still among the best: #3/) });
  });

  it('idle cash and a replacement never take the same pool', () => {
    // slots 3, cash 300: A in its first week, D past it (2.0%). Before: D was replaced for B and B also opened with the cash.
    const cs = [cand('A', 0.05), cand('B', 0.04), cand('C', 0.021), cand('D', 0.02)];
    const d = plan({ cash: 300, cands: cs, held: [held('A', HOLD_MS - 1), held('D', WEEK)] });
    expect(opens(d)).toEqual([['B', 300]]);
    expect(d[1]).toEqual({ kind: 'keep', id: 'bot-D', why: expect.stringMatching(/only \+0\.1% more/) });
  });

  it("a held bot is judged on its estimate: its swap in is paid, its swap back is paid either way", () => {
    // E spends ETH (1.2% to swap in and out): 3.0% a week, 1.8% after swaps. U spends USDG: 2.9%. Before: E was replaced for U.
    const e = cand('E', 0.03, { cost: 0.012, o: opp('E', { spend: 'ETH' }) }), u = cand('U', 0.029);
    expect(plan({ slots: 1, cands: [u, e], held: [held('E', WEEK)] })).toEqual([{ kind: 'keep', id: 'bot-E', why: expect.stringMatching(/still among the best: #1, expected \+3\.0%/) }]);
    // against a pool spending the same coin, both pay the swaps: 2.3% − 1.8% = 0.5%, under 0.6%
    const q = cand('Q', 0.035, { cost: 0.012, o: opp('Q', { spend: 'ETH' }) });
    expect(plan({ slots: 1, cands: [q, e], held: [held('E', WEEK)] })).toEqual([{ kind: 'keep', id: 'bot-E', why: expect.stringMatching(/only \+0\.5% more, under the \+0\.6% switching costs/) }]);
    // 2.8% − 1.8% = 1.0%: over 0.6%, so it is replaced, though its 3.0% estimate ranks above Q's 2.8% score
    const q2 = cand('Q', 0.04, { cost: 0.012, o: opp('Q', { spend: 'ETH' }) });
    expect(plan({ slots: 1, cands: [q2, e], held: [held('E', WEEK)] })).toEqual([{ kind: 'retire', id: 'bot-E', alt: q2.id, why: expect.stringMatching(/\+2\.8% a week as a grid against \+1\.8% here/) }]);
  });

  it("another way on the bot's own pair is compared like any other (no 'no longer earns'): grid ↔ range, V1 ↔ V2", () => {
    const grid = cand('P', 0.02058), lp = cand('P', 0.02064, { how: 'lp' }), q = cand('Q', 0.007);
    expect(plan({ slots: 1, cands: [lp, grid, q], held: [held('P', WEEK)] })).toEqual([{ kind: 'keep', id: 'bot-P', why: expect.stringMatching(/still among the best/) }]);
    // slots 1, X range 3.85%, X grid 2.06% (held, past its week), Y grid 1.4% → replaced for its own range, not for Y
    const xl = cand('X', 0.0385, { how: 'lp' }), xg = cand('X', 0.0206), y = cand('Y', 0.014);
    const d = plan({ slots: 1, cands: [xl, xg, y], held: [held('X', WEEK)] });
    expect(d).toEqual([{ kind: 'retire', id: 'bot-X', alt: xl.id, why: expect.stringMatching(/^X is expected to earn \+3\.9% a week as a liquidity range against \+2\.1% here/) }]);
  });

  it('more bots than the slots now set: the weakest past their first week are closed', () => {
    const d = plan({ slots: 1, cands: [cand('A', 0.05), cand('B', 0.04), cand('C', 0.021)], held: [held('A', WEEK), held('B', WEEK), held('C', WEEK)] });
    expect(d.map((x) => x.kind)).toEqual(['keep', 'retire', 'retire']);
    expect(d[2]).toMatchObject({ alt: null, why: expect.stringMatching(/more bots than the 1 per budget now set; it is the weakest/) });
  });

  it('one bot per coin pair: the best pool of a pair, and never a second pool of a pair it runs', () => {
    const items = [
      opp('PLS/DAI', { spend: 'DAI', swing: 0.5, key: 'DAI' }), // PulseX V1
      opp('DAI/PLS', { spend: 'PLS', swing: 0.4, key: null, ref: { address: '0xdai', quote: '0xwpls', pool: '0xv2' } }), // PulseX V2: same coins
    ];
    const { cands: c } = candidates(items, ALL, () => ({ cost: 0, rate: 1 }));
    expect(opens(plan({ cash: 900, cands: c }))).toEqual([['PLS/DAI', 900]]);
    expect(plan({ cash: 300, cands: c, held: [{ id: 'b', pool: c[0].id, pair: c[0].pair, label: 'PLS/DAI', openedAt: NOW, feeBps: 30 }] }))
      .toEqual([{ kind: 'keep', id: 'b', why: expect.any(String) }, { kind: 'wait', why: 'every pool expected to earn is already run' }]);
  });

  it('waits when the money left is too little for a bot, or nothing is expected to earn', () => {
    expect(plan({ cash: 50, cands })).toEqual([{ kind: 'wait', why: expect.stringMatching(/too little/) }]);
    expect(plan({ cash: 900, cands: [] })).toEqual([{ kind: 'wait', why: 'no pool is expected to earn with these options' }]);
    expect(plan({ cash: 900, cands: [cand('L', 0.001, { cost: 0.002 })] })).toEqual([{ kind: 'wait', why: 'no pool is expected to earn with these options' }]);
    // fewer good pools than slots: all of the money goes to the ones there are
    expect(opens(plan({ cash: 900, cands: cands.slice(0, 1) }))).toEqual([['A', 900]]);
  });
});
