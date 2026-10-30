/**
 * Units are coin symbols, never market keys: renders every main screen (Home, the Bots page and its desk, Analytics,
 * the token trader, and every trend, grid and LP page) from the real sanitized status payload plus a trend bot
 * (tests/helpers/unitsScreens.ts; its trend has no quoteSym, the shape of a bot whose market isn't loaded), and fails
 * if any text, tooltip or aria-label reads like 'robinhood:ETH/USDG' or contains 'chain:'.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  const { createElement: h } = await import('react');
  return { ...m, AnimatedNumber: ({ value, format }: { value: number | null | undefined; format: (x: number) => string }) => h('span', { className: 'num' }, value == null ? '—' : format(value)), useCount: (v: number | null) => v };
});
import { ShowUsdCtx } from '../src/ui/money';
import { EthUsdCtx, ethUsdOf, holdingsByToken, inEth } from '../src/ui/units';
import { Desk } from '../src/ui/Desk';
import { Header } from '../src/ui/Header';
import { Bots } from '../src/ui/Bots';
import { Holdings } from '../src/ui/Holdings';
import { MarketsTab, ModeAnalytics } from '../src/ui/Analytics';
import { TokenTraderPanel } from '../src/ui/TokenTrader';
import { LpDetail } from '../src/ui/LpDetail';
import { GridDetail } from '../src/ui/GridDetail';
import { TrendDetail } from '../src/ui/TrendDetail';
import { Alerts, DEFAULT_PREFS } from '../src/ui/Alerts';
import { HOLDINGS, JOURNAL, overview, PANELS, S, TRADER, TREND_ID } from './helpers/unitsScreens';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const noop = () => {};
const act = () => {};
const ETH = ethUsdOf(S, HOLDINGS);

const render = (el: ReactElement, ethUsd: number | null = ETH) => renderToStaticMarkup(
  createElement(ShowUsdCtx.Provider, { value: { on: true, set: noop } }, createElement(EthUsdCtx.Provider, { value: ethUsd }, el)),
);

/** Text, titles and aria-labels of the markup (what a user can read or hover). */
function readable(html: string): string {
  const attrs = [...html.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)].map((m) => m[1]);
  const text = html.replace(/<[^>]+>/g, ' ');
  return [text, ...attrs].join(' \n ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}
/** A market key as a unit: 'robinhood:ETH/USDG', 'pulsechain:PLS/DAI#9mm', or the word 'chain:' itself. */
const KEY = /\b[a-z]+:[A-Za-z0-9]+\/[A-Za-z0-9]+|chain:/;
function keysIn(html: string): string[] {
  return readable(html).split(/\n| {2,}/).filter((x) => KEY.test(x)).map((x) => x.trim()).slice(0, 8);
}

const screens: [string, () => string][] = [
  ['Home (wallet)', () => render(createElement(Desk, { s: S, nav: noop, act, busy: false, holdings: HOLDINGS as never, events: [] }))],
  ['Home (no wallet: bots only)', () => render(createElement(Desk, { s: { ...S, hasSigner: false }, nav: noop, act, busy: false, holdings: { hasSigner: false } as never, events: [] }))],
  ['Header', () => render(createElement(Header, { s: S, view: { v: 'home' }, nav: noop, chain: 'all', setChain: noop, connected: true, ver: null, holdings: HOLDINGS as never, onActivity: noop, onGuide: noop }))],
  ['Bots', () => render(createElement(Bots, { s: S, nav: noop, busy: false, onStopAll: noop }))],
  ['Holdings', () => render(createElement(Holdings, { s: S, snap: HOLDINGS as never, loading: false, error: null, reload: noop, nav: noop }))],
  ['Analytics live', () => render(createElement(ModeAnalytics, { s: S, mode: 'live', seed: { ov: overview('live'), j: JOURNAL } }))],
  ['Analytics paper', () => render(createElement(ModeAnalytics, { s: S, mode: 'paper', seed: { ov: overview('paper'), j: JOURNAL } }))],
  ['Analytics market conditions', () => render(createElement(MarketsTab, { seed: PANELS }))],
  ['Token trader', () => render(createElement(TokenTraderPanel, { s: S, seed: TRADER }))],
  ['Token trader (old dollar-only log)', () => render(createElement(TokenTraderPanel, { s: S, seed: { ...TRADER, metrics: { ...TRADER.metrics, generated: { USD: 10.23 }, quote: { ...TRADER.metrics.quote, symbol: 'USD' } }, spendTotals: null } }))],
  ['Alerts (notification settings)', () => render(createElement(Alerts, { status: S, prefs: { ...DEFAULT_PREFS, enabled: true }, setPrefs: noop }))],
  ['Trend', () => render(createElement(TrendDetail, { s: S, id: TREND_ID, events: [], ticks: null, nav: noop, act, busy: false }))],
  ...S.lps.map((l: Obj) => [`LP ${l.id}`, () => render(createElement(LpDetail, { s: S, id: l.id, events: [], ticks: null, nav: noop, act, busy: false }))] as [string, () => string]),
  ...S.grids.map((g: Obj) => [`Grid ${g.id}`, () => render(createElement(GridDetail, { s: S, id: g.id, events: [], ticks: null, nav: noop, act, busy: false }))] as [string, () => string]),
];

describe('no market key shown as a unit on any screen', () => {
  for (const [name, html] of screens) {
    it(name, () => {
      const out = html();
      expect(out.length).toBeGreaterThan(200);
      expect(keysIn(out)).toEqual([]);
    });
  }
  it('the fixture has a trend bot quoted by a market key, and its page reads USDG', () => {
    const t = S.trends.find((x: Obj) => x.id === TREND_ID);
    expect(t.quote).toBe('robinhood:ETH/USDG');
    expect(t.quoteSym).toBeUndefined();
    expect(readable(render(createElement(TrendDetail, { s: S, id: TREND_ID, events: [], ticks: null, nav: noop, act, busy: false })))).toMatch(/USDG/);
  });
});
