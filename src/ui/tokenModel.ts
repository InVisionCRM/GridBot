/**
 * The Token trader page's figures (pure): the three styles, where a position sits on its exit ladder, the scorecard
 * of closed sells, and the radar's blips. Exit points are the trader's own (market/tokenTrader.ts EXIT), measured from
 * the effective entry like the server measures them.
 */
import { EXIT } from '../market/tokenTrader';
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

/** The ladder runs from the hard stop to the second take profit. */
const LO = -EXIT.hardStop, HI = EXIT.tp2;
/** 0..1 along the ladder for a gain (clamped at both ends) */
export const ladderX = (gain: number) => Math.max(0, Math.min(1, (gain - LO) / (HI - LO)));

export interface Rung { key: string; label: string; x: number; done: boolean; kind: 'stop' | 'zero' | 'arm' | 'tp' }
/** The exit points on the ladder; done = already taken (take profits) */
export function ladderRungs(p: AnyObj): Rung[] {
  return [
    { key: 'stop', label: `−${EXIT.hardStop * 100}%`, x: ladderX(-EXIT.hardStop), done: false, kind: 'stop' },
    { key: 'zero', label: '0', x: ladderX(0), done: false, kind: 'zero' },
    { key: 'arm', label: `+${EXIT.trailArm * 100}%`, x: ladderX(EXIT.trailArm), done: false, kind: 'arm' },
    { key: 'tp1', label: `+${EXIT.tp1 * 100}%`, x: ladderX(EXIT.tp1), done: !!p.tp1Done, kind: 'tp' },
    { key: 'tp2', label: `+${EXIT.tp2 * 100}%`, x: ladderX(EXIT.tp2), done: !!p.tp2Done, kind: 'tp' },
  ];
}

/** Share of the 6 h time stop used, 0..1 */
export const timeUsed = (openedAt: number, now: number) => (Number.isFinite(openedAt) ? Math.max(0, Math.min(1, (now - openedAt) / EXIT.timeStopMs)) : 0);

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
