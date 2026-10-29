/**
 * Audit a001: a live token-trader swap whose receipt does not come before the executor stops waiting is kept by hash
 * and settled on later ticks, never dropped. A buy becomes a position with the tokens its receipt shows; a reverted
 * one books only its gas; a sell part books its real proceeds before the position may sell again.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { SwapPending, TokenTrader, type Position, type Recovered, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
const POOL: FreshPool = {
  chainId: 369, pool: '0x' + 'e'.repeat(40), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + '33'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40_000_000, tokenReserve: 1_000_000, feeBps: 29, price: 40, usdPerSpend: 0.00003,
};

function trader(o: { buyPending?: boolean; sellPending?: boolean }) {
  const receipts = new Map<string, Recovered>();
  const sent = { buys: 0, sells: 0 };
  let wave = [POOL]; // offered once
  const t: TokenTrader = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => NOW, emit: () => {},
    sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => { const x = wave; wave = []; return x; }, assess: async () => clean(), resolve: async () => null, mark: async () => null,
    balanceOf: async () => null,
    live: {
      buy: async (p, spend) => {
        sent.buys++;
        if (o.buyPending) throw new SwapPending('0xb1', p.token, 18, spend, 0.001);
        return { tokens: spend / p.price, spent: spend, spentUsd: spend * p.usdPerSpend, price: p.price, impact: 0.001 };
      },
      sell: async (_p, tokens) => {
        sent.sells++;
        if (o.sellPending) throw new SwapPending('0x5e11', POOL.spend, 18, tokens, 0);
        return { quoteOut: tokens * 80, tokensIn: tokens, price: 80, impact: 0.01 };
      },
      recover: async (_c, hash) => receipts.get(hash) ?? null,
    },
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe', maxImpact: 0.05, mode: 'live' });
  t.turnOn();
  return { t, receipts, sent };
}

describe('token trader: a live swap whose receipt is late is settled by hash, never dropped', () => {
  it('buy: kept in flight (spend still reserved, never bought again); opens from the receipt once mined', async () => {
    const w = trader({ buyPending: true });
    await w.t.tick();
    expect(w.sent.buys).toBe(1);
    expect(w.t.status().positions).toHaveLength(0);
    expect(w.t.status().inflight).toMatchObject([{ hash: '0xb1', chainId: 369 }]);
    const spend = w.t.status().inflight![0].spend;
    expect(w.t.reservations()).toContainEqual(expect.objectContaining({ address: POOL.spend, amount: spend }));
    await w.t.tick(); // not mined yet: waits, and the same pool is not bought again
    expect(w.sent.buys).toBe(1);
    expect(w.t.status().inflight).toHaveLength(1);
    const got = spend / POOL.price; // what the receipt shows arrived
    w.receipts.set('0xb1', { ok: true, amountOut: got, gasNative: 0.002 });
    await w.t.tick();
    expect(w.t.status().inflight).toHaveLength(0);
    expect(w.t.status().positions).toMatchObject([{ mode: 'live', tokens: got, spent: spend }]);
    expect(w.sent.buys).toBe(1);
  });

  it('a receipt read that fails (RPC error) waits; exits of other positions still run', async () => {
    const w = trader({ buyPending: true });
    await w.t.tick();
    const tr = w.t as unknown as { d: { live: { recover: () => Promise<unknown> } } };
    tr.d.live.recover = async () => { throw new Error('rpc down'); };
    await w.t.tick();
    expect(w.t.status().inflight).toHaveLength(1);
    expect(w.t.status().lastError).toBeNull();
  });

  it('buy that reverted: no position, the record is cleared', async () => {
    const w = trader({ buyPending: true });
    await w.t.tick();
    w.receipts.set('0xb1', { ok: false, amountOut: 0, gasNative: 0.002 });
    await w.t.tick();
    expect(w.t.status().inflight).toHaveLength(0);
    expect(w.t.status().positions).toHaveLength(0);
  });

  it('buy mined but its token amount unreadable: kept, with an error naming the hash (never guessed)', async () => {
    const w = trader({ buyPending: true });
    await w.t.tick();
    w.receipts.set('0xb1', { ok: true, amountOut: null, gasNative: 0.002 });
    await w.t.tick();
    expect(w.t.status().inflight).toHaveLength(1);
    expect(w.t.status().positions).toHaveLength(0);
    expect(w.t.status().lastError).toContain('0xb1');
  });

  it('sell: the part is not assumed sold, nothing else is sent until it settles, then its proceeds are booked', async () => {
    const w = trader({ sellPending: true });
    await w.t.tick();
    const p = w.t.status().positions[0] as Position;
    const start = p.tokens;
    w.t.mark(p.id, { price: p.entryPrice * 0.3, peak: p.entryPrice }); // stop-loss: sell everything
    await w.t.tick();
    expect(w.sent.sells).toBe(1);
    const q = w.t.status().positions[0];
    expect(q.tokens).toBe(start);
    expect(q.pendingSell).toMatchObject({ hash: '0x5e11', tokens: start });
    expect(q.reconcile).toBeFalsy();
    await w.t.tick(); // not mined: waits, sends nothing
    expect(w.sent.sells).toBe(1);
    w.receipts.set('0x5e11', { ok: true, amountOut: 777, gasNative: 0.001 });
    await w.t.tick();
    expect(w.t.status().positions).toHaveLength(0); // sold out: closed
    expect(w.t.status().trades[0]).toMatchObject({ side: 'sell', amount: 777, why: expect.stringContaining('0x5e11') });
    expect(w.sent.sells).toBe(1);
  });
});
