/**
 * The smart trader's decisions for one budget (pure; the server side is server/bot/autopilot.ts). Its inputs are every
 * pool the scan found on the budget's chain, each with what it is expected to earn next week (market/scan.ts, fitted on
 * the walk-forward in the README), and the bots it runs now. A pool that spends another coin than the budget's (ETH
 * pools for a USDG budget) is reached by swapping into that coin and back: its score is its estimate less those
 * swaps' pool fees (`convertCost`), and every comparison uses the score. The rules:
 *  - up to `slots` bots, best expected first; money not in a bot is split evenly over the bots it opens
 *  - a bot keeps its first week (HOLD_MS): the estimates are about a week, and switching costs money
 *  - after that, a bot whose pool is still among the best `slots` stays; otherwise it is replaced when a pool it doesn't
 *    run is expected to earn more than it by more than switching costs (selling back through its pool, buying in
 *    through the new one: the two pools' fees, a cautious estimate), or when its pool no longer has an estimate
 *  - one bot per coin pair: two pools of one pair (PLS/DAI on PulseX V1 and V2) are one bet on one price
 *  - a piece under MIN_PIECE of an even share isn't worth a bot's costs: it waits
 */
import { expectedGrid, expectedLp, type Opportunity } from './scan';

export const HOLD_MS = 7 * 86_400_000;
export const MIN_PIECE = 0.25;

export type Risk = 'safe' | 'medium' | 'any';
export interface PlanOptions { grid: boolean; lp: boolean; newTokens: boolean; risk: Risk; slots: number }

/**
 * A way to use a pool. id = the pool and the way (a grid and a range on one pool are two); expected = its estimate;
 * cost = swapping the budget's coin into the pool's coin and back (0 when it spends the budget's coin); score = the two.
 */
export interface Candidate { id: string; pair: string; how: 'grid' | 'lp'; expected: number; cost: number; score: number; feeBps: number; label: string; o: Opportunity }
/** A bot the trader runs: id = the bot, pool = its Candidate id, pair = its coins */
export interface Held { id: string; pool: string; pair: string; label: string; openedAt: number; feeBps: number }

export type Decision =
  | { kind: 'open'; cand: Candidate; capital: number; why: string }
  | { kind: 'retire'; id: string; why: string }
  | { kind: 'keep'; id: string; why: string }
  | { kind: 'wait'; why: string };

export const poolId = (o: Pick<Opportunity, 'chainId' | 'key' | 'add'>, how: 'grid' | 'lp') => `${o.chainId}:${o.add?.pool ?? o.key}:${how}`;
/** The two coins, either way round: PLS/DAI on PulseX V1 and DAI/PLS on V2 are the same bet on one price */
export const pairOf = (o: Pick<Opportunity, 'chainId' | 'stack' | 'spend'>) => `${o.chainId}:${[o.stack, o.spend].sort().join('/')}`;

const allowed = (o: Opportunity, risk: Risk) =>
  o.liveAllowed && (risk === 'any' || o.risk == null || o.risk === 'low' || (risk === 'medium' && o.risk === 'medium'));

/**
 * Every way to use the chain's pools that the options allow, best score first. convertCost(coin) = the share lost
 * swapping the budget's coin into `coin` and back (0 for the budget's own coin), null when there is no route.
 * entryCost(pool, way) = the share the entry swap costs at the size that will actually be deployed, or null when
 * even a small size cannot enter under the price-impact cap (that way is dropped).
 */
