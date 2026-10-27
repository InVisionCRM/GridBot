/**
 * Effective entry (spend per token received, after entry fee, impact, slippage and buy tax), the same for paper and
 * live, and exits measured after the exit fee: break-even at 1% in / 1% out is +2.03% in the pool mid.
 */
import { describe, expect, it } from 'vitest';
import { breakEvenMove, decideExit, effectiveEntry, sellSidePrice, sizeBuy, EXIT, type ExitPos, type FreshPool, type GateInput } from '../src/market/tokenTrader';
import { simBuy } from '../src/market/costs';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';

const NOW = 1_793_129_093_757;
const clean = (): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
});
const MID = 2;
/** Deep 1% pool (impact ≈ 0) so the fee is the only cost. */
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: 369, pool: '0x' + 'ab'.repeat(20), dex: 'pulsex-v2', kind: 'v2',
  token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20), tokenSymbol: 'NEW', spendSymbol: 'WPLS',
  liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'new',
  quoteReserve: 1e12, tokenReserve: 1e12 / MID, feeBps: 100, price: MID, usdPerSpend: 1, ...o,
});

function trader(o: { live?: { tokens: number; spent: number }; store?: MemoryStore<TraderState>; p?: FreshPool } = {}) {
  let wave = [o.p ?? pool()];
  const buys: { spend: number }[] = [];
  const t = new TokenTrader({
    store: o.store ?? new MemoryStore<TraderState>(), now: () => NOW, emit: () => {},
    sniper: { tick: async (c: Record<string, number>) => ({ cursors: c, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => { const w = wave; wave = []; return w; },
    assess: async () => clean(), resolve: async () => null, mark: async () => null,
    live: o.live ? {
      buy: async (_p, spend) => { buys.push({ spend }); return { tokens: o.live!.tokens, spent: o.live!.spent, spentUsd: o.live!.spent, price: o.live!.spent / o.live!.tokens, impact: 0 }; },
      sell: async () => { throw new Error('no sells here'); },
    } : undefined,
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0, risk: 'safe', maxImpact: 0.02, ...(o.live ? { mode: 'live' as const } : {}) });
  return { t, buys };
}
async function open(o: Parameters<typeof trader>[0] = {}) {
  const s = trader(o);
  s.t.turnOn();
  await s.t.tick();
  const p = s.t.status().positions[0];
  expect(p).toBeTruthy();
  return { ...s, p };
}
const at = (entryPrice: number, price: number, o: Partial<ExitPos> = {}): ExitPos => ({
  entryPrice, price, peak: price, openedAt: NOW, now: NOW, entryVolume: 0, volume: 0, entryLiq: 0, liq: 0,
  sellTax: 0, entrySellTax: 0, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1, exitFee: 0.01, ...o,
});

describe('break-even', () => {
  it('is +2.03% at 1% in / 1% out', () => {
    expect(breakEvenMove(100, 100)).toBeCloseTo(0.020304, 6);
    expect(+(breakEvenMove(100, 100) * 100).toFixed(2)).toBe(2.03);
  });

  it('paper round trip on a 1% pool: P&L ≈ 0 at +2.03% in the mid, < 0 just below, > 0 just above', async () => {
    const { t, p } = await open();
    expect(p.entryPrice).toBeCloseTo(MID / 0.99, 6); // fee charged once on the buy (it was twice)
    const pnlAt = (move: number) => { t.mark(p.id, { price: MID * (1 + move) }); return t.status().positions[0].pnlUsd; };
    expect(Math.abs(pnlAt(breakEvenMove(100, 100)))).toBeLessThan(1e-4);
    expect(pnlAt(0.02)).toBeLessThan(0);
    expect(pnlAt(0.021)).toBeGreaterThan(0);
    expect(pnlAt(0)).toBeCloseTo(-100 * (1 - 0.99 * 0.99), 3); // flat mid = both fees ≈ −1.99
  });

  it('decideExit: gain is 0 at break-even (time stop sees "only 0.0% up")', () => {
    const entry = MID / 0.99;
    const d = decideExit(at(entry, MID * (1 + breakEvenMove(100, 100)), { now: NOW + EXIT.timeStopMs }));
    expect(d).toMatchObject({ action: 'sell', why: expect.stringMatching(/only (-)?0\.0% up/) });
  });
});

describe('TP / SL trigger levels include the exit fee', () => {
  const entry = 100;
  const tp1 = (entry * (1 + EXIT.tp1)) / 0.99;     // mid where a token nets +50% after the 1% exit fee
  const stop = (entry * (1 - EXIT.hardStop)) / 0.99; // mid where it nets −25%

  it('take profit 1 fires at entry × 1.5 / (1 − exit fee), not at entry × 1.5', () => {
    expect(decideExit(at(entry, entry * 1.5))).toEqual({ action: 'hold' }); // the old (gross) trigger
    expect(decideExit(at(entry, tp1 * 0.999))).toEqual({ action: 'hold' });
    expect(decideExit(at(entry, tp1 * 1.001))).toMatchObject({ action: 'sell', why: expect.stringMatching(/take profit/) });
  });
  it('take profit 2 likewise', () => {
    const tp2 = (entry * (1 + EXIT.tp2)) / 0.99;
    expect(decideExit(at(entry, tp2 * 0.999, { tp1Done: true }))).toEqual({ action: 'hold' });
    expect(decideExit(at(entry, tp2 * 1.001, { tp1Done: true }))).toMatchObject({ action: 'sell', why: expect.stringMatching(/take profit/) });
  });
  it('hard stop fires at entry × 0.75 / (1 − exit fee): earlier than gross', () => {
    expect(decideExit(at(entry, stop * 1.001))).toEqual({ action: 'hold' });
    expect(decideExit(at(entry, stop * 0.999))).toMatchObject({ action: 'sell', why: expect.stringMatching(/hard stop/) });
    expect(decideExit(at(entry, entry * 0.755))).toMatchObject({ action: 'sell' }); // gross −24.5% is already −25.3% net
    expect(decideExit(at(entry, entry * 0.755, { exitFee: 0 }))).toEqual({ action: 'hold' });
  });
  it('trailing stop arms on the net peak', () => {
    const arm = (entry * (1 + EXIT.trailArm)) / 0.99;
    const drop = (peak: number) => peak * (1 - EXIT.trailGap) * 0.999;
    // a peak of +30.5% gross is only +29.2% net: not armed, so a 20% drop from it is not a trailing stop
    expect(decideExit(at(entry, drop(entry * 1.305), { peak: entry * 1.305 }))).toEqual({ action: 'hold' });
    expect(decideExit(at(entry, drop(entry * 1.305), { peak: entry * 1.305, exitFee: 0 }))).toMatchObject({ why: expect.stringMatching(/trailing/) });
    // just under the net arm level: the trail is not armed (a 20% drop from there is not a trailing stop)
    const d1 = decideExit(at(entry, drop(arm * 0.999), { peak: arm * 0.999 }));
    expect(d1.action === 'sell' ? d1.why : '').not.toMatch(/trailing/);
    const d2 = decideExit(at(entry, drop(arm * 1.001), { peak: arm * 1.001 }));
    expect(d2).toMatchObject({ action: 'sell', why: expect.stringMatching(/trailing/) });
  });
  it('the bot passes the pool fee as the exit fee', async () => {
    const { t, p } = await open();
    t.mark(p.id, { price: (p.entryPrice * 1.5) }); // +50% gross on the effective entry → under the net TP
    expect(t.status().positions[0].exitPlan).toBe('hold');
    t.mark(p.id, { price: (p.entryPrice * 1.5) / 0.99 * 1.001 });
    expect(t.status().positions[0].exitPlan).toMatch(/take profit/);
  });
});

describe('paper and live use the same effective entry', () => {
  it('identical entry for the same fill (spent / tokens received)', async () => {
    const paper = await open();
    const live = await open({ live: { tokens: paper.p.entryTokens, spent: paper.p.spent } });
    expect(live.buys).toHaveLength(1);
    expect(live.p.entryPrice).toBe(paper.p.entryPrice);
    expect(paper.p.entryPrice).toBe(effectiveEntry(paper.p.spent, paper.p.entryTokens));
    expect(live.p.entryPrice).toBe(effectiveEntry(live.p.spent, live.p.entryTokens));
    // both keep the pool mid as reference and start marking from it
    expect(paper.p).toMatchObject({ entryMid: MID, price: MID, peak: MID, entryBasis: 'effective' });
    expect(live.p).toMatchObject({ entryMid: MID, price: MID, peak: MID, entryBasis: 'effective' });
  });
  it('entry includes price impact and buy tax (paper sizing)', () => {
    const thin = { quoteReserve: 10_000, price: MID, feeBps: 30, usdPerSpend: 1 };
    const s = sizeBuy({ perTradeUsd: 100, totalUsd: 500, openUsd: 0, ...thin, buyTax: 0.05, maxImpact: 0.05 })!;
    const e = effectiveEntry(s.spend, s.tokens);
    expect(e).toBeGreaterThan(MID / (1 - 0.003) / 0.95); // fee + tax …
    expect(e).toBeLessThan(MID / (1 - 0.003) / 0.95 * 1.03); // … + ~1% impact
  });
  it('simBuy at the sell-side price charges the fee once (the mid input charged it twice)', () => {
    const m = { feeBps: 100, pool: null, gasPricePls: 0, approval: 'exact' as const, slippageBps: 0 };
    expect(100 / simBuy(100, sellSidePrice(MID, 100), m).pls).toBeCloseTo(MID / 0.99, 9);
    expect(100 / simBuy(100, MID, m).pls).toBeCloseTo(MID / 0.99 / 0.99, 9); // the old call
  });
});

describe('migration of open positions', () => {
  async function oldFile() {
    const paper = await open();
    const raw = structuredClone(paper.t['state' as never]) as TraderState;
    const pp = raw.positions[0];
    // a paper position from before: entryPrice = mid, fee charged twice into entryTokens
    pp.entryPrice = MID; pp.entryTokens = pp.tokens = 100 / (MID / 0.99 / 0.99); pp.spent = 100;
    delete pp.entryMid; delete pp.entryBasis;
    // a live one: entryPrice was already amountIn / amountOut
    const lp = { ...structuredClone(pp), id: 'tt-live', mode: 'live' as const, pool: '0x' + 'cd'.repeat(20), spent: 50, entryTokens: 24, tokens: 20 };
    lp.entryPrice = 50 / 24;
    raw.positions.push(lp);
    const store = new MemoryStore<TraderState>();
    store.save(raw);
    return store;
  }
  it('paper: entry becomes spent / entryTokens, old mid kept as entryMid; live: unchanged number, entryMid unknown', async () => {
    const store = await oldFile();
    const { t } = trader({ store });
    const [pp, lp] = t.status().positions;
    expect(pp.entryPrice).toBeCloseTo(MID / 0.99 / 0.99, 9);
    expect(pp).toMatchObject({ entryMid: MID, entryBasis: 'effective' });
    expect(lp.entryPrice).toBeCloseTo(50 / 24, 12);
    expect(lp).toMatchObject({ entryMid: null, entryBasis: 'effective', tokens: 20 });
    // persisted, and a second load changes nothing
    const again = trader({ store }).t.status().positions;
    expect(again.map((p) => p.entryPrice)).toEqual([pp.entryPrice, lp.entryPrice]);
  });
});
