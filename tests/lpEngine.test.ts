import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../src/live/networks';
import { chainFromNetwork } from '../src/live/chains';
import { legacyMarkets, type MarketDef } from '../src/live/markets';
import { ChainRuntime } from '../src/server/chains/runtime';
import { Hub } from '../src/server/chains/hub';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import { LpEngine, type LpState } from '../src/server/bot/lpEngine';
import { RECENTER_AFTER_MS, RECENTER_COOLDOWN_MS } from '../src/live/recenter';
import { Q128 } from '../src/live/v3Liquidity';
import { MultiDexMock, type Tok } from './helpers/multiDex';
import { ERC20, V3_NPM } from '../src/server/dex/abis';
import type { ReceiptLike } from '../src/server/bot/chain';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app';
import { MultiBot, type MultiState } from '../src/server/bot/multi';

const NET = NETWORKS.mainnet;
const CH = chainFromNetwork(NET);
const dex = (id: string) => CH.dexes.find((d) => d.id === id)!;
const WPLS: Tok = { address: NET.pulsex.wpls, symbol: 'WPLS', decimals: 18 };
const DAI: Tok = { address: NET.quotes.find((q) => q.symbol === 'DAI')!.address, symbol: 'DAI', decimals: 18 };
const PRICE = 0.00003; // DAI per PLS

function world() {
  const m = new MultiDexMock();
  [WPLS, DAI].forEach((t) => m.addToken(t));
  m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
  // deep pool: 1e10 PLS / 3e5 DAI at 0.00003 DAI per PLS
  const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
  const def: MarketDef = {
    key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
    base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
    pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
  };
  const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, null)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
  let t = 1_800_000_000_000;
  const store = new MemoryStore<LpState>();
  const lp = new LpEngine({ net: NET, store, log: new Logger(true), hub, now: () => t });
  return { m, pool, def, hub, lp, store, at: (ms: number) => { t = 1_800_000_000_000 + ms; } };
}
const value = (lp: LpEngine) => lp.status().value!;

