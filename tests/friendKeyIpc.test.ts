/**
 * A friend's key never goes through a copy's environment: the copy asks the host once over the IPC channel. Real child
 * processes: the copy's entry is the real env.ts (receiveFriendKey + createSigners) bundled with esbuild.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import { Wallet } from 'ethers';
import { afterAll, describe, expect, it } from 'vitest';
import { Copies, childEnv, keyMessage, type CopySpec } from '../src/server/friends/copies';

// Inside the repo, so the bundled entry finds node_modules (ethers) like dist/server/index.js does.
const cache = join(__dirname, '..', 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const tmp = mkdtempSync(join(cache, 'friendkey-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// The copy side: ask for the key, build the signers from it, report what it saw (hashes only, never the key).
const entrySrc = join(tmp, 'entry.ts');
writeFileSync(entrySrc, `
import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSigners, receiveFriendKey } from ${JSON.stringify(join(__dirname, '..', 'src', 'server', 'env.ts'))};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = await receiveFriendKey(5000);
const signers = createSigners([{ id: 1, envSlug: 'ETHEREUM', provider: null as never }], { friendKey: key });
const w = signers.get(1);
const env = JSON.stringify(process.env);
let procEnv = '';
try { procEnv = readFileSync('/proc/self/environ', 'latin1'); } catch { /* not Linux */ }
const body = key ? key.slice(2).toLowerCase() : '';
// Write-then-rename: report.json only ever appears complete. A plain writeFileSync creates the file before the bytes
// land, and the test's SIGTERM (copies.stop) could kill the copy in between and leave it empty.
writeFileSync('report.json.tmp', JSON.stringify({
  keySha: key ? sha(key) : null, address: w ? await w.getAddress() : null,
  envHasKey: !!body && env.toLowerCase().includes(body), procEnvHasKey: !!body && procEnv.toLowerCase().includes(body),
  envNames: Object.keys(process.env).filter((k) => /KEY|SECRET|PASSWORD/i.test(k)),
}));
renameSync('report.json.tmp', 'report.json');
process.exit(0);
`);
const entry = join(tmp, 'entry.mjs');
buildSync({ entryPoints: [entrySrc], outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'silent', absWorkingDir: join(__dirname, '..') });

async function runCopy(spec: CopySpec) {
  const copies = new Copies({ root: tmp, entry, hostEnv: { PRIVATE_KEY: '0x' + '1'.repeat(64), CHAINS: 'ethereum' }, host: () => ({ name: 'Kyle', url: 'http://127.0.0.1:1' }), say: () => undefined });
  copies.start(spec);
  try {
    return await readReport(join(copies.dir(spec.id), 'report.json'));
  } finally {
    await copies.stop(spec.id);
  }
}

type Report = { keySha: string | null; address: string | null; envHasKey: boolean; procEnvHasKey: boolean; envNames: string[] };

/**
 * Waits for a complete report before the copy is stopped: the file must exist AND parse. The old loop stopped at
 * existsSync, so on a slow disk (macOS CI) it could stop the copy mid-write and read '' ('Unexpected end of JSON input').
 * The report holds hashes and flags only, and a failure here never echoes the file's contents.
 */
async function readReport(file: string, timeoutMs = 10_000): Promise<Report> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file)) {
      try { return JSON.parse(readFileSync(file, 'utf8')) as Report; } catch { /* partly written: keep waiting */ }
    }
    if (Date.now() >= until) throw new Error(`no complete copy report after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("a friend's key reaches the copy over IPC, never its environment", () => {
  it('childEnv holds no key at all, the friend\'s or the host\'s', () => {
    const key = Wallet.createRandom().privateKey;
    const env = childEnv({ PRIVATE_KEY: '0xhost', PRIVATE_KEY_ETHEREUM: '0xhosteth', CHAINS: 'ethereum' }, { id: 'a', name: 'Alex', port: 3851, key }, { name: 'Kyle', url: 'x' });
    expect(Object.keys(env).filter((k) => /KEY|SECRET|PASSWORD/i.test(k))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(key.slice(2));
    expect(keyMessage({ id: 'a', name: 'Alex', port: 1, key: null })).toEqual({ type: 'friend-key', key: null });
  });

  it('a real copy gets the key over IPC, signs as the friend, and its environment (and /proc/self/environ) never holds it', { timeout: 20_000 }, async () => {
    const friend = Wallet.createRandom();
    const r = await runCopy({ id: 'alex', name: 'Alex', port: 39851, key: friend.privateKey });
    expect(r.keySha).toBe(sha(friend.privateKey));
    expect(r.address).toBe(friend.address);
    expect(r.envHasKey).toBe(false);
    expect(r.procEnvHasKey).toBe(false);
    expect(r.envNames).toEqual([]);
  });

  it('a paper-only friend: the copy gets null and has no signer (the host\'s own key never reaches it)', { timeout: 20_000 }, async () => {
    const r = await runCopy({ id: 'pat', name: 'Pat', port: 39852, key: null });
    expect(r).toMatchObject({ keySha: null, address: null, envNames: [] });
  });
});
