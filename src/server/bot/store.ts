import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Store<T> { load(): T | null; save(state: T): void; flush?(): void }

/**
 * JSON file store with atomic, durable writes: tmp file, fsync, the old file kept as `<file>.bak`, rename, directory
 * fsync. load() falls back to the backup when the file is missing or unreadable. Holds no secrets.
 * (state.json, which saves many times a second, uses DurableJsonStore: the same, debounced.)
 */
export class JsonStore<T> implements Store<T> {
  constructor(private readonly file: string) {}
  load(): T | null {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as T; } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      try { return JSON.parse(readFileSync(`${this.file}.bak`, 'utf8')) as T; } catch (be) {
        if (missing && (be as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`Cannot read state file ${this.file}: ${(e as Error).message}`);
      }
    }
  }
  save(state: T) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(state, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    try { copyFileSync(this.file, `${this.file}.bak`); } catch { /* first write */ }
    renameSync(tmp, this.file);
    try { const d = openSync(dirname(this.file), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort */ }
  }
}

export class MemoryStore<T> implements Store<T> {
  data: T | null = null;
  load() { return this.data ? (JSON.parse(JSON.stringify(this.data)) as T) : null; }
  save(s: T) { this.data = JSON.parse(JSON.stringify(s)); }
}
