import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTape } from '../src/v2/activity-tape';
import { BotView } from '../src/v2/bot-view';
import { adaptStatus } from '../src/v2/adapt-status';
import { figureAtoms, ledgerLines, normFigure, placesForBot, sheetRows } from '../src/v2/figures';
import { formatRangePx, formatTokenLine } from '../src/v2/format';
import { sanitizedActivity, sanitizedStatus } from '../src/v2/sanitized-fixture';
import type { BotMetrics } from '../src/v2/metrics';
import { HoldingsView } from '../src/v2/holdings-view';
import { HomeView, Ticker } from '../src/v2/home-view';
import { loadDesk } from '../src/v2/load-owner';
import type { TokenQty } from '../src/v2/metrics';

const BANNED = /\$|\bAPR\b|\bAPY\b|Unrealized|Realized|Value change|≈/;

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('v2 copy stays in token units', () => {
  const desk = loadDesk();

  it('does not render dollars, APR, or the old P&L labels', () => {
    const chunks = [
      renderToStaticMarkup(<><Ticker prices={desk.prices} /><HomeView portfolio={desk.portfolio} bots={desk.bots} prices={desk.prices} onOpen={() => {}} /></>),
      renderToStaticMarkup(<><Ticker prices={desk.prices} /><ActivityTape items={desk.activity} full /></>),
      renderToStaticMarkup(<HoldingsView rows={desk.holdings} />),
    ];
    for (const row of desk.bots) {
      chunks.push(renderToStaticMarkup(
        <BotView bot={row} activity={desk.activity.filter((a) => a.botId === row.metrics.botId)} prices={desk.prices} onBack={() => {}} onActivity={() => {}} breakdown />,
      ));
    }
    for (const html of chunks) {
      const text = textOf(html);
      expect(text).not.toMatch(BANNED);
      expect(text).not.toContain('Projected');
    }
  });

  it('shows breakdown parts that sum to the Generated row for each coin', () => {
    const coins = (line: string) => {
      const map = new Map<string, number>();
      const re = /([+\u2212-])?\s*(\d[\d,]*(?:\.\d+)?)\s+([A-Z][A-Z0-9]*)/g;
      for (const match of line.matchAll(re)) {
        const sign = match[1] === '−' || match[1] === '-' ? -1 : 1;
        const amount = sign * Number(match[2].replace(/,/g, ''));
        map.set(match[3], (map.get(match[3]) ?? 0) + amount);
      }
      return map;
    };
    for (const bot of desk.bots) {
      if (!bot.metrics.grossFees.length) continue;
      const [base, quote] = bot.pair.split('/');
      const rows = sheetRows(bot.metrics, { base: base || bot.base, quote: quote || bot.quote });
      const earned = rows.find((r) => r.label.endsWith(' fees earned'));
      const fee = earned?.value ?? '';
      const paid = rows.find((r) => r.label === 'Gas + swap fees')?.value ?? '';
      const move = rows.find((r) => r.label === 'Range-move loss')?.value ?? '';
      const generated = rows.find((r) => r.label === 'Generated')?.value ?? '';
      const note = rows.find((r) => r.label === 'Note')?.value ?? '';
      expect(generated, bot.pair).toBe(ledgerLines(bot.metrics)?.generated);
      if (paid) expect(paid, bot.pair).toMatch(/−/);
      if (move) expect(move, bot.pair).toMatch(/−/);
      const costSymbols = new Set([...coins(paid).keys(), ...coins(move).keys()]);
      if (costSymbols.size) expect(earned?.label, bot.pair).toMatch(/fees earned$/);
      for (const symbol of coins(fee).keys()) expect(costSymbols.has(symbol), `${bot.pair} ${symbol}`).toBe(true);
      const raw = (tokens: { symbol: string; amount: number }[], symbol: string) => tokens.find((t) => t.symbol === symbol)?.amount ?? 0;
      for (const symbol of costSymbols) {
        const grossRaw = raw(bot.metrics.grossFees, symbol);
        const paidRaw = raw(bot.metrics.feesPaid, symbol);
        const moveRaw = raw(bot.metrics.moveLoss, symbol);
        const madeRaw = raw(bot.metrics.generated, symbol);
        expect(grossRaw - Math.abs(paidRaw) - Math.abs(moveRaw), `${bot.pair} ${symbol} raw`).toBeCloseTo(madeRaw, 8);
        const parts = (coins(fee).get(symbol) ?? 0) + (coins(paid).get(symbol) ?? 0) + (coins(move).get(symbol) ?? 0);
        expect(parts, `${bot.pair} ${symbol}`).toBeCloseTo(coins(generated).get(symbol) ?? 0, 8);
      }
      const free = [...coins(generated).keys()].filter((symbol) => !costSymbols.has(symbol));
      if (free.length) expect(note, bot.pair).toContain('no costs taken out');
      for (const symbol of free) {
        expect(fee, bot.pair).not.toContain(symbol);
        expect(note, bot.pair).toContain(symbol);
      }
    }
  });

  it('renders the same generated figure on Home and the bot page', () => {
    const homeHtml = renderToStaticMarkup(
      <HomeView portfolio={desk.portfolio} bots={desk.bots} prices={desk.prices} onOpen={() => {}} />,
    ).replace(/<details class="card-details"[\s\S]*?<\/details>/g, ' ');
    const homeText = textOf(homeHtml);
    const homeAtoms = new Set(figureAtoms(homeText).map(normFigure));
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    const pools = [
      { mode: 'live' as const, tokens: desk.portfolio.tokens, pace: desk.portfolio.generatedPerDay },
      { mode: 'paper' as const, tokens: desk.portfolio.paperTokens, pace: null as TokenQty[] | null },
    ];
    for (const bot of desk.bots) {
      const botHtml = renderToStaticMarkup(
        <BotView bot={bot} activity={[]} prices={[]} onBack={() => {}} onActivity={() => {}} showFeed={false} breakdown />,
      );
      const botHero = textOf(botHtml.split('data-open="breakdown"')[0]);
      const botAtoms = new Set(figureAtoms(botHero).map(normFigure));
      const line = ledgerLines(bot.metrics)?.generated || formatTokenLine(bot.metrics.generated);
      if (line && line !== '—') expect(botHero, bot.pair).toContain(line);
      const pool = pools.find((p) => p.mode === bot.metrics.mode);
      const check = (botTokens: TokenQty[] | null | undefined, homeTokens: TokenQty[] | null | undefined) => {
        if (!botTokens?.length || !homeTokens?.length || !pool) return;
        for (const token of botTokens) {
          const homeToken = homeTokens.find((t) => t.symbol === token.symbol);
          if (!homeToken || !same(homeToken.amount, token.amount)) continue;
          const atom = figureAtoms(formatTokenLine([token], placesForBot(bot.metrics)))[0];
          if (!atom) continue;
          const key = normFigure(atom);
          expect(botAtoms.has(key), `${bot.pair} ${bot.metrics.mode} bot ${atom}`).toBe(true);
          expect(homeAtoms.has(key), `${bot.pair} ${bot.metrics.mode} home ${atom}`).toBe(true);
        }
      };
      check(bot.metrics.generated, pool?.tokens);
      check(bot.metrics.est.d1, pool?.pace);
      const [base, quote] = bot.pair.split('/');
      const rows = sheetRows(bot.metrics, { base: base || bot.base, quote: quote || bot.quote });
      for (const label of ['Est. 7d', 'Est. 365d'] as const) {
        const got = rows.find((r) => r.label === label)?.value;
        const tokens = label === 'Est. 7d' ? bot.metrics.est.d7 : bot.metrics.est.d365;
        if (!got || !tokens?.length) continue;
        expect(got, `${bot.pair} ${bot.metrics.mode} ${label}`).toBe(formatTokenLine(tokens, placesForBot(bot.metrics)));
      }
    }
  });

  it('shows a visible sum for every built-in LP and grid, including rounding edges', () => {
    const coins = (line: string) => {
      const map = new Map<string, number>();
      const re = /([+\u2212-])?\s*(\d[\d,]*(?:\.\d+)?)\s+([A-Z][A-Z0-9]*)/g;
      for (const match of line.matchAll(re)) {
        const sign = match[1] === '−' || match[1] === '-' ? -1 : 1;
        map.set(match[3], (map.get(match[3]) ?? 0) + sign * Number(match[2].replace(/,/g, '')));
      }
      return map;
    };
    const check = (metrics: BotMetrics, label: string) => {
      const rows = sheetRows(metrics, { base: 'ETH', quote: 'USDC' });
      const parts = [
        rows.find((r) => r.label === 'Trade profit before gas' || r.label.endsWith(' fees earned'))?.value ?? '',
        rows.find((r) => r.label === 'Gas + swap fees')?.value ?? '',
        rows.find((r) => r.label === 'Range-move loss')?.value ?? '',
      ];
      const generated = rows.find((r) => r.label === 'Generated')?.value ?? '';
      expect(generated, label).not.toBe('');
      const made = coins(generated);
      const sum = new Map<string, number>();
      for (const line of parts) {
        for (const [symbol, amount] of coins(line)) sum.set(symbol, (sum.get(symbol) ?? 0) + amount);
      }
      for (const [symbol, amount] of made) {
        if (!sum.has(symbol)) continue;
        expect(sum.get(symbol), `${label} ${symbol}`).toBeCloseTo(amount, 8);
      }
    };
    const sample = adaptStatus(sanitizedStatus, sanitizedActivity, sanitizedStatus.spotsAt, 'fixture');
    for (const bot of sample.bots) {
      if (bot.metrics.kind !== 'lp' && bot.metrics.kind !== 'grid') continue;
      if (!bot.metrics.generated.length) continue;
      check(bot.metrics, bot.metrics.botId);
    }
    const gross = 0.02683694099017285;
    const paid = 0.0026334039034537535;
    const move = 0.022472881717407633;
    const edge = ledgerLines({
      kind: 'lp',
      grossFees: [{ symbol: 'ETH', amount: gross, usd: null }],
      feesPaid: [{ symbol: 'ETH', amount: paid, usd: null }],
      moveLoss: [{ symbol: 'ETH', amount: move, usd: null }],
      generated: [{ symbol: 'ETH', amount: gross - paid - move, usd: null }],
    } as BotMetrics);
    expect(edge?.gross).toContain('0.026837');
    expect(edge?.paid).toContain('0.002633');
    expect(edge?.move).toContain('0.022473');
    expect(edge?.generated).toContain('0.001731');
    check({
      kind: 'lp',
      grossFees: [{ symbol: 'ETH', amount: gross, usd: null }],
      feesPaid: [{ symbol: 'ETH', amount: paid, usd: null }],
      moveLoss: [{ symbol: 'ETH', amount: move, usd: null }],
      generated: [{ symbol: 'ETH', amount: gross - paid - move, usd: null }],
    } as BotMetrics, 'live ETH edge');
    const quoteGross = 0.027928200555731086;
    const quotePaid = 0.000004965597670816732;
    const quoteMove = 0.012612938837774562;
    check({
      kind: 'lp',
      grossFees: [{ symbol: 'ETH', amount: quoteGross, usd: null }],
      feesPaid: [{ symbol: 'ETH', amount: quotePaid, usd: null }],
      moveLoss: [{ symbol: 'ETH', amount: quoteMove, usd: null }],
      generated: [{ symbol: 'ETH', amount: quoteGross - quotePaid - quoteMove, usd: null }],
    } as BotMetrics, 'paper ETH edge');
    expect(formatRangePx(2213.3, 2446.3, 'USDC', 'ETH')).toBe('2,213.30 – 2,446.30 USDC per ETH');
    expect(formatRangePx(2307.72, 2356.69, 'USDC', 'ETH')).toBe('2,307.72 – 2,356.69 USDC per ETH');
  });
});
