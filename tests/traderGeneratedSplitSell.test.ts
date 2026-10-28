/**
 * #76 review fix 2 (on top of #42's per-part accounting): in a live split sell, each part that lands is booked into
 * Generated at once (tokens, proceeds, gas) and saved, so a later part that fails never loses it, and nothing is booked
 * twice with #42's wallet reconcile. A part reported failed that actually landed is found by reconcile: its tokens
 * leave the position, its fill is unknown, so Generated counts neither its coins nor its cost (flagged `unpriced`).
 * Fake broker and fake wallet only: no signer, nothing is sent.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { JsonStore, MemoryStore, type Store } from '../src/server/bot/store';
import { TokenTrader, type LiveSell, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';

const WETH = '0x' + '22'.repeat(20), TOKEN = '0x' + '11'.repeat(20);
const NOW = 1_700_000_000_000;
const BUY_GAS = 0.002, PART_GAS = 0.001, FAIL_GAS = 0.0007, RATE = 0.0012;
const gate = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'live', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true, ...o,
});
let n = 0;
// Thin token side: a full exit of 1000 tokens splits into several parts under the 2% impact cap.
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 1, pool: '0x' + (0xb000 + n++).toString(16) + 'e'.repeat(36), dex: 'uni-v3', kind: 'v3',
  token: TOKEN, spend: WETH, tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 1e6, tokenReserve: 10_000, feeBps: 30, price: 0.001, usdPerSpend: 2_000, ...o,
});
const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper;
const coinInfo = (_c: number, spend: string) => ({ native: spend.toLowerCase() === WETH, nativeSymbol: 'ETH' });

type Fail = 'revert' | 'landed' | 'landed-unreadable' | 'hang';
interface Rig {
  t: TokenTrader; wallet: { balance: number | null }; fills: LiveSell[]; calls: number[];
  failAt: Map<number, Fail>; readFails: { n: number };
}
/**
 * Live trader, one position of 1000 tokens bought for 1 WETH (gas 0.002). Sell call i (0-based) may:
 * 'revert' (wallet unchanged, gas paid), 'landed' (tokens leave, but the send reports a failure, gas paid),
 * 'landed-unreadable' (as 'landed', then the next two wallet reads fail), 'hang' (never answers: a crash while the part is out).
 */
