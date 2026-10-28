/**
 * Units are coin symbols, never market keys: the trend status sends quoteSym (the quote token's symbol, from the
 * market like a grid's), and a bot whose market isn't loaded reads the symbols from its key, not the key itself.
 */
import { describe, expect, it } from 'vitest';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { Logger } from '../src/server/bot/logger';
import { MemoryStore } from '../src/server/bot/store';
import { ActivityBus } from '../src/server/bot/activity';
import { CandleStore } from '../src/server/market/candleStore';
import { keySymbols, unitOf } from '../src/lib/marketKey';
import { gridMetrics, lpGenerated, lpMetrics, trendMetrics } from '../src/metrics/botMetrics';
import { quoteSym } from '../src/ui/model';
import { MockChain, NET } from './helpers/mockChain';

const CFG = { strategy: 'ema' as const, fast: 2, slow: 3, atrPeriod: 2, stopAtr: 1, tpR: 2, trailAtr: 0, cooldownBars: 0, sizePct: 100 };
const KEY = /\b[a-z]+:[A-Za-z0-9]+\/[A-Za-z0-9]+|chain:/;

function bot(store = new MemoryStore<MultiState>()) {
  const now = 1_791_000_000_000;
  const chain = new MockChain(1e-5 / 0.9971);
  return {
    store,
    bot: new MultiBot({ net: NET, reader: chain, signer: null, store, log: new Logger(true), maxRetries: 0, retryDelayMs: 0, now: () => now, candles: new CandleStore(null), activity: new ActivityBus(50, () => now) }),
  };
}

describe('trend status quoteSym', () => {
  it("is the market's quote symbol (and flipped markets swap it), like a grid's", async () => {
    const { bot: b } = bot();
    const id = await b.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    const fl = await b.addTrend({ mode: 'paper', quote: 'HEX~', tf: '1h', cfg: CFG, capital: 100 });
    const st = b.status();
    const t = st.trends.find((x) => x.id === id)!, f = st.trends.find((x) => x.id === fl)!;
    expect(t.quoteSym).toBe('DAI');
    expect(t.base).toBe('PLS');
    expect(f.quoteSym).toBe('PLS');
    expect(f.base).toBe('HEX');
    expect(trendMetrics(t).quote.symbol).toBe('DAI');
    for (const g of st.grids) expect(g.quoteSym).not.toMatch(KEY);
  });

  it("a trend whose market isn't loaded reads USDG from 'robinhood:ETH/USDG', not the key", async () => {
    const a = bot();
    const id = await a.bot.addTrend({ mode: 'paper', quote: 'DAI', tf: '1h', cfg: CFG, capital: 100 });
    const saved = a.store.data as unknown as { trends: { id: string; quote: string }[] };
    saved.trends.find((x) => x.id === id)!.quote = 'robinhood:ETH/USDG'; // no such market on this hub
    const b = bot(a.store);
    const t = b.bot.status().trends.find((x) => x.id === id)!;
    expect(t.quoteSym).toBe('USDG');
    expect(t.base).toBe('ETH');
    expect(trendMetrics(t).quote.symbol).toBe('USDG');
  });
});

describe('market key → symbols', () => {
  it('keySymbols: chain key, second pool, flipped, legacy', () => {
    expect(keySymbols('robinhood:ETH/USDG')).toEqual({ base: 'ETH', quote: 'USDG' });
    expect(keySymbols('robinhood:ETH/USDG~')).toEqual({ base: 'USDG', quote: 'ETH' });
    expect(keySymbols('pulsechain:PLS/DAI#9mm')).toEqual({ base: 'PLS', quote: 'DAI' });
    expect(keySymbols('ethereum:GTC/WETH#2~')).toEqual({ base: 'WETH', quote: 'GTC' });
    expect(keySymbols('DAI')).toEqual({ base: 'PLS', quote: 'DAI' });
    expect(keySymbols('HEX~')).toEqual({ base: 'HEX', quote: 'PLS' });
    expect(keySymbols('')).toBeNull();
    expect(keySymbols('robinhood:ETH')).toBeNull();
  });
  it('unitOf keeps symbols and turns keys into their quote', () => {
    expect(unitOf('USDG')).toBe('USDG');
    expect(unitOf('robinhood:ETH/USDG')).toBe('USDG');
    expect(unitOf('robinhood:ETH/USDG', 'base')).toBe('ETH');
    expect(unitOf(null)).toBeNull();
  });
  it('metrics and the UI fall back to the symbol, not the key', () => {
    const tr = { id: 't', kind: 'trend', quote: 'robinhood:ETH/USDG', base: 'ETH', capital: 500, pnl: { realized: 12.75, equity: 515 }, startedAt: 1 };
    expect(trendMetrics(tr, 2).quote.symbol).toBe('USDG');
    expect(Object.keys(trendMetrics(tr, 2).generated ?? {})).toEqual(['USDG']);
    const gr = { id: 'g', kind: 'grid', stable: 'robinhood:SCHIFFY/WETH', base: 'SCHIFFY', capital: 1, pnl: { realized: 0.1 }, stats: { generated: 0.1 }, startedAt: 1 };
    expect(gridMetrics(gr, 2).quote.symbol).toBe('WETH');
    // an LP status without symbols reads them from its (flipped) market key
    expect(Object.keys(lpGenerated({ id: 'l', kind: 'lp', market: 'ethereum:ETH/USDC~', price: 0.0004, usdPerQuote: 2341 }).px)).toEqual(['USDC', 'ETH']);
    expect(lpMetrics({ id: 'l', kind: 'lp', market: 'ethereum:ETH/USDC~', startedAt: 1 }, 2).quote.symbol).toBe('ETH');
    expect(quoteSym({ quote: 'robinhood:ETH/USDG' })).toBe('USDG');
    expect(quoteSym({ stable: 'HEX~' })).toBe('PLS');
    expect(quoteSym({ quoteSym: 'USDG', quote: 'robinhood:ETH/USDG' })).toBe('USDG');
  });
});
