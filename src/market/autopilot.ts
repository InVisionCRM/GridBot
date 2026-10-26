/**
 * The smart trader's decisions for one budget (pure; the server side is server/bot/autopilot.ts). Its inputs are every
 * pool the scan found on the budget's chain, each with what it is expected to earn next week (market/scan.ts, fitted on
 * the walk-forward in the README), and the bots it runs now. A pool that spends another coin than the budget's (ETH
 * pools for a USDG budget) is reached by swapping into that coin and back: its score is its estimate less those
 * swaps' pool fees, and pools are ranked by score. The rules:
 *  - up to `slots` bots, best score first; money not in a bot is split evenly over the bots it opens, each at most the
 *    size the scan tested it at (the estimate is for that size)
 *  - a bot keeps its first week (HOLD_MS): the estimates are about a week, and switching costs money
 *  - after that, a bot whose pool is still among the best `slots` stays; otherwise it is replaced when a way it doesn't
 *    run is expected to earn more than it by more than switching costs (selling back through its pool, buying in
 *    through the new one: the two pools' fees, a cautious estimate). Staying is worth its estimate: the swap into its
 *    coin is paid, and the swap back is paid either way (unless the new pool spends the same coin)
 *  - a bot whose pool the scan tested and found not earning (or no longer allowed) is replaced after its first week;
 *    one whose pool is missing from the scan (its test failed today) is kept: no evidence either way
 *  - more bots than `slots` (the setting was lowered): the weakest past their first week are closed
 *  - one bot per coin pair: two pools of one pair (PLS/DAI on PulseX V1 and V2) are one bet on one price
 *  - the way a replaced bot was replaced for is kept for its money until that money is back
 *  - a piece under MIN_PIECE of an even share isn't worth a bot's costs: it waits
 */
import { expectedGrid, expectedLp, type Opportunity } from './scan';

export const HOLD_MS = 7 * 86_400_000;
export const MIN_PIECE = 0.25;

export type Risk = 'safe' | 'medium' | 'any';
export interface PlanOptions { grid: boolean; lp: boolean; newTokens: boolean; risk: Risk; slots: number }

/**
 * A way to use a pool. id = the pool and the way (a grid and a range on one pool are two); expected = its estimate;
 * cost = swapping the budget's coin into the pool's coin and back (0 when it spends the budget's coin); score = the two;
 * maxCapital = the size the scan tested it at, in the budget's coin.
 */
export interface Candidate { id: string; pair: string; how: 'grid' | 'lp'; expected: number; cost: number; score: number; feeBps: number; label: string; maxCapital: number; o: Opportunity }
/** A bot the trader runs: id = the bot, pool = its Candidate id, pair = its coins, capital = what it cost in the budget's coin */
export interface Held { id: string; pool: string; pair: string; label: string; openedAt: number; feeBps: number; capital: number }
/**
 * A bot that isn't judged: closing (its money comes back; `alt` = the way it is replaced for, kept for that money) or
 * stopped (by hand, KILL ALL, a safety pause: it keeps its slot). Either way its pool and pair stay taken.
 */
export interface Parked { pool: string; pair: string; closing: boolean; alt: string | null }

export type Decision =
  | { kind: 'open'; cand: Candidate; capital: number; why: string }
  | { kind: 'retire'; id: string; alt: string | null; why: string }
  | { kind: 'keep'; id: string; why: string }
  | { kind: 'wait'; why: string };

/** `key` is this app's market key (server/bot/autopilot.ts sets it from the pool's addresses); a pool not in the app yet goes by its address */
export const poolId = (o: Pick<Opportunity, 'chainId' | 'key' | 'ref'>, how: 'grid' | 'lp') => `${o.chainId}:${o.key ?? o.ref.pool}:${how}`;
/** A way by its pool's addresses: the same before and after its coin is added to the app */
export const wayKey = (o: Pick<Opportunity, 'chainId' | 'dex' | 'ref'>, how: 'grid' | 'lp') => `${o.chainId}:${o.dex}:${o.ref.address}:${o.ref.quote}:${o.ref.pool}:${how}`.toLowerCase();
/** The two coins, either way round: PLS/DAI on PulseX V1 and DAI/PLS on V2 are the same bet on one price */
export const pairOf = (o: Pick<Opportunity, 'chainId' | 'stack' | 'spend'>) => `${o.chainId}:${[o.stack, o.spend].sort().join('/')}`;

