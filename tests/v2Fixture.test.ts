import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoPlugin, v2FixtureEnabled, v2FixtureMiddleware } from '../src/v2/demo-plugin';

function call(enabled: boolean, url: string, method: string) {
  const handler = v2FixtureMiddleware(enabled);
  const writes: string[] = [];
  let code = 0;
  let nexted = false;
  const closes: Array<() => void> = [];
  handler?.({
    url,
    method,
    on(ev, cb) { if (ev === 'close') closes.push(cb); },
  }, {
    writeHead(c) { code = c; },
    write(chunk) { writes.push(chunk); },
    end() { /* sse stays open */ },
  }, () => { nexted = true; });
  closes.forEach((cb) => cb());
  return { code, writes, nexted, installed: handler != null };
}

describe('v2 fixture plugin', () => {
  it('is inert unless GRIDBOT_V2_FIXTURE=1', () => {
    const prev = process.env.GRIDBOT_V2_FIXTURE;
    delete process.env.GRIDBOT_V2_FIXTURE;
    try {
      expect(v2FixtureEnabled()).toBe(false);
      expect(v2FixtureMiddleware()).toBeNull();
      let used = false;
      demoPlugin().configureServer({ middlewares: { use() { used = true; } } });
      expect(used).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GRIDBOT_V2_FIXTURE;
      else process.env.GRIDBOT_V2_FIXTURE = prev;
    }
  });

  it('answers only GET /api/v2/stream and never a mutation or another route', () => {
    const stream = call(true, '/api/v2/stream', 'GET');
    expect(stream.installed).toBe(true);
    expect(stream.nexted).toBe(false);
    expect(stream.code).toBe(200);
    expect(stream.writes[0]).toContain('event: snapshot');
    expect(stream.writes.join('')).not.toMatch(/0x[0-9a-fA-F]{8,}/);

    for (const [url, method] of [
      ['/api/bot/status', 'GET'],
      ['/api/bot/stream', 'GET'],
      ['/api/bot/grids', 'POST'],
      ['/api/bot/grids/abc', 'PUT'],
      ['/api/bot/grids/abc', 'DELETE'],
      ['/api/v2/stream', 'POST'],
      ['/api/v2/stream', 'DELETE'],
    ] as const) {
      const hit = call(true, url, method);
      expect(hit.nexted).toBe(true);
      expect(hit.code).toBe(0);
      expect(hit.writes).toEqual([]);
    }

    const off = call(false, '/api/v2/stream', 'GET');
    expect(off.installed).toBe(false);
  });

  it('keeps the owner snapshot out of git', () => {
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(ignore).toMatch(/^data\/owner-snapshot\/$/m);
  });
});
