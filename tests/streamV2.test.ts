import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { apply, diff, type Op } from '../src/live/delta';
import { StatusFeed } from '../src/server/statusFeed';
import { MockChain, NET } from './helpers/mockChain';

type Ev = { event: string; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function stream(port: number, path: string, until: (e: Ev[]) => boolean, ms = 4000): Promise<{ evs: Ev[]; bytes: number }> {
  return new Promise((resolve, reject) => {
    const evs: Ev[] = [];
    let bytes = 0;
    const req = http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        bytes += c.length;
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) evs.push({ event: ev, data: JSON.parse(data) });
          if (until(evs)) { req.destroy(); resolve({ evs, bytes }); return; }
        }
      });
    });
    req.on('error', (e) => { if (!(e as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error(`timeout; got ${evs.map((e) => e.event)}`)); }, ms);
  });
}

describe('delta ops', () => {
  it('round-trips objects, deletes, in-place changes, rolling and newest-first arrays', () => {
    const a = { x: 1, y: { z: [1, 2, 3] }, gone: true, eq: Array.from({ length: 600 }, (_, i) => [i, i * 2]), trades: [{ id: 3 }, { id: 2 }, { id: 1 }], bots: [{ id: 'a', p: 1 }, { id: 'b', p: 2 }] };
    const b = { x: 2, y: { z: [1, 2, 3, 4] }, eq: [...a.eq.slice(1), [600, 1200]], trades: [{ id: 4 }, { id: 3 }, { id: 2 }], bots: [{ id: 'a', p: 1 }, { id: 'b', p: 5 }], added: null };
    const ops = diff(a, b);
    expect(apply(a, ops)).toEqual(b);
    // the 600-point history is sent as one point, not 600
    expect(ops.find((o) => o[1][0] === 'eq')).toEqual(['a', ['eq'], [[600, 1200]], 1]);
    expect(ops.find((o) => o[1][0] === 'trades')).toEqual(['p', ['trades'], [{ id: 4 }], 2]);
    expect(ops).toContainEqual(['s', ['bots', 1, 'p'], 5]);
    expect(ops).toContainEqual(['d', ['gone']]);
    expect(JSON.stringify(ops).length).toBeLessThan(JSON.stringify(b).length / 20);
    // apply never mutates the old object
    expect(a.x).toBe(1);
    expect(diff(b, b)).toEqual([]);
  });

  it('random edits always round-trip', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const make = (): unknown => {
      const r = rnd();
      if (r < 0.3) return Math.floor(rnd() * 5);
      if (r < 0.45) return null;
      if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 5) }, () => Math.floor(rnd() * 4));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [`k${i}`, rnd() < 0.5 ? Math.floor(rnd() * 3) : [1, Math.floor(rnd() * 3)]]));
    };
    for (let i = 0; i < 2000; i++) {
      const a = { v: make(), w: make() }, b = { v: make(), w: rnd() < 0.5 ? a.w : make() };
      expect(apply(a, diff(a, b))).toEqual(b);
    }
  });
});

describe('stream v2', () => {
  it('hello carries a snapshot and seq; patches follow in order and rebuild the same status; hb arrives', async () => {
    const chain = new MockChain(1e-5);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    await bot.add({ mode: 'paper', stable: 'DAI', lowerPrice: 0.9e-5, upperPrice: 1.1e-5, gridCount: 10, totalCapitalUsd: 30 });
    const server = createApp({ bot, net: NET, heartbeatMs: 40, statusThrottleMs: 5 }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const got = stream(port, '/api/bot/stream?v=2', (e) => e.filter((x) => x.event === 'patch').length >= 2 && e.some((x) => x.event === 'hb'));
      await new Promise((r) => setTimeout(r, 50));
      chain.setPrice(1.02e-5);
      await bot.tickAll();
      await new Promise((r) => setTimeout(r, 30));
      chain.setPrice(0.97e-5);
      await bot.tickAll();
      const { evs } = await got;
      const hello = evs.find((e) => e.event === 'hello')!.data;
      expect(hello).toMatchObject({ v: 2, epoch: expect.any(String), seq: expect.any(Number), hbMs: 40 });
      let status = hello.status, seq = hello.seq;
      for (const p of evs.filter((e) => e.event === 'patch').map((e) => e.data as { seq: number; ops: Op[] })) {
        expect(p.seq).toBe(seq + 1);
        status = apply(status, p.ops); seq = p.seq;
      }
      expect(status).toEqual(JSON.parse(JSON.stringify(bot.status())));
      expect(evs.some((e) => e.event === 'status')).toBe(false); // v2 never gets the whole status again
      expect(evs.find((e) => e.event === 'hb')!.data).toMatchObject({ seq: expect.any(Number), epoch: hello.epoch });
      await new Promise((r) => setTimeout(r, 30));
      expect(bot.activity.listenerCount('activity')).toBe(0);
      expect(bot.activity.listenerCount('status')).toBe(0);
    } finally { server.close(); }
  });

  it('v1 clients still get the whole status (unchanged)', async () => {
    const bot = new MultiBot({ net: NET, reader: new MockChain(1e-5), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    const server = createApp({ bot, net: NET, heartbeatMs: 1000, statusThrottleMs: 5 }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const got = stream(port, '/api/bot/stream', (e) => e.some((x) => x.event === 'status'));
      await new Promise((r) => setTimeout(r, 30));
      await bot.tickAll();
      const { evs } = await got;
      expect(evs.find((e) => e.event === 'status')!.data).toHaveProperty('grids');
    } finally { server.close(); }
  });

  it('computes the status once per push however many clients are connected, and sends nothing when nothing changed', () => {
    let calls = 0, v = 1;
    const feed = new StatusFeed(() => { calls++; return { v }; }, 0);
    const got: unknown[] = [];
    const offs = [feed.onPatch((p) => got.push(p)), feed.onPatch(() => undefined), feed.onFull(() => undefined)];
    feed.snapshot();
    calls = 0;
    feed.push();
    expect(calls).toBe(1);
    expect(got).toHaveLength(0); // unchanged
    v = 2; feed.push();
    expect(got).toEqual([{ seq: expect.any(Number), t: expect.any(Number), ops: [['s', ['v'], 2]] }]);
    offs.forEach((f) => f());
  });
});
