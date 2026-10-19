import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, VersionCheck, type VersionInput } from '../src/server/system/version';
import { botChecks, chainChecks, dataChecks, staleAfter } from '../src/server/system/checks';
import { nextLevels } from '../src/live/liveGrid';

const base: VersionInput = { dev: false, running: 'aaa1111', built: 'aaa1111', local: 'aaa1111', branch: 'main', dirty: false, remote: 'aaa1111', remoteInLocal: true };

describe('version: running vs built vs checkout vs GitHub', () => {
  it('names the first gap and its one fix', () => {
    expect(compareVersions(base)).toMatchObject({ state: 'current', steps: [] });
    expect(compareVersions({ ...base, remote: 'bbb2222', remoteInLocal: false })).toMatchObject({ state: 'update-available', steps: ['git pull', 'npm install', 'npm run build', expect.stringMatching(/Restart/)] });
    expect(compareVersions({ ...base, local: 'ccc3333', remote: 'ccc3333' })).toMatchObject({ state: 'not-built', steps: ['npm run build', expect.stringMatching(/Restart/)] });
    expect(compareVersions({ ...base, running: 'old0000' })).toMatchObject({ state: 'not-restarted' });
  });
  it('dev mode runs the checkout itself, so only GitHub matters; notes never hide the state', () => {
    expect(compareVersions({ ...base, dev: true, built: null, running: 'zzz' })).toMatchObject({ state: 'current' });
    const v = compareVersions({ ...base, remote: null, remoteInLocal: null, branch: 'feature', dirty: true });
    expect(v.state).toBe('current');
    expect(v.notes.join(' ')).toMatch(/branch "feature".*edited by hand.*GitHub couldn't be reached/);
  });

  it('reads a real checkout: up to date → GitHub moves ahead → pulled, not built → built, not restarted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gridbot-ver-'));
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    const origin = join(dir, 'origin.git'), app = join(dir, 'app'), other = join(dir, 'other');
    g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    g(dir, 'clone', '-q', origin, app);
    writeFileSync(join(app, 'a.txt'), '1'); g(app, 'add', '.'); g(app, 'commit', '-qm', 'one'); g(app, 'push', '-q', 'origin', 'HEAD:main');
    const stamp = (commit: string) => { mkdirSync(join(app, 'dist', 'server'), { recursive: true }); writeFileSync(join(app, 'dist', 'server', 'build.json'), JSON.stringify({ commit, builtAt: 1 })); };
    const c1 = g(app, 'rev-parse', 'HEAD');
    stamp(c1);
    const v = await VersionCheck.start(app, false);
    expect(v.running.commit).toBe(c1);
    expect(await v.report(true)).toMatchObject({ state: 'current', remote: c1, branch: 'main' });

    // someone pushes to GitHub
    g(dir, 'clone', '-q', origin, other);
    writeFileSync(join(other, 'b.txt'), '2'); g(other, 'add', '.'); g(other, 'commit', '-qm', 'two'); g(other, 'push', '-q', 'origin', 'HEAD:main');
    expect((await v.report(true)).state).toBe('update-available');

    g(app, 'pull', '-q', 'origin', 'main');
    expect((await v.report(true)).state).toBe('not-built');
    stamp(g(app, 'rev-parse', 'HEAD'));
    expect((await v.report(true)).state).toBe('not-restarted');
    const fresh = await VersionCheck.start(app, false); // the restart
    expect((await fresh.report(true)).state).toBe('current');
  });
});

const NOW = 1_800_000_000_000, POLL = 10_000;
const iv = (i: number, buy: number, status: string, extra: Record<string, unknown> = {}) => ({ index: i, buyPrice: buy, sellPrice: buy + 10, status, needsRearm: false, plsAmount: 0, buyAmount: 50, ...extra });
const grid = (o: Record<string, unknown> = {}) => ({
  id: 'g1', label: 'ETH/USDG·HOOD', status: 'running', price: 2395, priceAt: NOW - 5000, lastError: null, available: true, queue: [], inFlight: null,
  config: { lowerPrice: 2370, upperPrice: 2420, gridCount: 5 },
  intervals: [iv(0, 2370, 'waitingBuy'), iv(1, 2380, 'waitingBuy'), iv(2, 2390, 'waitingBuy'), iv(3, 2400, 'holding'), iv(4, 2410, 'holding')], ...o,
});

