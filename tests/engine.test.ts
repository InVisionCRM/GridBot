import { describe, expect, it } from 'vitest';
import { GridEngine, type BotState } from '../src/server/bot/engine';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { NET, MockChain, DAI } from './helpers/mockChain';

const P0 = 0.00001;
// The price starts at the top of the range: every level waits to buy and nothing is bought at the start, so these tests
// are about level mechanics only (the start-up buy for levels above the price has its own tests below).
const grid = { lowerPrice: P0 * 0.8, upperPrice: P0, gridCount: 10, totalCapitalUsd: 50 };
/** Level 9 spans 0.98·P0 (buy) → P0 (sell) */
const TOP = 9;

function make(chain = new MockChain(P0), store = new MemoryStore<BotState>(), signer: MockChain | null = chain, opts = {}) {
  const log = new Logger(true);
  const engine = new GridEngine({ net: NET, reader: chain, signer, store, log, maxRetries: 1, retryDelayMs: 0, ...opts });
  return { chain, store, log, engine };
}

describe('GridEngine live auto-execution (mocked chain + signer)', () => {
  it('trigger → exact approve → swap, nonces 0,1, fill recorded with tx hash and gas', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    expect(engine.state.intervals.filter((i) => i.status === 'waitingBuy')).toHaveLength(10);
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
    expect(engine.state.intervals[TOP].status).toBe('holding');
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
    expect(engine.state.intervals[TOP].status).toBe('waitingBuy');
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
    // Pool drains after start: $1k of DAI → $50 buys now carry ~5% impact
    chain.rD = 1_000n * 10n ** 18n;
    chain.rW = (chain.rD * 100_000n * 1026n) / 1000n; // price −2.5%
    await engine.tick();
    expect(chain.sent).toHaveLength(0);
    expect(log.entries.some((e) => /price impact .* > cap 3\.00%/.test(e.msg))).toBe(true);
    expect(engine.state.intervals[TOP]).toMatchObject({ status: 'waitingBuy', needsRearm: true });
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
    expect(engine.state.intervals[TOP]).toMatchObject({ status: 'waitingBuy', needsRearm: true });
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
    expect(b.engine.state.intervals[TOP].status).toBe('holding');
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
    expect(engine.state.intervals[TOP].needsRearm).toBe(true);
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

describe('Levels above the start price get coins at the start (#5)', () => {
  const mid = { lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 50 };

  it('the amount is split over all 10 levels; the 5 above the price are bought in one swap and sell as it rises', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...mid });
    expect(engine.state.usdPerBuy).toBeCloseTo(5, 12);
    expect(engine.state.queue).toMatchObject([{ side: 'buy', amount: 25, seed: [5, 6, 7, 8, 9] }]);
    await engine.tick();
    expect(chain.sent.map((x) => x.method)).toEqual(['approve', 'swapExactTokensForETH']);
    const [seed] = engine.state.trades;
    const up = engine.state.intervals.filter((i) => i.index >= 5);
    expect(up.every((i) => i.status === 'holding')).toBe(true);
    expect(up.reduce((a, i) => a + i.plsAmount, 0)).toBeCloseTo(seed.plsAmount, 9);
    expect(engine.state.intervals.filter((i) => i.status === 'waitingBuy').map((i) => i.index)).toEqual([0, 1, 2, 3, 4]);
    // up through 1.02·P0: level 5 (P0 → 1.02·P0) sells its share
    chain.setPrice(P0 * 1.025); await engine.tick();
    const sell = engine.state.trades.at(-1)!;
    expect(sell).toMatchObject({ side: 'sell', intervalIndex: 5 });
    expect(sell.plsAmount).toBeCloseTo(seed.plsAmount / 5, 9);
  });

  it('a price below the range is refused (nothing to wait for, everything would be bought at once)', async () => {
    const { engine } = make();
    await expect(engine.start({ mode: 'live', ...mid, lowerPrice: P0 * 1.1, upperPrice: P0 * 1.3 })).rejects.toThrow(/below the range/);
  });

  it("a live restart uses the coins the grid already holds before buying more", async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...mid });
    await engine.tick();
    expect(chain.sent).toHaveLength(2);
    engine.stop();
    await engine.start({ mode: 'live', ...mid });
    expect(engine.state.queue).toHaveLength(0);
    expect(engine.state.intervals.filter((i) => i.index >= 5).every((i) => i.status === 'holding')).toBe(true);
    await engine.tick();
    expect(chain.sent).toHaveLength(2); // nothing bought again
  });

  it('if the start-up buy can\'t happen, those levels wait to buy like any other level', async () => {
    const { chain, engine } = make();
    chain.faults = ['sendThrow', 'sendThrow'];
    await engine.start({ mode: 'live', ...mid });
    await engine.tick();
    expect(engine.state.intervals.filter((i) => i.index >= 5).every((i) => i.status === 'waitingBuy' && i.needsRearm)).toBe(true);
  });
  it('results are what its trading earned in the spend coin: no "vs holding" figures', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...mid });
    await engine.tick();
    chain.setPrice(P0 * 1.025); await engine.tick(); // level 5 sells
    const st = engine.status();
    expect(Object.keys(st.pnl).sort()).toEqual(['costUsd', 'gasUsd', 'plsHeld', 'realized', 'unrealized']);
    expect(st.pnl.realized).toBeGreaterThan(0);
    expect('opening' in st || 'opening' in engine.state).toBe(false);
  });
});

