/**
 * Crypto units only (Kyle's rule): no screen shows a dollar amount, except the home and the Wallet (Holdings), where
 * Kyle chose (2026-10-30) dollars with the coins under them: there every dollar figure sits beside its units (checked
 * below). Renders the header, the Bots page and its desk table, Analytics (live, paper, market conditions), the token trader,
 * and every LP, grid and trend page from the real sanitized status payload (tests/helpers/unitsScreens.ts), with the
 * old "$" switch forced ON, and fails on any "$" or "USD" in the text, a tooltip (title) or an aria-label. Coin names
 * like USDC / USDG are fine; "USD" as a word is not.
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
const DOLLAR = /\$|\bUSD\b|\bdollars?\b/i;
function dollarsIn(html: string): string[] {
  const t = readable(html);
  return t.split(/\n| {2,}/).filter((x) => DOLLAR.test(x)).map((x) => x.trim()).slice(0, 8);
}

const screens: [string, () => string][] = [
  ['Header', () => render(createElement(Header, { s: S, view: { v: 'home' }, nav: noop, chain: 'all', setChain: noop, connected: true, ver: null, holdings: HOLDINGS as never, onActivity: noop, onGuide: noop }))],
  ['Bots', () => render(createElement(Bots, { s: S, nav: noop, busy: false, onStopAll: noop }))],
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

describe('no dollar amounts on any screen (the "$" switch forced on)', () => {
  for (const [name, html] of screens) {
    it(name, () => {
      const out = html();
      expect(out.length).toBeGreaterThan(200); // it rendered something
      expect(dollarsIn(out)).toEqual([]);
    });
  }
});

describe('net worth in ETH', () => {
  it('ETH price: the wallet snapshot first, else the status payload (Ethereum, then any ETH-native chain)', () => {
    expect(ETH).toBe(2341.179); // the first ETH row of the snapshot (Robinhood Chain)
    expect(ethUsdOf(S, null)).toBeCloseTo(2341.0064, 4); // chains[] id 1
    expect(ethUsdOf({ chains: S.chains.filter((c: Obj) => c.id !== 1) }, null)).toBe(2341.179);
    expect(ethUsdOf({ chains: [{ id: 369, nativeSymbol: 'PLS', nativeUsd: 0.00001 }] }, null)).toBeNull();
  });
  it('the per-token list sums each coin across chains; no ETH price → a dash', () => {
    const tokens = holdingsByToken(HOLDINGS as never);
    expect(tokens.map((t) => t.sym)).toEqual(['ETH', 'USDG', 'PLS']); // ETH rows of both chains summed
    expect(tokens[0].amount).toBeCloseTo(1.65, 12);
    expect(inEth(100, null)).toBe('—');
  });
});

describe('token trader in the coins it spends', () => {
  it('Generated per spend coin from the new log fields; old dollar-only logs stay dollars inside', () => {
    expect(TRADER.metrics.generated).toEqual({ WETH: 0.00437 });
    expect(TRADER.metrics.quote.symbol).toBe('WETH');
    expect(TRADER.spendTotals.WETH.bought).toBeCloseTo(0.05126, 12);
    const html = render(createElement(TokenTraderPanel, { s: S, seed: TRADER }));
    expect(html).toMatch(/data-testid="tt-generated">\+0\.00437 WETH/);
  });
});

describe('the Wallet (Holdings): every dollar figure sits over its coins (Kyle 2026-10-30)', () => {
  it('each row\'s dollars have the row\'s coins right under them', () => {
    const html = render(createElement(Holdings, { s: S, snap: HOLDINGS as never, loading: false, error: null, reload: noop, nav: noop }));
    const vals = html.match(/<span class="wl-val"><b>[^<]*<\/b><small>[^<]*<\/small><\/span>/g) ?? [];
    expect(vals.length).toBe(HOLDINGS.wallet.length);
    for (const v of vals) expect(v).toMatch(/<b>\$[\d,.]+<\/b><small>[\d,.]+ [A-Z]/);
  });
});

describe('the home: every dollar figure sits beside its coins (Kyle 2026-10-30)', () => {
  const home = (hasSigner: boolean) => render(createElement(Desk, { s: { ...S, hasSigner }, nav: noop, act, busy: false, holdings: hasSigner ? HOLDINGS as never : { hasSigner: false } as never, events: [] }));
  for (const signer of [true, false]) {
    it(signer ? 'with a wallet' : 'paper only', () => {
      const html = home(signer);
      // the big figure has the coins line right under it
      const big = /data-testid="dk-big">([^<]*)</.exec(html)![1];
      const units = /data-testid="dk-units">([\s\S]*?)<\/div>/.exec(html)![1].replace(/<[^>]+>/g, ' ');
      if (big !== '—') expect(units).toMatch(/[\d.,]+ [A-Z]/);
      // each card that shows dollars shows its coins too
      for (const card of html.match(/<button type="button" class="dk-cardi[\s\S]*?<\/button>/g) ?? []) {
        const cu = /class="dk-cu">([^<]*)</.exec(card)?.[1] ?? '';
        const cv = /class="dk-cv[^"]*">([^<]*)</.exec(card)?.[1] ?? '';
        if (cu) expect(cv).toMatch(/[\d.,]+ [A-Z]/);
      }
    });
  }
});

