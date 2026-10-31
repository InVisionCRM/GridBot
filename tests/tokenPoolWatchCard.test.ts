/**
 * What a token-trader card reports about its position and pool (Kyle, 2026-10-31: "THESE CARD ARE IMPORTANT AND SHOULD
 * UPDATE THEMSELVES AND REPORT").
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXIT, exitTargets } from '../src/market/tokenTrader';
import { poolWatch, shortSpan } from '../src/ui/tokenModel';
import { ExitLine } from '../src/ui/TokenTraderPage';

const NOW = 1_800_000_000_000;
const exitPos = { entryPrice: 1, price: 1.1, peak: 1.1, openedAt: NOW - 3600_000, now: NOW, entryVolume: 0, volume: 0, entryLiq: 100_000, liq: 80_000, liqPeak: 120_000, movedAt: NOW - 45 * 60_000, sellTax: 0.02, entrySellTax: 0.02, sellSimOk: true, tp1Done: false, tp2Done: false, remainingFrac: 1 };
const pos = (o: Record<string, unknown> = {}) => ({ exitPlan: 'hold', routed: true, markedAt: NOW - 3000, checkedAt: NOW - 4 * 60_000, checkNote: null, readError: null, liq: 80_000, sellTax: 0.02, exits: exitTargets(exitPos), ...o });

describe('the status line says what the trader is doing', () => {
  it('holding: names the nearest exit and how far it is', () => {
    expect(poolWatch(pos(), NOW).status).toEqual({ tone: 'ok', text: 'Holding · next: trailing stop arms +18.2% away' });
  });
  it('a read that failed, a first pool check, a sell under way and Sell now each say so', () => {
    expect(poolWatch(pos({ readError: 'execution reverted' }), NOW).status).toEqual({ tone: 'bad', text: 'Price read failed (last price kept): execution reverted' });
    expect(poolWatch(pos({ routed: false, markedAt: null }), NOW).status).toEqual({ tone: 'warn', text: 'First pool check running' });
    expect(poolWatch(pos({ routed: false, markedAt: null, checkNote: 'safety check failed: no pool to trade' }), NOW).status.text).toBe('First pool check failed, trying again: safety check failed: no pool to trade');
    expect(poolWatch(pos({ exitPlan: 'no trades in the pool for 2.0 h' }), NOW).status).toEqual({ tone: 'warn', text: 'Selling: no trades in the pool for 2.0 h' });
    expect(poolWatch(pos({ sellNow: NOW }), NOW).status.text).toBe('Selling: you pressed Sell now');
  });
});

describe('the pool meters', () => {
  it('depth: dollars now and the share gone from the peak, as a share of the 40% that sells', () => {
    const w = poolWatch(pos(), NOW);
    expect(w.depth!.usd).toBe(80_000);
    expect(w.depth!.drop).toBeCloseTo(1 / 3, 9);
    expect(w.depth!.frac).toBeCloseTo((1 / 3) / EXIT.liqPull, 9);
  });
  it('last trade: time since the pool moved, as a share of the 2 h that sells', () => {
    const w = poolWatch(pos(), NOW);
    expect(w.quiet).toEqual({ ms: 45 * 60_000, frac: 45 / 120, msLeft: 75 * 60_000 });
  });
  it('safety: when it was last checked, the sell tax it measured, and any note', () => {
    expect(poolWatch(pos(), NOW).safety).toEqual({ ms: 4 * 60_000, tax: 0.02, note: null });
    expect(poolWatch(pos({ checkedAt: null }), NOW).safety.ms).toBeNull();
  });
  it('spans read short: 45s, 12m, 2h 5m', () => {
    expect([shortSpan(45_000), shortSpan(12 * 60_000), shortSpan(125 * 60_000)]).toEqual(['45s', '12m', '2h 5m']);
  });
});

describe('the exits list names the pool rules', () => {
  it('liquidity pulled and pool stopped trading', () => {
    const line = (x: Record<string, unknown>) => renderToStaticMarkup(createElement(ExitLine, { x }));
    expect(line({ key: 'drain', does: "sells all if the pool's depth falls 40% from its peak", move: null, at: 0.4, drop: 0.25 })).toMatch(/<b>Liquidity pulled<\/b>.*<em>25% of 40% gone<\/em>/);
    expect(line({ key: 'dead', does: 'sells all after 2 h with no trades in the pool', move: null, msLeft: 75 * 60_000, ms: 2 * 3600_000 })).toMatch(/<b>Pool stopped trading<\/b>.*<em>1h 15m left<\/em>/);
  });
});