describe('LP bot (paper): open, earn, re-range, send, close', () => {
  it('opens a ±10% position around the price with the right mix; value stays close to the amount', async () => {
    const { lp } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick(); // swap to the mix + mint
    const s = lp.status();
    expect(s.step).toBeNull();
    expect(s.position).not.toBeNull();
    expect(s.position!.lower).toBeLessThan(PRICE);
    expect(s.position!.upper).toBeGreaterThan(PRICE);
    expect(s.position!.lower).toBeCloseTo(PRICE * 0.9, 6);
    expect(s.inRange).toBe(true);
    // roughly half in each coin; only the swap's fee + impact and dust stay out
    expect(s.coins!.base * PRICE).toBeGreaterThan(400);
    expect(s.coins!.quote).toBeGreaterThan(400);
    expect(value(lp)).toBeGreaterThan(995);
    expect(value(lp)).toBeLessThan(1000);
  });

  it("fees come from the pool's counters, scaled by the share of the pool the position would be", async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const v0 = value(lp);
    // the pool's in-range liquidity earns 1e-6 DAI per unit of liquidity (DAI is token1 here only if WPLS < DAI)
    m.addFees(pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n);
    await lp.tick();
    const s = lp.status(), L = BigInt(s.position!.liquidity);
    const poolL = BigInt(Math.round(Math.sqrt(1e10 * 1e18 * 3e5 * 1e18)));
    const each = Number((L / 10n ** 6n) * poolL / (poolL + L)) / 1e18; // per token, human (both 18 decimals)
    expect(s.owed!.base).toBeCloseTo(each, 9);
    expect(s.owed!.quote).toBeCloseTo(each, 9);
    expect(value(lp) - v0).toBeCloseTo(each * PRICE + each, 9);
  });

  it(`re-ranges both ways after ${RECENTER_AFTER_MS / 3600_000}h out of range, at most every ${RECENTER_COOLDOWN_MS / 3600_000}h`, async () => {
    const { lp, m, pool, at } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    const first = lp.status().position!;
    m.movePrice(pool, 1.2); // PLS up 20% (DAI per PLS ↑ when WPLS is token0)
    await lp.tick();
    expect(lp.status().inRange).toBe(false);
    at(RECENTER_AFTER_MS - 60_000); await lp.tick();
    expect(lp.status().position!.id).toBe(first.id);
    at(RECENTER_AFTER_MS + 60_000); await lp.tick(); // exit → swap → mint, all in paper
    const s = lp.status();
    expect(s.reranges).toBe(1);
    expect(s.inRange).toBe(true);
    expect(s.position!.lower).toBeGreaterThan(first.upper * 0.95);
    // down through it again: not before the cooldown
    m.movePrice(pool, 0.7);
    at(RECENTER_AFTER_MS * 3); await lp.tick();
    at(RECENTER_AFTER_MS * 4); await lp.tick();
    expect(lp.status().reranges).toBe(1);
    at(RECENTER_AFTER_MS + 60_000 + RECENTER_COOLDOWN_MS + 1); await lp.tick();
    expect(lp.status().reranges).toBe(2);
    expect(lp.status().inRange).toBe(true);
  });

  it('a stopped bot never re-ranges; the position stays open', async () => {
    const { lp, m, pool, at } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    lp.stop();
    m.movePrice(pool, 1.3);
    at(RECENTER_AFTER_MS * 5); await lp.tick();
    expect(lp.status()).toMatchObject({ status: 'stopped', reranges: 0 });
    expect(lp.status().position).not.toBeNull();
  });

  it('send mode collects the fees to the address once they are worth 10× the gas', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000, profits: { mode: 'send', to: '0x00000000000000000000000000000000000beef1' } });
    await lp.tick();
    m.addFees(pool, Q128 / 10n ** 5n, Q128 / 10n ** 5n);
    await lp.tick(); // fees large enough → collect step
    await lp.tick();
    const s = lp.status();
    expect(s.totals.sent).toBeGreaterThan(0);
    expect(s.owed!.base + s.owed!.quote).toBeCloseTo(0, 12);
  });

  it('close takes everything out to the wallet and ends the bot', async () => {
    const { lp, m, pool } = world();
    await lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    await lp.tick();
    m.addFees(pool, Q128 / 10n ** 6n, 0n);
    lp.close();
    await lp.tick();
    const s = lp.status();
    expect(s).toMatchObject({ status: 'closed', position: null, step: null });
    expect(s.totals.fees).toBeGreaterThan(0);
    expect(s.idle.base * PRICE + s.idle.quote).toBeGreaterThan(995);
  });

  it('refuses ranges outside ±1–50%, no amount, and markets that are not V3 pools', async () => {
    const { lp } = world();
    await expect(lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.6, capital: 100 })).rejects.toThrow(/±1% to ±50%/);
    await expect(lp.start({ mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 0 })).rejects.toThrow(/amount/);
    await expect(lp.start({ mode: 'paper', market: 'DAI', bandPct: 0.1, capital: 100 })).rejects.toThrow(/needs a V3 pool/);
  });
});

