/**
 * The Token trader page's figures (pure): the three styles, the scorecard of closed sells, the radar's blips and the
 * discovery cycle. A position's exit distances come from the server (market/tokenTrader.ts exitTargets).
 */
import type { AnyObj } from './model';

export type StyleId = 'careful' | 'balanced' | 'wild';
type Patch = {
  risk: 'safe' | 'medium' | 'any'; enforceWashAndAge: boolean; enforceOwnerPowers: boolean;
  enforceLiquidityFloor: boolean; enforceHolderCheck: boolean; enforceSizeImpact: boolean;
};
export interface Style { id: StyleId; name: string; line: string; patch: Patch }

/** One click sets the risk level and the optional checks together. Anything else set by hand shows as Custom. */
export const STYLES: Style[] = [
  {
    id: 'careful', name: 'Careful', line: 'Low-risk coins only, every extra check on: pool age and wash volume, owner powers, holders, the liquidity floor, impact at the real size.',
    patch: { risk: 'safe', enforceWashAndAge: true, enforceOwnerPowers: true, enforceLiquidityFloor: true, enforceHolderCheck: true, enforceSizeImpact: true },
  },
  {
    id: 'balanced', name: 'Balanced', line: 'Also coins with a tax (launcher pools) or an upgradeable contract. Age, wash, owner and impact checks stay on; no holder check (it reads too few holders on most new launcher coins) and no liquidity floor.',
    patch: { risk: 'medium', enforceWashAndAge: true, enforceOwnerPowers: true, enforceLiquidityFloor: false, enforceHolderCheck: false, enforceSizeImpact: true },
  },
  {
    id: 'wild', name: 'Wild', line: 'Anything the safety check lets trade, brand-new pools included. The extra checks are off; honeypots and sell-blocked coins are still refused.',
    patch: { risk: 'any', enforceWashAndAge: false, enforceOwnerPowers: false, enforceLiquidityFloor: false, enforceHolderCheck: false, enforceSizeImpact: false },
  },
];

/** The style these options match exactly, or null (set by hand: Custom). */
export function styleOf(o: AnyObj | null | undefined): StyleId | null {
  if (!o) return null;
  const hit = STYLES.find((s) => (Object.keys(s.patch) as (keyof Patch)[]).every((k) => (o[k] ?? false) === s.patch[k]));
  return hit?.id ?? null;
}

export interface Scorecard { sells: number; wins: number; winRate: number | null; best: AnyObj | null; worst: AnyObj | null }
/** Closed sells with a result: how many won, the best and the worst (by their result in dollars, shown in coins) */
export function scorecard(trades: AnyObj[] | null | undefined): Scorecard {
  const sells = (trades ?? []).filter((t) => t.side === 'sell' && t.pnlUsd != null && Number.isFinite(t.pnlUsd));
  const wins = sells.filter((t) => t.pnlUsd > 0).length;
  const by = [...sells].sort((a, b) => b.pnlUsd - a.pnlUsd);
  return { sells: sells.length, wins, winRate: sells.length ? wins / sells.length : null, best: by[0] ?? null, worst: by.length ? by[by.length - 1] : null };
}

/** A pool always lands on the same spot of the radar */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export type Tone = 'bought' | 'checks' | 'rules' | 'buy';
/** How far in a coin got: the edge of the radar is the rules, the middle the buy (the core = bought) */
export const DEPTH: Record<Tone, number> = { rules: 0.86, checks: 0.62, buy: 0.4, bought: 0.18 };

export interface Sector { chainId: number; from: number; to: number; mid: number }
/** One slice of the radar per chain the trader reads, clockwise from the top (radians) */
export function radarSectors(chains: number[]): Sector[] {
  const n = Math.max(1, chains.length), w = (2 * Math.PI) / n;
  return chains.map((chainId, i) => ({ chainId, from: -Math.PI / 2 + i * w, to: -Math.PI / 2 + (i + 1) * w, mid: -Math.PI / 2 + (i + 0.5) * w }));
}

