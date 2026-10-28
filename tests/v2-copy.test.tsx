import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTape } from '../src/v2/activity-tape';
import { BotView } from '../src/v2/bot-view';
import { ledgerLines, sheetRows } from '../src/v2/figures';
import { HoldingsView } from '../src/v2/holdings-view';
import { HomeView, Ticker } from '../src/v2/home-view';
import { loadDesk } from '../src/v2/load-owner';

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
      const gross = rows.find((r) => r.label === 'Gross fees')?.value ?? '';
      const paid = rows.find((r) => r.label === 'Gas + swap fees')?.value ?? '';
      const move = rows.find((r) => r.label === 'Range-move loss')?.value ?? '';
      const generated = rows.find((r) => r.label === 'Generated')?.value ?? '';
      expect(generated, bot.pair).toBe(ledgerLines(bot.metrics)?.generated);
      if (paid) expect(paid, bot.pair).toMatch(/−/);
      if (move) expect(move, bot.pair).toMatch(/−/);
      const sum = new Map<string, number>();
      for (const part of [coins(gross), coins(paid), coins(move)]) {
        for (const [symbol, amount] of part) sum.set(symbol, (sum.get(symbol) ?? 0) + amount);
      }
      const made = coins(generated);
      const symbols = new Set([...sum.keys(), ...made.keys()]);
      for (const symbol of symbols) {
        expect(sum.get(symbol) ?? 0, `${bot.pair} ${symbol}`).toBeCloseTo(made.get(symbol) ?? 0, 8);
      }
    }
  });
});
