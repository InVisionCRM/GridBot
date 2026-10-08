import { describe, expect, it } from 'vitest';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain, DAI } from './helpers/mockChain';

const P0 = 0.00001;
const grid = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 50 };

function make(chain = new MockChain(P0), store = new MemoryStore<BotState>(), signer: MockChain | null = chain, opts = {}) {
  const log = new Logger(true);
  const engine = new GridEngine({ net: NET, reader: chain, signer, store, log, maxRetries: 1, retryDelayMs: 0, ...opts });
  return { chain, store, log, engine };
}

describe('GridEngine live auto-execution (mocked chain + signer)', () => {
  it('trigger → exact approve → swap, nonces 0,1, fill recorded with tx hash and gas', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    expect(engine.state.intervals.filter((i) => i.status === 'waitingBuy')).toHaveLength(5);
    await engine.tick();
    expect(chain.sent).toHaveLength(0); // no crossing yet

    chain.setPrice(P0 * 0.975); // crosses the 0.98·P0 level
    await engine.tick();
    expect(chain.sent.map((s) => [s.method, s.nonce])).toEqual([['approve', 0], ['swapExactTokensForETH', 1]]);
    const usdPerBuy = engine.state.usdPerBuy;
    expect(chain.sent[0].args[1]).toBe(BigInt(Math.round(usdPerBuy * 1e8)) * 10n ** 10n); // exact amount, not MaxUint256
    const [fill] = engine.state.trades;
    expect(fill.side).toBe('buy');
    expect(fill.txHash).toMatch(/^0x/);
    expect(fill.approvalTxHash).toMatch(/^0x/);
    expect(fill.gasPls).toBeCloseTo(0.2); // approve + swap, 0.1 PLS each
    expect(fill.plsAmount).toBeGreaterThan(0);
    expect(engine.state.intervals[4].status).toBe('holding');
    expect(engine.state.inFlight).toBeNull();
  });

  it('sell side: no approval, next nonce, realized PnL includes all gas', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.975); await engine.tick();
    const buy = engine.state.trades[0];
    chain.setPrice(P0 * 1.005); await engine.tick();
    expect(chain.sent.map((s) => [s.method, s.nonce])).toEqual([['approve', 0], ['swapExactTokensForETH', 1], ['swapExactETHForTokens', 2]]);
    const sell = engine.state.trades[1];
    expect(sell.side).toBe('sell');
    expect(sell.plsAmount).toBeCloseTo(buy.plsAmount);
    expect(sell.realizedPnlUsd).toBeCloseTo(sell.stableAmount - buy.stableAmount - buy.gasUsd - sell.gasUsd, 10);
    expect(engine.state.intervals[4].status).toBe('waitingBuy');
  });

  it('several levels crossed at once execute one at a time with sequential nonces', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.935); // crosses 0.98, 0.96, 0.94
    await engine.tick();
    expect(chain.sent.map((s) => s.nonce)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(chain.sent.filter((s) => s.method === 'approve')).toHaveLength(3); // exact approval per trade
    expect(engine.state.trades.filter((t) => t.side === 'buy' && !t.failed)).toHaveLength(3);
    expect(engine.state.queue).toHaveLength(0);
  });

  it('blocks trades above the price-impact cap (no tx sent)', async () => {
    const chain = new MockChain(P0);
    const { engine, log } = make(chain);
    chain.dai = 10_000n * 10n ** 18n;
    await engine.start({ mode: 'live', ...grid, totalCapitalUsd: 500 }); // deep pool at start: economics OK
    // Pool drains after start: $1k of DAI → $100 buys now carry ~10% impact
    chain.rD = 1_000n * 10n ** 18n;
    chain.rW = (chain.rD * 100_000n * 1026n) / 1000n; // price −2.5%
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
    expect(log.entries.some((e) => /price impact .* > cap 3\.00%/.test(e.msg))).toBe(true);
    expect(engine.state.intervals[4]).toMatchObject({ status: 'waitingBuy', needsRearm: true });
  });

  it('a reverted swap is recorded with its gas, then retried with a fresh quote', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.faults = [undefined as never, 'revert']; // approve ok, swap reverts once
    chain.setPrice(P0 * 0.975);
    await engine.tick();
    expect(chain.sent.map((s) => [s.method, s.nonce])).toEqual([['approve', 0], ['swapExactTokensForETH', 1], ['swapExactTokensForETH', 2]]);
    const [failed, fill] = engine.state.trades;
    expect(failed).toMatchObject({ failed: true });
    expect(failed.gasPls).toBeCloseTo(0.2);
    expect(failed.realizedPnlUsd).toBeLessThan(0);
    expect(fill.side).toBe('buy');
    expect(fill.failed).toBeUndefined();
  });

  it('send errors resync the nonce from chain; exhausted retries skip the level', async () => {
    const { chain, engine, log } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.faults = ['sendThrow', 'sendThrow'];
    chain.setPrice(P0 * 0.975);
    const before = chain.txCountCalls;
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
    expect(chain.txCountCalls - before).toBeGreaterThanOrEqual(2);
    expect(engine.state.intervals[4]).toMatchObject({ status: 'waitingBuy', needsRearm: true });
    expect(log.entries.some((e) => /Skipped buy/.test(e.msg))).toBe(true);
    // re-arms once price moves back above, then trades normally
    chain.setPrice(P0); await engine.tick();
    chain.setPrice(P0 * 0.975); await engine.tick();
    expect(chain.sent.map((s) => s.nonce)).toEqual([0, 1]);
  });

  it('STOP halts immediately: nothing is sent after stop, even mid-job', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.onSend = (m) => { if (m === 'approve') engine.stop(); };
    chain.setPrice(P0 * 0.935);
    await engine.tick();
    expect(chain.sent.map((s) => s.method)).toEqual(['approve']); // swap never sent
    expect(engine.state.status).toBe('stopped');
    expect(engine.state.queue).toHaveLength(0);
    expect(engine.state.trades[0]).toMatchObject({ failed: true });
    await engine.tick();
    expect(chain.sent).toHaveLength(1);
  });

  it('restart resumes: persisted grid continues, and an unconfirmed swap is reconciled by hash (no resend)', async () => {
    const store = new MemoryStore<BotState>();
    const chain = new MockChain(P0);
    const a = make(chain, store);
    await a.engine.start({ mode: 'live', ...grid });
    chain.faults = [undefined as never, 'timeout'];
    chain.setPrice(P0 * 0.975);
    await a.engine.tick();
    expect(a.engine.state.inFlight?.swapTxHash).toMatch(/^0x/);
    expect(a.engine.state.trades).toHaveLength(0);
    expect(store.data?.inFlight?.swapTxHash).toBe(a.engine.state.inFlight?.swapTxHash);

    // "process restart": new engine on the same store
    const hash = a.engine.state.inFlight!.swapTxHash;
    const b = make(chain, store);
    expect(b.engine.state.status).toBe('running');
    await b.engine.tick();
    expect(chain.sent).toHaveLength(2); // nothing resent
    expect(b.engine.state.inFlight).toBeNull();
    expect(b.engine.state.trades[0]).toMatchObject({ side: 'buy', txHash: hash });
    expect(b.engine.state.intervals[4].status).toBe('holding');
    // and keeps trading with the next nonce
    chain.setPrice(P0 * 1.005); await b.engine.tick();
    expect(chain.sent.at(-1)).toMatchObject({ method: 'swapExactETHForTokens', nonce: 2 });
  });

  it('a stuck swap past its deadline is dropped and the level re-armed', async () => {
    let now = Date.now();
    const chain = new MockChain(P0);
    const { engine } = make(chain, undefined, chain, { now: () => now });
    await engine.start({ mode: 'live', ...grid });
    chain.faults = [undefined as never, 'timeout'];
    chain.setPrice(P0 * 0.975);
    await engine.tick();
    chain.receipts.clear(); // never mined
    await engine.tick();
    expect(engine.state.inFlight).not.toBeNull();
    now += 20 * 60_000;
    await engine.tick();
    expect(engine.state.inFlight).toBeNull();
    expect(engine.state.intervals[4].needsRearm).toBe(true);
  });

  it('paper mode runs on the same engine with no signer and sends nothing', async () => {
    const chain = new MockChain(P0);
    const { engine } = make(chain, undefined, null);
    await expect(engine.start({ mode: 'live', ...grid })).rejects.toThrow(/PRIVATE_KEY/);
    await engine.start({ mode: 'paper', ...grid });
    chain.setPrice(P0 * 0.975); await engine.tick();
    chain.setPrice(P0 * 1.005); await engine.tick();
    expect(chain.sent).toHaveLength(0);
    const [b, s] = engine.state.trades;
    expect(b).toMatchObject({ side: 'buy', paper: true });
    expect(s).toMatchObject({ side: 'sell', paper: true });
    const bal = engine.paperBalances();
    expect(bal.stable).toBeCloseTo(50 - b.stableAmount + s.stableAmount);
    expect(engine.status().pnl.realized).toBeCloseTo(s.realizedPnlUsd);
  });

  it('validates start params and limits (impact cap ≤ 5%)', async () => {
    const { engine } = make();
    await expect(engine.start({ mode: 'live', ...grid, upperPrice: grid.lowerPrice })).rejects.toThrow();
    await expect(engine.start({ mode: 'live', ...grid, limits: { maxPriceImpact: 0.2 } })).rejects.toThrow(/Price-impact/);
    expect(() => engine.setLimits({ slippageBps: 0 })).toThrow();
    engine.setLimits({ maxPriceImpact: 0.01, slippageBps: 50, deadlineMinutes: 5 });
    expect(engine.state.limits).toEqual({ maxPriceImpact: 0.01, slippageBps: 50, deadlineMinutes: 5 });
    expect(DAI.symbol).toBe('DAI');
  });
});
