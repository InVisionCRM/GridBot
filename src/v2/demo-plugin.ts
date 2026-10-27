/**
 * Opt-in Vite middleware for the v2 desk when the bot server is not running.
 * Off unless GRIDBOT_V2_FIXTURE=1. When on, it answers only GET /api/v2/stream
 * from the local snapshot (or the sanitized fixture). Every other /api route,
 * including POST/PUT/DELETE, falls through to the real proxy.
 */
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
type Next = () => void;
export type FixtureMiddleware = (req: DemoReq, res: DemoRes, next: Next) => void;

export function v2FixtureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GRIDBOT_V2_FIXTURE === '1';
}

/** Null when the fixture is off, so the dev server installs nothing. */
export function v2FixtureMiddleware(enabled = v2FixtureEnabled()): FixtureMiddleware | null {
  if (!enabled) return null;
  const desk = createSnapshotDesk(loadDesk());
  return (req, res, next) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '').split('?')[0];
    if (method !== 'GET' || path !== '/api/v2/stream') return next();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('snapshot', desk.snapshot());
    const timer = setInterval(() => {
      send('delta', desk.tick());
      send('hb', { t: Date.now() });
    }, 900);
    req.on('close', () => clearInterval(timer));
  };
}

/** Dev-only. Typed without Vite's Plugin so vitest's nested Vite copy still accepts it. */
export function demoPlugin(enabled = v2FixtureEnabled()) {
  const handler = v2FixtureMiddleware(enabled);
  return {
    name: 'gridbot-v2-demo',
    configureServer(server: { middlewares: { use: (fn: FixtureMiddleware) => void } }) {
      if (handler) server.middlewares.use(handler);
    },
  };
}
