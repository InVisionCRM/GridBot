/**
 * #42 review fixes: a live split sell that stops partway is booked per part and reconciled from the wallet (never assumed
 * sold); the exits count shows once per card; "Run exits" asks first; the update migration checks any file not
 * explicitly on.
 */
import { describe, expect, it } from 'vitest';
import type { GateInput, FreshPool } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { blockedNote, modeLabel, pickChoice, runExitsConfirmText } from '../src/ui/TokenTrader';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
let n = 0;
// Thin pool so a 1/3 take-profit splits into several parts under the 2% impact cap.
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 369, pool: '0x' + (n++).toString(16).padStart(4, '0') + 'e'.repeat(36), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + '33'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 40_000_000, tokenReserve: 1_000_000, feeBps: 29, price: 40, usdPerSpend: 0.00003, ...o,
});

interface Wallet { balance: number | null }
/** A live trader whose sells move tokens out of a fake wallet; `failAt` = the sell call (0-based) that throws. */
async function liveWithPosition(o: { failAt?: number; offAt?: number; wallet?: Wallet } = {}) {
  const store = new MemoryStore<TraderState>();
  const wallet: Wallet = o.wallet ?? { balance: 0 };
  const sells: number[] = [];
  let wave = [pool()];
  let t!: TokenTrader;
  t = new TokenTrader({
    store, now: () => NOW, emit: () => {},
    sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => { const w = wave; wave = []; return w; },
    assess: async () => clean(), resolve: async () => null, mark: async () => null,
    balanceOf: async () => wallet.balance,
    live: {
      buy: async (p, spend) => { const tokens = spend / p.price; wallet.balance = (wallet.balance ?? 0) + tokens; return { tokens, spent: spend, spentUsd: spend * p.usdPerSpend, price: p.price, impact: 0.001 }; },
      sell: async (_p, tokens) => {
        const i = sells.length;
        if (o.offAt === i) t.turnOff('full'); // Off completely lands while this part is out; it still fills
        if (o.failAt === i) throw new Error('execution reverted');
        sells.push(tokens);
        wallet.balance = (wallet.balance ?? 0) - tokens;
        return { quoteOut: tokens * 80, tokensIn: tokens, price: 80, impact: 0.01 };
      },
    },
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe', maxImpact: 0.02, mode: 'live' });
  t.turnOn();
  await t.tick();
  const p = t.status().positions[0] as Position;
  expect(p).toBeTruthy();
  return { t, store, wallet, sells, p };
}
/** Price +100%: take profit (a third) on a thin pool → a multi-part split sell. */
const pump = (t: TokenTrader, p: Position, reserve: number) => t.mark(p.id, { price: p.entryPrice * 2.05, peak: p.entryPrice * 2.05, tokenReserve: reserve });

describe('1. live split sell that stops partway', () => {
  it('a part that reverts: earlier parts are booked, the rest is not assumed sold, tokens come from the wallet', async () => {
    const s = await liveWithPosition({ failAt: 1 });
    const start = s.p.tokens;
    pump(s.t, s.p, start * 4); // a third of the bag is ~8% of the reserve → several parts under 2% impact
    await s.t.tick();
    expect(s.sells).toHaveLength(1); // part 0 went out, part 1 reverted, no more parts tried
    const p = s.t.status().positions[0];
    expect(p.tokens).toBeCloseTo(start - s.sells[0], 6); // books == wallet
    expect(p.tokens).toBeCloseTo(s.wallet.balance!, 6);
    expect(p.reconcile).toBe(false); // the wallet read worked, so it's settled
    expect(s.t.status().trades[0]).toMatchObject({ side: 'sell', why: expect.stringMatching(/partial/) });
    expect(s.t.status().lastError).toMatch(/sell stopped after .* execution reverted/);
    expect(s.store.load()!.positions[0].tokens).toBeCloseTo(s.wallet.balance!, 6); // persisted
  });

  it('Off completely between parts: no further part is sent, the ledger matches the wallet', async () => {
    const s = await liveWithPosition({ offAt: 0 });
    const start = s.p.tokens;
    pump(s.t, s.p, start * 4);
    await s.t.tick();
    expect(s.sells).toHaveLength(1);
    expect(s.t.status().runMode).toBe('full');
    expect(s.t.status().positions[0].tokens).toBeCloseTo(s.wallet.balance!, 6);
    expect(s.t.status().positions[0].tokens).toBeCloseTo(start - s.sells[0], 6);
  });

  it('wallet unreadable after the failure: flagged, no sell until the next tick reads the wallet', async () => {
    const wallet: Wallet = { balance: 0 };
    const s = await liveWithPosition({ failAt: 1, wallet });
    pump(s.t, s.p, s.p.tokens * 4);
    let hidden: number | null = null;
    // the wallet read fails right after the revert
    const trader = s.t as unknown as { d: { balanceOf: () => Promise<number | null> } };
    const read = trader.d.balanceOf;
    trader.d.balanceOf = async () => null;
    await s.t.tick();
    expect(s.sells).toHaveLength(1);
    expect(s.t.status().positions[0].reconcile).toBe(true);
    // still unreadable: holds (no sell attempted) even though the take profit is still hit
    await s.t.tick();
    expect(s.sells).toHaveLength(1);
    // readable again on the next tick: reconciled first, then exits continue from the real balance.
    // Meanwhile 50 tokens left the wallet some other way: the ledger takes the wallet's number, never the assumed one.
    hidden = wallet.balance! - 50;
    wallet.balance = hidden;
    trader.d.balanceOf = read;
    s.t.mark(s.p.id, { price: s.p.entryPrice, peak: s.p.entryPrice * 2.05 }); // hold now (no rule hit)
    await s.t.tick();
    const p = s.t.status().positions[0];
    expect(p.reconcile).toBe(false);
    expect(p.tokens).toBeCloseTo(hidden, 6);
  });

  it('a wallet that shows the tokens are gone closes the position', async () => {
    const s = await liveWithPosition({ failAt: 1 });
    pump(s.t, s.p, s.p.tokens * 4);
    s.wallet.balance = 0; // e.g. the "failed" part actually landed and the rest was moved out
    const trader = s.t as unknown as { d: { live: { sell: (...a: unknown[]) => Promise<unknown> } } };
    trader.d.live.sell = async () => { throw new Error('rpc timeout'); };
    await s.t.tick();
    expect(s.t.status().positions).toHaveLength(0);
  });

  it('a split sell that completes is unchanged (no partial, no reconcile)', async () => {
    const s = await liveWithPosition();
    const start = s.p.tokens;
    pump(s.t, s.p, start * 4);
    await s.t.tick();
    expect(s.sells.length).toBeGreaterThan(1);
    const p = s.t.status().positions[0];
    expect(p.reconcile).toBeFalsy();
    expect(p.tokens).toBeCloseTo(start * 2 / 3, 6);
    expect(s.t.status().trades[0].why).not.toMatch(/partial/);
  });
});

describe('2. the exits count appears once per card', () => {
  it('tag carries (N) only when the new-buys-stopped banner (which shows "Exits still managed: N") is not up', () => {
    expect(modeLabel({ runMode: 'exits', exitsManaged: 3 }, { mode: 'live' })).toBe('Off for new buys · exits running (3)');
    const withBanner = modeLabel({ runMode: 'exits', exitsManaged: 3, entriesHalt: { at: NOW } }, { mode: 'live' });
    expect(withBanner).toBe('Off for new buys · exits running');
    expect(withBanner).not.toMatch(/3/);
  });
});

describe('3. "Run exits" asks first', () => {
  it('confirm states that N live positions will be sold by their exit rules; cancel posts nothing', async () => {
    const asked: string[] = [];
    const posted: string[] = [];
    const post = async (m: 'exits' | 'full') => { posted.push(m); return { pendingChoice: null }; };
    expect(await pickChoice('exits', 2, { confirm: (m) => { asked.push(m); return false; }, post })).toBeNull();
    expect(posted).toEqual([]);
    expect(asked[0]).toMatch(/2 live positions will be sold by their exit rules/);
    expect(await pickChoice('exits', 2, { confirm: () => true, post })).toEqual({ pendingChoice: null });
    expect(posted).toEqual(['exits']);
    expect(runExitsConfirmText(1)).toMatch(/1 live position will be sold by its exit rules/);
  });
  it('"Keep fully off" needs no confirm', async () => {
    const posted: string[] = [];
    await pickChoice('full', 2, { confirm: () => { throw new Error('asked'); }, post: async (m) => { posted.push(m); return {}; } });
    expect(posted).toEqual(['full']);
  });
});

describe('4. migration guard: any file not explicitly on is checked', () => {
  async function oldFile(on: boolean | undefined) {
    const s = await liveWithPosition();
    const raw = structuredClone(s.store.load()!) as TraderState & { on?: boolean };
    if (on === undefined) delete raw.on; else raw.on = on;
    delete raw.offMode; delete raw.modeLog; delete raw.pendingChoice;
    const store = new MemoryStore<TraderState>();
    store.save(raw as TraderState);
    return store;
  }
  const load = (store: MemoryStore<TraderState>) => new TokenTrader({
    store, now: () => NOW, emit: () => {},
    sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => [], assess: async () => clean(), resolve: async () => null,
  });

  // Fails with the old guard (`loaded.on !== false` returned early for a missing `on`).
  it('`on` missing + a live position: loads off completely with the choice banner', async () => {
    const t = load(await oldFile(undefined));
    expect(t.status()).toMatchObject({ runMode: 'full', pendingChoice: { livePositions: 1 } });
    expect(t.canSell()).toBe(false);
  });
  it('`on: false` + a live position: same', async () => {
    expect(load(await oldFile(false)).status()).toMatchObject({ runMode: 'full', pendingChoice: { livePositions: 1 } });
  });
  it('`on: true`: not migrated (stays on, no banner)', async () => {
    expect(load(await oldFile(true)).status()).toMatchObject({ runMode: 'on', pendingChoice: null });
  });
});

// ── #42 second review (Claude gate on 53fc2e6) ─────────────────────────────────────────────────────────────────────
type Live = { d: { live: { sell: (p: Position, tokens: number) => Promise<unknown> }; balanceOf: (p: Position) => Promise<number | null> } };
/** Sells that work again (and move tokens out of the fake wallet). */
function healSells(s: Awaited<ReturnType<typeof liveWithPosition>>) {
  (s.t as unknown as Live).d.live.sell = async (_p, tokens) => {
    s.sells.push(tokens);
    s.wallet.balance = (s.wallet.balance ?? 0) - tokens;
    return { quoteOut: tokens * 80, tokensIn: tokens, price: 80, impact: 0.01 };
  };
}

describe('5. a take profit that stops partway is not marked done; the rest of that tranche is sold later', () => {
  it('part 2 reverts: tp1Done stays false, then the next take profit sells only the rest of the third', async () => {
    const s = await liveWithPosition({ failAt: 1 });
    const entry = s.p.entryTokens, third = entry / 3;
    pump(s.t, s.p, s.p.tokens * 4);
    await s.t.tick();
    let p = s.t.status().positions[0];
    expect(s.sells).toHaveLength(1);
    expect(p.tp1Done).toBe(false);
    expect(p.tpPending).toMatchObject({ tp: 1 });
    expect(p.tpPending!.sold).toBeCloseTo(s.sells[0], 6);
    expect(p.tpPending!.target).toBeCloseTo(third, 6);
    healSells(s);
    await s.t.tick(); // take profit 1 still hit: sells the rest of the tranche, not another full third
    p = s.t.status().positions[0];
    const total = s.sells.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(third, 6);
    expect(p.tp1Done).toBe(true);
    expect(p.tp2Done).toBe(false);
    expect(p.tpPending ?? null).toBeNull();
    expect(p.tokens).toBeCloseTo(entry - third, 6);
    expect(p.tokens).toBeCloseTo(s.wallet.balance!, 6);
  });

  it('a "failed" part that actually landed counts toward the tranche (read from the wallet)', async () => {
    const s = await liveWithPosition();
    const entry = s.p.entryTokens, third = entry / 3;
    let i = 0;
    (s.t as unknown as Live).d.live.sell = async (_p, tokens) => {
      s.wallet.balance = (s.wallet.balance ?? 0) - tokens; // it lands…
      if (i++ === 1) throw new Error('receipt timeout'); // …but the second one reports a failure
      s.sells.push(tokens);
      return { quoteOut: tokens * 80, tokensIn: tokens, price: 80, impact: 0.01 };
    };
    pump(s.t, s.p, s.p.tokens * 4);
    await s.t.tick();
    const p1 = s.t.status().positions[0];
    expect(p1.tp1Done).toBe(false);
    const landed = entry - s.wallet.balance!;
    expect(p1.tpPending!.sold).toBeCloseTo(landed, 6);
    expect(p1.tokens).toBeCloseTo(s.wallet.balance!, 6);
    healSells(s);
    await s.t.tick();
    expect(entry - s.wallet.balance!).toBeCloseTo(third, 6); // one third left the wallet in total
    expect(s.t.status().positions[0].tp1Done).toBe(true);
  });

  it('paper and a live take profit that completes are unchanged: one third, marked done at once', async () => {
    const s = await liveWithPosition();
    pump(s.t, s.p, s.p.tokens * 4);
    await s.t.tick();
    const p = s.t.status().positions[0];
    expect(p.tp1Done).toBe(true);
    expect(p.tpPending ?? null).toBeNull();
    expect(p.tokens).toBeCloseTo(s.p.entryTokens * 2 / 3, 6);
  });
});

describe('6. a position stuck on reconcile shows a lasting "exits blocked" state (saved, survives a restart)', () => {
  it('blocked on the row and in plan(), lastError may clear but the warning stays; the peak keeps updating; clears once read', async () => {
    const s = await liveWithPosition({ failAt: 1 });
    pump(s.t, s.p, s.p.tokens * 4);
    const tr = s.t as unknown as Live;
    const read = tr.d.balanceOf;
    tr.d.balanceOf = async () => { throw new Error('rpc down'); };
    await s.t.tick();
    let st = s.t.status();
    expect(st.exitsBlocked).toBe(1);
    expect(st.positions[0].exitsBlocked).toMatch(/exits blocked: can't read the wallet balance \(rpc down\)/);
    expect(st.positions[0].exitPlan).toBe(st.positions[0].exitsBlocked);
    const since = st.positions[0].blockedSince;
    expect(since).toBe(NOW);
    // a later tick: lastError is reset each tick, the blocked state is not
    const higher = s.p.entryPrice * 3;
    // the tick's own price read (d.mark), as in the app: the peak must follow it while blocked
    (s.t as unknown as { d: { mark: (p: Position) => Promise<Partial<Position> | null> } }).d.mark = async () => ({ price: higher });
    await s.t.tick();
    (s.t as unknown as { d: { mark: (p: Position) => Promise<Partial<Position> | null> } }).d.mark = async () => null;
    st = s.t.status();
    expect(st.lastError ?? null).toBeNull();
    expect(st.positions[0].exitsBlocked).toMatch(/exits blocked/);
    expect(st.positions[0].peak).toBeCloseTo(higher, 9); // peak follows the price while blocked
    // saved: a restart still shows it
    const again = new TokenTrader({
      store: s.store, now: () => NOW, emit: () => {},
      sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
      discover: async () => [], assess: async () => clean(), resolve: async () => null,
    });
    expect(again.status().exitsBlocked).toBe(1);
    expect(again.status().positions[0]).toMatchObject({ reconcile: true, blockedSince: since, exitsBlocked: expect.stringMatching(/exits blocked/) });
    expect(blockedNote(again.status().positions[0])).toMatch(/^exits blocked: can't read the wallet balance \(rpc down\) since /);
    // the wallet is readable again: cleared
    tr.d.balanceOf = read;
    s.t.mark(s.p.id, { price: s.p.entryPrice, peak: s.p.entryPrice * 3 * 0.99 });
    await s.t.tick();
    st = s.t.status();
    expect(st.exitsBlocked).toBe(0);
    expect(st.positions[0]).toMatchObject({ reconcile: false, exitsBlocked: null, blockedSince: null });
    expect(blockedNote(st.positions[0])).toBeNull();
  });
});

describe('7. reconcile never counts wallet tokens the bot did not buy', () => {
  it('1,000 tokens bought by hand sit in the same wallet: a stop partway books only what left during the sell', async () => {
    const s = await liveWithPosition({ failAt: 1 });
    const start = s.p.tokens;
    s.wallet.balance! += 1000; // manual buy / airdrop of the same coin
    pump(s.t, s.p, start * 4);
    await s.t.tick();
    const p = s.t.status().positions[0];
    expect(p.tokens).toBeCloseTo(start - s.sells[0], 6); // not the wallet's balance (or entryTokens)
    expect(s.wallet.balance! - p.tokens).toBeCloseTo(1000, 6); // the manual tokens are not the bot's
    expect(p.reconcile).toBe(false);
  });

  it('…and a "failed" part that landed is booked too, still without the manual tokens', async () => {
    const s = await liveWithPosition();
    const start = s.p.tokens;
    s.wallet.balance! += 1000;
    let i = 0;
    (s.t as unknown as Live).d.live.sell = async (_p, tokens) => {
      s.wallet.balance = (s.wallet.balance ?? 0) - tokens;
      if (i++ === 1) throw new Error('receipt timeout');
      s.sells.push(tokens);
      return { quoteOut: tokens * 80, tokensIn: tokens, price: 80, impact: 0.01 };
    };
    pump(s.t, s.p, start * 4);
    await s.t.tick();
    expect(s.t.status().positions[0].tokens).toBeCloseTo(s.wallet.balance! - 1000, 6);
  });

  it('balance before the sell unreadable: the wallet is only an upper bound, the position never grows from it', async () => {
    const s = await liveWithPosition({ failAt: 1 });
    const start = s.p.tokens;
    s.wallet.balance! += 1000;
    const tr = s.t as unknown as Live;
    const read = tr.d.balanceOf;
    let calls = 0;
    tr.d.balanceOf = async (p) => (calls++ === 0 ? null : read(p)); // the read before the sell fails
    pump(s.t, s.p, start * 4);
    await s.t.tick();
    const p = s.t.status().positions[0];
    expect(p.tokens).toBeCloseTo(start - s.sells[0], 6);
    expect(p.tokens).toBeLessThan(s.wallet.balance! - 999);
  });
});
