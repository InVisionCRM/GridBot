/**
 * A scheduled tax re-check whose buy/sell simulation could not run (RPC timeout, rate limit) measured nothing. It must
 * not pause the bots on that market, and the market keeps its last measured safety report. A check after a suspicious
 * event still fails closed, and a honeypot found by a working simulation still pauses.
 */
import { describe, expect, it } from 'vitest';
import { classify, type ProbeResult } from '../src/server/dex/safety';
import { TaxWatch, isInconclusive } from '../src/server/bot/taxWatch';
import { Hub } from '../src/server/chains/hub';
import { MockChain, NET } from './helpers/mockChain';
import type { SafetyReport } from '../src/live/markets';

const probe = (p: Partial<ProbeResult> = {}): ProbeResult => ({
  stage: 0, quoteIn: 10n ** 18n, expectedBuy: 1000n, gotBuy: 1000n, transferSent: 100n, transferGot: 100n,
  sellIn: 900n, expectedSell: 900n, gotSell: 900n, err: '', gasBuy: 100_000n, gasSell: 100_000n, ...p,
});
const depth = [{ usd: 100, buyImpactPct: 0.001, sellImpactPct: 0.001 }, { usd: 1000, buyImpactPct: 0.01, sellImpactPct: 0.01 }];
const measured = (p: Partial<ProbeResult> = {}): SafetyReport => classify({ probe: probe(p), proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2', now: 0 });
const unavailable = (): SafetyReport => classify({ probe: null, simError: 'request timeout (code=TIMEOUT)', proxy: null, depth, liquidityUsd: 1e6, poolKind: 'v2', now: 1 });

function watch(next: () => SafetyReport) {
  const current = measured({ gotBuy: 990n });
  const paused: string[] = [];
  const alerts: { level: string; msg: string }[] = [];
  const w = new TaxWatch({
    now: () => 1e12, markets: () => ['MEME/DAI'], current: () => current,
    recheck: async () => next(),
    pause: (_k, why) => { paused.push(why); return 3; },
    alert: (_k, level, msg) => { alerts.push({ level, msg }); },
    label: () => 'MEME/DAI·PLS', intervalMs: 1, debounceMs: 0,
  });
  return { w, paused, alerts };
}

describe('TaxWatch: an inconclusive scheduled re-check', () => {
  it('a simulation that did not run is inconclusive; a measured one is not', () => {
    expect(isInconclusive(unavailable())).toBe(true);
    expect(unavailable().liveAllowed).toBe(false);
    expect(isInconclusive(measured())).toBe(false);
    expect(isInconclusive(measured({ stage: 4 }))).toBe(false);
  });

  it('does not pause bots when the scheduled simulation could not run', async () => {
    const { w, paused, alerts } = watch(unavailable);
    const [r] = await w.tick();
    expect(paused).toEqual([]);
    expect(r).toMatchObject({ blocked: false, paused: 0 });
    expect(r.error).toMatch(/simulation unavailable/i);
    expect(alerts[0]).toMatchObject({ level: 'warn' });
    expect(alerts[0].msg).toMatch(/inconclusive.*keep running/);
  });

  it('still pauses on a honeypot found by a working simulation', async () => {
    const { w, paused } = watch(() => measured({ stage: 4 }));
    const [r] = await w.tick();
    expect(r.blocked).toBe(true);
    expect(paused).toHaveLength(1);
  });

  it('still pauses on a tax rise', async () => {
    const { w, paused } = watch(() => measured({ gotBuy: 900n }));
    const [r] = await w.tick();
    expect(r.rose).toMatch(/buy/);
    expect(paused[0]).toMatch(/tax rose/);
  });

  it('after a suspicious event (swap reverted) an inconclusive check still fails closed', async () => {
    const { w, paused } = watch(unavailable);
    const r = await w.suspect('MEME/DAI', 'swap reverted on MEME/DAI·PLS');
    expect(r?.blocked).toBe(true);
    expect(paused).toHaveLength(1);
  });
});

describe('Hub.recheck({ keepMeasured }) keeps the last measured report when a re-check measured nothing', () => {
  const hubWith = (fresh: SafetyReport) => {
    const hub = Hub.single(NET, new MockChain(), null);
    const key = hub.list()[0].key;
    const d = hub.def(key);
    d.safety = measured();
    (hub as unknown as { inspect: () => Promise<unknown> }).inspect = async () => ({ safety: fresh });
    return { hub, key, d };
  };

  it('returns the inconclusive report but leaves the stored one in place', async () => {
    const { hub, key, d } = hubWith(unavailable());
    const before = d.safety;
    const r = await hub.recheck(key, { keepMeasured: true });
    expect(isInconclusive(r)).toBe(true);
    expect(r.liveAllowed).toBe(false);
    expect(d.safety).toBe(before);
    expect(d.safety!.liveAllowed).toBe(true);
  });

  it('without keepMeasured (a live start, a manual re-check) the fresh report replaces it, as before', async () => {
    const fresh = unavailable();
    const { hub, key, d } = hubWith(fresh);
    expect(await hub.recheck(key)).toBe(fresh);
    expect(d.safety).toBe(fresh);
  });

  it('stores a measured report as before', async () => {
    const hp = measured({ stage: 4 });
    const { hub, key, d } = hubWith(hp);
    const r = await hub.recheck(key, { keepMeasured: true });
    expect(r).toBe(hp);
    expect(d.safety).toBe(hp);
  });
});
