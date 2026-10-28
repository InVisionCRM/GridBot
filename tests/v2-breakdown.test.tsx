import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { adaptStatus } from '../src/v2/adapt-status';
import { sheetRows } from '../src/v2/figures';
import { formatTokenLine } from '../src/v2/format';
import { lpMetrics } from '../src/metrics/botMetrics';
import { HomeView } from '../src/v2/home-view';

type Obj = Record<string, unknown>;
const DAY = 86_400_000;

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('breakdown rows come from botMetrics', () => {
  it('renders the live LP ETH parts so they add up to Generated', () => {
    const status = JSON.parse(readFileSync(new URL('./fixtures/real-status-2026-10-27.json', import.meta.url), 'utf8')) as Obj & { lps: Obj[]; spotsAt?: number };
    const lp = status.lps.find((row) => row.id === 'lp-mvnm73sx-hghe');
    const asOf = (status.grids as Obj[])[0] && ((status.grids as Obj[])[0].metrics as Obj)?.asOf;
    const now = typeof asOf === 'number' ? asOf : Date.parse('2026-10-27T21:00:00Z');
    const server = lpMetrics(lp, now);
    const desk = adaptStatus({ spotsAt: now, lps: [lp] }, [], now);
    const bot = desk.bots[0];
    expect(bot.metrics.generated.map((t) => [t.symbol, t.amount])).toEqual(
      Object.entries(server.generated ?? {}).filter(([, n]) => Number.isFinite(n)),
    );
    const rows = sheetRows(bot.metrics, { base: 'ETH', quote: 'USDC' });
    const earned = rows.find((r) => r.label === 'ETH fees earned')?.value ?? '';
    const gas = rows.find((r) => r.label === 'Gas + swap fees')?.value ?? '';
    const move = rows.find((r) => r.label === 'Range-move loss')?.value ?? '';
    const generated = rows.find((r) => r.label === 'Generated')?.value ?? '';
    expect(earned).toContain('0.026837');
    expect(gas).toContain('−0.002633');
    expect(move).toContain('−0.022473');
    expect(generated).toContain('0.001731');
    expect(rows.some((r) => r.value === 'Breakdown coming soon')).toBe(false);
    expect(rows.some((r) => r.value === 'USDC has no costs taken out.')).toBe(true);
    const coins = (line: string) => {
      const map = new Map<string, number>();
      for (const match of line.matchAll(/([+\u2212-])?\s*(\d[\d,]*(?:\.\d+)?)\s+([A-Z][A-Z0-9]*)/g)) {
        const sign = match[1] === '−' || match[1] === '-' ? -1 : 1;
        map.set(match[3], (map.get(match[3]) ?? 0) + sign * Number(match[2].replace(/,/g, '')));
      }
      return map;
    };
    const eth = (coins(earned).get('ETH') ?? 0) + (coins(gas).get('ETH') ?? 0) + (coins(move).get('ETH') ?? 0);
    expect(eth).toBeCloseTo(coins(generated).get('ETH') ?? 0, 8);
  });

  it('shows 0 PLS and 0 DAI for grids with no fills, not a dash or a status', () => {
    const now = 1_700_000_000_000;
    const grid = (id: string, sym: string) => ({
      id, mode: 'live', status: 'running', label: `HEX/${sym}`, base: 'HEX', quoteSym: sym, stable: sym,
      usdPerQuote: 1, price: 1, startedAt: now - 3 * DAY,
      config: { totalCapitalUsd: 100, lowerPrice: 1, upperPrice: 2 },
      pnl: { realized: null, unrealized: 0 },
      stats: { roundTrips: 0, totalFees: 0 },
      trades: [], moveCount: 0,
    });
    const desk = adaptStatus({ spotsAt: now, grids: [grid('pls', 'PLS'), grid('dai', 'DAI')] }, [], now);
    for (const [id, sym] of [['pls', 'PLS'], ['dai', 'DAI']] as const) {
      const bot = desk.bots.find((b) => b.metrics.botId === id);
      expect(bot?.metrics.generated).toEqual([{ symbol: sym, amount: 0, usd: null }]);
      expect(formatTokenLine(bot?.metrics.generated)).toBe(`0 ${sym}`);
      expect(bot?.metrics.invested).toEqual([{ symbol: sym, amount: 100, usd: null }]);
      const html = renderToStaticMarkup(
        <HomeView portfolio={desk.portfolio} bots={desk.bots} prices={[]} onOpen={() => {}} />,
      );
      const chunk = html.split(`data-bot="${id}"`)[1] ?? '';
      const face = textOf(chunk.split('card-details')[0] ?? '');
      const full = textOf(chunk.split('data-bot=')[0] ?? chunk);
      expect(face).toContain(`0 ${sym}`);
      expect(face).not.toContain('In range');
      expect(face).not.toContain('Not calculated yet');
      expect(full).toContain('No earnings yet, so no estimate.');
      expect(full).not.toContain(`Est. 24H 0 ${sym}`);
      expect(full).not.toMatch(/\bUSD\b/);
    }
  });

  it('leaves an archived closed bot out of the live total so the listed card matches the hero', () => {
    const now = 1_700_000_000_000;
    const lp = (id: string, eth: number, archivedAt: number | null) => ({
      id, mode: 'live', status: archivedAt ? 'closed' : 'running', base: 'USDC', quote: 'ETH',
      usdPerQuote: 2000, price: 0.0005, startedAt: now - 3 * DAY, archivedAt,
      pnl: {
        feeCoins: { base: 63.24, quote: eth },
        fees: 1, gas: 0, swapCost: 0, moveLoss: 0, net: 1, price: 0, equity: 1,
      },
      totals: { gas: 0, swapCost: 0, moveLoss: 0 },
    });
    const desk = adaptStatus({
      spotsAt: now,
      lps: [lp('open', 0.001731, null), lp('archived', 5, now - DAY)],
    }, [], now);
    expect(desk.bots.map((b) => b.metrics.botId).sort()).toEqual(['archived', 'open']);
    const heroEth = desk.portfolio.tokens.find((t) => t.symbol === 'ETH')?.amount;
    const cardEth = desk.bots.find((b) => b.metrics.botId === 'open')?.metrics.generated.find((t) => t.symbol === 'ETH')?.amount;
    expect(heroEth).toBeCloseTo(0.001731, 8);
    expect(cardEth).toBeCloseTo(heroEth ?? NaN, 8);
    const html = textOf(renderToStaticMarkup(
      <HomeView portfolio={desk.portfolio} bots={desk.bots} prices={[]} onOpen={() => {}} />,
    ));
    expect(html).toContain('Closed · 1');
    expect(html).toContain('0.001731 ETH');
    expect(html).toContain('All live USDC + ETH');
    expect((html.match(/0\.001731 ETH/g) ?? []).length).toBe(1);
    const hero = html.split('LIVE')[0];
    expect(hero).toContain('0.001731 ETH');
    expect(hero).not.toMatch(/Generated\s+—/);
  });

  it('does not copy Generated into a null 7d estimate', () => {
    const now = 1_700_000_000_000;
    const closed = {
      id: 'stonk', mode: 'paper', status: 'closed', base: 'STONKD', quote: 'USDG',
      usdPerQuote: 1, price: 0.01, startedAt: now - 2 * 3_600_000,
      halt: { at: now - 60_000 },
      pnl: null, position: null,
      totals: { feeCoins: { base: 216_000, quote: -916.42 }, fees: 0, gas: 0, swapCost: 0, moveLoss: 0 },
    };
    const server = lpMetrics(closed, now);
    expect(server.generatedRate.d7).toBeNull();
    const desk = adaptStatus({ spotsAt: now, lps: [closed] }, [], now);
    const metrics = desk.bots[0].metrics;
    expect(metrics.est.d7).toBeNull();
    expect(metrics.est.d1).toBeNull();
    expect(metrics.est.d365).toBeNull();
    const generated = formatTokenLine(metrics.generated);
    expect(generated).toContain('STONKD');
    expect(generated).not.toBe('—');
    const rows = sheetRows(metrics, { base: 'STONKD', quote: 'USDG' });
    expect(rows.find((r) => r.label === 'Est. 7d')).toBeUndefined();
    expect(rows.find((r) => r.label === 'Generated')?.value).toBe(generated);
    expect(rows.some((r) => r.label.startsWith('Est.') && r.value === generated)).toBe(false);
  });
});
