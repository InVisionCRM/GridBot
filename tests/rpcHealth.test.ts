/**
 * Ethereum "missing revert data" (2026-10-27): ethers v6 turns any JSON-RPC error on eth_call into CALL_EXCEPTION
 * "missing revert data". cloudflare-eth.com answers every eth_call with {"code":-32603,"message":"Internal error"}, so the
 * reader treated it as a revert, never rotated off it, and the ETH/USDC liquidity bots and the GTC grid failed every tick.
 * These pin: such errors rotate; real reverts don't; endpoints cool down; chain health alerts and recovers once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbiCoder, type JsonRpcProvider } from 'ethers';
import { FallbackReader, isRealRevert, isTransportError, rpcErrorText } from '../src/server/chains/fallback';

const tx = { to: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', data: '0x3850c7bd' };

/** The exact error ethers 6.17 builds for an eth_call JSON-RPC error (JsonRpcProvider.getRpcError). */
function rpcCallError(error: { code: number; message: string; data?: string }) {
  const e = AbiCoder.getBuiltinCallException('call', tx, error.data ?? null) as Error & { info?: unknown };
  e.info = { error, payload: { method: 'eth_call', params: [tx, 'latest'] } };
  return e;
}
const cloudflare = () => rpcCallError({ code: -32603, message: 'Internal error' });
const rateLimited = () => rpcCallError({ code: -32005, message: 'Rate limit exceeded' });
const reverted = () => rpcCallError({ code: -32000, message: 'execution reverted' });
const revertedWithData = () => rpcCallError({ code: 3, message: 'execution reverted', data: '0x1425ea42' /* a custom error selector */ });
const down = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });

type Step = 'ok' | 'cf' | 'rl' | 'revert' | 'down';
function rpc(script: Step[] | (() => Step)) {
  let n = 0;
  const p = {
    call: async () => {
      n++;
      const s = typeof script === 'function' ? script() : script.shift() ?? 'ok';
      if (s === 'cf') throw cloudflare();
      if (s === 'rl') throw rateLimited();
      if (s === 'revert') throw reverted();
      if (s === 'down') throw down();
      return '0x01';
    },
  };
  return { p: p as unknown as JsonRpcProvider, calls: () => n };
}
async function settle<T>(p: Promise<T>) {
  const out = p.then((v) => ({ v }), (e: Error) => ({ e }));
  await vi.advanceTimersByTimeAsync(10_000);
  return out;
}
const T0 = 1_793_115_346_000;

describe('error classification', () => {
  it('a JSON-RPC error wrapped as "missing revert data" is a transport error', () => {
    const e = cloudflare();
    expect((e as Error).message).toMatch(/missing revert data/);
    expect(isRealRevert(e)).toBe(false);
    expect(isTransportError(e)).toBe(true);
    expect(isTransportError(rateLimited())).toBe(true);
    expect(rpcErrorText(e)).toBe('RPC error -32603 Internal error');
  });
  it('a real revert stays final (with data, code 3, or "execution reverted" without data)', () => {
    for (const e of [reverted(), revertedWithData()]) {
      expect(isRealRevert(e)).toBe(true);
      expect(isTransportError(e)).toBe(false);
    }
    // raised locally without an RPC payload: still treated as the contract's answer
    expect(isTransportError(AbiCoder.getBuiltinCallException('call', tx, null))).toBe(false);
  });
});

