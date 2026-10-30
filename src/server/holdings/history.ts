/**
 * The wallet's dollar value over time: the Wallet drawer's chart. One point per fresh holdings read, at most every
 * WORTH_EVERY_MS, with the total (dust left out, as the drawer's headline) and each chain's part. Nothing is invented
 * for the time before the first point: the chart starts the day this began recording.
 */
import type { HoldingsSnapshot } from '../../live/holdingsMath';
import type { Store } from '../bot/store';

export interface WorthPoint { t: number; usd: number; chains: Record<string, number> }
export interface WorthFile { version: 1; points: WorthPoint[] }

/** At most one point per 15 minutes */
export const WORTH_EVERY_MS = 15 * 60_000;
/** A year of 15-minute points, and some */
export const WORTH_KEPT = 40_000;
/** Points sent for one chart: enough for a smooth line at any width */
export const WORTH_SHOWN = 360;
export const WORTH_RANGES = { '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000, ALL: null } as const;
export type WorthRange = keyof typeof WORTH_RANGES;
export const isWorthRange = (v: unknown): v is WorthRange => typeof v === 'string' && v in WORTH_RANGES;

export class WalletHistory {
  private points: WorthPoint[];
  constructor(private readonly store: Store<WorthFile>, private readonly now: () => number = Date.now) {
    const f = store.load();
    if (f && f.version !== 1) throw new Error(`wallet history: unknown version ${String((f as { version?: unknown }).version)}`);
    this.points = f?.points ?? [];
  }

  /** A fresh holdings read. Kept when it has a wallet, a total, and the last point is WORTH_EVERY_MS old. */
  note(s: HoldingsSnapshot): boolean {
    if (!s.hasSigner || s.netWorthExDustUsd == null) return false;
    const last = this.points[this.points.length - 1];
    if (last && s.at - last.t < WORTH_EVERY_MS) return false;
    const chains: Record<string, number> = {};
    for (const c of s.chains) chains[String(c.chainId)] = c.usd;
    this.points.push({ t: s.at, usd: s.netWorthExDustUsd, chains });
    if (this.points.length > WORTH_KEPT) this.points.splice(0, this.points.length - WORTH_KEPT);
    this.store.save({ version: 1, points: this.points });
    return true;
  }

  /** The points in `range` (one chain's part with `chainId`), thinned evenly to WORTH_SHOWN, the last one always kept */
  series(range: WorthRange, chainId: number | null): { t: number; usd: number }[] {
    const span = WORTH_RANGES[range], from = span == null ? -Infinity : this.now() - span;
    const pts = this.points.filter((p) => p.t >= from).map((p) => ({ t: p.t, usd: chainId == null ? p.usd : p.chains[String(chainId)] ?? 0 }));
    if (pts.length <= WORTH_SHOWN) return pts;
    const step = pts.length / WORTH_SHOWN, out: { t: number; usd: number }[] = [];
    for (let i = 0; i < WORTH_SHOWN - 1; i++) out.push(pts[Math.floor(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
  }
}
