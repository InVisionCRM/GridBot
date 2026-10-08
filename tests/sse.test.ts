import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { MockChain, NET } from './helpers/mockChain';

function readEvents(port: number, want: (evs: { event: string; data: any }[]) => boolean, path = '/api/bot/stream'): Promise<{ event: string; data: any }[]> {
  return new Promise((resolve, reject) => {
    const evs: { event: string; data: any }[] = [];
    const req = http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) evs.push({ event: ev, data: JSON.parse(data) });
          if (want(evs)) { req.destroy(); resolve(evs); return; }
        }
      });
    });
    req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error(`timeout; got ${evs.map((e) => e.event)}`)); }, 4000);
  });
}

describe('SSE stream + API', () => {
  it('sends hello (with backlog), activity, ticks and status pushes', async () => {
    const chain = new MockChain(1e-5);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    bot.activity.emitEvent({ type: 'info', kind: 'system', msg: 'before connect' });
    const server = createApp({ bot, net: NET, heartbeatMs: 50, statusThrottleMs: 10 }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const got = readEvents(port, (e) => ['hello', 'activity', 'ticks', 'status'].every((k) => e.some((x) => x.event === k)));
      await new Promise((r) => setTimeout(r, 100));
      bot.activity.emitEvent({ type: 'filled', kind: 'grid', msg: 'test fill', notify: true });
      await bot.tickAll();
      const evs = await got;
      const hello = evs.find((e) => e.event === 'hello')!;
      expect(hello.data.recent.map((e: { msg: string }) => e.msg)).toContain('before connect');
      expect(evs.find((e) => e.event === 'activity' && e.data.msg === 'test fill')!.data).toMatchObject({ type: 'filled', notify: true });
      expect(Object.keys(evs.find((e) => e.event === 'ticks')!.data.prices)).toEqual(expect.arrayContaining(['DAI', 'HEX']));
      expect(evs.find((e) => e.event === 'status')!.data).toHaveProperty('trends');
      // listeners are released on disconnect
      await new Promise((r) => setTimeout(r, 50));
      expect(bot.activity.listenerCount('activity')).toBe(0);

      // a couple of the new REST endpoints on the same app
      const get = (p: string) => new Promise<{ status: number; body: string }>((resolve) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
      }));
      const c = await get('/api/market/candles?pair=DAI&tf=1m');
      expect(c.status).toBe(200);
      expect(JSON.parse(c.body).candles.length).toBe(1);
      expect((await get('/api/market/candles?pair=DAI&tf=7m')).status).toBe(400);
      const csv = await get('/api/analytics/journal.csv');
      expect(csv.body.startsWith('time,botId')).toBe(true);
    } finally {
      server.close();
    }
  });
});
