/**
 * Capital router settings: off and paper by default, hard caps clamp, Stop all turns it off,
 * live refuses to arm with zero caps, and quote keys never appear in the API body.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { Logger, redact } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { bridgeConfigured, takeBridgeKeys } from '../src/server/env';
import { Router, type RouterFile } from '../src/server/router/router';
import { DEFAULT_MAX_GAS_PRICE_WEI, DEFAULT_MAX_PRIORITY_FEE_WEI, defaultMaxPriorityFee, etaP90Within, liveEnableError, MAX_GAS_PRICE_WEI_CAP, ROUTER_HARD_CAPS } from '../src/server/router/settings';
import { MockChain, NET } from './helpers/mockChain';

const CHAINS = [369, 1, 4663];
const servers: http.Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) { s.closeAllConnections?.(); s.close(); } });

function listen(app: ReturnType<typeof createApp>) {
  const server = http.createServer(app);
  servers.push(server);
  return new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function req(port: number, path: string, method: string, headers: http.OutgoingHttpHeaders = {}, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body != null) r.end(body); else r.end();
  });
}
const json = { 'content-type': 'application/json' };

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

describe('router settings', () => {
  it('defaults are off and paper, with empty allow-lists and zero live caps', () => {
    const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: CHAINS });
    const s = router.status();
    expect(s.on).toBe(false);
    expect(s.mode).toBe('paper');
    expect(s.host).toBe(true);
    expect(s.maxPerMoveUsd).toBe(0);
    expect(s.maxPerDayUsd).toBe(0);
    expect(s.maxPerMoveUsdByChain).toEqual({});
    expect(s.allowedChains).toEqual([]);
    expect(s.allowedBridges).toEqual([]);
    expect(s.minNetGainPct).toBe(0.005);
    expect(s.minNetGainTok).toMatchObject({ USDG: 5, ETH: 0.002, PLS: 50_000 });
    expect(s.maxSlippageBps).toBe(50);
    expect(s.maxEtaMin).toBe(60);
    expect(s.maxEtaBasis).toBe('p90');
    expect(s.cooldownMin).toBe(360);
    expect(s.maxMovesPerDay).toBe(2);
    expect(s.minConfidence).toBe(0.5);
    expect(s.receiptTimeoutMs).toBe(120_000);
    expect(s.autoClaim).toBe(false);
    expect(s.halt).toBeNull();
    expect(s.configured).toEqual({ across: false, relay: false, lifi: false });
    expect(router.gasCap(369, 'bridge')).toBe(300_000n);
    expect(router.gasCap(1, 'claim')).toBe(500_000n);
    expect(router.gasCap(999, 'swap')).toBeNull();
    expect(s.maxGasPriceWei['1']).toBe(DEFAULT_MAX_GAS_PRICE_WEI[1].toString());
    expect(s.maxGasPriceWei['369']).toBe(DEFAULT_MAX_GAS_PRICE_WEI[369].toString());
    expect(s.maxGasPriceWei['4663']).toBe(DEFAULT_MAX_GAS_PRICE_WEI[4663].toString());
    expect(router.maxGasPriceWei(1)).toBe(DEFAULT_MAX_GAS_PRICE_WEI[1]);
    expect(router.maxGasPriceWei(999)).toBeNull();
    expect(s.maxPriorityFeeWei['1']).toBe(DEFAULT_MAX_PRIORITY_FEE_WEI[1].toString());
    expect(s.maxPriorityFeeWei['369']).toBe(DEFAULT_MAX_PRIORITY_FEE_WEI[369].toString());
    expect(s.maxPriorityFeeWei['4663']).toBe(DEFAULT_MAX_PRIORITY_FEE_WEI[4663].toString());
    expect(DEFAULT_MAX_PRIORITY_FEE_WEI[369]).toBe(1_000_000n * 1_000_000_000n);
    expect(DEFAULT_MAX_PRIORITY_FEE_WEI[369]).toBeGreaterThan(935_000n * 1_000_000_000n);
    expect(router.maxPriorityFeeWei(369)).toBe(DEFAULT_MAX_PRIORITY_FEE_WEI[369]);
    expect(router.maxPriorityFeeWei(999)).toBeNull();
    expect(defaultMaxPriorityFee(10, 200n * 1_000_000_000n)).toBe(20n * 1_000_000_000n);
    expect(defaultMaxPriorityFee(369, 1n)).toBe(1n);
    expect(router.isHalted()).toBe(false);
    expect(etaP90Within(60 * 60, 60)).toBe(true);
    expect(etaP90Within(60 * 60 + 1, 60)).toBe(false);
    expect(router.update(s)).toEqual(s);
    const saved = new MemoryStore<RouterFile>();
    new Router({ store: saved, host: true, chainIds: CHAINS }).status();
    const file = saved.load()!;
    expect(file.version).toBe(1);
    expect(file.on).toBe(false);
    expect(file).not.toHaveProperty('host');
    expect(file).not.toHaveProperty('configured');
    expect(file).not.toHaveProperty('maxEtaBasis');
  });

  it('clamps to the hard caps and never stores canonical-slow', () => {
    const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: CHAINS });
    const s = router.update({
      maxPerMoveUsd: 1e12,
      maxPerDayUsd: -1,
      maxSlippageBps: 99_999,
      maxEtaMin: 0,
      cooldownMin: -4,
      maxMovesPerDay: 100,
      minConfidence: 4,
      minNetGainPct: 0.9,
      minNetGainTok: { ETH: 1e13, PLS: -1 },
      allowedBridges: ['Across', 'canonical-slow', 'relay'],
      allowedChains: [369, 1],
      gasCaps: { '369': { claim: 9_000_000 } },
      autoClaim: true,
    });
    expect(s.maxPerMoveUsd).toBe(ROUTER_HARD_CAPS.maxPerMoveUsd);
    expect(s.maxPerDayUsd).toBe(0);
    expect(s.maxSlippageBps).toBe(ROUTER_HARD_CAPS.maxSlippageBps);
    expect(s.maxEtaMin).toBe(1);
    expect(s.cooldownMin).toBe(0);
    expect(s.maxMovesPerDay).toBe(ROUTER_HARD_CAPS.maxMovesPerDay);
    expect(s.minConfidence).toBe(1);
    expect(s.minNetGainPct).toBe(ROUTER_HARD_CAPS.minNetGainPct);
    expect(s.minNetGainTok.ETH).toBe(ROUTER_HARD_CAPS.minNetGainTok);
    expect(s.minNetGainTok.PLS).toBe(0);
    expect(s.allowedBridges).toEqual(['across', 'relay']);
    expect(s.allowedChains).toEqual([369, 1]);
    expect(s.gasCaps['369'].claim).toBe(ROUTER_HARD_CAPS.gasUnits);
    expect(s.gasCaps['369'].bridge).toBe(300_000);
    expect(router.update({ maxGasPriceWei: { '1': MAX_GAS_PRICE_WEI_CAP.toString() + '0' } }).maxGasPriceWei['1']).toBe(MAX_GAS_PRICE_WEI_CAP.toString());
    expect(router.update({ maxGasPriceWei: { '369': '1000000000' } }).maxGasPriceWei['369']).toBe('1000000000');
    expect(() => router.update({ maxGasPriceWei: { '999': '1' } })).toThrow(/Unknown chain/);
    expect(router.maxGasPriceWei(369)).toBe(1_000_000_000n);
    expect(router.update({ maxPriorityFeeWei: { '1': '1' } }).maxPriorityFeeWei['1']).toBe('1');
    expect(router.update({ maxPriorityFeeWei: { '369': MAX_GAS_PRICE_WEI_CAP.toString() + '0' } }).maxPriorityFeeWei['369']).toBe(MAX_GAS_PRICE_WEI_CAP.toString());
    expect(() => router.update({ maxPriorityFeeWei: { '999': '1' } })).toThrow(/Unknown chain/);
    expect(s.autoClaim).toBe(true);
    expect(router.update({ receiptTimeoutMs: 999_999 }).receiptTimeoutMs).toBe(ROUTER_HARD_CAPS.receiptTimeoutMs);
    expect(router.update({ receiptTimeoutMs: 30_000 }).receiptTimeoutMs).toBe(30_000);
    expect(router.update({ maxPerMoveUsd: 100, maxSlippageBps: 0, maxPerMoveUsdByChain: { '369': 1_000 } }).maxPerMoveUsdByChain).toEqual({ '369': 100 });
    expect(router.status().maxSlippageBps).toBe(1);
    expect(() => router.update({ allowedBridges: ['nope'] })).toThrow(/Unknown bridge/);
    expect(() => router.update({ allowedChains: [999] })).toThrow(/not loaded/);
    expect(() => router.update({ maxPerMoveUsdByChain: { '999': 10 } })).toThrow(/Unknown chain/);
    expect(router.status().allowedBridges).toEqual(['across', 'relay']);
  });

  it('a bad file cannot boot into live, and a friend copy cannot turn it on', () => {
    const store = new MemoryStore<RouterFile>();
    store.save({
      version: 1, on: true, mode: 'live', maxPerMoveUsd: 0, maxPerDayUsd: 0,
      maxPerMoveUsdByChain: {}, maxPerDayUsdByChain: {}, allowedChains: [], allowedBridges: ['canonical-slow' as 'across'],
      minNetGainTok: {}, minNetGainPct: 0.005, maxSlippageBps: 99_999, maxEtaMin: 60, cooldownMin: 360,
      maxMovesPerDay: 2, minConfidence: 0.5, gasCaps: {}, maxGasPriceWei: {}, maxPriorityFeeWei: {}, autoClaim: false, halt: null,
    });
    const host = new Router({ store, host: true, chainIds: CHAINS });
    expect(host.status().on).toBe(false);
    expect(host.status().mode).toBe('live');
    expect(host.status().maxSlippageBps).toBe(ROUTER_HARD_CAPS.maxSlippageBps);
    expect(host.status().allowedBridges).toEqual([]);
    expect(store.load()!.on).toBe(false);

    const armed = new MemoryStore<RouterFile>();
    const paper = new Router({ store: armed, host: true, chainIds: CHAINS });
    paper.turnOn();
    expect(paper.status().on).toBe(true);
    const friend = new Router({ store: armed, host: false, chainIds: CHAINS });
    expect(friend.status().host).toBe(false);
    expect(friend.status().on).toBe(false);
    expect(armed.load()!.on).toBe(false);
    expect(() => friend.turnOn()).toThrow(/host app/);
    expect(() => friend.update({ maxPerMoveUsd: 5 })).toThrow(/host app/);
    expect(new Router({ store: new MemoryStore<RouterFile>(), chainIds: CHAINS }).status().host).toBe(false);
  });

  it('refuses to turn on in live while caps or allow-lists are empty, and paper may be on', () => {
    const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: CHAINS });
    expect(router.turnOn().on).toBe(true);
    expect(router.turnOff().on).toBe(false);
    router.update({ mode: 'live' });
    expect(() => router.turnOn()).toThrow(/maxPerMoveUsd/);
    expect(() => router.update({ on: true })).toThrow(/Zero blocks live/);
    expect(router.status().on).toBe(false);
    router.update({ maxPerMoveUsd: 10, maxPerDayUsd: 20 });
    expect(() => router.turnOn()).toThrow(/allowed bridge/);
    router.update({ allowedChains: [369], allowedBridges: ['canonical-slow'] });
    expect(router.status().allowedBridges).toEqual([]);
    expect(() => router.turnOn()).toThrow(/allowed bridge/);
    router.update({ allowedBridges: ['lifi'] });
    expect(router.turnOn()).toMatchObject({ on: true, mode: 'live' });
  });

  it('refuses live when the net gain floor is missing or zero', () => {
    const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: CHAINS });
    router.update({ mode: 'live', maxPerMoveUsd: 10, maxPerDayUsd: 20, allowedChains: [1], allowedBridges: ['across'] });
    expect(liveEnableError(router.status())).toBeNull();
    router.update({ minNetGainPct: 0 });
    expect(() => router.turnOn()).toThrow(/minNetGainPct/);
    expect(router.status().on).toBe(false);
    router.update({ minNetGainPct: 0.005, minNetGainTok: { USDG: 0 } });
    expect(() => router.turnOn()).toThrow(/minNetGainTok/);
    expect(router.status().on).toBe(false);
    expect(liveEnableError({ ...router.status(), minNetGainTok: {} })).toMatch(/minNetGainTok/);
    router.update({ minNetGainTok: { USDG: 5 } });
    expect(router.turnOn()).toMatchObject({ on: true, mode: 'live' });
  });

  it('a restart does not re-arm a router that was left on', () => {
    const liveStore = new MemoryStore<RouterFile>();
    const live = new Router({ store: liveStore, host: true, chainIds: CHAINS });
    live.update({ mode: 'live', maxPerMoveUsd: 10, maxPerDayUsd: 20, allowedChains: [369], allowedBridges: ['across'] });
    expect(live.turnOn()).toMatchObject({ on: true, mode: 'live' });
    expect(liveStore.load()!.on).toBe(true);
    const booted = new Router({ store: liveStore, host: true, chainIds: CHAINS });
    expect(booted.status()).toMatchObject({ on: false, mode: 'live' });
    expect(liveStore.load()!.on).toBe(false);
    expect(booted.turnOn()).toMatchObject({ on: true, mode: 'live' });

    const paperStore = new MemoryStore<RouterFile>();
    const paper = new Router({ store: paperStore, host: true, chainIds: CHAINS });
    paper.turnOn();
    expect(paper.status()).toMatchObject({ on: true, mode: 'paper' });
    const paperAgain = new Router({ store: paperStore, host: true, chainIds: CHAINS });
    expect(paperAgain.status()).toMatchObject({ on: false, mode: 'paper' });
    expect(paperStore.load()!.on).toBe(false);
  });

  it('Stop all turns the router off and records subject router; STOP chain does not', async () => {
    const chain = new MockChain();
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    const store = new MemoryStore<RouterFile>();
    const router = new Router({
      store, host: true, chainIds: [NET.chainId], emit: bot.activity.emitEvent,
    });
    bot.routerHalt = (h) => router.halt(h);
    router.update({ mode: 'live', maxPerMoveUsd: 25, maxPerDayUsd: 50, allowedChains: [NET.chainId], allowedBridges: ['across'] });
    router.turnOn();
    expect(router.status().on).toBe(true);
    bot.stopChain(NET.chainId);
    expect(router.status().on).toBe(true);
    bot.stopAll();
    expect(router.status().on).toBe(false);
    expect(router.status().halt).toMatchObject({ subject: 'router', halt: { what: 'stop-all', detail: 'POST /api/bot/stop-all' } });
    expect(store.load()!.halt).toMatchObject({ subject: 'router' });
    expect(bot.activity.recent().some((e) => e.msg === 'capital router off — no new moves' && (e.data as { subject?: string })?.subject === 'router')).toBe(true);

    router.update({ mode: 'paper' });
    router.turnOn();
    expect(router.status().halt).toBeNull();
    const port = await listen(createApp({ bot, net: NET, router, heartbeatMs: 60_000, statusThrottleMs: 60_000 }));
    const stopped = await req(port, '/api/bot/stop-all', 'POST', json, '{}');
    expect(stopped.status).toBe(200);
    const got = await req(port, '/api/router', 'GET');
    const body = JSON.parse(got.text) as { on: boolean; halt: { subject: string } };
    expect(body.on).toBe(false);
    expect(body.halt.subject).toBe('router');
    const put = await req(port, '/api/router', 'PUT', json, JSON.stringify({ mode: 'live', maxPerMoveUsd: 0, maxPerDayUsd: 0, allowedChains: [], allowedBridges: [] }));
    expect(put.status).toBe(200);
    const refused = await req(port, '/api/router/on', 'POST', json, '{}');
    expect(refused.status).toBe(400);
    expect(refused.text).toMatch(/Zero blocks live/);
    expect(router.status().on).toBe(false);
  });

  it('a save error while recording the halt does not fail Stop all', () => {
    const chain = new MockChain();
    const log = new Logger(true);
    const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log });
    const store = new MemoryStore<RouterFile>();
    const inner = store.save.bind(store);
    let boom = false;
    store.save = (s) => {
      if (boom) throw new Error('disk full https://rpc.example/SECRETKEYVALUE123');
      inner(s);
    };
    const router = new Router({ store, host: true, chainIds: [NET.chainId], log, emit: bot.activity.emitEvent });
    router.turnOn();
    expect(router.isHalted()).toBe(false);
    bot.routerHalt = (h) => router.halt(h);
    boom = true;
    expect(() => bot.stopAll()).not.toThrow();
    expect(router.status().on).toBe(false);
    expect(router.isHalted()).toBe(true);
    expect(router.status().halt?.subject).toBe('router');
    const logged = log.entries.map((e) => e.msg).join('\n');
    expect(logged).toMatch(/halt was not saved/);
    expect(logged).not.toContain('SECRETKEYVALUE123');
    expect(logged).not.toMatch(/https?:\/\//);
    expect(bot.activity.recent().some((e) => e.msg === 'capital router off — no new moves')).toBe(true);
  });
});

describe('router quote keys', () => {
  const across = 'across-test-key-aaaaaaaa';
  const lifi = 'lifi-test-key-bbbbbbbb';

  it('removes the keys from the environment and never puts them in GET /api/router', async () => {
    delete process.env.ACROSS_API_KEY;
    delete process.env.RELAY_API_KEY;
    delete process.env.LIFI_API_KEY;
    process.env.ACROSS_API_KEY = across;
    process.env.LIFI_API_KEY = lifi;
    try {
      const configured = takeBridgeKeys();
      expect(configured).toEqual({ across: true, relay: false, lifi: true });
      expect(bridgeConfigured()).toEqual(configured);
      expect(process.env.ACROSS_API_KEY).toBeUndefined();
      expect(process.env.RELAY_API_KEY).toBeUndefined();
      expect(process.env.LIFI_API_KEY).toBeUndefined();
      expect(redact(`leak ${across} ${lifi}`)).toBe('leak [REDACTED] [REDACTED]');

      const store = new MemoryStore<RouterFile>();
      const router = new Router({ store, host: true, chainIds: CHAINS, configured });
      const chain = new MockChain();
      const bot = new MultiBot({ net: NET, reader: chain, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
      const port = await listen(createApp({ bot, net: NET, router, heartbeatMs: 60_000, statusThrottleMs: 60_000 }));
      const got = await req(port, '/api/router', 'GET');
      expect(got.status).toBe(200);
      expect(got.text).not.toContain(across);
      expect(got.text).not.toContain(lifi);
      const body = JSON.parse(got.text) as { configured: { across: boolean; relay: boolean; lifi: boolean } };
      expect(body.configured).toEqual({ across: true, relay: false, lifi: true });
      expect(strings(body).some((s) => s.includes(across) || s.includes(lifi))).toBe(false);
      expect(JSON.stringify(store.load())).not.toContain(across);
      expect(JSON.stringify(router)).not.toContain(across);

      const live = await req(port, '/api/router', 'PUT', json, JSON.stringify({ mode: 'live', on: true }));
      expect(live.status).toBe(400);
      expect(live.text).toMatch(/Zero blocks live/);
      expect(live.text).not.toContain(across);
    } finally {
      delete process.env.ACROSS_API_KEY;
      delete process.env.RELAY_API_KEY;
      delete process.env.LIFI_API_KEY;
    }
  });
});
