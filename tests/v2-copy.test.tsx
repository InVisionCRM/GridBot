import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTape } from '../src/v2/activity-tape';
import { BotView } from '../src/v2/bot-view';
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
});
