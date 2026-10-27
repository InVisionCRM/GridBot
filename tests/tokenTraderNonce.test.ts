/**
 * Token-trader live sends go through the chain's TxGate and the wallet's SharedNonce, the same ones grid / LP /
 * converter sends use (tokenFeed.liveSwap). One hot wallet, one fake chain that only accepts the next pending nonce.
 */
import { describe, expect, it } from 'vitest';
import { LiveExecutor, type Quote, type Quoter, type TxSender } from '../src/server/bot/chain';
import { SharedNonce, TxGate } from '../src/server/bot/txGate';
import { liveSwap, sendChecks } from '../src/server/market/tokenFeed';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { systemHalt } from '../src/server/bot/audit';
import { DEFAULT_LIMITS } from '../src/live/limits';

const ME = '0x' + '11'.repeat(20);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
function deferred() { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; }

/** A chain that accepts a tx only at the wallet's next nonce, and tracks how many swaps overlap. */
function fakeChain() {
  const c = { pending: 0, sent: [] as { nonce: number; who: string }[], rejected: [] as { nonce: number; who: string; why: string }[], inflight: 0, maxInflight: 0 };
  const signer = (who: string, hold?: Promise<void>): TxSender => ({
    getAddress: async () => ME,
    sendTransaction: async (tx) => {
      await tick(1);
      if (tx.nonce !== c.pending) {
        const why = tx.nonce < c.pending ? 'nonce too low' : 'nonce gap';
        c.rejected.push({ nonce: tx.nonce, who, why });
        throw new Error(why);
      }
      c.pending++;
      c.sent.push({ nonce: tx.nonce, who });
      c.inflight++; c.maxInflight = Math.max(c.maxInflight, c.inflight);
      const hash = '0x' + tx.nonce.toString(16).padStart(64, '0');
      return { hash, wait: async () => { if (hold) await hold; await tick(2); c.inflight--; return { status: 1, gasUsed: 21_000n, gasPrice: 1n, logs: [] }; } };
    },
  });
  const quote = (side: 'buy' | 'sell', amount: number): Quote => ({
    side, tokenIn: '0x' + 'aa'.repeat(20), tokenOut: '0x' + 'bb'.repeat(20), decimalsIn: 18, decimalsOut: 18,
    amountIn: BigInt(Math.round(amount * 1e6)) * 10n ** 12n, quotedOut: 1n,
    call: { method: 'swap', to: '0x' + 'dd'.repeat(20), data: '0x1234', value: 0n, amountOutMin: 0n } as unknown as Quote['call'],
    approveAmount: null, spender: '0x' + 'dd'.repeat(20), priceImpact: 0.001, gasPlsEstimate: 0, gasNativeEstimate: 0, gasWei: 0n, l1FeeWei: 0n,
    basePerNative: 1, amountInHuman: amount, quotedOutHuman: amount, minOutHuman: 0, price: 1, balanceOk: true, balanceNote: null,
    routerOut: 1n, poolIn: 1n, taxInPct: 0, taxOutPct: 0, feeOnTransfer: false, poolPrice: 1, block: null,
  });
  const quoter = {
    tokenIn: () => '0x' + 'aa'.repeat(20),
    allowance: async () => 2n ** 255n,
    ensureDecimals: async () => undefined,
    def: { quote: { decimals: 18 }, base: { decimals: 18 }, safety: undefined },
    tokenBalance: async () => 10n ** 30n,
    quote: async (side: 'buy' | 'sell', amount: number) => { await tick(1); return quote(side, amount); },
    // pending count read takes a moment (a public RPC): wide enough for two ungated sends to read the same value
    reader: { getBalance: async () => 10n ** 30n, getTransactionCount: async () => { await tick(3); return c.pending; }, getTransactionReceipt: async () => null },
    chain: { nativeSymbol: 'PLS', wrappedNative: { address: '0x' + 'cc'.repeat(20) } },
    stable: { symbol: 'WPLS', native: false }, base: { symbol: 'NEW', native: false }, tokenSide: 'base',
  } as unknown as Quoter;
  return { c, signer, quoter };
}

/** A grid send exactly as GridEngine does it: drain() → gate.run(runJob) → quote + execute, executor with rt.nonce. */
function gridSend(rt: { gate: TxGate; nonce: SharedNonce }, quoter: Quoter, signer: TxSender, canSend = () => true) {
  return rt.gate.run(async () => {
    const ex = new LiveExecutor(quoter, signer, { approval: 'exact', receiptTimeoutMs: 1000, sharedNonce: rt.nonce });
    const q = await ex.quote('buy', 1, DEFAULT_LIMITS);
    return ex.execute(q, { canSend, onSent: () => undefined });
  });
}
const OPTS = { approval: 'exact' as const, receiptTimeoutMs: 1000 };

function trader() {
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => 1_793_129_093_757, emit: () => {},
    sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => [], assess: async () => { throw new Error('unused'); }, resolve: async () => null,
  });
  t.turnOn();
  return t;
}

