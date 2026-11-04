/**
 * One confirmation in the app (Kyle 2026-11-04): the sheet in src/ui/Confirm.tsx, hold-to-confirm for real money.
 * The browser's own OK / Cancel pop-up (confirm / window.confirm) is easy to click through, so it is used nowhere.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
  });
}

describe('one confirmation: the hold sheet, never the browser pop-up', () => {
  it('no confirm() or window.confirm() anywhere in the app', () => {
    const hits = files(new URL('../src', import.meta.url).pathname).flatMap((p) =>
      readFileSync(p, 'utf8').split('\n').map((l, i) => [p, i + 1, l] as const)
        .filter(([, , l]) => /(^|[^.\w])(window\.)?confirm\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
        .map(([p2, n, l]) => `${p2}:${n}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  it('the sheet is mounted at the root, so ask() always has somewhere to show', () => {
    expect(readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')).toMatch(/<ConfirmHost \/>/);
  });
});
