/**
 * One status computation per push for every stream client, and the v2 delta stream (docs/stream-v2.md).
 * Before: each open stream called bot.status() itself and sent the whole object (every bot's last 100 trades and
 * 600 equity points) once a second. Now the status is computed once per push, and v2 clients get only what changed.
 */
import { randomBytes } from 'node:crypto';
import { diff, type Op } from '../live/delta';

export interface StatusPatch { seq: number; t: number; ops: Op[] }

export class StatusFeed {
  /** Changes when the server restarts: a client that sees a new epoch resyncs */
  readonly epoch = randomBytes(6).toString('hex');
  seq = 0;
  private snap: unknown = null;
  private snapJson = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  private readonly full = new Set<(s: unknown) => void>();
  private readonly patches = new Set<(p: StatusPatch) => void>();

  constructor(private readonly compute: () => unknown, private readonly throttleMs = 1000, private readonly now = () => Date.now()) {}

  /** The current status and its sequence number (a new client's starting point). */
  snapshot(): { seq: number; status: unknown } {
    // With no client connected nothing kept the snapshot current: take a fresh one.
    if (this.snap == null || !this.listeners) { this.refresh(); this.seq++; }
    return { seq: this.seq, status: this.snap };
  }

  onFull(f: (s: unknown) => void) { this.full.add(f); return () => { this.full.delete(f); }; }
  onPatch(f: (p: StatusPatch) => void) { this.patches.add(f); return () => { this.patches.delete(f); }; }
  get listeners() { return this.full.size + this.patches.size; }

  /** Something changed: push at most once per throttle window. */
  poke() {
    if (this.timer || !this.listeners) return;
    const wait = Math.max(0, this.throttleMs - (this.now() - this.last));
    this.timer = setTimeout(() => { this.timer = null; this.last = this.now(); this.push(); }, wait);
  }

  /** Compute the status once and send it: whole to v1 clients, as ops to v2 clients (nothing when nothing changed). */
  push() {
    let raw: unknown;
    try { raw = this.compute(); } catch { return; }
    const json = JSON.stringify(raw);
    for (const f of this.full) f(raw);
    if (json === this.snapJson) return;
    const next = JSON.parse(json);
    const ops = this.snap == null ? [['s', [], next] as Op] : diff(this.snap, next);
    this.snap = next; this.snapJson = json;
    if (!ops.length) return;
    this.seq++;
    const p = { seq: this.seq, t: this.now(), ops };
    for (const f of this.patches) f(p);
  }

  private refresh() {
    try {
      const json = JSON.stringify(this.compute());
      this.snap = JSON.parse(json); this.snapJson = json;
    } catch { /* keep */ }
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
