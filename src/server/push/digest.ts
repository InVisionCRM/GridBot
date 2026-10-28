/** Group a burst of grid fills into one lock-screen alert. */
import { FILL_DIGEST_LIMIT, FILL_DIGEST_QUIET_MS, FILL_DIGEST_WINDOW_MS } from '../../live/pushRules';

export interface DigestItem { title: string; body: string; tag: string; mode?: 'paper' | 'live' }
export interface DigestSend { kind: 'send'; title: string; body: string; tag: string; mode?: 'paper' | 'live' }
export interface DigestBatch { title: string; body: string; tag: string; count: number; mode?: 'paper' | 'live' }

/** Held lines kept for one digest. Past this, only the count grows. */
export const DIGEST_HOLD_CAP = 200;

interface Held extends DigestItem { at: number }

export class FillDigester {
  private stamps: number[] = [];
  private held: Held[] = [];
  private overflow = 0;
  private lastHeldAt = 0;

  constructor(
    private readonly windowMs = FILL_DIGEST_WINDOW_MS,
    private readonly threshold = FILL_DIGEST_LIMIT,
    private readonly quietMs = FILL_DIGEST_QUIET_MS,
    private readonly now: () => number = Date.now,
    private readonly holdCap = DIGEST_HOLD_CAP,
  ) {}

  /**
   * The first `threshold` fills in the window are sent as they happen.
   * Anything past that is held for one digest.
   */
  offer(item: DigestItem): DigestSend | { kind: 'hold' } {
    const t = this.now();
    this.stamps = this.stamps.filter((x) => t - x < this.windowMs);
    this.stamps.push(t);
    if (this.stamps.length > this.threshold) {
      if (this.held.length >= this.holdCap) this.overflow++;
      else this.held.push({ ...item, at: t });
      this.lastHeldAt = t;
      return { kind: 'hold' };
    }
    return { kind: 'send', title: item.title, body: item.body, tag: item.tag, mode: item.mode };
  }

  /**
   * One digest after the burst goes quiet, or when the window ends, whichever comes first.
   * The lines stay held until commit(), so a quiet hour (or a failed send) can try again.
   */
  flush(): DigestBatch | null {
    if (!this.held.length) return null;
    const t = this.now();
    const first = this.held[0].at;
    const last = this.lastHeldAt || this.held[this.held.length - 1].at;
    if (t - last < this.quietMs && t - first < this.windowMs) return null;
    const n = this.held.length + this.overflow;
    const lines = this.held.slice(0, 3).map((h) => h.body);
    const more = n > lines.length ? ` (+${n - lines.length} more)` : '';
    const paper = this.held.every((h) => h.mode === 'paper');
    return {
      title: `GridBot · ${n} more grid fill${n === 1 ? '' : 's'}`,
      body: `${lines.join(' · ')}${more}`,
      tag: 'grid-fill-digest',
      count: n,
      ...(paper ? { mode: 'paper' as const } : {}),
    };
  }

  /** The digest was delivered. Drop the held lines. */
  commit() {
    this.held = [];
    this.overflow = 0;
    this.lastHeldAt = 0;
  }
}