describe('Profits: reinvested by default, or sent to an address (#6)', () => {
  const ME_TOO = '0x1234567890123456789012345678901234567890';
  const PAYEE = '0x00000000000000000000000000000000000beef1';
  async function roundTrip(o: { profits?: { mode: 'send'; to: string } } = {}, beforeSell?: (c: MockChain) => void) {
    const m = make();
    await m.engine.start({ mode: 'live', ...grid, ...o });
    m.chain.setPrice(P0 * 0.975); await m.engine.tick();
    beforeSell?.(m.chain);
    m.chain.setPrice(P0 * 1.005); await m.engine.tick(); // the sell, then the transfer in the same tick
    return m;
  }

  it('reinvest (default): a level\'s profit is added to its next buy', async () => {
    const { engine } = await roundTrip();
    expect(engine.state.profits).toEqual({ mode: 'reinvest' });
    const sell = engine.state.trades.find((t) => t.side === 'sell')!;
    expect(sell.realizedPnlUsd).toBeGreaterThan(0);
    expect(engine.state.intervals[TOP].buyAmount).toBeCloseTo(5 + sell.realizedPnlUsd, 9);
    expect(engine.state.intervals[TOP - 1].buyAmount).toBe(5);
  });

  it('send: the next buy stays the same size and the profit goes to the address in one transfer', async () => {
    const { chain, engine } = await roundTrip({ profits: { mode: 'send', to: PAYEE } });
    const sell = engine.state.trades.find((t) => t.side === 'sell')!;
    expect(engine.state.intervals[TOP].buyAmount).toBe(5);
    expect(chain.transfers).toEqual([{ token: DAI.address.toLowerCase(), to: PAYEE, amount: expect.any(BigInt) }]);
    expect(Number(chain.transfers[0].amount) / 1e18).toBeCloseTo(sell.realizedPnlUsd, 9);
    await engine.tick(); // settles by hash
    expect(engine.state.payoutInFlight).toBeNull();
    expect(engine.status().payout).toMatchObject({ pending: 0, count: 1 });
    expect(engine.status().payout.sent).toBeCloseTo(sell.realizedPnlUsd, 9);
  });

  it('a transfer that isn\'t confirmed yet is never sent again', async () => {
    const { chain, engine } = await roundTrip({ profits: { mode: 'send', to: PAYEE } }, (c) => { c.faults = [undefined as never, 'timeout']; });
    expect(engine.state.payoutInFlight).not.toBeNull();
    for (let i = 0; i < 3; i++) await engine.tick();
    expect(chain.transfers).toHaveLength(1);
    chain.mine(); await engine.tick();
    expect(engine.state.payoutInFlight).toBeNull();
    expect(engine.state.payoutPending).toBe(0);
    expect(chain.transfers).toHaveLength(1);
  });

  it('refuses a bad address or the bot\'s own wallet; can switch while running', async () => {
    const { engine } = make();
    await expect(engine.start({ mode: 'live', ...grid, profits: { mode: 'send', to: '0x123' } })).rejects.toThrow(/0x… address/);
    await expect(engine.start({ mode: 'live', ...grid, profits: { mode: 'send', to: ME_TOO } })).rejects.toThrow(/own wallet/);
    await engine.start({ mode: 'live', ...grid });
    await engine.setProfits({ mode: 'send', to: PAYEE });
    expect(engine.state.profits).toEqual({ mode: 'send', to: PAYEE });
  });

  it('paper mode books the payout without sending anything', async () => {
    const chain = new MockChain(P0);
    const { engine } = make(chain, undefined, null);
    await engine.start({ mode: 'paper', ...grid, profits: { mode: 'send', to: PAYEE } });
    chain.setPrice(P0 * 0.975); await engine.tick();
    chain.setPrice(P0 * 1.005); await engine.tick();
    await engine.tick(); await engine.tick();
    expect(chain.sent).toHaveLength(0);
    const sell = engine.state.trades.find((t) => t.side === 'sell')!;
    expect(engine.status().payout).toMatchObject({ count: 1, pending: 0 });
    expect(engine.paperBalances().stable).toBeCloseTo(50 - engine.state.trades[0].stableAmount + sell.stableAmount - sell.realizedPnlUsd, 9);
  });
});

