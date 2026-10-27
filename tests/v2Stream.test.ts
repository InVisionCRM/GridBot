import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { ActivityEvent } from '../src/server/bot/activity';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { deskDelta, deskFromStatus } from '../src/server/v2Desk';
import { applyDelta } from '../src/v2/use-desk';
import { MockChain, NET } from './helpers/mockChain';

function bot() {
  return new MultiBot({ net: NET, reader: new MockChain(1e-5), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
}

function listen(app: ReturnType<typeof createApp>): Promise<{ port: number; close: () => void }> {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => resolve({
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  })));
}

type Ev = { event: string; data: Record<string, unknown> };

function stream(port: number, until: (evs: Ev[]) => boolean, headers: Record<string, string> = {}): Promise<{ status: number; evs: Ev[] }> {
  return new Promise((resolve, reject) => {
    const evs: Ev[] = [];
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`timeout; got ${evs.map((e) => e.event).join(',')}`)); }, 4000);
    const done = (value: { status: number; evs: Ev[] }) => { clearTimeout(timer); resolve(value); };
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/v2/stream',
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      if ((res.statusCode ?? 500) !== 200) {
        res.resume();
        done({ status: res.statusCode ?? 0, evs });
        return;
      }
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) evs.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          if (until(evs)) { req.destroy(); done({ status: 200, evs }); return; }
        }
      });
    });
    req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') { clearTimeout(timer); reject(e); } });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
  });
}

const PAPER = { mode: 'paper' as const, stable: 'DAI', lowerPrice: 0.9e-5, upperPrice: 1.1e-5, gridCount: 10, totalCapitalUsd: 30 };

describe('v2 desk stream', () => {
  it('does not copy wallet fields out of status', () => {
    const secret = `0x${'ab'.repeat(20)}`;
    const desk = deskFromStatus({
      spotsAt: 1_700_000_000_000,
      address: secret,
      walletBalances: { PLS: 9 },
      wallets: [{ address: secret }],
      hasSigner: true,
      log: [{ msg: `paid ${secret}` }],
      grids: [{
        id: 'g1', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: 1_700_000_000_000 - 86_400_000,
        config: { totalCapitalUsd: 10 },
        pnl: { realized: 1, unrealized: 0, gasUsd: 0 },
        stats: { roundTrips: 2, totalFees: 0 },
      }],
    }, [{ id: 1, t: 1_700_000_000_000, type: 'filled', level: 'success', msg: `fill ${secret}`, botId: 'g1' } as ActivityEvent]);
    const json = JSON.stringify(desk);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('walletBalances');
    expect(desk.source).toBe('live');
    expect(desk.bots.map((b) => b.metrics.botId)).toEqual(['g1']);
    expect(desk.activity[0]?.text ?? '').not.toMatch(/0x/i);
  });

  it('names added and removed bots in a delta', () => {
    const row = (id: string) => ({
      id, mode: 'live', status: 'running', label: `${id}/USDC`, base: id, quoteSym: 'USDC',
      usdPerQuote: 1, price: 1, startedAt: 1_700_000_000_000 - 86_400_000,
      config: { totalCapitalUsd: 10 },
      pnl: { realized: 1, unrealized: 0, gasUsd: 0 },
      stats: { roundTrips: 2, totalFees: 0 },
    });
    const now = 1_700_000_000_000;
    const before = deskFromStatus({ spotsAt: now, grids: [row('a'), row('b')] });
    const after = deskFromStatus({ spotsAt: now, grids: [row('b'), row('c')] });
    const delta = deskDelta(before, after);
    expect(delta.removedIds).toEqual(['a']);
    expect(delta.bots.map((b) => b.metrics.botId)).toEqual(['c']);
    const merged = applyDelta(before, delta);
    expect(merged.bots.map((b) => b.metrics.botId).sort()).toEqual(['b', 'c']);
  });

  it('serves a snapshot, a heartbeat, and one bot of metrics, and refuses another host', async () => {
    const owner = bot();
    const id = await owner.add(PAPER);
    const server = createApp({ bot: owner, net: NET, heartbeatMs: 30, statusThrottleMs: 60_000 }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const live = await stream(port, (e) => e.some((x) => x.event === 'snapshot') && e.some((x) => x.event === 'hb'));
      const snap = live.evs.find((e) => e.event === 'snapshot')!.data as { source: string; bots: { metrics: { botId: string } }[] };
      expect(snap.source).toBe('live');
      expect(snap.bots.map((b) => b.metrics.botId)).toContain(id);
      expect(JSON.stringify(snap)).not.toContain('walletBalances');

      const metrics = await get(port, `/api/bot/${id}/metrics`);
      expect(metrics.status).toBe(200);
      expect(JSON.parse(metrics.body).metrics.botId).toBe(id);
      expect((await get(port, '/api/bot/missing/metrics')).status).toBe(404);

      const denied = await stream(port, () => false, { host: 'evil.example' });
      expect(denied.status).toBe(403);

      const posted = await new Promise<number>((resolve) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/api/v2/stream', method: 'POST',
          headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', origin: 'http://127.0.0.1' },
        }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.end('{}');
      });
      expect(posted).not.toBe(200);
      expect(posted).not.toBe(201);
    } finally {
      server.close();
    }
  });

  it('a friend copy stream does not include the owner bot', async () => {
    const owner = bot();
    const friend = bot();
    const id = await owner.add(PAPER);
    const ownerSrv = await listen(createApp({ bot: owner, net: NET, heartbeatMs: 60_000 }));
    const friendSrv = await listen(createApp({ bot: friend, net: NET, copy: true, heartbeatMs: 60_000 }));
    try {
      const ownerSnap = await stream(ownerSrv.port, (e) => e.some((x) => x.event === 'snapshot'));
      const friendSnap = await stream(friendSrv.port, (e) => e.some((x) => x.event === 'snapshot'));
      const ids = (evs: Ev[]) => JSON.stringify((evs.find((e) => e.event === 'snapshot')?.data as { bots?: unknown })?.bots ?? []);
      expect(ids(ownerSnap.evs)).toContain(id);
      expect(ids(friendSnap.evs)).not.toContain(id);
    } finally {
      ownerSrv.close();
      friendSrv.close();
    }
  });
});