describe('FallbackReader rotation', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('rotates off an endpoint that answers eth_call with "Internal error"', async () => {
    const a = rpc(['cf']), b = rpc(['ok']);
    const r = new FallbackReader(['https://cloudflare-eth.com', 'https://b.example'], 1, [a.p, b.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect(r.currentUrl).toBe('https://b.example');
    expect(r.health().endpoints[0]).toMatchObject({ ok: false, lastError: 'RPC error -32603 Internal error' });
  });

  it('rotates on a JSON-RPC rate limit (-32005)', async () => {
    const a = rpc(['rl']), b = rpc(['ok']);
    const r = new FallbackReader(['https://a.example', 'https://b.example'], 1, [a.p, b.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
  });

  it('does not rotate or retry on a real revert', async () => {
    const a = rpc(['revert']), b = rpc(['ok']);
    const r = new FallbackReader(['https://a.example', 'https://b.example'], 1, [a.p, b.p]);
    const out = await settle(r.call(tx));
    expect('e' in out && out.e.message).toMatch(/missing revert data/);
    expect([a.calls(), b.calls()]).toEqual([1, 0]);
    expect(r.currentUrl).toBe('https://a.example');
    expect(r.health().state).toBe('ok');
  });

  it('skips an endpoint that is cooling down', async () => {
    // a fails → b; b fails → c (a cooling) ; c fails → all cooling → a
    const a = rpc(['down', 'ok']), b = rpc(['down']), c = rpc(['ok']);
    const r = new FallbackReader(['https://a.example', 'https://b.example', 'https://c.example'], 1, [a.p, b.p, c.p]);
    expect(await settle(r.call(tx))).toEqual({ v: '0x01' });
    expect(r.currentUrl).toBe('https://c.example');
    expect(r.health().endpoints.map((x) => x.ok)).toEqual([false, false, true]);
  });

  it('cooldown: after a fails, the next rotation from b goes to c, not back to a', async () => {
    const a = rpc(['down']), b = rpc(['ok', 'down']), c = rpc(['ok']);
    const r = new FallbackReader(['https://a.example', 'https://b.example', 'https://c.example'], 1, [a.p, b.p, c.p]);
    await settle(r.call(tx)); // a fails → b ok
    expect(r.currentUrl).toBe('https://b.example');
    await settle(r.call(tx)); // b fails → c (a still cooling), ok
    expect(r.currentUrl).toBe('https://c.example');
    expect([a.calls(), b.calls(), c.calls()]).toEqual([1, 2, 1]);
  });
});

describe('chain RPC health: alert and recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('every endpoint failing for 3 min alerts once; quiet + a success recovers once', async () => {
    let mode: Step = 'cf';
    const a = rpc(() => mode), b = rpc(() => mode);
    const r = new FallbackReader(['https://a.example', 'https://b.example'], 1, [a.p, b.p]);
    expect(r.checkHealth()).toBeNull();
    // fail every 10 s for 3.5 min
    for (let t = 0; t < 21; t++) {
      await settle(r.call(tx));
      expect(r.health().state).toBe('down');
      if (t < 17) expect(r.checkHealth()).toBeNull();
    }
    const alerts = [r.checkHealth(), r.checkHealth()].filter(Boolean);
    expect(alerts).toEqual([expect.objectContaining({ kind: 'alert', minutes: 3, lastError: 'RPC error -32603 Internal error' })]);
    expect(r.health()).toMatchObject({ state: 'down', alerted: true, lastError: 'RPC error -32603 Internal error' });
    mode = 'ok';
    await settle(r.call(tx));
    expect(r.checkHealth()).toBeNull(); // not quiet long enough yet
    vi.advanceTimersByTime(120_000);
    await settle(r.call(tx));
    expect(r.checkHealth()).toMatchObject({ kind: 'recovered' });
    expect(r.checkHealth()).toBeNull();
    expect(r.health().state).toBe('ok');
  });

  it('the alert fires exactly once per episode', async () => {
    const a = rpc(() => 'down');
    const r = new FallbackReader(['https://a.example'], 1, [a.p]);
    const seen: string[] = [];
    for (let t = 0; t < 40; t++) {
      await settle(r.call(tx));
      const ch = r.checkHealth();
      if (ch) seen.push(ch.kind);
    }
    expect(seen).toEqual(['alert']);
  });

  it('a short burst (under the alert time) closes quietly', async () => {
    let mode: Step = 'cf';
    const a = rpc(() => mode);
    const r = new FallbackReader(['https://a.example'], 1, [a.p]);
    for (let t = 0; t < 4; t++) { await settle(r.call(tx)); expect(r.checkHealth()).toBeNull(); }
    mode = 'ok';
    vi.advanceTimersByTime(130_000);
    await settle(r.call(tx));
    expect(r.checkHealth()).toBeNull();
    expect(r.health().state).toBe('ok');
  });
});

describe('MultiBot: RPC health in the status and the Activity log', async () => {
  const { MultiBot } = await import('../src/server/bot/multi');
  const { MemoryStore } = await import('../src/server/bot/store');
  const { Logger } = await import('../src/server/bot/logger');
  const { ActivityBus } = await import('../src/server/bot/activity');
  const { NETWORKS } = await import('../src/live/networks');
  const { MockChain } = await import('./helpers/mockChain');

  it('writes one alert entry and one recovery entry, and exposes rpcHealth per chain', () => {
    const changes: (null | { kind: 'alert'; minutes: number; failures: number; lastError: string | null } | { kind: 'recovered'; minutes: number; failures: number })[] = [
      { kind: 'alert', minutes: 4, failures: 24, lastError: 'RPC error -32603 Internal error' }, null, { kind: 'recovered', minutes: 6, failures: 31 },
    ];
    const health = { state: 'down', alerted: true, failingSince: T0, failures: 24 };
    const reader = Object.assign(new MockChain(1e-5), { checkHealth: () => changes.shift() ?? null, health: () => health });
    const activity = new ActivityBus();
    const bot = new MultiBot({ net: NETWORKS.mainnet, reader, signer: null, store: new MemoryStore(), log: new Logger(true), activity });
    bot.checkRpcHealth(); bot.checkRpcHealth(); bot.checkRpcHealth();
    const ev = activity.recent().filter((e) => /RPC/.test(e.msg));
    expect(ev.map((e) => [e.level, e.notify])).toEqual([['error', true], ['success', true]]);
    expect(ev[0].msg).toMatch(/RPC failing for 4 min \(24 failed reads on every endpoint\): RPC error -32603 Internal error/);
    expect(ev[1].msg).toMatch(/RPC recovered after 6 min/);
    expect(bot.chainsStatus()[0].rpcHealth).toEqual(health);
  });
});