const riskOk = (o: Opportunity, risk: Risk) => risk === 'any' || o.risk == null || o.risk === 'low' || (risk === 'medium' && o.risk === 'medium');
const way = (how: 'grid' | 'lp') => (how === 'lp' ? 'as a liquidity range' : 'as a grid');

/**
 * Every way to use the chain's pools that the options allow and that has an estimate, best score first (a score may be
 * 0 or less: a held bot is still compared on it). `gone` = the ways of the scanned pools that were measured and aren't
 * candidates, with why. A way with no evidence either way (its liquidity test failed to run, or its coin has no price
 * right now) is in neither. reach(coin) = the share lost swapping the budget's coin into `coin` and back (0 for the
 * budget's own coin) and budget coins per unit of it (null: no price yet); null when there is no route.
 */
export function candidates(items: Opportunity[], opt: PlanOptions, reach: (coin: string) => { cost: number; rate: number | null } | null): { cands: Candidate[]; gone: Map<string, string> } {
  const cands: Candidate[] = [], gone = new Map<string, string>();
  for (const o of items) {
    const r = reach(o.spend);
    if (r && r.rate == null) continue; // no price for its coin right now: no evidence either way
    const all = !o.liveAllowed ? 'it failed its latest safety check'
      : !riskOk(o, opt.risk) ? `its risk is ${o.risk}, above what you allowed`
        : !opt.newTokens && o.key == null ? 'new tokens are off'
          : r == null ? `no route from the budget's coin to ${o.spend}` : null;
    for (const how of ['grid', 'lp'] as const) {
      if (how === 'lp' && o.lpFailed) continue; // its liquidity test failed to run (a read failed): no evidence
      const id = poolId(o, how), e = how === 'grid' ? expectedGrid(o) : expectedLp(o);
      const why = all ?? (how === 'grid' && !opt.grid ? 'grids are off'
        : how === 'lp' && !opt.lp ? 'liquidity ranges are off'
          : e == null ? (how === 'grid' ? o.gridWhy : o.lpWhy) ?? 'it earned nothing in the test week' : null);
      if (why != null) { gone.set(id, why); continue; }
      cands.push({ id, pair: pairOf(o), how, expected: e!, cost: r!.cost, score: e! - r!.cost, feeBps: o.feeBps, label: o.label, maxCapital: o.capital * r!.rate!, o });
    }
  }
  return { cands: cands.sort((a, b) => b.score - a.score), gone };
}

