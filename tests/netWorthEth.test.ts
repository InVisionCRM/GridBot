/**
 * The ETH price the screens use: the wallet snapshot's ETH row, else /api/bot/status chains[].nativeUsd (Ethereum
 * first, then any ETH-native chain); none → null. And TrendDetail shows no dollar figure beside Generated.
 * (Net worth now lives in the home's Wallet & funds drawer: dollars with the coins under them, Kyle 2026-10-30.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/motion', async (orig) => {
  const m = await orig<typeof import('../src/ui/motion')>();
  return { ...m, useCount: (v: number | null) => v };
});
import { ShowUsdCtx } from '../src/ui/money';
import { EthUsdCtx, ethUsdOf, holdingsByToken } from '../src/ui/units';
import { gridMetrics, lpMetrics } from '../src/metrics/botMetrics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const RAW = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj;
const S: Obj = {
  ...RAW,
  grids: RAW.grids.map((g: Obj) => ({ ...g, metrics: gridMetrics({ ...g, kind: 'grid' }, g.metrics.asOf) })),
  lps: RAW.lps.map((l: Obj) => ({ ...l, metrics: lpMetrics(l, l.metrics.asOf) })),
};
const coin = (chainId: number, symbol: string, amount: number, usdEach: number) => ({ chainId, address: null, symbol, decimals: 18, amount, usdEach, usd: amount * usdEach });
const wallet = [
  { coin: coin(4663, 'ETH', 1.25, 2341.179), dust: false, bots: [] },
  { coin: coin(4663, 'USDG', 840.5, 1), dust: false, bots: [] },
  { coin: coin(1, 'WETH', 0.4, 2341.0064), dust: false, bots: [] },
];
const net = wallet.reduce((a, w) => a + w.coin.usd, 0);
const HOLD: Obj = { hasSigner: true, at: 0, netWorthUsd: net, netWorthExDustUsd: net, walletUsd: net, wallet, positions: [], fees: [], bots: [], chains: [] };
const noop = () => {};
const render = (el: ReactElement, eth: number | null, usd = true) => renderToStaticMarkup(
  createElement(ShowUsdCtx.Provider, { value: { on: usd, set: noop } }, createElement(EthUsdCtx.Provider, { value: eth }, el)),
);
const home = (eth: number | null) => render(createElement(Home, { s: S, nav: noop, holdings: HOLD as never, act: noop }), eth);
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const hero = (html: string) => /<section class="card hero-card"[\s\S]*?<\/section>/.exec(html)![0];

describe('ETH price source', () => {
  it('the wallet snapshot\'s ETH row, else the status chains\' native price; none → null', () => {
    expect(ethUsdOf(S, HOLD as never)).toBe(2341.179);
    expect(ethUsdOf(S, null)).toBeCloseTo(2341.0064, 4);
    expect(ethUsdOf({ chains: [{ id: 369, nativeSymbol: 'PLS', nativeUsd: 0.00001 }] }, null)).toBeNull();
    expect(holdingsByToken(HOLD as never).map((t) => t.sym)).toEqual(['ETH', 'USDG']);
  });
});

describe('TrendDetail: no dollar figure beside Generated', () => {
  it('the ≈ generatedUsd line is gone', () => {
    const src = readFileSync(new URL('../src/ui/TrendDetail.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/generatedUsd/);
  });
});
