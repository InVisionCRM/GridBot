/**
 * #76 review fix 1: the token trader's Generated ledger keeps paper and live apart (key mode:chain:coin). A position
 * books into its own mode (fixed at its buy) across a change of the trader's mode, and ledgers saved before the split
 * are migrated: open positions' shares go to their recorded mode; the rest is live only if it paid gas, else paper.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { JsonStore, MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type GenLedger, type LiveSell, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';

const WETH = '0x' + '22'.repeat(20), TOKEN = '0x' + '11'.repeat(20);
const NOW = 1_700_000_000_000;
const gate = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true, ...o,
});
let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  // distinct first 4 hex digits: position ids are tt-<time>-<pool[2..6]> and the clock is fixed
  chainId: 1, pool: '0x' + (0xa000 + n++).toString(16) + 'd'.repeat(36), dex: 'uni-v3', kind: 'v3',
  token: TOKEN, spend: WETH, tokenSymbol: 'NEW', spendSymbol: 'WETH',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 1e9, tokenReserve: 1e12, feeBps: 30, price: 0.001, usdPerSpend: 2_000, ...o,
});
const sniper = { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper;
const coinInfo = (_c: number, spend: string) => ({ native: spend.toLowerCase() === WETH, nativeSymbol: 'ETH' });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** One trader that can buy paper or live (scripted broker, no signer, nothing sent) on the same chain and coin */
function trader(store: MemoryStore<TraderState> | JsonStore<TraderState>, sell: (k: number) => LiveSell = (k) => ({ quoteOut: k * 0.0012, tokensIn: k, price: 0.0012, impact: 0, gasNative: 0.001 })) {
  const queue: FreshPool[] = [];
  const t = new TokenTrader({
    store, now: () => NOW, sniper, coinInfo,
    discover: async () => queue.splice(0),
    assess: async (_p, mode) => gate({ mode }),
    live: {
      buy: async () => ({ tokens: 1000, spent: 1, spentUsd: 2000, price: 0.001, impact: 0, gasNative: 0.002 }),
      sell: async (_p, k) => sell(k),
    },
  });
  return { t, queue };
}
const entries = (t: TokenTrader) => t.status().generated.filter((g) => g.coin.address === WETH);
const of = (t: TokenTrader, mode: 'paper' | 'live') => entries(t).find((g) => g.mode === mode)!;

describe('Generated: paper and live kept apart (mode in the key)', () => {
  it('paper and live positions on the same chain and coin keep separate ledgers across mode changes', async () => {
    const { t, queue } = trader(new MemoryStore<TraderState>());
    t.configure({ mode: 'paper', perTradeUsd: 2000, totalUsd: 10_000, minPoolAgeSec: 0, risk: 'any' });
    t.turnOn();
    queue.push(pool());
    await t.tick();
    // mode change with the paper position still open
    t.configure({ mode: 'live' });
    queue.push(pool());
    await t.tick();
    const [paper, live] = t.status().positions;
    expect([paper.mode, live.mode]).toEqual(['paper', 'live']);
    expect(entries(t)).toHaveLength(2);
    expect(of(t, 'paper')).toMatchObject({ mode: 'paper', gasNative: 0, closed: 0 });
    expect(of(t, 'live')).toMatchObject({ mode: 'live', gasNative: 0.002, closed: 0 });
    expect(of(t, 'live').cost).toBeCloseTo(0.003, 12); // only the live buy's fee
    expect(of(t, 'paper').cost).toBeCloseTo(paper.spent * 0.003, 12);
    // back to paper: the open live position still books into live when it sells, and the paper one into paper
    t.configure({ mode: 'paper' });
    t.mark(live.id, { price: 0.0004 });
    t.mark(paper.id, { price: 0.0004 });
    await t.tick();
    expect(t.status().positions).toHaveLength(0);
    const L = of(t, 'live'), P = of(t, 'paper');
    expect(L).toMatchObject({ proceeds: 1.2, closed: 1 });
    expect(L.cost).toBeCloseTo(1, 12);
    expect(L.gasNative).toBeCloseTo(0.003, 12);
    expect(L.amount).toBeCloseTo(1.2 - 1 - 0.003, 12);
    expect(P.gasNative).toBe(0);
    expect(P.closed).toBe(1);
    expect(P.cost).toBeCloseTo(paper.spent, 12);
    expect(P.proceeds).not.toBeCloseTo(1.2, 3); // simulated paper sell, not the live broker's fill
    // each position's own figure carries its mode
    expect(t.status().generated.every((g) => g.mode === 'paper' || g.mode === 'live')).toBe(true);
  });

  it('the API keeps its shape: the same fields as before plus mode (nothing renamed)', async () => {
    const { t, queue } = trader(new MemoryStore<TraderState>());
    t.configure({ mode: 'live', perTradeUsd: 2000, totalUsd: 10_000, minPoolAgeSec: 0, risk: 'any' });
    t.turnOn();
    queue.push(pool());
    await t.tick();
    const g = t.status().generated[0];
    for (const k of ['coin', 'amount', 'proceeds', 'cost', 'fees', 'taxes', 'gasNative', 'gasSymbol', 'gasInAmount', 'closed', 'basis']) expect(g).toHaveProperty(k);
    expect(g.mode).toBe('live');
    expect(g.modeInferred).toBeUndefined();
    expect(t.status().positions[0].generated.mode).toBe('live');
  });
});