export const switchCost = (fromBps: number, toBps: number) => (fromBps + toBps) / 10_000;
const pc = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(Math.abs(x) < 0.001 ? 2 : 1)}%`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const num = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : String(Number(x.toPrecision(4))));

/** The best way per coin pair, best score first */
function bestPerPair(cs: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const c of cs) { const cur = best.get(c.pair); if (!cur || c.score > cur.score) best.set(c.pair, c); }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * One review of one budget: what to keep, retire and open. `cash` = the budget's money not in a bot, in its coin.
 * Decisions come in the order of `held`, then the opens.
 */
export function planBudget(p: { now: number; budget: number; cash: number; slots: number; cands: Candidate[]; gone: Map<string, string>; held: Held[]; parked: Parked[] }): Decision[] {
  const byId = new Map(p.cands.map((c) => [c.id, c]));
  const taken = new Set([...p.held, ...p.parked].map((h) => h.pair));
  const free = bestPerPair(p.cands.filter((c) => !taken.has(c.pair) && c.score > 0));
  const closing = p.parked.filter((r) => r.closing), stopped = p.parked.length - closing.length;
  // A stopped bot keeps its slot: the running bots have the rest
  const runSlots = p.slots - stopped;
  // Pairs spoken for (one bot per pair): the replacement each closing bot's money is waiting for
  const altOf = (r: Parked) => (r.alt ? byId.get(r.alt) ?? null : null);
  const use = new Set(closing.flatMap((r) => { const a = altOf(r); return a ? [a.pair] : []; }));
  // Staying is worth the held way's estimate (its swap in is paid); against a way spending the same coin, its score.
  const stay = (cur: Candidate, alt: Candidate) => cur.expected - (alt.o.spend === cur.o.spend ? cur.cost : 0);
  // What it runs (at what staying earns) and the pools it doesn't (at their score), best first: an open's rank
  const standing = [...p.held.flatMap((h) => { const c = byId.get(h.pool); return c ? [{ id: h.pool, v: c.expected }] : []; }), ...free.map((c) => ({ id: c.id, v: c.score }))]
    .sort((a, b) => b.v - a.v);
  const rank = (id: string) => standing.findIndex((s) => s.id === id);
  // How many of the bots it runs and the pools it doesn't would earn more than this bot staying
  const beaten = (h: Held, cur: Candidate) => p.held.filter((x) => x !== h && (byId.get(x.pool)?.expected ?? -Infinity) > cur.expected).length
    + free.filter((c) => c.score > stay(cur, c)).length;

  // Money not in a bot opens the best pools not run in the free slots (bots closing or stopped keep theirs); a pair a
  // closing bot is replaced on waits for that bot's money.
  const out = new Map<string, Decision>(), opens: Decision[] = [];
  const slotsFree = p.slots - p.held.length - p.parked.length;
  if (slotsFree > 0 && p.cash > 0) {
    const pick = free.filter((c) => !use.has(c.pair)).slice(0, slotsFree);
    const piece = p.cash / pick.length;
    if (!pick.length) opens.push({ kind: 'wait', why: free.length ? "the pools expected to earn are run, or kept for a closing bot's money" : p.cands.some((c) => c.score > 0) ? 'every pool expected to earn is already run' : 'no pool is expected to earn with these options' });
    else if (piece < MIN_PIECE * (p.budget / p.slots)) opens.push({ kind: 'wait', why: `${piece.toPrecision(4)} a bot is too little (under a quarter of an even share)` });
    else for (const c of pick) {
      use.add(c.pair);
      const capital = Math.min(piece, c.maxCapital);
      opens.push({ kind: 'open', cand: c, capital, why: `#${rank(c.id) + 1} of ${standing.length}: expected ${pc(c.expected)} a week ${way(c.how)}${c.cost ? `, ${pc(c.score)} after ${pc(c.cost)} for swapping into ${c.o.spend} and back` : ''}${capital < piece ? `; ${num(capital)} is the size it was tested at, so the rest waits` : ''}` });
    }
  }
  // A closing bot replaced by nothing frees its slot when its money is back, and that money opens the best way then
  // free: those ways are spoken for too, so a replacement decided now is measured against what is really left.
  const refill = Math.max(0, Math.min(closing.filter((r) => !altOf(r)).length, p.slots - p.held.length - stopped - closing.filter((r) => altOf(r)).length - opens.filter((d) => d.kind === 'open').length));
  for (const c of free.filter((c) => !use.has(c.pair)).slice(0, refill)) use.add(c.pair);

  const fresh = p.held.filter((h) => p.now - h.openedAt < HOLD_MS);
  for (const h of fresh) out.set(h.id, { kind: 'keep', id: h.id, why: `in its first week (until ${day(h.openedAt + HOLD_MS)})` });
  const past = p.held.filter((h) => p.now - h.openedAt >= HOLD_MS);
  const retire = (h: Held, alt: Candidate | null, why: string) => { out.set(h.id, { kind: 'retire', id: h.id, alt: alt?.id ?? null, why }); if (alt) use.add(alt.pair); };
  // The best way not yet spoken for: of the pools it doesn't run, or another way of the bot's own pair
  const best = (cs: Candidate[]) => cs.filter((c) => !use.has(c.pair)).sort((a, b) => b.score - a.score)[0] ?? null;
  const ownPair = (h: Held) => best(p.cands.filter((c) => c.pair === h.pair && c.id !== h.pool && c.score > 0));
  const altFor = (h: Held) => best([...free, ...p.cands.filter((c) => c.pair === h.pair && c.id !== h.pool && c.score > 0)]);
  /**
   * Replaced for `alt` when that earns more than staying by more than switching costs; otherwise kept, with why. The
   * new way takes at most the size it was tested at, and the rest of the bot's money would wait: compared in money.
   */
  const versus = (h: Held, cur: Candidate, alt: Candidate) => {
    const cost = switchCost(h.feeBps, alt.feeBps), now = stay(cur, alt), share = Math.min(1, alt.maxCapital / h.capital), gain = alt.score * share - now;
    if (gain > cost) {
      retire(h, alt, `${alt.label} is expected to earn ${pc(alt.score)} a week ${way(alt.how)} against ${pc(now)} here, more than the ${pc(cost)} switching costs${share < 1 ? ` (on the ${num(alt.maxCapital)} it was tested at; the rest waits)` : ''}`);
      return true;
    }
    out.set(h.id, { kind: 'keep', id: h.id, why: gain > 0 ? `the best way it doesn't run earns only ${pc(gain)} more${share < 1 ? ` (it was tested at ${num(alt.maxCapital)}, under this bot's ${num(h.capital)})` : ''}, under the ${pc(cost)} switching costs` : `expected ${pc(now)} a week; nothing better` });
    return false;
  };

  for (const h of past) {
    if (byId.has(h.pool)) continue;
    const why = p.gone.get(h.pool);
    if (why == null) { out.set(h.id, { kind: 'keep', id: h.id, why: "its pool isn't measured in today's scan (its test failed, or its coin has no price right now), so there is nothing to judge it on" }); continue; }
    const alt = altFor(h);
    retire(h, alt, `${why}${alt ? `; ${alt.label} is expected to earn ${pc(alt.score)} a week ${way(alt.how)}` : ''}`);
  }
  // More bots than slots (the setting was lowered): the weakest past their first week go, never one of the best that
  // fit; a bot in its first week goes once its week is over.
  const top = new Set(p.held.filter((h) => byId.has(h.pool)).sort((a, b) => byId.get(b.pool)!.expected - byId.get(a.pool)!.expected).slice(0, Math.max(0, runSlots)).map((h) => h.id));
  // Weakest first: the best way free goes to replacing the worst bot
  const measured = past.filter((h) => byId.has(h.pool)).sort((a, b) => byId.get(a.pool)!.expected - byId.get(b.pool)!.expected);
  let over = p.held.length + stopped - [...out.values()].filter((d) => d.kind === 'retire').length - p.slots;
  for (const h of measured) {
    const cur = byId.get(h.pool)!;
    if (over > 0 && !top.has(h.id)) { over--; retire(h, null, `more bots than the ${p.slots} per budget now set; it is among the weakest (expected ${pc(cur.expected)} a week), and its money waits`); continue; }
    // A better way on its own pair (its range instead of its grid, the pair's other pool) replaces it in its slot
    const own = ownPair(h);
    if (own && versus(h, cur, own)) continue;
    const r = beaten(h, cur);
    if (r < runSlots) { out.set(h.id, { kind: 'keep', id: h.id, why: `still among the best: #${r + 1}, expected ${pc(cur.expected)} a week` }); continue; }
    const alt = altFor(h);
    if (!alt) { out.set(h.id, { kind: 'keep', id: h.id, why: `expected ${pc(cur.expected)} a week; nothing better` }); continue; }
    versus(h, cur, alt);
  }
  return [...p.held.map((h) => out.get(h.id)!), ...opens];
}