describe('token trader shares the per-chain gate and nonce with grid sends', () => {
  it('concurrent grid + token-trader buys/sells on one wallet: unique, sequential nonces, none lost or duplicated', async () => {
    const { c, signer, quoter } = fakeChain();
    const rt = { signer: signer('tt'), gate: new TxGate(), nonce: new SharedNonce() };
    const gridSigner = signer('grid');
    const t = trader();
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 8; i++) {
      jobs.push(gridSend(rt, quoter, gridSigner));
      jobs.push(liveSwap(rt, quoter, OPTS, i % 2 ? 'sell' : 'buy', 1 + i, DEFAULT_LIMITS, i % 2 ? sendChecks(t).sell() : sendChecks(t).buy(369)));
    }
    const res = await Promise.allSettled(jobs);
    expect(res.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(c.rejected).toEqual([]);
    expect(c.sent.map((s) => s.nonce)).toEqual(Array.from({ length: 16 }, (_, i) => i)); // 0..15, in order, no gaps
    expect(new Set(c.sent.map((s) => s.nonce)).size).toBe(16);
    expect(c.sent.filter((s) => s.who === 'tt')).toHaveLength(8);
    expect(c.sent.filter((s) => s.who === 'grid')).toHaveLength(8);
    expect(c.maxInflight).toBe(1); // one swap at a time per chain, like grid sends
  });

  it('control: the old token-trader path (own executor, no gate, no shared nonce) collides with grid sends', async () => {
    const { c, signer, quoter } = fakeChain();
    const rt = { gate: new TxGate(), nonce: new SharedNonce() };
    const gridSigner = signer('grid');
    const old = async () => {
      const ex = new LiveExecutor(quoter, signer('tt'), OPTS); // what tokenFeed.executor() built before this PR
      const q = await ex.quote('buy', 1, DEFAULT_LIMITS);
      return ex.execute(q, { canSend: () => true, onSent: () => undefined });
    };
    const res = await Promise.allSettled([gridSend(rt, quoter, gridSigner), old(), gridSend(rt, quoter, gridSigner), old()]);
    expect(c.rejected.length + res.filter((r) => r.status === 'rejected').length).toBeGreaterThan(0);
  });

  it('a send that fails releases its nonce: the next send re-reads pending, no gap', async () => {
    const { c, signer, quoter } = fakeChain();
    const rt = { signer: signer('tt'), gate: new TxGate(), nonce: new SharedNonce() };
    const bad: TxSender = { getAddress: async () => ME, sendTransaction: async () => { throw new Error('rpc down'); } };
    await expect(liveSwap({ ...rt, signer: bad }, quoter, OPTS, 'buy', 1, DEFAULT_LIMITS, () => true)).rejects.toThrow(/rpc down/);
    await gridSend(rt, quoter, signer('grid'));
    await liveSwap(rt, quoter, OPTS, 'buy', 1, DEFAULT_LIMITS, () => true);
    expect(c.sent.map((s) => s.nonce)).toEqual([0, 1]);
  });
});

describe('a token-trader send queued behind another is refused after a stop', () => {
  async function queued(stop: (t: TokenTrader) => void, side: 'buy' | 'sell') {
    const { c, signer, quoter } = fakeChain();
    const hold = deferred();
    const rt = { signer: signer('tt'), gate: new TxGate(), nonce: new SharedNonce() };
    const t = trader();
    const grid = gridSend(rt, quoter, signer('grid', hold.p)); // holds the chain's gate until released
    await tick(10);
    expect(rt.gate.busy).toBe(true);
    let quotes = 0;
    const q2 = { ...quoter, quote: async (...a: Parameters<Quoter['quote']>) => { quotes++; return (quoter.quote as (...x: unknown[]) => Promise<Quote>)(...a); } } as unknown as Quoter;
    const tt = liveSwap(rt, q2, OPTS, side, 1, DEFAULT_LIMITS, side === 'buy' ? sendChecks(t).buy(369) : sendChecks(t).sell());
    stop(t); // lands while the token-trader send waits in the queue
    hold.resolve();
    await grid;
    await expect(tt).rejects.toThrow(/stopped/);
    expect(quotes).toBe(0); // refused before quoting, before any nonce was taken
    expect(c.sent.map((s) => ({ n: s.nonce, who: s.who }))).toEqual([{ n: 0, who: 'grid' }]);
    // nothing consumed: the next grid send gets nonce 1
    await gridSend(rt, quoter, signer('grid'));
    expect(c.sent.map((s) => s.nonce)).toEqual([0, 1]);
  }

  it('buy refused after Stop all', async () => {
    await queued((t) => t.stopEntries(null, systemHalt('stop-all', 'test', 1)), 'buy');
  });
  it('buy refused after Stop all on that chain', async () => {
    await queued((t) => t.stopEntries(369, systemHalt('stop-chain', 'test', 1)), 'buy');
  });
  it('sell refused after the token trader is turned off', async () => {
    await queued((t) => t.turnOff(), 'sell');
  });
  it('a buy that is not stopped goes out after the queued grid send, at the next nonce', async () => {
    const { c, signer, quoter } = fakeChain();
    const hold = deferred();
    const rt = { signer: signer('tt'), gate: new TxGate(), nonce: new SharedNonce() };
    const grid = gridSend(rt, quoter, signer('grid', hold.p));
    await tick(10);
    const tt = liveSwap(rt, quoter, OPTS, 'buy', 1, DEFAULT_LIMITS, sendChecks(trader()).buy(369));
    hold.resolve();
    await grid; await tt;
    expect(c.sent.map((s) => `${s.nonce}:${s.who}`)).toEqual(['0:grid', '1:tt']);
  });
});
