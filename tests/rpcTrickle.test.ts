/**
 * "Robinhood Chain: RPC failing for 4 min (18 failed reads …)" (Kyle, 2026-10-31) while Robinhood's RPC answered fast:
 * a trickle of failed reads among mostly good ones. The banner says bots "can't read prices or trade until it
 * recovers", which is only true when reads are failing, not when one failed recently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcProvider } from 'ethers';
import { FallbackReader } from '../src/server/chains/fallback';

const tx = { to: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', data: '0x3850c7bd' };
const down = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'NETWORK_ERROR' });
async function settle<T>(p: Promise<T>) {
  const out = p.then((v) => ({ v }), (e: Error) => ({ e }));
  await vi.advanceTimersByTimeAsync(5_000);
  return out;
}

describe('a trickle of failed reads among good ones', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_793_115_346_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('a random failed read is retried and never counts: the chain stays ok', async () => {
    let n = 0;
    const p = { call: async () => { if (++n % 10 === 0) throw down(); return '0x01'; } } as unknown as JsonRpcProvider;
    const r = new FallbackReader(['https://rpc.example'], 4663, [p]);
    for (let i = 0; i < 60; i++) { await settle(r.call(tx)); r.checkHealth(); }
    expect(r.health()).toMatchObject({ state: 'ok', failures: 0 });
  });

  it('one kind of read always fails (all 3 tries) while every other read works for 5 min: no "failing" alert; the chain reads degraded', async () => {
    const bad = { to: '0x' + 'bb'.repeat(20), data: '0x01' };
    const p = { call: async (t: { to: string }) => { if (t.to === bad.to) throw down(); return '0x01'; } } as unknown as JsonRpcProvider;
    const r = new FallbackReader(['https://rpc.example'], 4663, [p]);
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      await settle(r.call(tx));
      if (i % 4 === 0) await settle(r.call(bad));
      const ch = r.checkHealth();
      if (ch) seen.push(ch.kind);
    }
    expect(r.health().failures).toBeGreaterThan(10);
    expect(seen).toEqual([]);
    expect(r.health().state).toBe('degraded');
    expect(r.health().alerted).toBe(false);
  });

  it('after a real outage, good reads for 2 min clear the alert once, even while one kind of read still fails', async () => {
    const bad = { to: '0x' + 'bb'.repeat(20), data: '0x01' };
    let outage = true;
    const p = { call: async (t: { to: string }) => { if (outage || t.to === bad.to) throw down(); return '0x01'; } } as unknown as JsonRpcProvider;
    const r = new FallbackReader(['https://rpc.example'], 4663, [p]);
    const seen: string[] = [];
    const step = async (i: number) => {
      await settle(r.call(tx));
      if (i % 4 === 0) await settle(r.call(bad));
      const ch = r.checkHealth();
      if (ch) seen.push(ch.kind);
    };
    for (let i = 0; i < 40; i++) await step(i);
    expect(seen).toEqual(['alert']);
    outage = false;
    for (let i = 0; i < 12; i++) await step(i); // ~60-75 s of good reads: not yet
    expect(seen).toEqual(['alert']);
    for (let i = 0; i < 30; i++) await step(i);
    expect(seen).toEqual(['alert', 'recovered']);
    expect(r.health().alerted).toBe(false);
  });

  it('every read failing for 3 min still alerts once', async () => {
    const p = { call: async () => { throw down(); } } as unknown as JsonRpcProvider;
    const r = new FallbackReader(['https://rpc.example'], 4663, [p]);
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      await settle(r.call(tx));
      const ch = r.checkHealth();
      if (ch) seen.push(ch.kind);
    }
    expect(seen).toEqual(['alert']);
    expect(r.health().state).toBe('down');
  });
});
