/**
 * Home's Net worth card is the live wallet. Its change chip and chart come from live bots' equity only: a paper bot's
 * paper loss is not a change in what the wallet is worth. With no priced net worth there is no chip at all, since a
 * change in an unknown total means nothing.
 */
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  return { ...m, useCount: (v: number | null) => v };
});
import { ShowUsdCtx } from '../src/ui/money';
import { EthUsdCtx } from '../src/ui/units';
import { Home } from '../src/ui/Home';
import { gridMetrics, lpMetrics } from '../src/metrics/botMetrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const RAW = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const now = Date.now();
// every bot paper, each with an hour of equity history that lost 10 of its quote coin (quote priced at $1)
const paperDrop = (b: Obj) => ({ ...b, mode: 'paper', usdPerQuote: 1, equityHist: [[now - 3_600_000, 1000], [now - 1_800_000, 995], [now, 990]] });
const S: Obj = {
  ...RAW,
  grids: RAW.grids.map((g: Obj) => paperDrop({ ...g, metrics: gridMetrics({ ...g, kind: 'grid' }, g.metrics.asOf) })),
  lps: RAW.lps.map((l: Obj) => paperDrop({ ...l, metrics: lpMetrics(l, l.metrics.asOf) })),
  trends: [],
};
const ETH_USD = 2000;
const coin = (chainId: number, symbol: string, amount: number, usdEach: number) => ({ chainId, address: null, symbol, decimals: 18, amount, usdEach, usd: amount * usdEach });
const wallet = [{ coin: coin(1, 'ETH', 2, ETH_USD), dust: false, bots: [] }];
const PRICED: Obj = { hasSigner: true, at: 0, netWorthUsd: 2 * ETH_USD, netWorthExDustUsd: 2 * ETH_USD, walletUsd: 2 * ETH_USD, wallet, positions: [], fees: [], bots: [], chains: [] };
const UNPRICED: Obj = { ...PRICED, netWorthUsd: null, netWorthExDustUsd: null, walletUsd: 0, wallet: [] };
const noop = () => {};
const render = (el: ReactElement) => renderToStaticMarkup(
  createElement(ShowUsdCtx.Provider, { value: { on: false, set: noop } }, createElement(EthUsdCtx.Provider, { value: ETH_USD }, el)),
);
const hero = (holdings: Obj) => /<section class="card hero-card"[\s\S]*?<\/section>/.exec(render(createElement(Home, { s: S, nav: noop, holdings: holdings as never, act: noop })))![0];
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('Home net worth chip is live only', () => {
  it('paper bots losing paper money do not move the chip under a live wallet', () => {
    const h = hero(PRICED);
    expect(text(h)).toContain('2 ETH');
    expect(h).toMatch(/class="chip/);
    expect(text(h)).not.toMatch(/−[\d.]+ ETH/);
  });
  it('no priced net worth: a dash and no chip', () => {
    const h = hero(UNPRICED);
    expect(text(h)).toContain('Net worth—');
    expect(h).not.toMatch(/class="chip/);
  });
});
