import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { ActivityBus } from '../src/server/bot/activity';
import { appendLogLine } from '../src/server/bot/fileLog';
import { Logger, registerSecret } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { haltText, showHalt } from '../src/ui/haltText';
import { MockChain, NET } from './helpers/mockChain';

const P0 = 0.00001;
const base = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 30 };

function make(store = new MemoryStore<MultiState>(), signer: MockChain | null = null) {
  const chain = new MockChain(P0);
  const log = new Logger(true);
  const bot = new MultiBot({ net: NET, reader: chain, signer, store, log, maxRetries: 1, retryDelayMs: 0 });
  return { chain, store, log, bot };
}

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

function listen(app: ReturnType<typeof createApp>) {
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function req(port: number, path: string, method: string, headers: http.OutgoingHttpHeaders = {}, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body != null) r.end(body); else r.end();
  });
}

describe('stop reasons', () => {
  it('stop all with no request is recorded as the app, and a restart keeps it', async () => {
    const store = new MemoryStore<MultiState>();
    const a = make(store);
    await a.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    a.bot.stopAll();
    const g = a.bot.status().grids[0];
    expect(g.status).toBe('stopped');
    expect(g.halt).toMatchObject({ what: 'stop-all', origin: 'system', detail: 'POST /api/bot/stop-all', endpoint: null, ua: null });
    expect(a.log.entries.some((e) => /KILL ALL/.test(e.msg))).toBe(true);
    const b = make(store);
    expect(b.bot.status().grids[0].status).toBe('stopped');
    expect(b.bot.status().grids[0].halt).toEqual(g.halt);
  });

  it('a saved running bot with no halt field still resumes', async () => {
    const store = new MemoryStore<MultiState>();
    const a = make(store);
    await a.bot.add({ mode: 'paper', stable: 'DAI', ...base });
    expect(a.bot.status().grids[0].status).toBe('running');
    delete (store.data!.grids[0] as { halt?: unknown }).halt;
    const b = make(store);
    expect(b.bot.status().grids[0].status).toBe('running');
    expect(b.bot.status().grids[0].halt).toBeNull();
  });

  it('resume clears a stored reason', async () => {
    const { bot } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    bot.stop(id);
    expect(bot.status().grids[0].halt?.what).toBe('bot-stop');
    bot.resume(id);
    expect(bot.status().grids[0].status).toBe('running');
    expect(bot.status().grids[0].halt).toBeNull();
  });

  it('a safety pause is the app, not whoever happened to have a request open', async () => {
    const { bot } = make();
    await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    expect(bot.pauseMarket('DAI', 'tax rose on buy')).toBe(1);
    expect(bot.status().grids[0].halt).toMatchObject({ what: 'safety-pause', origin: 'system', detail: 'tax rose on buy', endpoint: null });
  });

  it('GET and a non-JSON POST cannot stop a bot; a JSON POST records the button, the computer, and the browser', async () => {
    const { bot } = make();
    const id = await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const chainId = bot.status().grids[0].chainId;
    const app = createApp({ bot, net: NET, heartbeatMs: 60_000, statusThrottleMs: 60_000 });
    const port = await listen(app);
    for (const path of ['/api/bot/stop-all', '/api/bot/stop', `/api/chains/${chainId}/stop`, `/api/bot/grids/${id}/stop`]) {
      const got = await req(port, path, 'GET');
      expect(got.status).toBe(404);
    }
    const bare = await req(port, '/api/bot/stop-all', 'POST');
    expect(bare.status).toBe(415);
    expect(bot.status().grids[0].status).toBe('running');
    const stopped = await req(port, '/api/bot/stop-all', 'POST', {
      'content-type': 'application/json',
      'user-agent': 'TestPhone/1',
      'x-gridbot-from': 'header-stop-all',
    }, '{}');
    expect(stopped.status).toBe(200);
    expect(bot.status().grids[0].status).toBe('stopped');
    expect(bot.status().grids[0].halt).toMatchObject({
      what: 'button', detail: 'Stop all button', origin: 'localhost', endpoint: 'POST /api/bot/stop-all', ua: 'TestPhone/1',
    });
  });

  it('the stop alias is the same stop-all, and a gateway via header is the phone', async () => {
    const { bot } = make();
    await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const port = await listen(createApp({ bot, net: NET, heartbeatMs: 60_000, statusThrottleMs: 60_000 }));
    const stopped = await req(port, '/api/bot/stop', 'POST', {
      'content-type': 'application/json',
      'x-gridbot-via': 'owner',
      'user-agent': 'iPhone',
    }, '{}');
    expect(stopped.status).toBe(200);
    expect(bot.status().grids[0].halt).toMatchObject({
      what: 'stop-all', detail: 'POST /api/bot/stop-all', origin: 'gateway-owner', endpoint: 'POST /api/bot/stop', ua: 'iPhone',
    });
  });

  it('a friend copy stays a friend copy even if the via header says owner', async () => {
    const { bot } = make();
    await bot.add({ mode: 'paper', stable: 'DAI', ...base });
    const port = await listen(createApp({ bot, net: NET, copy: true, heartbeatMs: 60_000, statusThrottleMs: 60_000 }));
    const stopped = await req(port, '/api/bot/stop-all', 'POST', {
      'content-type': 'application/json',
      'x-gridbot-via': 'owner',
    }, '{}');
    expect(stopped.status).toBe(200);
    expect(bot.status().grids[0].halt?.origin).toBe('friend-copy');
  });
});