async function rig(store: Store<TraderState> = new MemoryStore<TraderState>()): Promise<Rig> {
  const wallet = { balance: 0 as number | null };
  const fills: LiveSell[] = [], calls: number[] = [];
  const failAt = new Map<number, Fail>(), readFails = { n: 0 };
  let queue = [pool()];
  const t = new TokenTrader({
    store, now: () => NOW, sniper, coinInfo, emit: () => {},
    discover: async () => { const q = queue; queue = []; return q; },
    assess: async () => gate(), resolve: async () => null,
    balanceOf: async () => { if (readFails.n > 0) { readFails.n--; throw new Error('rpc down'); } return wallet.balance; },
    live: {
      buy: async () => { wallet.balance = (wallet.balance ?? 0) + 1000; return { tokens: 1000, spent: 1, spentUsd: 2000, price: 0.001, impact: 0, gasNative: BUY_GAS }; },
      sell: async (_p, k) => {
        const i = calls.length;
        calls.push(k);
        const f = failAt.get(i);
        if (f === 'hang') return new Promise<LiveSell>(() => {});
        if (f === 'revert') throw Object.assign(new Error('execution reverted'), { opts: { gasNative: FAIL_GAS } });
        wallet.balance = (wallet.balance ?? 0) - k;
        if (f === 'landed-unreadable') readFails.n = 2;
        if (f === 'landed' || f === 'landed-unreadable') throw Object.assign(new Error('receipt timeout'), { opts: { gasNative: FAIL_GAS } });
        const s = { quoteOut: k * RATE, tokensIn: k, price: RATE, impact: 0, gasNative: PART_GAS };
        fills.push(s);
        return s;
      },
    },
  });
  t.configure({ mode: 'live', perTradeUsd: 2000, totalUsd: 10_000, minPoolAgeSec: 0, risk: 'any', maxImpact: 0.02 });
  t.turnOn();
  await t.tick();
  expect(t.status().positions).toHaveLength(1);
  return { t, wallet, fills, calls, failAt, readFails };
}
const L = (t: TokenTrader) => t.status().generated.find((g) => g.coin.address === WETH && g.mode === 'live')!;
const pos = (t: TokenTrader) => t.status().positions[0];
const hardStop = (t: TokenTrader) => t.mark(pos(t).id, { price: 0.0004 });
/** Basis of `k` tokens: the buy fee (0.3% of 1) is booked at the buy; the rest of `spent` pro rata */
const basis = (k: number) => 0.997 * (k / 1000);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Generated: split sell booked per landed part (on #42)', () => {
  it('all parts land: tokens to 0, one closed sell, proceeds and gas of every part exactly once', async () => {
    const r = await rig();
    hardStop(r.t);
    await r.t.tick();
    expect(r.calls.length).toBeGreaterThan(2); // really split
    expect(r.t.status().positions).toHaveLength(0);
    const g = L(r.t);
    expect(g.proceeds).toBeCloseTo(sum(r.fills.map((f) => f.quoteOut)), 12);
    expect(g.proceeds).toBeCloseTo(1.2, 12);
    expect(g.cost).toBeCloseTo(1, 12);
    expect(g.gasNative).toBeCloseTo(BUY_GAS + PART_GAS * r.calls.length, 12);
    expect(g.closed).toBe(1);
    expect(g.unpriced).toBeUndefined();
    expect(g.amount).toBeCloseTo(1.2 - 1 - BUY_GAS - PART_GAS * r.calls.length, 12);
  });

  it('part 1 lands, part 2 reverts: tokens drop by part 1 only; part 1 proceeds and gas once, the failed gas once; the rest sells later', async () => {
    const r = await rig();
    r.failAt.set(1, 'revert');
    hardStop(r.t);
    await r.t.tick();
    const q = r.calls[0];
    const p = pos(r.t);
    expect(p.tokens).toBeCloseTo(1000 - q, 9);
    expect(r.wallet.balance).toBeCloseTo(1000 - q, 9);
    expect(p.reconcile).toBe(false); // #42 reconcile ran (wallet readable) and agreed
    let g = L(r.t);
    expect(g.proceeds).toBeCloseTo(q * RATE, 12);
    expect(g.cost).toBeCloseTo(0.003 + basis(q), 12);
    expect(g.gasNative).toBeCloseTo(BUY_GAS + PART_GAS + FAIL_GAS, 12);
    expect(g.closed).toBe(1);
    expect(g.unpriced).toBeUndefined();
    expect(p.generated.proceeds).toBeCloseTo(q * RATE, 12);
    expect(r.t.status().trades[0].why).toMatch(/partial/);
    // a second tick sells the rest: the whole round trip costs exactly what was spent, nothing counted twice
    await r.t.tick();
    expect(r.t.status().positions).toHaveLength(0);
    g = L(r.t);
    expect(g.proceeds).toBeCloseTo(sum(r.fills.map((f) => f.quoteOut)), 12);
    expect(g.proceeds).toBeCloseTo(1.2, 12);
    expect(g.cost).toBeCloseTo(1, 12);
    expect(g.gasNative).toBeCloseTo(BUY_GAS + PART_GAS * r.fills.length + FAIL_GAS, 12);
    expect(g.closed).toBe(2);
  });

  it("a part reported failed that landed: #42's reconcile drops its tokens; Generated books it neither as proceeds nor as cost (unpriced, once)", async () => {
    const r = await rig();
    r.failAt.set(1, 'landed');
    hardStop(r.t);
    await r.t.tick();
    const [q1, q2] = r.calls;
    const p = pos(r.t);
    expect(p.tokens).toBeCloseTo(1000 - q1 - q2, 9); // reconcile: what left the wallet
    expect(p.tokens).toBeCloseTo(r.wallet.balance!, 9);
    let g = L(r.t);
    expect(g.proceeds).toBeCloseTo(q1 * RATE, 12); // part 1 only, once
    expect(g.cost).toBeCloseTo(0.003 + basis(q1), 12); // part 2's basis not booked (its coins received are unknown)
    expect(g.gasNative).toBeCloseTo(BUY_GAS + PART_GAS + FAIL_GAS, 12);
    expect(g.unpriced).toBe(1);
    expect(p.generated.unpriced).toBe(1);
    // the rest sells; reconcile is not repeated, so unpriced stays 1 and the totals add up without part 2
    await r.t.tick();
    expect(r.t.status().positions).toHaveLength(0);
    g = L(r.t);
    expect(g.unpriced).toBe(1);
    expect(g.proceeds).toBeCloseTo(sum(r.fills.map((f) => f.quoteOut)), 12);
    expect(g.proceeds).toBeCloseTo(1.2 - q2 * RATE, 12);
    expect(g.cost).toBeCloseTo(1 - basis(q2), 12);
    expect(g.gasNative).toBeCloseTo(BUY_GAS + PART_GAS * r.fills.length + FAIL_GAS, 12);
  });

  it('the wallet read fails at first: the position stays blocked, then reconciles once; unpriced counted once', async () => {
    const r = await rig();
    r.failAt.set(1, 'landed-unreadable');
    hardStop(r.t);
    await r.t.tick(); // part 1 lands, part 2 lands but reports a failure; the reconcile read fails
    expect(r.calls).toHaveLength(2);
    const p = pos(r.t);
    expect(p.reconcile).toBe(true);
    expect(p.exitsBlocked).toBeTruthy();
    expect(p.tokens).toBeCloseTo(1000 - r.calls[0], 9); // part 2 not assumed sold
    expect(L(r.t).unpriced).toBeUndefined();
    await r.t.tick(); // the read fails again: still blocked, nothing booked or sold
    expect(r.calls).toHaveLength(2);
    expect(L(r.t).unpriced).toBeUndefined();
    await r.t.tick(); // readable: reconciled once, then the rest sells
    expect(L(r.t).unpriced).toBe(1);
    expect(r.t.status().positions).toHaveLength(0);
    const g = L(r.t);
    expect(g.proceeds).toBeCloseTo(sum(r.fills.map((f) => f.quoteOut)), 12);
    expect(g.cost).toBeCloseTo(1 - basis(r.calls[1]), 12);
    expect(g.gasNative).toBeCloseTo(BUY_GAS + PART_GAS * r.fills.length + FAIL_GAS, 12);
  });
});