export interface Blip { key: string; x: number; y: number; tone: Tone; fade: number; label: string }
/** Blips fade over this long */
export const BLIP_LIFE_MS = 15 * 60_000;
/**
 * The newest feed items as blips: in their chain's slice, at the depth they reached (DEPTH). x, y in 0..100 (percent
 * of the radar); fade 1 (new) … 0.2 (old). A coin of a chain not in `chains` has no slice and is left out.
 */
export function radarBlips(feed: AnyObj[] | null | undefined, now: number, chains: number[], max = 24): Blip[] {
  const sectors = radarSectors(chains);
  return (feed ?? []).slice(0, max).flatMap((f) => {
    const sec = sectors.find((x) => x.chainId === f.chainId);
    if (!sec) return [];
    const h = hash(`${f.chainId}:${f.pool}`);
    const tone: Tone = f.verdict === 'bought' ? 'bought' : f.stage === 'checks' ? 'checks' : f.stage === 'buy' ? 'buy' : 'rules';
    const a = sec.from + (0.12 + ((h % 1000) / 1000) * 0.76) * (sec.to - sec.from);
    const r = DEPTH[tone] + ((((h >>> 10) % 100) / 100) - 0.5) * 0.1;
    const age = Math.max(0, now - Number(f.t));
    return [{ key: `${f.chainId}:${f.pool}:${f.t}`, x: 50 + Math.cos(a) * r * 50, y: 50 + Math.sin(a) * r * 50, tone, fade: Math.max(0.2, 1 - age / BLIP_LIFE_MS), label: String(f.label) }];
  });
}

/**
 * Where discovery is in its cycle (status.look: the last run and how often it runs): `elapsed` since the last run and
 * `inMs` until the next one is due (0 = due now; the trader checks every 10 s). null = no run yet.
 */
export function lookCycle(look: AnyObj | null | undefined, now: number): { elapsed: number; everyMs: number; inMs: number } | null {
  const at = Number(look?.last?.at), every = Number(look?.everyMs);
  if (!Number.isFinite(at) || !(every > 0)) return null;
  const elapsed = Math.max(0, now - at);
  return { elapsed, everyMs: every, inMs: Math.max(0, every - elapsed) };
}

export interface TrackMark { key: string; at: number; x: number; done: boolean }
export interface ExitTrack {
  /** The result now after costs (the exit math's), and its place on the track (0..100) */
  now: number; x: number;
  /** The track runs from the stop (left) to the last take-profit (right) */
  lo: number; hi: number;
  marks: TrackMark[];
  /** Share of the time stop's span gone (0..1), and whether the time stop is off (up enough) */
  time: { frac: number; msLeft: number; off: boolean } | null;
}
/**
 * A position's exits on one line, from status `exits` (exitTargets). The result now comes from the stop: it fires at
 * `at` after a move of `move` from here, so (1 + now)(1 + move) = 1 + at. An armed trail has no fixed level: its
 * place is the result it would fire at from here. null when the stop has no distance (no price read yet).
 */
export function exitTrack(exits: AnyObj[] | null | undefined): ExitTrack | null {
  const by = new Map((exits ?? []).map((e) => [e.key, e]));
  const stop = by.get('stop'), top = by.get('tp2');
  if (stop?.move == null || stop.at == null || top?.at == null) return null;
  const now = (1 + stop.at) / (1 + stop.move) - 1;
  const lo = Number(stop.at), hi = Number(top.at);
  // percent of the track, to 0.01 (a style value)
  const x = (v: number) => Math.round(Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)) * 100) / 100;
  const marks = (['stop', 'trail', 'tp1', 'tp2'] as const).flatMap((k) => {
    const e = by.get(k);
    if (!e) return [];
    const at = e.at != null ? Number(e.at) : e.move != null ? (1 + now) * (1 + e.move) - 1 : null;
    return at == null ? [] : [{ key: k, at, x: x(at), done: !!e.done }];
  });
  const t = by.get('time');
  const time = t && t.ms > 0 ? { frac: Math.max(0, Math.min(1, 1 - Number(t.msLeft) / Number(t.ms))), msLeft: Number(t.msLeft), off: String(t.does).startsWith('off') } : null;
  return { now, x: x(now), lo, hi, marks, time };
}