describe('Grids saved before per-level sizes', () => {
  it('load with the old buy size on funded levels and 0 on the idle levels above the old start price', async () => {
    const store = new MemoryStore<BotState>();
    const { engine } = make(new MockChain(P0), store);
    await engine.start({ mode: 'paper', lowerPrice: P0 * 0.9, upperPrice: P0 * 1.1, gridCount: 10, totalCapitalUsd: 50 });
    // what an old save looked like: $50 over the 5 levels below the start, the 5 above idle, no buyAmount
    store.save({ ...engine.state, usdPerBuy: 10, queue: [], intervals: engine.state.intervals.map(({ buyAmount: _b, ...iv }) => ({ ...iv, status: iv.index < 5 ? 'waitingBuy' : 'inactive' })) as never });
    const again = make(new MockChain(P0), store).engine;
    expect(again.state.intervals.map((i) => i.buyAmount)).toEqual([10, 10, 10, 10, 10, 0, 0, 0, 0, 0]);
    expect(again.state.intervals.reduce((a, i) => a + i.buyAmount, 0)).toBe(50); // a re-range spreads the real $50
  });
});


describe('GridEngine close', () => {
  it('paper close archives immediately and does not sell; the coins stay where the fills left them', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'paper', ...grid });
    chain.setPrice(P0 * 0.935); // buys at 0.98, 0.96, 0.94
    await engine.tick();
    const bought = engine.paperBalances().pls;
    expect(bought).toBeGreaterThan(0);
    expect(engine.requestClose()).toBe(false);
    const s = engine.status();
    expect(s).toMatchObject({ status: 'stopped', closing: false });
    expect(s.archivedAt).toBeGreaterThan(0);
    expect(engine.paperBalances().pls).toBeCloseTo(bought, 6);
    await engine.tick(); // archived: a later tick does not sell
    expect(engine.paperBalances().pls).toBeCloseTo(bought, 6);
    expect(engine.state.trades.filter((t) => t.side === 'sell')).toHaveLength(0);
  });

  it('Stop pauses without archiving; the grid keeps what it still holds', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'paper', ...grid });
    chain.setPrice(P0 * 0.935);
    await engine.tick();
    engine.stop();
    expect(engine.state.archivedAt).toBeNull();
    expect(engine.state.closing).toBe(false);
    await engine.tick();
    expect(engine.paperBalances().pls).toBeGreaterThan(0);
    expect(engine.status().archivedAt).toBeNull();
  });

  it("a live close's sales that keep failing (reverts) wait 10, 20, 40, 80 minutes, then stop the grid after 5; Close again tries again", async () => {
    let now = 1_800_000_000_000;
    const { chain, engine } = make(undefined, undefined, undefined, { now: () => now });
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.935);
    await engine.tick();
    expect(engine.requestClose()).toBe(true);
    chain.faults = Array(400).fill('revert');
    const waits: number[] = [], sends: number[] = [];
    for (let i = 0; i < 5; i++) {
      const n = chain.sent.length;
      await engine.tick();
      sends.push(chain.sent.length - n);
      await engine.tick(); // waiting: nothing is sent
      const f = engine.state.closeFails;
      if (f) { waits.push((f.retryAt - now) / 60_000); now = f.retryAt; }
    }
    // one sale per try (sent twice: the executor's own retry), the others wait with it
    expect(sends).toEqual([2, 2, 2, 2, 2]);
    expect(waits).toEqual([10, 20, 40, 80]);
    expect(engine.state).toMatchObject({ status: 'stopped', closing: false, archivedAt: null, closeFails: null });
    const n = chain.sent.length;
    now += 3600_000;
    await engine.tick();
    expect(chain.sent.length).toBe(n);
    chain.faults = [];
    expect(engine.requestClose()).toBe(true);
    for (let i = 0; i < 3; i++) await engine.tick();
    expect(engine.state.archivedAt).not.toBeNull();
    expect(engine.status().pnl.plsHeld).toBeLessThan(1e-6);
  });

  it("a live close's sales are in the position and its profit, not grid round trips", async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.935);
    await engine.tick();
    engine.requestClose();
    for (let i = 0; i < 3; i++) await engine.tick();
    expect(engine.state.archivedAt).not.toBeNull();
    const sales = engine.state.trades.filter((t) => t.side === 'sell' && !t.failed);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((t) => t.closeSale && t.roundTripNet === undefined)).toBe(true);
    expect(engine.status().stats.roundTrips).toBe(0);
  });

  it('a close sale far over the impact cap (a thin pool) is refused for its impact, not as a units mismatch', async () => {
    const { chain, engine } = make();
    await engine.start({ mode: 'live', ...grid });
    chain.setPrice(P0 * 0.935);
    await engine.tick();
    const held = engine.status().pnl.plsHeld;
    // the pool shrinks to well under one sale's size: the quote's price, impact included, is far from the spot
    chain.rD = BigInt(Math.round(held * P0 * 0.935 / 6)) * 10n ** 18n / 1n;
    chain.setPrice(P0 * 0.935, 'DAI');
    engine.setLimits({ maxPriceImpact: 0.05 });
    engine.requestClose();
    await engine.tick();
    expect(engine.status().lastError).toMatch(/price impact/);
    expect(engine.status().lastError).not.toMatch(/inconsistent/);
  });
});