describe('self-test: bots', () => {
  it('a healthy grid in range says where it trades next', () => {
    expect(nextLevels(grid().intervals, 2395)).toEqual({ buy: 2390, sell: 2410 });
    const c = botChecks(grid(), 'grid', NOW, POLL);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ state: 'pass' });
    expect(c[0].detail).toMatch(/next buy 2,390 \(0\.21% below\), next sell 2,410 \(0\.63% above\)/);
  });
  it('flags levels an older version left empty, and levels that lost their start-up buy', () => {
    const legacy = grid({ intervals: [iv(0, 2390, 'waitingBuy'), iv(1, 2400, 'inactive'), iv(2, 2410, 'inactive')] });
    expect(botChecks(legacy, 'grid', NOW, POLL).find((x) => x.id.endsWith(':legacy'))).toMatchObject({ state: 'warn', detail: expect.stringMatching(/2 of 3 levels can never trade/), fix: expect.stringMatching(/Change range/) });
    const lost = grid({ intervals: [iv(0, 2390, 'waitingBuy'), iv(1, 2400, 'waitingBuy', { needsRearm: true }), iv(2, 2410, 'waitingBuy', { needsRearm: true })] });
    expect(botChecks(lost, 'grid', NOW, POLL).find((x) => x.id.endsWith(':seed'))).toMatchObject({ state: 'warn', detail: expect.stringMatching(/^2 levels above the price have no coins/) });
  });
  it(`a running bot with no price for ${staleAfter(POLL) / 1000} s is not ticking; errors, stopped and stuck swaps are named`, () => {
    expect(botChecks(grid({ priceAt: NOW - 46_000 }), 'grid', NOW, POLL).find((x) => x.id.endsWith(':ticking'))).toMatchObject({ state: 'fail' });
    expect(botChecks(grid({ priceAt: NOW - 40_000 }), 'grid', NOW, POLL).some((x) => x.id.endsWith(':ticking'))).toBe(false);
    expect(botChecks(grid({ lastError: 'request timeout' }), 'grid', NOW, POLL).find((x) => x.id.endsWith(':error'))).toMatchObject({ state: 'fail', detail: 'Last attempt failed: request timeout' });
    expect(botChecks(grid({ status: 'stopped' }), 'grid', NOW, POLL)[0]).toMatchObject({ state: 'warn', fix: 'Press Resume on the bot.' });
    expect(botChecks(grid({ inFlight: { job: { createdAt: NOW - 12 * 60_000 } } }), 'grid', NOW, POLL).find((x) => x.id.endsWith(':tx'))).toMatchObject({ state: 'warn', detail: 'A swap has waited 12 min to confirm.' });
    expect(botChecks(grid({ price: 2300 }), 'grid', NOW, POLL).find((x) => x.id.endsWith(':range'))!.detail).toMatch(/below the range/);
  });
  it('liquidity bots: out of range with moving off; unavailable short-circuits', () => {
    const lp = { id: 'l1', label: 'ETH/USDG·HOOD', status: 'running', priceAt: NOW, position: { id: '1' }, inRange: false, config: { rerange: false }, step: null };
    expect(botChecks(lp, 'lp', NOW, POLL)[0]).toMatchObject({ state: 'warn', detail: expect.stringMatching(/outside the range/) });
    expect(botChecks({ ...lp, available: false }, 'lp', NOW, POLL)).toEqual([expect.objectContaining({ state: 'fail', id: 'bot:l1:available' })]);
  });
});

describe('self-test: chains and market data', () => {
  const chain = { id: 4663, name: 'Robinhood Chain', rpc: 'https://rpc', hasSigner: true, walletError: null, lowGas: false, gasNative: 0.4644, nativeSymbol: 'ETH', lowGasNative: 0.002, address: '0xabc' };
  it('times the RPC, reads the wallet and gas', () => {
    expect(chainChecks(chain, 240, 1)).toEqual([
      expect.objectContaining({ state: 'pass', detail: 'RPC answered in 240 ms.' }),
      expect.objectContaining({ state: 'pass', detail: 'Wallet readable; 0.4644 ETH for gas.' }),
    ]);
    expect(chainChecks(chain, new Error('timeout'), 1)[0]).toMatchObject({ state: 'fail', detail: expect.stringMatching(/didn't answer: timeout/) });
    expect(chainChecks({ ...chain, lowGas: true }, 240, 2)[1]).toMatchObject({ state: 'fail', fix: 'Send some ETH to 0xabc.' });
    expect(chainChecks({ ...chain, hasSigner: false }, 240, 0)[1]).toMatchObject({ state: 'pass', detail: 'No signing key: paper only here.' });
  });
  it('counts GeckoTerminal rate limits seen on this machine', () => {
    expect(dataChecks({ limited1h: 0, calls: 120, paceMs: 2500 }, null, NOW)[0]).toMatchObject({ state: 'pass', detail: expect.stringMatching(/^No rate limits in the last hour \(120 requests/) });
    expect(dataChecks({ limited1h: 7, calls: 120, paceMs: 10_000 }, null, NOW)[0]).toMatchObject({ state: 'warn', detail: expect.stringMatching(/^7 rate limits .* every 10\.0 s/), fix: expect.any(String) });
    expect(dataChecks(null, { at: NOW - 30 * 3600_000, running: false }, NOW)[0]).toMatchObject({ state: 'warn', detail: 'Last scan 30 h ago.' });
  });
});
