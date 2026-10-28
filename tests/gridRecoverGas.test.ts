/**
 * Gas on a swap reconciled after a restart is booked in BASE units. A fresh Quoter's lastBasePerNative starts at 1, so
 * reading it in recover() booked native gas 1:1 as base on pairs whose base isn't the chain's coin (HEX/PLS). The rate
 * is now saved with the in-flight swap; old records read it again; if neither works the gas is marked unknown (never 1).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'ethers';
import { LiveExecutor, Quoter, type ChainReader, type ReceiptLike, type TxSender } from '../src/server/bot/chain';
import { GAS_UNKNOWN_NOTE } from '../src/server/bot/engine';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { DurableJsonStore } from '../src/server/bot/durableStore';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore, type Store } from '../src/server/bot/store';
import type { MarketDef } from '../src/live/markets';
import { MockChain, NET } from './helpers/mockChain';

// ── LiveExecutor.recover on a fresh Quoter (lastBasePerNative = 1), fake reader, no transactions ───────────────
const WNAT = getAddress('0x' + 'a'.repeat(40));
const TOK = getAddress('0x' + 'c'.repeat(40));
const ME = getAddress('0x' + 'd'.repeat(40));
const GAS_NATIVE = 0.1; // 100k gas × 1000 gwei
const receipt = (status: number): ReceiptLike => ({ status, gasUsed: 100_000n, gasPrice: 10n ** 12n, logs: [] });

function exec(o: { baseNative: boolean; status?: number; rate?: () => Promise<number> }) {
  const reader = {
    async getTransactionReceipt() { return receipt(o.status ?? 1); },
  } as unknown as ChainReader;
  const signer = { async getAddress() { return ME; } } as unknown as TxSender;
  const def = {
    key: o.baseNative ? 'ethereum:ETH/USDG' : 'pulse:HEX/PLS', chainId: o.baseNative ? 1 : 369,
    base: o.baseNative ? { address: WNAT, symbol: 'ETH', decimals: 18, native: true } : { address: TOK, symbol: 'HEX', decimals: 8 },
    quote: o.baseNative ? { address: TOK, symbol: 'USDG', decimals: 6 } : { address: WNAT, symbol: 'PLS', decimals: 18, native: true },
    pool: { dex: 'x', kind: 'v2', address: WNAT, feeBps: 29 }, probe: 1, quoteKind: o.baseNative ? 'stable' : 'token',
  } as unknown as MarketDef;
  const chain = { wrappedNative: { address: WNAT, symbol: 'W', decimals: 18 } } as never;
  let calls = 0;
  const q = new Quoter(reader, def, { chain, adapter: {} as never, basePerNative: async () => { calls++; return o.rate ? o.rate() : 0.0075; } });
  return { q, ex: new LiveExecutor(q, signer, { approval: 'exact', receiptTimeoutMs: 1000 }), calls: () => calls };
}

describe('LiveExecutor.recover: gas in base units on a fresh Quoter', () => {
  it('HEX/PLS fill: the rate saved at send time is used (no re-read), not the starting 1', async () => {
    const { q, ex, calls } = exec({ baseNative: false });
    expect(q.lastBasePerNative).toBe(1);
    const r = (await ex.recover('0x1', TOK, 8, 0.008))!;
    expect(r.ok).toBe(true);
    expect(r.gasNative).toBeCloseTo(GAS_NATIVE, 12);
    expect(r.gasPls).toBeCloseTo(GAS_NATIVE * 0.008, 12);
    expect(r.gasUnknown).toBeUndefined();
    expect(calls()).toBe(0);
  });
  it('HEX/PLS fill, old record without the rate: reads it now (awaited), not the starting 1', async () => {
    const { ex, calls } = exec({ baseNative: false });
    const r = (await ex.recover('0x1', TOK, 8))!;
    expect(r.gasPls).toBeCloseTo(GAS_NATIVE * 0.0075, 12);
    expect(calls()).toBe(1);
    // a bad saved value (0 / NaN) is ignored the same way
    expect((await ex.recover('0x1', TOK, 8, 0))!.gasPls).toBeCloseTo(GAS_NATIVE * 0.0075, 12);
    expect((await ex.recover('0x1', TOK, 8, Number.NaN))!.gasPls).toBeCloseTo(GAS_NATIVE * 0.0075, 12);
  });
  it('HEX/PLS reverted swap: same conversion on the failure path', async () => {
    const saved = (await exec({ baseNative: false, status: 0 }).ex.recover('0x1', TOK, 8, 0.008))!;
    expect(saved).toMatchObject({ ok: false, amountOutHuman: 0 });
    expect(saved.gasPls).toBeCloseTo(GAS_NATIVE * 0.008, 12);
    const old = (await exec({ baseNative: false, status: 0 }).ex.recover('0x1', TOK, 8))!;
    expect(old.gasPls).toBeCloseTo(GAS_NATIVE * 0.0075, 12);
  });
  it('rate unreadable and none saved: gas marked unknown (0 base, native kept), never booked 1:1', async () => {
    for (const rate of [async () => { throw new Error('rpc down'); }, async () => Number.NaN, async () => 0]) {
      const r = (await exec({ baseNative: false, rate }).ex.recover('0x1', TOK, 8))!;
      expect(r.gasUnknown).toBe(true);
      expect(r.gasPls).toBe(0);
      expect(r.gasNative).toBeCloseTo(GAS_NATIVE, 12);
    }
    // a rate already read in this process is still a real reading and is used
    let fail = false;
    const { q, ex } = exec({ baseNative: false, rate: async () => { if (fail) throw new Error('rpc down'); return 0.009; } });
    await q.basePerNative();
    fail = true;
    const r = (await ex.recover('0x1', TOK, 8))!;
    expect(r.gasUnknown).toBeUndefined();
    expect(r.gasPls).toBeCloseTo(GAS_NATIVE * 0.009, 12);
  });
  it('ETH/USDG (native base) is unchanged: gas in base = gas in ETH, saved rate or not', async () => {
    for (const saved of [undefined, 1]) {
      const { ex, calls } = exec({ baseNative: true });
      const r = (await ex.recover('0x1', TOK, 6, saved))!;
      expect(r.gasPls).toBeCloseTo(GAS_NATIVE, 12);
      expect(r.gasUnknown).toBeUndefined();
      expect(calls()).toBe(0);
    }
  });
});

// ── Grid engine restart on the mock: flipped HEX/PLS live grid (base HEX, quote native PLS) ────────────────
const P0 = 0.00001;
const QH = 0.0075; // HEX per PLS
type Trade = { txHash: string; gasPls: number; gasUsd: number; failed?: boolean; gasUnknown?: boolean; note?: string; side: string };

function boot(chain: MockChain, store: Store<MultiState>) {
  return new MultiBot({ net: NET, reader: chain, signer: chain, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
}
/** Live HEX~ grid whose first swap is broadcast but not confirmed before the "crash". */
async function crashWithPendingSwap(store: Store<MultiState>) {
  const chain = new MockChain(P0, { quoteDepth: 100_000_000 });
  chain.setPrice(QH, 'HEX');
  const a = boot(chain, store);
  const mid = 1 / QH;
  chain.faults = ['timeout'];
  const id = await a.add({ mode: 'live', stable: 'HEX~', lowerPrice: mid * 0.9, upperPrice: mid * 1.1, gridCount: 10, totalCapitalUsd: 1_000_000 });
  for (let i = 0; i < 3 && !a.status().grids[0].inFlight?.swapTxHash; i++) { chain.setPrice(QH / (0.97 - i * 0.01), 'HEX'); await a.tickAll(); }
  a.flush();
  const g = store.load()!.grids.find((x) => x.id === id)!;
  expect(g.inFlight?.swapTxHash).toMatch(/^0x/);
  return { chain, id, hash: g.inFlight!.swapTxHash!, saved: g.inFlight!.basePerNative };
}
const tradeOf = (bot: MultiBot, id: string, hash: string) =>
  (bot.status().grids.find((x: { id: string }) => x.id === id)!.trades as Trade[]).find((t) => t.txHash === hash);

