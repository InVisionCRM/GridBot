/** Read-only watch of liquidity ranges. It never moves a position or sends a transaction. */
import { LP_OUT_MS } from '../../live/pushRules';
import { pctToEdge, rangeZone, type RangeZone } from '../../live/rangeBand';

export interface LpSnap {
  id: string;
  label: string;
  chainId: number;
  price: number;
  lower: number;
  upper: number;
  inRange: boolean | null;
  outSince: number | null;
}

export interface LpNote {
  id: string;
  kind: 'near' | 'out';
  title: string;
  body: string;
  tag: string;
}

function sig(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toPrecision(6);
}

export function lpSnapsFromStatus(status: unknown): LpSnap[] {
  const s = status && typeof status === 'object' ? status as { lps?: unknown } : {};
  const out: LpSnap[] = [];
  for (const raw of Array.isArray(s.lps) ? s.lps : []) {
    if (!raw || typeof raw !== 'object') continue;
    const lp = raw as Record<string, unknown>;
    const pos = lp.position && typeof lp.position === 'object' ? lp.position as Record<string, unknown> : null;
    if (!pos || lp.archivedAt || lp.status === 'closed' || lp.status === 'idle') continue;
    const id = typeof lp.id === 'string' ? lp.id : '';
    const lower = pos.lower, upper = pos.upper, price = lp.price;
    if (!id || typeof lower !== 'number' || typeof upper !== 'number' || typeof price !== 'number') continue;
    if (!(upper > lower) || !Number.isFinite(price)) continue;
    out.push({
      id, label: typeof lp.label === 'string' && lp.label ? lp.label : 'Liquidity',
      chainId: typeof lp.chainId === 'number' ? lp.chainId : 0,
      price, lower, upper,
      inRange: typeof lp.inRange === 'boolean' ? lp.inRange : null,
      outSince: typeof lp.outSince === 'number' ? lp.outSince : null,
    });
  }
  return out;
}

export class LpWatch {
  private zone = new Map<string, RangeZone>();
  private outAt = new Map<string, number>();
  private toldOut = new Set<string>();

  constructor(private readonly now: () => number = Date.now, private readonly outMs = LP_OUT_MS) {}

  /** An auto-move event already told the phone. Skip the "out for 10 min" push for this stay outside. */
  suppressOut(id: string) { if (id) this.toldOut.add(id); }

  /**
   * The first sight of a position only records where it is, so a restart does not repeat an alert
   * the phone already had. Later crossings do.
   */
  update(snaps: LpSnap[]): LpNote[] {
    const notes: LpNote[] = [];
    const now = this.now();
    const seen = new Set<string>();
    for (const s of snaps) {
      seen.add(s.id);
      const prev = this.zone.get(s.id) ?? null;
      const zone = rangeZone(s.price, s.lower, s.upper, s.inRange, prev);
      this.zone.set(s.id, zone);
      if (prev == null) {
        if (zone === 'out') this.outAt.set(s.id, s.outSince ?? now);
        continue;
      }
      if (zone === 'near' && prev === 'in') notes.push(this.near(s));
      if (zone === 'out') {
        if (prev !== 'out') this.outAt.set(s.id, s.outSince ?? now);
        const since = this.outAt.get(s.id) ?? s.outSince ?? now;
        // Told only after a push is actually handed off (suppressOut). While the toggle or quiet hours
        // hold it back, the note stays available for a later tick.
        if (!this.toldOut.has(s.id) && now - since >= this.outMs) notes.push(this.out(s, now - since));
      } else {
        this.outAt.delete(s.id);
        this.toldOut.delete(s.id);
      }
    }
    for (const id of [...this.zone.keys()]) if (!seen.has(id)) {
      this.zone.delete(id);
      this.outAt.delete(id);
      this.toldOut.delete(id);
    }
    return notes;
  }

  private near(s: LpSnap): LpNote {
    const pct = pctToEdge(s.price, s.lower, s.upper);
    return {
      id: s.id, kind: 'near', tag: `lp-near-${s.id}`.slice(0, 64),
      title: 'GridBot · LP near edge',
      body: `${s.label}: price ${sig(s.price)} is ${pct ?? '—'}% to the edge (${sig(s.lower)}–${sig(s.upper)}).`,
    };
  }

  private out(s: LpSnap, ms: number): LpNote {
    const min = Math.max(1, Math.round(ms / 60_000));
    return {
      id: s.id, kind: 'out', tag: `lp-out-${s.id}`.slice(0, 64),
      title: 'GridBot · LP out of range',
      body: `${s.label}: out of range for ${min} min. Price ${sig(s.price)} vs ${sig(s.lower)}–${sig(s.upper)}.`,
    };
  }
}