describe('Generated: split sell resume through the real file store', () => {
  it('a landed part is saved before the next part is sent: a crash mid-sell keeps it (tokens and Generated)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gensplit-')); dirs.push(dir);
    const file = join(dir, 'token-trader.json');
    const r = await rig(new JsonStore<TraderState>(file));
    r.failAt.set(1, 'hang'); // part 2 never answers: the process dies with it out
    hardStop(r.t);
    void r.t.tick();
    for (let i = 0; i < 50 && r.calls.length < 2; i++) await new Promise((res) => setTimeout(res, 5));
    expect(r.calls.length).toBe(2);
    const q = r.calls[0];
    const saved = JSON.parse(readFileSync(file, 'utf8')) as TraderState;
    expect(saved.positions[0].tokens).toBeCloseTo(1000 - q, 9);
    const led = Object.values(saved.generated!).find((l) => l.mode === 'live')!;
    expect(led.proceeds).toBeCloseTo(q * RATE, 12);
    expect(led.gasNative).toBeCloseTo(BUY_GAS + PART_GAS, 12);
    // restart from the file: the same figures, booked once
    const again = new TokenTrader({ store: new JsonStore<TraderState>(file), now: () => NOW, coinInfo });
    expect(L(again).proceeds).toBeCloseTo(q * RATE, 12);
    expect(L(again).cost).toBeCloseTo(0.003 + basis(q), 12);
    expect(L(again).closed).toBe(1);
    expect(again.status().positions[0].tokens).toBeCloseTo(1000 - q, 9);
  });

  it('after a stopped split sell, a restart from the file reads the same Generated and tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gensplit-')); dirs.push(dir);
    const file = join(dir, 'token-trader.json');
    const r = await rig(new JsonStore<TraderState>(file));
    r.failAt.set(1, 'landed');
    hardStop(r.t);
    await r.t.tick();
    const before = r.t.status();
    const again = new TokenTrader({ store: new JsonStore<TraderState>(file), now: () => NOW, coinInfo });
    expect(again.status().generated).toEqual(before.generated);
    expect(again.status().positions[0].tokens).toBe(before.positions[0].tokens);
    expect(again.status().positions[0].generated).toEqual(before.positions[0].generated);
  });
});