export function candidates(items: Opportunity[], opt: PlanOptions, convertCost: (coin: string) => number | null, entryCost?: (o: Opportunity, how: 'grid' | 'lp') => number | null): Candidate[] {
  const out: Candidate[] = [];
  for (const o of items) {
    if (!allowed(o, opt.risk) || (!opt.newTokens && o.key == null)) continue;
    const cost = convertCost(o.spend);
    if (cost == null) continue;
    const g = opt.grid ? expectedGrid(o) : null, l = opt.lp ? expectedLp(o) : null;
    for (const [how, e] of [['grid', g], ['lp', l]] as const) {
      if (e == null) continue;
      const entry = entryCost?.(o, how) ?? 0;
      if (entry == null) continue;
      if (e - cost - entry > 0) out.push({ id: poolId(o, how), pair: pairOf(o), how, expected: e, cost, score: e - cost - entry, feeBps: o.feeBps, label: o.label, o });
    }
  }
  // one per coin pair (the best pool and way): two pools of one pair are one bet on one price
  const best = new Map<string, Candidate>();
  for (const c of out) {
    const cur = best.get(c.pair);
    if (!cur || c.score > cur.score) best.set(c.pair, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export const switchCost = (fromBps: number, toBps: number) => (fromBps + toBps) / 10_000;
const pc = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(Math.abs(x) < 0.001 ? 2 : 1)}%`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** One review of one budget: what to keep, retire and open. `cash` = the budget's money not in a bot. */
export function planBudget(p: { now: number; budget: number; cash: number; slots: number; cands: Candidate[]; held: Held[] }): Decision[] {
  const out: Decision[] = [];
  const rank = new Map(p.cands.map((c, i) => [c.id, i]));
  const run = new Set(p.held.map((h) => h.pool)), pairs = new Set(p.held.map((h) => h.pair));
  const free = p.cands.filter((c) => !run.has(c.id) && !pairs.has(c.pair));
  const taken = new Set<string>();
  for (const h of p.held) {
    const r = rank.get(h.pool), cur = r == null ? null : p.cands[r];
    if (p.now - h.openedAt < HOLD_MS) { out.push({ kind: 'keep', id: h.id, why: `in its first week (until ${day(h.openedAt + HOLD_MS)})` }); continue; }
    if (cur && r! < p.slots) { out.push({ kind: 'keep', id: h.id, why: `still among the best: #${r! + 1}, expected ${pc(cur.score)} a week` }); continue; }
    const alt = free.find((c) => !taken.has(c.id));
    if (!cur) { out.push({ kind: 'retire', id: h.id, why: `its pool no longer earns${alt ? `; ${alt.label} is expected to earn ${pc(alt.score)} a week` : ''}` }); if (alt) taken.add(alt.id); continue; }
    const cost = alt ? switchCost(h.feeBps, alt.feeBps) : 0;
    if (alt && alt.score - cur.score > cost) {
      out.push({ kind: 'retire', id: h.id, why: `${alt.label} is expected to earn ${pc(alt.score)} a week against ${pc(cur.score)} here, more than the ${pc(cost)} switching costs` });
      taken.add(alt.id);
    } else {
      out.push({ kind: 'keep', id: h.id, why: alt ? `the best pool it doesn't run earns only ${pc(alt.score - cur.score)} more, under the ${pc(cost)} switching costs` : `expected ${pc(cur.score)} a week; nothing better` });
    }
  }
  // Money not in a bot goes to the best pools not run (as many as there are free slots), split evenly. Retiring bots
  // still hold their slot: their money comes back first.
  const slotsFree = p.slots - p.held.length;
  if (slotsFree <= 0 || p.cash <= 0) return out;
  const opens = free.slice(0, slotsFree);
  if (!opens.length) { out.push({ kind: 'wait', why: p.cands.length ? 'every pool expected to earn is already run' : 'no pool is expected to earn with these options' }); return out; }
  const piece = p.cash / opens.length;
  if (piece < MIN_PIECE * (p.budget / p.slots)) { out.push({ kind: 'wait', why: `${piece.toPrecision(4)} a bot is too little (under a quarter of an even share)` }); return out; }
  for (const c of opens) out.push({ kind: 'open', cand: c, capital: piece, why: `#${rank.get(c.id)! + 1} of ${p.cands.length}: expected ${pc(c.expected)} a week as a ${c.how === 'lp' ? 'liquidity range' : 'grid'}${c.cost ? `, ${pc(c.score)} after ${pc(c.cost)} for swapping into ${c.o.spend} and back` : ''}` });
  return out;
}
