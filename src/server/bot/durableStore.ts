/**
 * state.json writer for the poll loop. Saves come in many times a second (every bot saves on every tick). Writing the
 * whole file synchronously each time blocked the event loop.
 *
 * - **Debounced and off the event loop.** A routine save (prices, equity points, grid intervals) only marks the state
 *   dirty. One write, made `delayMs` later, carries every save made in between. It is serialized at write time, so it
 *   always holds the newest state.
 * - **Urgent saves are synchronous.** `urgentKey(state)` summarizes what must be on disk before the app acts on it:
 *   a transaction marked in flight before it is sent, a tx hash, a bot's status (stopped / running / closing). When
 *   it differs from the last written one, the save is written now, before `save()` returns, exactly like the old
 *   store. A crash can lose a few price ticks, never a sent transaction or a Stop.
 * - **Durable.** Each write goes to a temporary file that is fsynced and then renamed over the old one. The directory
 *   is fsynced too (best effort). The previous good file is kept as `<file>.bak`. `load()` falls back to it when the
 *   main file is missing or unreadable (e.g. a power cut on a disk that reordered writes).
 * - `flush()` writes anything pending, synchronously (shutdown).
 */
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { open, copyFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Store } from './store';

export interface DurableOptions<T> {
  /** Debounce for routine saves (ms). Default 500. */
  delayMs?: number;
  /** Fields that must be on disk before save() returns; a change in this string makes the save synchronous */
  urgentKey?: (s: T) => string;
  /** A failed write (disk full…). The next save retries. */
  onError?: (e: Error) => void;
  /** JSON indent (default 2, as before) */
  indent?: number;
}

function fsyncDir(dir: string) {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* not supported everywhere */ }
}

export class DurableJsonStore<T> implements Store<T> {
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastKey: string | null = null;
  /** Bumped by every write that starts; a write renames only if no newer one finished first */
  private gen = 0;
  private written = 0;
  private writing: Promise<void> | null = null;
  /** Writes made, for tests and the status line */
  writes = 0;
  lastError: string | null = null;
  readonly backupFile: string;

  constructor(private readonly file: string, private readonly o: DurableOptions<T> = {}) {
    this.backupFile = `${file}.bak`;
  }

  load(): T | null {
    const read = (f: string): T | null => JSON.parse(readFileSync(f, 'utf8')) as T;
    try {
      const s = read(this.file);
      if (s && this.o.urgentKey) this.lastKey = this.o.urgentKey(s);
      return s;
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      try {
        const b = read(this.backupFile);
        if (b) { this.o.onError?.(new Error(`${this.file} ${missing ? 'is missing' : `is unreadable (${(e as Error).message})`}; loaded the backup ${this.backupFile}`)); }
        if (b && this.o.urgentKey) this.lastKey = this.o.urgentKey(b);
        return b;
      } catch (be) {
        if (missing && (be as NodeJS.ErrnoException).code === 'ENOENT') return null;
        if (missing) throw new Error(`Cannot read state backup ${this.backupFile}: ${(be as Error).message}`);
        throw new Error(`Cannot read state file ${this.file}: ${(e as Error).message}`);
      }
    }
  }

  save(state: T) {
    this.pending = state;
    const key = this.o.urgentKey?.(state) ?? null;
    if (key !== null && key !== this.lastKey) { this.flush(); return; }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flushAsync(); }, this.o.delayMs ?? 500);
  }

  /** Write now, synchronously, if anything is pending. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const s = this.pending;
    if (s == null) return;
    this.pending = null;
    const my = ++this.gen;
    try {
      const text = JSON.stringify(s, null, this.o.indent ?? 2);
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const fd = openSync(tmp, 'w');
      try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      try { copyFileSync(this.file, this.backupFile); } catch { /* first write: nothing to back up */ }
      renameSync(tmp, this.file);
      fsyncDir(dirname(this.file));
      this.written = my;
      this.writes++;
      this.lastError = null;
      if (this.o.urgentKey) this.lastKey = this.o.urgentKey(s);
    } catch (e) {
      // keep it pending: the next save retries
      if (this.pending == null) this.pending = s;
      this.lastError = (e as Error).message;
      this.o.onError?.(e as Error);
      throw e;
    }
  }

  /** The debounced write. Serializes now, writes off the event loop, renames only if no newer write landed. */
  private async flushAsync(): Promise<void> {
    if (this.writing) { await this.writing; if (this.pending != null && !this.timer) return this.flushAsync(); return; }
    const s = this.pending;
    if (s == null) return;
    this.pending = null;
    const my = ++this.gen;
    const key = this.o.urgentKey?.(s) ?? null;
    const text = JSON.stringify(s, null, this.o.indent ?? 2);
    const tmp = `${this.file}.tmp-${my}`;
    const run = (async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const fh = await open(tmp, 'w');
        try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
        try { await copyFile(this.file, this.backupFile); } catch { /* first write */ }
        // No await between this check and the rename: a synchronous write can't land in between.
        if (this.written > my) { await unlink(tmp).catch(() => undefined); return; }
        renameSync(tmp, this.file);
        this.written = my;
        this.writes++;
        this.lastError = null;
        if (key !== null) this.lastKey = key;
        fsyncDir(dirname(this.file));
      } catch (e) {
        try { unlinkSync(tmp); } catch { /* gone */ }
        if (this.pending == null) { this.pending = s; if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flushAsync(); }, (this.o.delayMs ?? 500) * 4); }
        this.lastError = (e as Error).message;
        this.o.onError?.(e as Error);
      }
    })();
    this.writing = run;
    try { await run; } finally { this.writing = null; }
  }

  /** Resolves when nothing is pending and no write is running (tests, shutdown with time to spare). */
  async idle(): Promise<void> {
    while (this.timer || this.writing || this.pending != null) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; await this.flushAsync(); }
      else if (this.writing) await this.writing;
      else await this.flushAsync();
    }
  }
}
