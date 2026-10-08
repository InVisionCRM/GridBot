import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Store<T> { load(): T | null; save(state: T): void }

/** JSON file store with atomic writes (tmp file + rename). Holds no secrets. */
export class JsonStore<T> implements Store<T> {
  constructor(private readonly file: string) {}
  load(): T | null {
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as T; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Cannot read state file ${this.file}: ${(e as Error).message}`);
    }
  }
  save(state: T) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}

export class MemoryStore<T> implements Store<T> {
  data: T | null = null;
  load() { return this.data ? (JSON.parse(JSON.stringify(this.data)) as T) : null; }
  save(s: T) { this.data = JSON.parse(JSON.stringify(s)); }
}