describe('logs survive a restart', () => {
  it('two loggers append to the same file, and a full file is renamed rather than wiped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gridbot-log-'));
    const file = join(dir, 'server.log');
    const a = new Logger(true, 200, file);
    const b = new Logger(true, 200, file);
    a.info('alpha');
    b.warn('beta');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'));
    const rotated = join(dir, 'rotate.log');
    appendLogLine(rotated, 'hello\n', 20);
    const before = readFileSync(rotated, 'utf8');
    expect(before).toBe('hello\n');
    appendLogLine(rotated, 'this line is long enough to rotate\n', 20);
    expect(readFileSync(`${rotated}.1`, 'utf8')).toBe(before);
    expect(readFileSync(rotated, 'utf8')).toBe('this line is long enough to rotate\n');
  });

  it('the activity feed reloads the last events and keeps going from the last id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gridbot-act-'));
    const file = join(dir, 'activity.log');
    const secret = 'supersecretvalue123456';
    registerSecret(secret);
    const a = new ActivityBus(400, () => 1_000, file);
    a.emitEvent({ type: 'stopped', msg: 'one' });
    a.emitEvent({ type: 'info', msg: `two ${secret}` });
    expect(a.recent().at(-1)?.msg).toContain(secret);
    expect(readFileSync(file, 'utf8')).not.toContain(secret);
    expect(readFileSync(file, 'utf8')).toContain('[REDACTED]');
    appendLogLine(file, 'not json\n');
    const b = new ActivityBus(400, () => 2_000, file);
    expect(b.recent().map((e) => e.msg.replace(secret, '[REDACTED]'))).toEqual(['one', 'two [REDACTED]']);
    expect(b.recent().map((e) => e.id)).toEqual([1, 2]);
    b.emitEvent({ type: 'info', msg: 'three' });
    expect(b.recent().at(-1)).toMatchObject({ id: 3, msg: 'three' });
  });
});

describe('halt sentence', () => {
  it('names the phone and how long ago', () => {
    const now = 1_700_000_000_000;
    const at = now - 2 * 3600 * 1000;
    expect(haltText({ at, detail: 'Stop all button', origin: 'gateway-owner' }, now)).toBe('Stop all button from the phone, 2h ago');
    expect(showHalt({ status: 'running', halt: { detail: 'Stop all button', origin: 'localhost', at } }, false, now)).toBeNull();
    expect(showHalt({ status: 'stopped', halt: { detail: 'Stop button', origin: 'localhost', at } }, false, now)).toBe('Stop button from this computer, 2h ago');
  });
});

describe('log rotation keeps more history', () => {
  it('rotates name.1 … name.5, never rewrites a line, and reads them oldest first', async () => {
    const { mkdtempSync: mk, existsSync } = await import('node:fs');
    const { readLogLines } = await import('../src/server/bot/fileLog');
    const dir = mk(join(tmpdir(), 'rot-'));
    const f = join(dir, 'a.log');
    for (let i = 0; i < 8; i++) appendLogLine(f, `line ${i} padded to rotate`, 30);
    expect(existsSync(`${f}.5`)).toBe(true);
    expect(existsSync(`${f}.6`)).toBe(false);
    expect(readLogLines(f)).toEqual([2, 3, 4, 5, 6, 7].map((i) => `line ${i} padded to rotate`));
    expect(readLogLines(f, 1)).toEqual([6, 7].map((i) => `line ${i} padded to rotate`));
  });
});
