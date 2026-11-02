/**
 * Bots tab: every token-trader row showed a dash in every column (Kyle, 2026-10-31). The columns read `metrics` and the
 * position rows had none. Each position now carries its own figures, from the same code as the trader's.
 */
import { describe, expect, it } from 'vitest';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type Position, type TraderState } from '../src/server/bot/tokenTrader';
import type { PoolSniper } from '../src/server/market/sniper';
import { setEthUsdSource } from '../src/lib/ethUnits';
import { botFacts } from '../src/ui/deskStats';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeskTable } from '../src/ui/DeskTable';
import { S } from './helpers/unitsScreens';

setEthUsdSource(() => 2500);
const NOW = 1_800_000_000_000;
const pool: FreshPool = {
  chainId: 1, pool: '0x' + 'ab'.repeat(20), dex: 'uni-v3', kind: 'v3', token: '0x' + '11'.repeat(20), spend: '0x' + '22'.repeat(20),
  tokenSymbol: 'PEPE', spendSymbol: 'WETH', liquidityUsd: 80_000, volumeUsd: 10_000, createdAt: NOW - 48 * 3600_000, source: 'trending',
  quoteReserve: 40, tokenReserve: 1_000_000, feeBps: 30, price: 0.00004, usdPerSpend: 2_000,
};
const clean: GateInput = {
  mode: 'paper', risk: 'any', honeypot: false, sellSimOk: true, paused: false, decimals: 18, buyTax: 0, sellTax: 0,
  liquidityUsd: 80_000, minLiquidityUsd: 0, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true,
};

function trader() {
  let now = NOW, quote = 40;
  const batches = [[pool]];
  const t = new TokenTrader({
    store: new MemoryStore<TraderState>(), now: () => now,
    sniper: { tick: async (cursors: Record<string, number>) => ({ cursors, hits: [], notes: [] }) } as unknown as PoolSniper,
    discover: async () => batches.shift() ?? [], assess: async () => clean, resolve: async () => null,
    mark: async (p: Position) => ({ price: quote / 1_000_000, quoteReserve: quote, tokenReserve: 1_000_000, liq: 2 * quote * p.usdPerSpend }),
  });
  t.configure({ perTradeUsd: 100, totalUsd: 500, risk: 'any' });
  t.turnOn();
  return { t, later: (ms: number) => { now += ms; }, setQuote: (q: number) => { quote = q; } };
}

describe('a token-trader position carries its own figures', () => {
  it('open: value, cost and result in its spend coin and in dollars; Total P&L is its open result', async () => {
    const { t, later, setQuote } = trader();
    await t.tick();
    setQuote(44); // +10%
    later(3600_000); await t.tick();
    const p = t.status().positions[0];
    const m = p.metrics;
    expect(m).toMatchObject({ botId: p.id, mode: 'paper', kind: 'token' });
    expect(m.ageSec).toBe(3600);
    expect(m.quote.symbol).toBe('WETH');
    expect(m.quote.currentValue).toBeCloseTo(p.value!, 12);
    expect(m.currentValueUsd).toBeCloseTo(p.value! * 2_000, 6);
    // only the buy fee has been booked: Generated is minus that fee; Total P&L = open result + Generated
    expect(m.generated.WETH).toBeLessThan(0);
    expect(m.quote.totalPnl).toBeCloseTo(p.pnl! + m.generated.WETH, 12);
  });

  it('after a take profit sells a third: what it took is in Generated, and Total P&L still adds up', async () => {
    const { t, later, setQuote } = trader();
    await t.tick();
    setQuote(64); // +60%: take profit 1
    later(60_000); await t.tick();
    const p = t.status().positions[0];
    expect(p.tp1Done).toBe(true);
    expect(p.metrics.generated.WETH).toBeGreaterThan(0);
    expect(p.metrics.quote.paidOut).toBeGreaterThan(0);
    expect(p.metrics.quote.totalPnl).toBeCloseTo(p.pnl! + p.metrics.generated.WETH, 12);
  });

  it("the Bots tab's columns get numbers, not dashes", async () => {
    const { t, later } = trader();
    await t.tick();
    later(60_000); await t.tick();
    const f = botFacts({ ...t.status().positions[0], kind: 'trader' });
    expect(f.valueUsd).not.toBeNull();
    expect(f.investedUsd).not.toBeNull();
    expect(f.pnlUsd).not.toBeNull();
    expect(f.generated).not.toBeNull();
    expect(f.ageMs).toBe(60_000);
  });

  it('the row names its coins (PEPE, WETH), not their addresses, in its units and logo', async () => {
    const { t, later } = trader();
    await t.tick();
    later(60_000); await t.tick();
    const p = t.status().positions[0];
    // the row as the Bots tab builds it
    const row = { ...p, kind: 'trader', name: p.label, label: p.label, base: p.token, quote: p.spend, quoteSym: p.spendSym, status: 'running', startedAt: p.openedAt, usdPerQuote: p.usdPerSpend };
    const html = renderToStaticMarkup(createElement(DeskTable, { s: S, bots: [row], nav: () => undefined, pause: () => undefined, close: () => undefined }));
    expect(html).toMatch(/PEPE\/\u200BWETH|PEPE\/WETH/);
    expect(html).toMatch(/WETH/);
    expect(html).not.toMatch(new RegExp(pool.spend.slice(2, 12)));
    expect(html).not.toMatch(new RegExp(pool.token.slice(2, 12)));
  });
});
