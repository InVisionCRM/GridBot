import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'plays') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
}

describe('plays wiring', () => {
  it('is not imported by the running app', () => {
    const found: string[] = [];
    files(join(process.cwd(), 'src'), found);
    const wired = found.filter((path) => /from\s+['"][^'"]*\/plays(?:\/|['"])/.test(readFileSync(path, 'utf8')));
    expect(wired).toEqual([]);
  });
});
