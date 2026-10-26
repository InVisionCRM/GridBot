/** Append-only log lines under data/. A full file is renamed to name.1 and a new file starts. Never truncated. */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendLogLine(file: string, line: string, maxBytes = 2_000_000): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const text = line.endsWith('\n') ? line : `${line}\n`;
    const bytes = Buffer.byteLength(text);
    let size = 0;
    try { size = statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + bytes > maxBytes) {
      try { renameSync(file, `${file}.1`); } catch { /* keep appending if the rename fails */ }
    }
    appendFileSync(file, text);
  } catch { /* a full disk must not take the bots down */ }
}

function readLines(file: string): string[] {
  try { return readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}

/** Previous rotation, then the current file. Blank lines dropped. */
export function readLogLines(file: string): string[] {
  return [...readLines(`${file}.1`), ...readLines(file)].filter((l) => l.length > 0);
}
