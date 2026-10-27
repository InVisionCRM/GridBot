/** Group a burst of grid fills into one lock-screen alert. */
import { FILL_DIGEST_LIMIT, FILL_DIGEST_QUIET_MS, FILL_DIGEST_WINDOW_MS } from '../../live/pushRules';

export interface DigestItem { title: string; body: string; tag: string }
export interface DigestSend { kind: 'send'; title: string; body: string; tag: string }
export interface DigestBatch { title: string; body: string; tag: string; count: number }

interface Held extends DigestItem { at: number }

export class FillDigester {
  private stamps: number[] = [];
  private held: Held[] = [];

  constructor(
    private readonly windowMs = FILL_DIGEST_WINDOW_MS,
    private readonly threshold = FILL_DIGEST_LIMIT,
    private readonly quietMs = FILL_DIGEST_QUIET_MS,
    private readonly now: () => number = Date.now,
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
      this.held.push({ ...item, at: t });
      return { kind: 'hold' };
    }
    return { kind: 'send', title: item.title, body: item.body, tag: item.tag };
  }

  /** One digest after the burst goes quiet, or when the window ends, whichever comes first. */
  flush(): DigestBatch | null {
    if (!this.held.length) return null;
    const t = this.now();
    const first = this.held[0].at;
    const last = this.held[this.held.length - 1].at;
    if (t - last < this.quietMs && t - first < this.windowMs) return null;
    const n = this.held.length;
    const lines = this.held.slice(0, 3).map((h) => h.body);
    const more = n > 3 ? ` (+${n - 3} more)` : '';
    const batch: DigestBatch = {
      title: `GridBot · ${n} more grid fill${n === 1 ? '' : 's'}`,
      body: `${lines.join(' · ')}${more}`,
      tag: 'grid-fill-digest',
      count: n,
    };
    this.held = [];
    return batch;
  }
}