describe('grid restart reconcile (HEX/PLS): gas booked in base units', () => {
  it('saves basePerNative with the in-flight swap and books the fill gas with it after a restart', async () => {
    const store = new MemoryStore<MultiState>();
    const { chain, id, hash, saved } = await crashWithPendingSwap(store);
    expect(saved).toBeGreaterThan(QH * 0.9); // HEX per PLS, not 1
    expect(saved).toBeLessThan(QH * 1.2);
    chain.setPrice(QH * 2, 'HEX'); // a re-read rate would now differ: the send-time rate must win
    const b = boot(chain, store);
    await b.tickAll();
    const t = tradeOf(b, id, hash)!;
    expect(t).toMatchObject({ side: 'buy' });
    expect(t.failed).toBeFalsy();
    expect(t.gasPls).toBeCloseTo(GAS_NATIVE * saved!, 12);
    expect(t.gasUnknown).toBeUndefined();
  });

  it('reverted swap reconciled after a restart: the failure books gas in base units too', async () => {
    const store = new MemoryStore<MultiState>();
    const { chain, id, hash, saved } = await crashWithPendingSwap(store);
    chain.receipts.set(hash, { ...chain.receipts.get(hash)!, status: 0, logs: [] });
    const b = boot(chain, store);
    await b.tickAll();
    const t = tradeOf(b, id, hash)!;
    expect(t.failed).toBe(true);
    expect(t.gasPls).toBeCloseTo(GAS_NATIVE * saved!, 12);
  });

  it('an old state.json record (no basePerNative) loads through the real file store and re-reads the rate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-recover-gas-'));
    try {
      const file = join(dir, 'state.json');
      const { chain, id, hash, saved } = await crashWithPendingSwap(new DurableJsonStore<MultiState>(file));
      // Rewrite the file the way an older build left it: the in-flight record has no basePerNative.
      const raw = JSON.parse(readFileSync(file, 'utf8')) as MultiState;
      for (const g of raw.grids) if (g.inFlight) delete g.inFlight.basePerNative;
      writeFileSync(file, JSON.stringify(raw, null, 2));
      const store = new DurableJsonStore<MultiState>(file);
      expect(store.load()!.grids.find((x) => x.id === id)!.inFlight).toMatchObject({ swapTxHash: hash });
      const b = boot(chain, store);
      expect(b.status().grids.find((x: { id: string }) => x.id === id)!.status).toBe('running');
      await b.tickAll();
      const t = tradeOf(b, id, hash)!;
      expect(t.failed).toBeFalsy();
      // Spot moved only by the swap itself: the re-read rate is within 1% of the send-time one
      expect(t.gasPls / (GAS_NATIVE * saved!)).toBeCloseTo(1, 2);
      expect(t.gasPls).toBeLessThan(GAS_NATIVE * 0.5); // never the 1:1 booking
      b.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([['fill', 1], ['reverted swap', 0]] as const)('rate unreadable on an old record (%s): booked with gas marked unknown and a warning, not 1:1', async (_, status) => {
    const store = new MemoryStore<MultiState>();
    const { chain, id, hash } = await crashWithPendingSwap(store);
    if (status === 0) chain.receipts.set(hash, { ...chain.receipts.get(hash)!, status: 0, logs: [] });
    for (const g of store.data!.grids) if (g.inFlight) delete g.inFlight.basePerNative;
    const lines: string[] = [];
    const log = new Logger(true);
    const orig = log.warn.bind(log);
    log.warn = (m: string) => { lines.push(m); orig(m); };
    const b = new MultiBot({ net: NET, reader: chain, signer: chain, store, log, maxRetries: 0, retryDelayMs: 0 });
    // The pool read behind the rate fails for this reconcile only (the receipt read still works).
    const call = chain.call.bind(chain);
    chain.call = async () => { throw new Error('rpc down'); };
    const e = (b as unknown as { engines: Map<string, { reconcile(): Promise<void> }> }).engines.get(id)!;
    await e.reconcile();
    chain.call = call;
    const t = tradeOf(b, id, hash)!;
    expect(t.gasUnknown).toBe(true);
    expect(t.gasPls).toBe(0);
    expect(t.gasUsd).toBe(0);
    expect(!!t.failed).toBe(status === 0);
    expect(t.note).toContain(GAS_UNKNOWN_NOTE);
    expect(lines.some((m) => m.includes('not booked') && m.includes(hash))).toBe(true);
  });
});
