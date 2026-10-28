import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { adaptStatus } from '../src/v2/adapt-status';
import { BotView } from '../src/v2/bot-view';
import { repeatedFigures } from '../src/v2/figures';
import { HomeView, Ticker } from '../src/v2/home-view';
import { ActivityTape } from '../src/v2/activity-tape';
import { loadDesk } from '../src/v2/load-owner';
import type { BotDesk, DeskSnapshot } from '../src/v2/metrics';

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function renderAt(node: ReactElement, width: number): string {
  void width;
  return textOf(renderToStaticMarkup(node));
}

function screen(node: ReactElement, width: number, label: string) {
  const text = renderAt(node, width);
  const repeats = repeatedFigures(text);
  expect(repeats, `${label} @ ${width}: ${repeats.join(', ')}`).toEqual([]);
  return text;
}

function home(desk: DeskSnapshot, width: number) {
  return (
    <>
      <Ticker prices={desk.prices} />
      <HomeView portfolio={desk.portfolio} bots={desk.bots} prices={desk.prices} onOpen={() => {}} />
      {width >= 1280 && <ActivityTape items={desk.activity} />}
    </>
  );
}

function bot(desk: DeskSnapshot, row: BotDesk, width: number, breakdown: boolean | 'projected' = false) {
  const mine = desk.activity.filter((a) => a.botId === row.metrics.botId);
  return (
    <>
      <Ticker prices={desk.prices} />
      <BotView
        bot={row}
        activity={mine}
        prices={desk.prices}
        onBack={() => {}}
        onActivity={() => {}}
        breakdown={breakdown}
        showFeed={width < 1280}
      />
      {width >= 1280 && <ActivityTape items={mine} />}
    </>
  );
}

describe('no money or token figure is repeated on a screen', () => {
  const desk = loadDesk();
  const widths = [390, 1440];

  it('renders Home, Bot, Activity, and Breakdown at desktop and iPhone widths', () => {
    for (const width of widths) {
      screen(home(desk, width), width, 'Home');
      screen(
        <>
          <Ticker prices={desk.prices} />
          <ActivityTape items={desk.activity} full />
        </>,
        width,
        'Activity',
      );
      for (const row of desk.bots) {
        screen(bot(desk, row, width), width, `Bot ${row.pair} ${row.metrics.mode}`);
        screen(bot(desk, row, width, true), width, `Breakdown ${row.pair} ${row.metrics.mode}`);
        screen(bot(desk, row, width, 'projected'), width, `Breakdown projected ${row.pair} ${row.metrics.mode}`);
      }
    }
  });

  it('a single live contributor does not restate the hero', () => {
    const now = 1_700_000_000_000;
    const one = adaptStatus({
      spotsAt: now,
      grids: [
        {
          id: 'only', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
          usdPerQuote: 1, price: 2, startedAt: now - 2 * 86_400_000,
          config: { totalCapitalUsd: 100, lowerPrice: 1, upperPrice: 3 },
          pnl: { realized: 63.24, unrealized: 0, gasUsd: 0 },
          stats: { roundTrips: 2, totalFees: 0 },
        },
        {
          id: 'quiet', mode: 'live', status: 'running', label: 'BBB/USDC', base: 'BBB', quoteSym: 'USDC',
          usdPerQuote: 1, price: 3, startedAt: now - 86_400_000,
          config: { totalCapitalUsd: 10, lowerPrice: 1, upperPrice: 4 },
          pnl: { realized: 0, unrealized: 0, gasUsd: 0 },
          stats: { roundTrips: 0, totalFees: 0 },
        },
      ],
    }, [], now);
    for (const width of widths) {
      const text = screen(home(one, width), width, 'one contributor');
      expect(text).toContain('All of the live total');
      expect(text.match(/\+63\.24 USDC/g)).toHaveLength(1);
      expect(text).not.toContain('Paper $');
    }
  });
});
