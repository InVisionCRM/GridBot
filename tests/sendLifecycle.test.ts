/**
 * The live send path when a transaction does not end the plain way:
 * - a042: replaced or cancelled from a wallet app (same nonce): never booked as our fill; a re-priced copy is ours.
 * - a043: dropped by the network: the shared nonce is re-read, so the next send on the chain can still mine.
 * - a044: mined OK but its output log can't be read: booked at the swap's guaranteed minimum (flagged), never as a
 *   revert after a restart.
 */
import { describe, expect, it } from 'vitest';
import { LiveExecutor, type Quote, type Quoter, type TxSender } from '../src/server/bot/chain';
import { SharedNonce } from '../src/server/bot/txGate';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore, type Store } from '../src/server/bot/store';
import { DEFAULT_LIMITS } from '../src/live/limits';
import { MockChain, NET } from './helpers/mockChain';

const ME = '0x' + '11'.repeat(20);
type Wait = 'mined' | 'cancelled' | 'repriced' | 'dropped';

/** A chain that mines only the next nonce in order; `plan` says how each sent tx ends. */
function chain(plan: Wait[]) {
  const c = { mined: 0, sent: [] as number[] };
  const signer: TxSender = {
    getAddress: async () => ME,
    sendTransaction: async (tx) => {
      c.sent.push(tx.nonce);
      const how = plan.shift() ?? 'mined';
      const hash = '0x' + (c.sent.length).toString(16).padStart(64, '0');
      const ok = { status: 1, gasUsed: 21_000n, gasPrice: 1n, logs: [] };
      return {
        hash,
        wait: async () => {
          if (how === 'dropped' || tx.nonce !== c.mined) return null; // never mined (a gap leaves later nonces stuck)
          c.mined++;
          if (how === 'cancelled') throw Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', reason: 'cancelled', receipt: ok, replacement: { hash: '0xcafe' } });
          if (how === 'repriced') throw Object.assign(new Error('replaced'), { code: 'TRANSACTION_REPLACED', reason: 'repriced', receipt: ok, replacement: { hash: '0xbeef' } });
          return ok;
        },
      };
    },
  };
  const q: Quote = {
    side: 'buy', tokenIn: '0x' + 'aa'.repeat(20), tokenOut: '0x' + 'bb'.repeat(20), decimalsIn: 18, decimalsOut: 18,
    amountIn: 10n ** 18n, quotedOut: 10n ** 18n,
    call: { method: 'swap', to: '0x' + 'dd'.repeat(20), data: '0x1234', value: 0n, amountOutMin: 5n * 10n ** 17n } as unknown as Quote['call'],
    approveAmount: null, spender: '0x' + 'dd'.repeat(20), priceImpact: 0.001, gasPlsEstimate: 0, gasNativeEstimate: 0, gasWei: 0n, l1FeeWei: 0n,
    basePerNative: 1, amountInHuman: 1, quotedOutHuman: 1, minOutHuman: 0.5, price: 1, balanceOk: true, balanceNote: null,
    routerOut: 1n, poolIn: 1n, taxInPct: 0, taxOutPct: 0, feeOnTransfer: false, poolPrice: 1, block: null,
  };
  const quoter = {
    tokenIn: () => q.tokenIn, allowance: async () => 2n ** 255n, ensureDecimals: async () => undefined,
    def: { quote: { decimals: 18 }, base: { decimals: 18 }, safety: undefined }, tokenBalance: async () => 10n ** 30n,
    quote: async () => q,
    reader: { getBalance: async () => 10n ** 30n, getTransactionCount: async () => c.mined, getTransactionReceipt: async () => null },
    chain: { nativeSymbol: 'PLS', wrappedNative: { address: '0x' + 'cc'.repeat(20) } },
    stable: { symbol: 'WPLS', native: false }, base: { symbol: 'NEW', native: false }, tokenSide: 'base',
  } as unknown as Quoter;
  const nonce = new SharedNonce();
  const send = async () => {
    const ex = new LiveExecutor(quoter, signer, { approval: 'exact', receiptTimeoutMs: 50, sharedNonce: nonce });
    return ex.execute(await ex.quote('buy', 1, DEFAULT_LIMITS), { canSend: () => true, onSent: () => undefined });
  };
  return { c, send };
}

describe('a swap replaced from the wallet (a042)', () => {
  it('cancelled: not a fill; the nonce is re-read for the next send', async () => {
    const w = chain(['cancelled', 'mined']);
    await expect(w.send()).rejects.toThrow(/cancelled/);
    await expect(w.send()).resolves.toMatchObject({ amountOutHuman: expect.any(Number) });
    expect(w.c.sent).toEqual([0, 1]);
  });
  it('re-priced (same call, more gas): our fill, under its new hash', async () => {
    const w = chain(['repriced']);
    await expect(w.send()).resolves.toMatchObject({ txHash: '0xbeef' });
  });
});

describe('a swap the network dropped (a043)', () => {
  it('the next send re-reads the nonce and mines (was: every later send stuck behind the gap)', async () => {
    const w = chain(['dropped', 'mined']);
    await expect(w.send()).rejects.toThrow(/not confirmed yet/);
    await expect(w.send()).resolves.toBeTruthy();
    expect(w.c.sent).toEqual([0, 0]);
  });
});

describe('a mined swap whose output log can not be read, settled after a restart (a044)', () => {
  const P0 = 0.00001;
  const boot = (c: MockChain, store: Store<MultiState>) => new MultiBot({ net: NET, reader: c, signer: c, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0 });
  it('booked at the guaranteed minimum, flagged; never a revert that re-arms the level', async () => {
    const store = new MemoryStore<MultiState>();
    const c = new MockChain(P0);
    const a = boot(c, store);
    const read = c.getTransactionReceipt.bind(c);
    c.getTransactionReceipt = async () => null; // the app goes down before it sees the receipt
    c.faults = [undefined as never, 'timeout']; // the DAI approval goes through; the swap's receipt is not seen
    const id = await a.add({ mode: 'live', stable: 'DAI', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalQuote: 30 });
    for (let i = 0; i < 3 && !a.status().grids[0].inFlight?.swapTxHash; i++) { c.setPrice(P0 * (0.97 - i * 0.01)); await a.tickAll(); }
    a.flush();
    const saved = store.load()!.grids.find((g) => g.id === id)!.inFlight!;
    expect(saved.swapTxHash).toMatch(/^0x/);
    expect(saved.minOutHuman).toBeGreaterThan(0);
    for (const h of [...c.unmined.keys(), saved.swapTxHash!]) { const r = c.unmined.get(h) ?? c.receipts.get(h); if (r) { c.unmined.delete(h); c.receipts.set(h, { ...r, logs: [] }); } } // mined OK, nothing readable
    c.getTransactionReceipt = read;
    const b = boot(c, store);
    await b.tickAll();
    const t = b.status().grids.find((g) => g.id === id)!.trades.find((x: { txHash?: string }) => x.txHash === saved.swapTxHash)!;
    expect(t).toMatchObject({ side: 'buy', fromReceipt: false });
    expect(t.failed).toBeFalsy();
    expect(t.plsAmount).toBeCloseTo(saved.minOutHuman!, 6);
  });
});