describe('LP bot (live): every step sent once, settled by hash, safe across restarts', () => {
  const ME = '0x1234567890123456789012345678901234567890';
  const NPM = dex('9mm-v3').positionManager!;
  function live() {
    const m = new MultiDexMock();
    [WPLS, DAI].forEach((t) => m.addToken(t));
    m.addV3('9mm-v3', { factory: dex('9mm-v3').factory, quoter: dex('9mm-v3').quoter! });
    const pool = m.v3Pool('9mm-v3', WPLS, 1e10, DAI, 3e5, 2500);
    const def: MarketDef = {
      key: 'pulsechain:PLS/DAI#9mm', chainId: 369, custom: true,
      base: { address: WPLS.address, symbol: 'PLS', decimals: 18, native: true }, quote: { address: DAI.address, symbol: 'DAI', decimals: 18 },
      pool: { dex: '9mm-v3', kind: 'v3', address: pool, feeBps: 25, feeTier: 2500 }, probe: 1, quoteKind: 'stable',
    };
    const receipts = new Map<string, ReceiptLike>();
    let approved = false;
    const call = m.call.bind(m);
    m.call = async (tx) => (approved && tx.data.startsWith(ERC20.getFunction('allowance')!.selector) ? ERC20.encodeFunctionResult('allowance', [2n ** 255n]) : call(tx));
    m.getTransactionReceipt = async (h: string) => receipts.get(h) ?? null;
    const signer = { getAddress: async () => ME, sendTransaction: async () => { throw new Error('use the scripted executor'); } };
    const hub = new Hub({ runtimes: [new ChainRuntime(CH, m, signer as never)], markets: [...legacyMarkets(NET), def], legacyNet: NET });
    const store = new MemoryStore<LpState>();
    const sent: { to: string; data: string; value: bigint; hash: string }[] = [];
    // Scripted executor: swaps fill at the pool price; every other tx is recorded and mined only when the test says so.
    const exec = {
      mode: 'live' as const, address: async () => ME, getPrice: async () => PRICE,
      balances: async () => ({ pls: 1e12, stable: 1e9 }),
      quote: async (side: 'buy' | 'sell', amount: number) => ({ side, amountInHuman: amount, quotedOutHuman: side === 'buy' ? amount / PRICE : amount * PRICE, balanceOk: true, priceImpact: 0, tokenOut: side === 'buy' ? WPLS.address : DAI.address, decimalsOut: 18, price: PRICE }),
      execute: async (q: { side: string; amountInHuman: number; quotedOutHuman: number }) => ({ txHash: '0xswap', amountInHuman: q.amountInHuman, amountOutHuman: q.quotedOutHuman, gasPls: 0.1 }),
      recover: async () => null,
      sendTx: async (req: { to: string; data: string; value: bigint }) => { const hash = `0x${(sent.length + 1).toString(16).padStart(64, '0')}`; sent.push({ ...req, hash }); return hash; },
    };
    const make = () => { const e = new LpEngine({ net: NET, store, log: new Logger(true), hub, now: () => 1_800_000_000_000 }); (e as unknown as { executor: unknown }).executor = exec; return e; };
    const ok = (hash: string, logs: ReceiptLike['logs'] = []) => receipts.set(hash, { status: 1, gasUsed: 100_000n, gasPrice: 10n ** 9n, logs });
    const ev = (name: 'IncreaseLiquidity' | 'DecreaseLiquidity' | 'Collect', args: unknown[]) => ({ address: NPM, ...V3_NPM.encodeEventLog(name, args) });
    return { m, make, sent, receipts, ok, ev, approve: () => { approved = true; } };
  }

  it('approve → mint: each sent once, nothing resent while unmined, position from the receipt; a restart resumes by hash', async () => {
    const w = live();
    const a = w.make();
    await a.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (a as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor; // start() rebuilt it
    await a.tick();
    expect(w.sent).toHaveLength(1);
    expect(ERC20.parseTransaction({ data: w.sent[0].data })!.name).toBe('approve'); // DAI to the position manager
    expect(w.sent[0].to.toLowerCase()).toBe(DAI.address.toLowerCase());
    await a.tick(); await a.tick();
    expect(w.sent).toHaveLength(1); // not mined → never resent
    w.approve(); w.ok(w.sent[0].hash);
    await a.tick();
    expect(w.sent).toHaveLength(2);
    const mint = w.sent[1];
    expect(mint.to).toBe(NPM);
    const [calls] = V3_NPM.decodeFunctionData('multicall', mint.data) as unknown as [string[]];
    expect(calls.map((c) => V3_NPM.parseTransaction({ data: c })!.name)).toEqual(['mint', 'refundETH']); // PLS paid with the tx value
    expect(mint.value).toBeGreaterThan(0n);
    // restart before the mint is mined: the new engine waits on the same hash
    const b = w.make();
    await b.tick();
    expect(w.sent).toHaveLength(2);
    w.ok(mint.hash, [w.ev('IncreaseLiquidity', [777n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n])]);
    await b.tick();
    expect(b.status().position).toMatchObject({ id: '777', liquidity: (10n ** 20n).toString() });
    expect(b.status().step).toBeNull();
  });

  it('close: one multicall (remove all, collect via the manager, unwrap PLS, sweep DAI, burn); fees = collected − principal', async () => {
    const w = live();
    const e = w.make();
    await e.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (e as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor;
    w.approve();
    await e.tick();
    w.ok(w.sent[0].hash, [w.ev('IncreaseLiquidity', [5n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n])]);
    await e.tick();
    e.close();
    await e.tick();
    const exit = w.sent[1];
    const [calls] = V3_NPM.decodeFunctionData('multicall', exit.data) as unknown as [string[]];
    expect(calls.map((c) => V3_NPM.parseTransaction({ data: c })!.name)).toEqual(['decreaseLiquidity', 'collect', 'unwrapWETH9', 'sweepToken', 'burn']);
    const col = V3_NPM.decodeFunctionData('collect', calls[1])[0] as { recipient: string };
    expect(col.recipient).toBe('0x0000000000000000000000000000000000000000');
    expect((V3_NPM.decodeFunctionData('sweepToken', calls[3]) as unknown as [string])[0].toLowerCase()).toBe(DAI.address.toLowerCase());
    // principal 1000 PLS + 0.03 DAI, collected 1010 PLS + 0.04 DAI → fees 10 PLS + 0.01 DAI (WPLS < DAI: token0 = WPLS)
    w.ok(exit.hash, [w.ev('DecreaseLiquidity', [5n, 10n ** 20n, 10n ** 21n, 3n * 10n ** 16n]), w.ev('Collect', [5n, '0x0000000000000000000000000000000000000000', 1010n * 10n ** 18n, 4n * 10n ** 16n])]);
    await e.tick();
    const s = e.status();
    expect(s).toMatchObject({ status: 'closed', position: null });
    expect(s.totals.fees).toBeCloseTo(10 * PRICE + 0.01, 9);
  });

  it('a step that keeps reverting stops the bot after 3 tries (nothing lost)', async () => {
    const w = live();
    const e = w.make();
    await e.start({ mode: 'live', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
    (e as unknown as { executor: unknown }).executor = (w.make() as unknown as { executor: unknown }).executor;
    w.approve();
    for (let i = 0; i < 3; i++) {
      await e.tick();
      w.receipts.set(w.sent.at(-1)!.hash, { status: 0, gasUsed: 100_000n, gasPrice: 10n ** 9n, logs: [] });
    }
    await e.tick();
    expect(e.status().status).toBe('stopped');
    expect(e.lastError).toMatch(/reverted 3 times/);
    expect(w.sent).toHaveLength(3);
  });
});


describe('LP bot in the app: API, status, restart, money split', () => {
  async function serve(store = new MemoryStore<MultiState>()) {
    const w = world();
    const bot = new MultiBot({ net: NET, reader: w.m, signer: null, store, log: new Logger(true), hub: w.hub, now: () => 1_800_000_000_000 });
    const server = createApp({ bot, net: NET }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const data = JSON.stringify(body ?? {}); // like the UI: always a JSON body (with its length, as browsers send it)
      const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(b) }));
      });
      req.on('error', reject);
      req.end(data);
    });
    return { ...w, bot, store, call, close: () => new Promise((r) => server.close(r)) };
  }

  it('starts from the API, opens on the next poll, and every control works; a position blocks Remove until closed', async () => {
    const a = await serve();
    try {
      const ml = a.bot.marketList();
      expect(ml.find((m) => m.key === 'pulsechain:PLS/DAI#9mm')!.lpOk).toBe(true);
      expect(ml.find((m) => m.key === 'DAI')!.lpOk).toBe(false); // PulseX V2: no position manager
      const bad = await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'DAI', bandPct: 0.1, capital: 100 });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/needs a V3 pool/);
      expect(a.bot.status().lps).toHaveLength(0); // a failed start leaves nothing behind

      const r = await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.08, capital: 500, profits: { mode: 'reinvest' } });
      expect(r.status).toBe(200);
      const id = r.body.id as string;
      await a.bot.tickAll();
      let st = a.bot.status().lps[0];
      expect(st).toMatchObject({ id, status: 'running', inRange: true, config: { bandPct: 0.08, capital: 500, rerange: true } });
      expect(st.position).not.toBeNull();
      expect(st.pnl!.equity).toBeLessThan(500);
      expect(st.pnl!.equity).toBeGreaterThan(495);

      expect((await a.call('PUT', `/api/bot/lps/${id}/rerange`, { enabled: false })).status).toBe(200);
      expect(a.bot.status().lps[0].config!.rerange).toBe(false);
      expect((await a.call('PUT', `/api/bot/lps/${id}/profits`, { mode: 'send', to: 'nope' })).status).toBe(400);
      expect((await a.call('POST', `/api/bot/lps/${id}/stop`)).status).toBe(200);
      expect(a.bot.status().lps[0].status).toBe('stopped');
      const del = await a.call('DELETE', `/api/bot/lps/${id}`);
      expect(del.status).toBe(400);
      expect(del.body.error).toMatch(/Close the position first/);
      expect((await a.call('POST', `/api/bot/lps/${id}/resume`)).status).toBe(200);
      expect((await a.call('POST', `/api/bot/lps/${id}/close`)).status).toBe(200);
      await a.bot.tickAll();
      st = a.bot.status().lps[0];
      expect(st).toMatchObject({ status: 'closed', position: null, step: null });
      expect((await a.call('DELETE', `/api/bot/lps/${id}`)).status).toBe(200);
      expect(a.bot.status().lps).toHaveLength(0);
    } finally { await a.close(); }
  });

  it('a restart picks the position up from the saved state; KILL ALL pauses it but it keeps being measured', async () => {
    const store = new MemoryStore<MultiState>();
    const a = await serve(store);
    let id: string;
    try {
      id = (await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 })).body.id;
      await a.bot.tickAll();
    } finally { await a.close(); }
    const before = a.bot.status().lps[0].position!;
    const b = await serve(store);
    try {
      expect(b.bot.status().lps[0]).toMatchObject({ id, status: 'running', position: before });
      b.bot.stopAll();
      await b.bot.tickAll();
      const st = b.bot.status().lps[0];
      expect(st.status).toBe('stopped');
      expect(st.value).toBeGreaterThan(990); // still read while paused
    } finally { await b.close(); }
  });

  it('profit = fees − gas + price, and the overview counts the bot', async () => {
    const a = await serve();
    try {
      await a.call('POST', '/api/bot/lps', { mode: 'paper', market: 'pulsechain:PLS/DAI#9mm', bandPct: 0.1, capital: 1000 });
      await a.bot.tickAll();
      a.m.addFees(a.pool, Q128 / 10n ** 6n, Q128 / 10n ** 6n);
      a.m.movePrice(a.pool, 1.03); // stays inside the ±10% range
      await a.bot.tickAll();
      const st = a.bot.status().lps[0], p = st.pnl!;
      expect(p.fees).toBeGreaterThan(0);
      expect(p.gas).toBeGreaterThan(0);
      expect(p.profit).toBeCloseTo(p.fees - p.gas + p.price, 9);
      expect(p.equity).toBeCloseTo(st.value! + st.totals.sent - st.totals.gas, 9);
      const row = a.bot.overview().bots.find((x) => x.kind === 'lp')!;
      expect(row.capital).toBe(1000);
      expect(row.equity).toBeCloseTo(p.equity, 9);
      expect(row.realized).toBeCloseTo(p.fees - p.gas, 9);
      expect(row.unrealized).toBeCloseTo(p.price, 9);
    } finally { await a.close(); }
  });
});
