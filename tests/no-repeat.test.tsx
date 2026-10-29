import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { adaptStatus } from '../src/v2/adapt-status';
import { deskOf } from './helpers/deskOf';
import { sanitizedActivity, sanitizedStatus } from '../src/v2/sanitized-fixture';
import { BotView } from '../src/v2/bot-view';
import { figureAtoms, isLedgerLabel, normFigure, repeatedFigures, sheetRows } from '../src/v2/figures';
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

function sectionRepeats(html: string): string[] {
  const problems: string[] = [];
  const heroAt = html.indexOf('class="hero');
  const groupAt = html.indexOf('class="group-title"');
  if (heroAt >= 0) {
    problems.push(...repeatedFigures(textOf(html.slice(heroAt, groupAt === -1 ? undefined : groupAt))));
  }
  for (const part of html.split('class="group-title"').slice(1)) {
    const [openHtml, closedHtml = ''] = part.split('class="closed-group"');
    // a card may equal its section total (both are labelled); it must not repeat itself
    const cards = openHtml.split(/class="bot-card/);
    for (const card of cards.slice(1)) problems.push(...repeatedFigures(textOf(card)));
    for (const card of closedHtml.split(/class="bot-card/).slice(1)) {
      problems.push(...repeatedFigures(textOf(card)));
    }
  }
  return [...new Set(problems)];
}

function screen(node: ReactElement, width: number, label: string) {
  const html = renderToStaticMarkup(node);
  const text = textOf(html);
  const repeats = html.includes('class="hero') ? sectionRepeats(html) : repeatedFigures(text);
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
      <HomeView portfolio={desk.portfolio} bots={desk.bots} onOpen={() => {}} />
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

  it('does not repeat a label in the bot hero', () => {
    for (const row of desk.bots) {
      const html = renderToStaticMarkup(
        <BotView bot={row} activity={[]} prices={desk.prices} onBack={() => {}} onActivity={() => {}} showFeed={false} />,
      );
      const hero = html.split('data-open="breakdown"')[0];
      const labels = [...hero.matchAll(/class="eyebrow">([^<]+)/g)].map((m) => m[1]);
      const dupes = labels.filter((label, i) => labels.indexOf(label) !== i);
      expect(dupes, row.pair).toEqual([]);
    }
  });

  it('counts a coin amount inside a multi-coin figure', () => {
    const repeats = repeatedFigures('+63.24 USDC + 0.001731 ETH +63.24 USDC + 0.026837 ETH');
    expect(repeats).toContain(normFigure('+63.24 USDC'));
    expect(figureAtoms('+63.24 USDC + 0.001731 ETH').map(normFigure)).toContain(normFigure('+63.24 USDC'));
    expect(figureAtoms('Generated 0 PLS Est. 24H 0 PLS').map(normFigure)).toContain(normFigure('0 PLS'));
    expect(repeatedFigures('Generated 0 PLS Est. 24H 0 PLS')).toContain(normFigure('0 PLS'));
    expect(repeatedFigures('Invested 14.00M PLS and the card 14.00M PLS')).toContain(normFigure('14.00M PLS'));
  });

  it('a card shows its figure even when it is the whole section; the header keeps the total', () => {
    const sample = adaptStatus(sanitizedStatus, sanitizedActivity, sanitizedStatus.spotsAt, 'fixture');
    const html = renderToStaticMarkup(<HomeView portfolio={sample.portfolio} bots={sample.bots} onOpen={() => {}} />);
    const text = textOf(html);
    expect(sectionRepeats(html), text).toEqual([]);
    expect(text).not.toMatch(/All (live|paper)/);
    expect(text.match(/1\.00 ETH/g)!.length).toBeGreaterThanOrEqual(2); // the header and the card
    expect(text.match(/\+20\.00 USDC/g)!.length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('+2 more');
  });

  it('keeps the same invested amount on different bots, and a coin that is the whole section keeps its figure', () => {
    const now = 1_700_000_000_000;
    const shared = {
      mode: 'paper', status: 'running', chainId: 1, base: 'ETH', quoteSym: 'ETH', usdPerQuote: 2000, price: 2000,
      startedAt: now - 3 * 86_400_000, config: { totalCapitalQuote: 3.5 },
      pnl: { realized: 1, unrealized: 0, gasUsd: 0 }, stats: { roundTrips: 1, totalFees: 0 },
    };
    const desk = deskOf({
      spotsAt: now,
      grids: [
        { ...shared, id: 'a', label: 'AAA/ETH' },
        { ...shared, id: 'b', label: 'BBB/ETH' },
      ],
    }, [], now);
    const text = renderAt(<HomeView portfolio={desk.portfolio} bots={desk.bots} onOpen={() => {}} />, 390);
    expect(text.match(/3\.50 ETH/g)?.length).toBeGreaterThan(1);
    expect(text).not.toContain('All of the paper total');
    const sole = deskOf({
      spotsAt: now,
      grids: [
        {
          id: 'hex', mode: 'live', status: 'running', chainId: 369, label: 'HEX/PLS', base: 'HEX', quoteSym: 'PLS',
          usdPerQuote: 0.0001, price: 0.00002, startedAt: now - 3 * 86_400_000,
          config: { totalCapitalQuote: 14_000_000, lowerPrice: 0.00001, upperPrice: 0.00003 },
          pnl: { realized: 10, unrealized: 0, gasUsd: 0 }, stats: { roundTrips: 1, totalFees: 0 },
        },
        {
          id: 'eth', mode: 'live', status: 'running', chainId: 1, label: 'ETH/USDC', base: 'ETH', quoteSym: 'ETH',
          usdPerQuote: 2000, price: 2000, startedAt: now - 3 * 86_400_000,
          config: { totalCapitalQuote: 3.5 },
          pnl: { realized: 1, unrealized: 0, gasUsd: 0 }, stats: { roundTrips: 1, totalFees: 0 },
        },
      ],
    }, [], now);
    const live = renderAt(<HomeView portfolio={sole.portfolio} bots={sole.bots} onOpen={() => {}} />, 390);
    expect(live.match(/14\.00M PLS/g)).toHaveLength(2); // the hero and the card
    expect(live).not.toContain('All live');
    expect(live).toContain('3.50 ETH');
  });

  it('does not repeat a coin amount across breakdown rows', () => {
    for (const row of desk.bots) {
      const [base, quote] = row.pair.split('/');
      const rows = sheetRows(row.metrics, { base: base || row.base, quote: quote || row.quote });
      const ledger = rows.filter((r) => isLedgerLabel(r.label)).map((r) => r.value).join(' ');
      expect(repeatedFigures(ledger), `${row.pair}: ${ledger}`).toEqual([]);
    }
  });

  it('a single live contributor shows its figure under the hero that sums it', () => {
    const now = 1_700_000_000_000;
    const one = deskOf({
      spotsAt: now,
      grids: [
        {
          id: 'only', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
          usdPerQuote: 1, price: 2, startedAt: now - 2 * 86_400_000,
          config: { totalCapitalQuote: 100, lowerPrice: 1, upperPrice: 3 },
          pnl: { realized: 63.24, unrealized: 0, gasUsd: 0 },
          stats: { roundTrips: 2, totalFees: 0 },
        },
        {
          id: 'quiet', mode: 'live', status: 'running', label: 'BBB/USDC', base: 'BBB', quoteSym: 'USDC',
          usdPerQuote: 1, price: 3, startedAt: now - 86_400_000,
          config: { totalCapitalQuote: 10, lowerPrice: 1, upperPrice: 4 },
          pnl: { realized: 0, unrealized: 0, gasUsd: 0 },
          stats: { roundTrips: 0, totalFees: 0 },
        },
      ],
    }, [], now);
    for (const width of widths) {
      const text = screen(home(one, width), width, 'one contributor');
      expect(text).not.toContain('All live');
      expect(text.match(/\+63\.24 USDC/g)).toHaveLength(2); // the hero and the card
      expect(repeatedFigures(text), text).not.toContain(normFigure('0 USDC'));
      expect(text).not.toContain('Paper $');
    }
  });
});