describe('Generated: migration of a ledger saved before the mode split', () => {
  /** A real file: run paper + live positions, then rewrite the ledger as the old format (one entry, no mode) plus `rest` */
  async function oldFile(rest: Partial<GenLedger>, positions: 'both' | 'none' = 'both') {
    const dir = mkdtempSync(join(tmpdir(), 'genmode-')); dirs.push(dir);
    const file = join(dir, 'token-trader.json');
    const { t, queue } = trader(new JsonStore<TraderState>(file));
    t.configure({ mode: 'paper', perTradeUsd: 2000, totalUsd: 10_000, minPoolAgeSec: 0, risk: 'any' });
    t.turnOn();
    if (positions === 'both') {
      queue.push(pool()); await t.tick();
      t.configure({ mode: 'live' });
      queue.push(pool()); await t.tick();
    }
    t.turnOff();
    const s = JSON.parse(readFileSync(file, 'utf8')) as TraderState;
    const sum = { chainId: 1, coin: WETH, symbol: 'WETH', proceeds: 0, cost: 0, fees: 0, taxes: 0, gasNative: 0, closed: 0 };
    for (const l of Object.values(s.generated ?? {})) for (const k of ['proceeds', 'cost', 'fees', 'taxes', 'gasNative', 'closed'] as const) sum[k] += l[k];
    for (const k of ['proceeds', 'cost', 'fees', 'taxes', 'gasNative', 'closed'] as const) sum[k] += rest[k] ?? 0;
    s.generated = { [`1:${WETH}`]: sum as GenLedger };
    writeFileSync(file, JSON.stringify(s));
    return { file, sum, positions: s.positions };
  }
  const load = (file: string) => new TokenTrader({ store: new JsonStore<TraderState>(file), now: () => NOW, coinInfo });

  it('open positions go to their recorded mode; a closed rest that paid gas goes to live (inferred); totals unchanged; saved; idempotent', async () => {
    const { file, sum, positions } = await oldFile({ proceeds: 0.5, cost: 0.4, fees: 0.001, gasNative: 0.0015, closed: 1 });
    const t = load(file);
    const P = of(t, 'paper'), L = of(t, 'live');
    const pp = positions.find((p) => p.mode === 'paper')!, lp = positions.find((p) => p.mode === 'live')!;
    expect(P).toMatchObject({ mode: 'paper', proceeds: 0, gasNative: 0, closed: 0 });
    expect(P.cost).toBeCloseTo(pp.gen!.feeBooked, 12);
    expect(P.modeInferred).toBeUndefined(); // recorded on the position, not guessed
    expect(L.mode).toBe('live');
    expect(L.modeInferred).toBe(true);
    expect(L.proceeds).toBeCloseTo(0.5, 12);
    expect(L.cost).toBeCloseTo(0.4 + lp.gen!.feeBooked, 12);
    expect(L.gasNative).toBeCloseTo(0.0015 + 0.002, 12);
    expect(L.closed).toBe(1);
    for (const k of ['proceeds', 'cost', 'fees', 'taxes', 'gasNative', 'closed'] as const) expect(P[k]! + L[k]!).toBeCloseTo(sum[k], 12);
    const saved = JSON.parse(readFileSync(file, 'utf8')) as TraderState;
    expect(Object.keys(saved.generated!).sort()).toEqual([`live:1:${WETH}`, `paper:1:${WETH}`]);
    const again = load(file); // second load: nothing to migrate, same figures
    expect(again.status().generated).toEqual(t.status().generated);
  });

  it('a closed rest with no gas paid goes to paper (no evidence of live)', async () => {
    const { file, positions } = await oldFile({ proceeds: 0.3, cost: 0.25, closed: 2 });
    const t = load(file);
    const P = of(t, 'paper'), L = of(t, 'live');
    const lp = positions.find((p) => p.mode === 'live')!;
    expect(P.proceeds).toBeCloseTo(0.3, 12);
    expect(P.closed).toBe(2);
    expect(P.modeInferred).toBe(true);
    expect(L.proceeds).toBe(0);
    expect(L.gasNative).toBeCloseTo(lp.gen!.gasNative, 12);
    expect(L.modeInferred).toBeUndefined();
  });

  it('no open positions: the whole entry is live if it paid gas, else paper', async () => {
    const a = await oldFile({ proceeds: 1, cost: 0.9, gasNative: 0.01, closed: 3 }, 'none');
    expect(load(a.file).status().generated).toEqual([expect.objectContaining({ mode: 'live', proceeds: 1, closed: 3, modeInferred: true })]);
    const b = await oldFile({ proceeds: 1, cost: 0.9, closed: 3 }, 'none');
    expect(load(b.file).status().generated).toEqual([expect.objectContaining({ mode: 'paper', proceeds: 1, gasNative: 0, closed: 3, modeInferred: true })]);
  });

  it('only open positions (no rest): each share to its own mode, the closed count to the one mode that sold', async () => {
    const { file, sum } = await oldFile({});
    const t = load(file);
    expect(entries(t)).toHaveLength(2);
    expect(entries(t).every((g) => !g.modeInferred)).toBe(true);
    expect(of(t, 'paper').gasNative + of(t, 'live').gasNative).toBeCloseTo(sum.gasNative, 12);
  });
});
