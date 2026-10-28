import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { adaptStatus } from '../src/v2/adapt-status';
import { BotView } from '../src/v2/bot-view';
import { repeatedFigures } from '../src/v2/figures';
import { deskStatusPill, formatClockEt, formatQuotePx, formatUnitPx } from '../src/v2/format';
import { HomeView, Ticker } from '../src/v2/home-view';
import { ActivityTape } from '../src/v2/activity-tape';
import { loadDesk } from '../src/v2/load-owner';
import { createSnapshotDesk } from '../src/v2/snapshot-desk';
import { applyDelta } from '../src/v2/use-desk';
import type { BotDesk, DeskSnapshot } from '../src/v2/metrics';

function textOf(html: string): string {
  const kept = html
    .replace(/<([a-z0-9]+)\b[^>]*\bdata-est\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<([a-z0-9]+)\b[^>]*\bdata-ledger\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return kept
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

function pillText(desk: DeskSnapshot): string {
  return deskStatusPill(desk.source, desk.portfolio.asOf, false).text;
}

function frame(desk: DeskSnapshot, node: ReactElement) {
  return (
    <>
      <span className="live-chip">{pillText(desk)}</span>
      {node}
    </>
  );
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
    const keys = desk.prices.map((p) => `${p.symbol}|${p.chain}|${p.fee ?? ''}`);
    expect(new Set(keys).size, 'one tape row per pair, chain, and pool').toBe(keys.length);
    const pill = pillText(desk);
    expect(pill).toBe(`Snapshot · ${formatClockEt(desk.portfolio.asOf)}`);
    for (const width of widths) {
      const homeText = screen(frame(desk, home(desk, width)), width, 'Home');
      expect(homeText.split(pill).length - 1, `pill @ ${width}`).toBe(1);
      for (const p of desk.prices) {
        expect(homeText, `ticker ${p.symbol} ${p.fee ?? ''} @ ${width}`).toContain(formatQuotePx(p.price, p.symbol.split('/')[1] || ''));
        if (p.fee) expect(homeText).toContain(p.fee);
      }
      const activityText = screen(
        frame(desk, (
          <>
            <Ticker prices={desk.prices} />
            <ActivityTape items={desk.activity} full />
          </>
        )),
        width,
        'Activity',
      );
      expect(activityText.split(pill).length - 1).toBe(1);
      for (const p of desk.prices) expect(activityText).toContain(formatQuotePx(p.price, p.symbol.split('/')[1] || ''));
      for (const row of desk.bots) {
        const botText = screen(frame(desk, bot(desk, row, width)), width, `Bot ${row.pair} ${row.metrics.mode}`);
        expect(botText.split(pill).length - 1).toBe(1);
        for (const p of desk.prices) expect(botText, `ticker on ${row.pair}`).toContain(formatQuotePx(p.price, p.symbol.split('/')[1] || ''));
        const sheet = screen(frame(desk, bot(desk, row, width, true)), width, `Breakdown ${row.pair} ${row.metrics.mode}`);
        expect(sheet.split(pill).length - 1).toBe(1);
        const projected = screen(frame(desk, bot(desk, row, width, 'projected')), width, `Breakdown projected ${row.pair} ${row.metrics.mode}`);
        expect(projected.split(pill).length - 1).toBe(1);
      }
    }
  });

  it('a heartbeat does not change the pill on Home or the bot page', () => {
    const later = desk.portfolio.asOf + 3 * 60 * 60 * 1000;
    const beat = createSnapshotDesk(desk).tick();
    expect(beat.asOf).toBe(desk.portfolio.asOf);
    const next = applyDelta(desk, { ...beat, asOf: later, portfolio: { ...desk.portfolio, asOf: later } });
    expect(pillText(next)).toBe(pillText(desk));
    const row = next.bots[0];
    for (const width of widths) {
      const homeText = screen(frame(next, home(next, width)), width, 'heartbeat home');
      const botText = screen(frame(next, bot(next, row, width)), width, 'heartbeat bot');
      expect(homeText).toContain(pillText(desk));
      expect(botText).toContain(pillText(desk));
      expect(homeText).not.toContain(formatClockEt(later));
      expect(botText).not.toContain(formatClockEt(later));
    }
  });

  it('an in-range bot shows its range around the displayed price', () => {
    for (const row of desk.bots) {
      const range = row.metrics.range;
      if (!range?.inRange) continue;
      expect(range.lower, row.pair).toBeLessThanOrEqual(range.current);
      expect(range.current, row.pair).toBeLessThanOrEqual(range.upper);
      const text = screen(bot(desk, row, 390, true), 390, `range ${row.pair}`);
      expect(text).toContain(formatUnitPx(range.lower));
      expect(text).toContain(formatUnitPx(range.upper));
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
