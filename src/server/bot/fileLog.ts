/**
 * Append-only log lines under data/. A full file is renamed to name.1 (name.1 to name.2, … up to name.KEEP) and a new
 * file starts. Lines are never rewritten; only the oldest rotation (beyond KEEP) is dropped.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Rotations kept besides the current file (was 1) */
export const LOG_KEEP = 5;

function rotate(file: string, keep: number) {
  for (let i = keep - 1; i >= 1; i--) { try { renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* not there yet */ } }
  renameSync(file, `${file}.1`);
}

export function appendLogLine(file: string, line: string, maxBytes = 2_000_000, keep = LOG_KEEP): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const text = line.endsWith('\n') ? line : `${line}\n`;
    const bytes = Buffer.byteLength(text);
    let size = 0;
    try { size = statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + bytes > maxBytes) {
      try { rotate(file, keep); } catch { /* keep appending if the rename fails */ }
    }
    appendFileSync(file, text);
  } catch { /* a full disk must not take the bots down */ }
}

function readLines(file: string): string[] {
  try { return readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

/** Older rotations first, then the current file. Blank lines dropped. */
export function readLogLines(file: string, keep = LOG_KEEP): string[] {
  const out: string[] = [];
  for (let i = keep; i >= 1; i--) out.push(...readLines(`${file}.${i}`));
  out.push(...readLines(file));
  return out.filter((l) => l.length > 0);
}
