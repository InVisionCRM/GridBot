/** Swap quotes are the host's. A friend's copy and a Funnel request do not get them. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import type { SwapService } from '../src/server/swap/service';
import { MockChain, NET } from './helpers/mockChain';

function appOf(o: { copy?: boolean; funnel?: boolean }) {
  const chain = new MockChain();
  const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
  let quotes = 0;
  const swap = { quote: async () => { quotes++; return { paper: true, holdId: null, tx: null }; } } as unknown as SwapService;
  const app = createApp({ bot, net: NET, copy: o.copy, swap, heartbeatMs: 60_000, statusThrottleMs: 60_000 });
  return { app, quotes: () => quotes };
}

const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

function post(app: ReturnType<typeof createApp>, headers: http.OutgoingHttpHeaders) {
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const r = http.request({
        host: '127.0.0.1', port, path: '/api/swap/quote', method: 'POST',
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ chainId: 369, tokenIn: 'native', tokenOut: '0x' + '11'.repeat(20), amountIn: '1', owner: '0x' + '22'.repeat(20) }));
    });
  });
}

describe('swap quoting is host-only', () => {
  it('a friend copy does not serve the route, even if a service was passed in', async () => {
    const { app, quotes } = appOf({ copy: true });
    const got = await post(app, {});
    expect(got.status).toBe(400);
    expect(got.text).toMatch(/host-only/);
    expect(quotes()).toBe(0);
  });

  it('a Funnel request is refused on the host', async () => {
    const { app, quotes } = appOf({});
    const got = await post(app, { 'tailscale-funnel-request': '?1' });
    expect(got.status).toBe(400);
    expect(got.text).toMatch(/host-only/);
    expect(quotes()).toBe(0);
  });

  it('the host quotes when the request is local', async () => {
    const { app, quotes } = appOf({});
    const got = await post(app, {});
    expect(got.status).toBe(200);
    expect(quotes()).toBe(1);
  });
});
