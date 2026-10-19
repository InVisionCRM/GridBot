/**
 * Build stamp: the commit the server bundle is built from, written next to it (dist/server/build.json). The running
 * server reads it once at start, so the System check can tell "running", "built" and "checked out" apart.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
mkdirSync('dist/server', { recursive: true });
writeFileSync('dist/server/build.json', JSON.stringify({ commit, builtAt: Date.now() }));
console.log(`build stamp ${commit.slice(0, 7)}`);
