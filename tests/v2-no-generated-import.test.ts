import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

describe('v2 desk source', () => {
  it('does not import the retired generated module from a v2 file', () => {
    const paths = [
      ...files('src/v2').filter((p) => /\.(ts|tsx)$/.test(p)),
      'src/server/v2Desk.ts',
      ...files('tests').filter((p) => /\.(ts|tsx)$/.test(p)),
    ].filter((p) => !p.endsWith('v2-no-generated-import.test.ts'));
    const needle = ['shared', 'generated'].join('/');
    const hits = paths.filter((p) => readFileSync(p, 'utf8').includes(needle));
    expect(hits).toEqual([]);
  });
});
