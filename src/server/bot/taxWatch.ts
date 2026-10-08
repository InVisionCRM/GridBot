/**
 * Tax watcher: re-runs the eth_call safety probe for every CUSTOM market a bot is using, every TAX_RECHECK_MIN
 * minutes (default 30) and immediately when an engine reports something suspicious (swap reverted, fill short of
 * the post-tax quote). If any tax rose by more than TAX_RISE_EPS (0.5 pp), the token became a honeypot / paused /
 * otherwise blocked, every bot on that market is paused and a notifying alert is emitted. Resuming is manual.
 */
import type { SafetyReport } from '../../live/markets';
import { TAX_RISE_EPS, fmtTax, taxRise, taxesOf } from '../../live/tax';

export interface TaxWatchDeps {
  now(): number;
  /** Custom market keys with at least one running (or in-flight) bot */
  markets(): string[];
  current(key: string): SafetyReport | undefined;
  recheck(key: string): Promise<SafetyReport>;
  /** Pause every bot on the market; returns how many were running */
  pause(key: string, why: string): number;
  alert(key: string, level: 'info' | 'warn' | 'error', msg: string, notify: boolean): void;
  label(key: string): string;
  intervalMs?: number;
  /** Minimum gap between two suspicion-triggered checks of one market */
  debounceMs?: number;
}

export interface TaxCheck { key: string; rose: string | null; blocked: boolean; paused: number; report: SafetyReport | null; error?: string }

export class TaxWatch {
  readonly intervalMs: number;
  private last = new Map<string, number>();
  private busy = new Set<string>();
  constructor(private readonly d: TaxWatchDeps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = Number((globalThis as any)?.process?.env?.TAX_RECHECK_MIN);
    this.intervalMs = d.intervalMs ?? (Number.isFinite(env) && env > 0 ? env * 60_000 : 30 * 60_000);
  }

  /** Periodic pass: re-check markets whose last check is older than the interval. */
  async tick(): Promise<TaxCheck[]> {
    const now = this.d.now();
    const due = this.d.markets().filter((k) => now - (this.last.get(k) ?? this.d.current(k)?.at ?? 0) >= this.intervalMs);
    const out: TaxCheck[] = [];
    for (const k of due) { const r = await this.check(k, 'scheduled'); if (r) out.push(r); }
    return out;
  }

  /** Suspicion from an engine (debounced per market). */
  async suspect(key: string, why: string): Promise<TaxCheck | null> {
    const at = this.last.get(key) ?? 0;
    if (this.d.now() - at < (this.d.debounceMs ?? 60_000)) return null;
    return this.check(key, why);
  }

  async check(key: string, why: string): Promise<TaxCheck | null> {
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    this.last.set(key, this.d.now());
    const prev = this.d.current(key);
    const label = this.d.label(key);
    try {
      let next: SafetyReport;
      try { next = await this.d.recheck(key); } catch (e) {
        const msg = (e as Error).message.slice(0, 160);
        // A failed re-check after a suspicious event is treated as unsafe; a failed scheduled one only warns.
        if (why !== 'scheduled') {
          const n = this.d.pause(key, `tax re-check failed after ${why}: ${msg}`);
          this.d.alert(key, 'error', `${label}: tax re-check FAILED after ${why} — ${n} bot(s) paused (${msg})`, true);
          return { key, rose: null, blocked: true, paused: n, report: null, error: msg };
        }
        this.d.alert(key, 'warn', `${label}: scheduled tax re-check failed (${msg}); will retry`, false);
        return { key, rose: null, blocked: false, paused: 0, report: null, error: msg };
      }
      const rose = taxRise(taxesOf(prev), taxesOf(next), TAX_RISE_EPS);
      const blocked = !!prev?.liveAllowed && !next.liveAllowed;
      const bad = rose || blocked || next.honeypot === true || next.paused === true;
      if (bad) {
        const what = [rose && `tax rose (${rose})`, blocked && `now ${next.risk}: ${next.reasons[0] ?? ''}`, next.honeypot && 'honeypot', next.paused && 'trading paused'].filter(Boolean).join('; ');
        const n = this.d.pause(key, what);
        this.d.alert(key, 'error', `${label}: ${what} — ${n} bot(s) paused. Review the token card, then resume manually.`, true);
        return { key, rose, blocked: true, paused: n, report: next };
      }
      if (why !== 'scheduled') this.d.alert(key, 'info', `${label}: tax re-check after ${why} — unchanged (${fmtTax(taxesOf(next))})`, false);
      return { key, rose: null, blocked: false, paused: 0, report: next };
    } finally {
      this.busy.delete(key);
    }
  }
}
