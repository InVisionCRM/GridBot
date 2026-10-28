/**
 * Rejected token-trader candidates. They are not part of token-trader.json: that file is rewritten
 * on every tick, and a growing reject list made those saves slow enough to delay exits.
 * Passed plays stay on the trader state. Rejects append here, one JSON line at a time.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayRecord } from '../../metrics/playScore';

/** In-memory rows kept for a quick look. The scorecard reads the files, not this window. */
export const REJECT_WINDOW = 500;
/** Rotate the active file once it passes this size, and also when its mtime is a previous UTC day. */
export const REJECT_FILE_MAX = 1_048_576;

export function rejectKey(chainId: number, pool: string, reason: string | null): string {
  return `${chainId}|${pool.toLowerCase()}|${reason ?? ''}`;
}

export interface RejectSink {
  has(key: string): boolean;
  append(row: PlayRecord): void;
  window(): readonly PlayRecord[];
  /** Every stored reject. The scorecard calls this; tick() does not. */
  read(): PlayRecord[];
}

export class MemoryRejects implements RejectSink {
  private readonly keys = new Set<string>();
  private readonly recent: PlayRecord[] = [];
  has(key: string) { return this.keys.has(key); }
  append(row: PlayRecord) {
    const key = rejectKey(row.chain_id, row.pool_address, row.reason);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.recent.push(row);
    if (this.recent.length > REJECT_WINDOW) this.recent.shift();
  }
  window() { return this.recent; }
  read() { return this.recent.slice(); }
}

export class PlayRejectLog implements RejectSink {
  private readonly keys = new Set<string>();
  private readonly recent: PlayRecord[] = [];

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    this.index();
  }

  private active() { return join(this.dir, 'play-rejects.jsonl'); }

  private files(): string[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => n === 'play-rejects.jsonl' || n.startsWith('play-rejects-')).sort().map((n) => join(this.dir, n));
  }

  /** Once, at construction, so tick() only does a Set lookup. */
  private index() {
    for (const file of this.files()) this.scan(file, (row) => this.keys.add(rejectKey(row.chain_id, row.pool_address, row.reason)));
  }

  private scan(file: string, on: (row: PlayRecord) => void) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as PlayRecord;
        if (row && typeof row.chain_id === 'number' && typeof row.pool_address === 'string') on(row);
      } catch { /* a torn last line is skipped */ }
    }
  }

  has(key: string) { return this.keys.has(key); }

  append(row: PlayRecord) {
    const key = rejectKey(row.chain_id, row.pool_address, row.reason);
    if (this.keys.has(key)) return;
    this.keys.add(key);
    mkdirSync(this.dir, { recursive: true });
    this.rotate();
    appendFileSync(this.active(), JSON.stringify(row) + '\n');
    this.recent.push(row);
    if (this.recent.length > REJECT_WINDOW) this.recent.shift();
  }

  window() { return this.recent; }

  read(): PlayRecord[] {
    const out: PlayRecord[] = [];
    for (const file of this.files()) this.scan(file, (row) => { if (row.rejected) out.push(row); });
    return out;
  }

  private rotate() {
    const file = this.active();
    let size = 0, mtimeMs = 0;
    try { const st = statSync(file); size = st.size; mtimeMs = st.mtimeMs; } catch { return; }
    const day = new Date(mtimeMs).toISOString().slice(0, 10);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (size < REJECT_FILE_MAX && day === today) return;
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    let dest = join(this.dir, `play-rejects-${stamp}.jsonl`);
    let n = 0;
    while (existsSync(dest)) { n++; dest = join(this.dir, `play-rejects-${stamp}-${n}.jsonl`); }
    renameSync(file, dest);
  }
}
