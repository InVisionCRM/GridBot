/**
 * Vite middleware: demo SSE for v2 and a frozen classic API for before-screenshots.
 * Handles /api itself so dev does not need the real bot server or a key.
 */
import { classicAuto, classicCandles, classicHoldings, classicOpps, classicStatus, classicTrader } from './classic-fixture';
import { loadDesk } from './load-owner';
import { createSnapshotDesk } from './snapshot-desk';

interface DemoReq {
  url?: string;
  method?: string;
  on: (ev: string, cb: () => void) => void;
}
interface DemoRes {
  writeHead: (code: number, headers: Record<string, string>) => void;
  write: (chunk: string) => void;
  end: (chunk?: string) => void;
}

/** Dev-only demo API. Typed without Vite's Plugin so vitest's nested Vite copy still accepts it. */
export function demoPlugin() {
  const desk = createSnapshotDesk(loadDesk());
  return {
    name: 'gridbot-v2-demo',
    configureServer(server: { middlewares: { use: (fn: (req: DemoReq, res: DemoRes, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) return next();
        const path = url.split('?')[0];

        if (path === '/api/v2/stream') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          const send = (event: string, data: unknown) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          send('snapshot', desk.snapshot());
          const timer = setInterval(() => send('delta', desk.tick()), 900);
          req.on('close', () => clearInterval(timer));
          return;
        }

        if (path === '/api/bot/stream') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          const send = (event: string, data: unknown) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          send('hello', { t: Date.now(), network: 'demo', recent: [] });
          send('status', classicStatus());
          const timer = setInterval(() => {
            send('ticks', { t: Date.now(), prices: { USDC: 3248.2, HEX: 1420, DAI: 0.00482 } });
          }, 2000);
          req.on('close', () => clearInterval(timer));
          return;
        }

        const json = (body: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(body));
        };
        if (path === '/api/bot/status') return json(classicStatus());
        if (path === '/api/holdings') return json(classicHoldings());
        if (path === '/api/autopilot') return json(classicAuto());
        if (path === '/api/token-trader') return json(classicTrader());
        if (path === '/api/opportunities') return json(classicOpps());
        if (path === '/api/market/candles') return json(classicCandles());
        if (path === '/api/activity') return json({ events: [] });
        if (path === '/api/system/version') return json({ state: 'current', title: 'Demo', detail: 'Demo data', steps: [], v: null });
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') return json({ ok: true, demo: true });
        return json({ demo: true });
      });
    },
  };
}
