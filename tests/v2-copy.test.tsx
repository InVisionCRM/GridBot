import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityTape } from '../src/v2/activity-tape';
import { BotView } from '../src/v2/bot-view';
import { adaptStatus } from '../src/v2/adapt-status';
import { figureAtoms, generatedCardLine, ledgerLines, normFigure, sheetRows } from '../src/v2/figures';
import { formatRangePx, formatTokenLine, tokenLineParts } from '../src/v2/format';
import { sanitizedActivity, sanitizedStatus } from '../src/v2/sanitized-fixture';
import type { BotMetrics } from '../src/v2/metrics';
import { HomeView, Ticker } from '../src/v2/home-view';
import { TokenHeadline } from '../src/v2/tokens';
import { loadDesk } from '../src/v2/load-owner';
import type { TokenQty } from '../src/v2/metrics';

const BANNED = /\$|\bAPR\b|\bAPY\b|Unrealized|Realized|Value change|≈|Total P&L|start value|capital in|Price change|impermanent loss/i;

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('v2 copy stays in token units', () => {
  const desk = loadDesk();

  it('does not render dollars, APR, or the old P&L labels', () => {
    const chunks = [
      renderToStaticMarkup(<><Ticker prices={desk.prices} /><HomeView portfolio={desk.portfolio} bots={desk.bots} onOpen={() => {}} /></>),
      renderToStaticMarkup(<><Ticker prices={desk.prices} /><ActivityTape items={desk.activity} full /></>),
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
      <HomeView portfolio={desk.portfolio} bots={desk.bots} onOpen={() => {}} />,
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
          const atom = figureAtoms(formatTokenLine([token]))[0];
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
        expect(got, `${bot.pair} ${bot.metrics.mode} ${label}`).toBe(formatTokenLine(tokens));
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
    for (const bot of sample.bots) {
      const rows = sheetRows(bot.metrics, { base: bot.base, quote: bot.quote });
      const generated = rows.find((r) => r.label === 'Generated');
      if (generated) {
        // the sheet prints Generated at its parts' step (a006), so it is the metric to the digits it shows
        for (const m of generated.value.matchAll(/([+\u2212-])?\s*(\d[\d,]*)(?:\.(\d+))?([kMB])?\s+([A-Z][A-Z0-9]*)/g)) {
          const t = bot.metrics.generated.find((x) => x.symbol === m[5])!;
          if (m[4]) { expect(formatTokenLine([t]), bot.metrics.botId).toContain(m[0].trim().replace(/^\+\s*/, '')); continue; }
          const shown = (m[1] === '−' || m[1] === '-' ? -1 : 1) * Number(`${m[2].replace(/,/g, '')}.${m[3] ?? '0'}`);
          expect(Math.abs(shown - t.amount), `${bot.metrics.botId} ${m[5]}`).toBeLessThanOrEqual(0.5 * 10 ** -(m[3]?.length ?? 0) + 1e-12);
        }
      }
      for (const label of ['Est. 7d', 'Est. 365d'] as const) {
        const got = rows.find((r) => r.label === label)?.value;
        const tokens = label === 'Est. 7d' ? bot.metrics.est.d7 : bot.metrics.est.d365;
        if (!got || !tokens?.length) continue;
        expect(got, `${bot.metrics.botId} ${label}`).toBe(formatTokenLine(tokens));
      }
      for (const row of rows) {
        if (row.label !== 'Generated' && !row.label.startsWith('Est.')) continue;
        for (const amount of row.value.matchAll(/[+\u2212-]?\d[\d,]*(?:\.\d+)?[kMB]?/g)) {
          expect(overPrecise(amount[0]), `${bot.metrics.botId} ${row.label} ${amount[0]}`).toBe(false);
        }
      }
      expect(rows.some((r) => r.value === 'Rows are rounded to add up exactly.'), bot.metrics.botId).toBe(false);
      if (bot.metrics.breakdownBasis) {
        expect(rows.some((r) => r.value === 'Breakdown coming soon'), bot.metrics.botId).toBe(false);
      } else if (bot.metrics.kind === 'lp' || bot.metrics.kind === 'grid') {
        expect(rows.some((r) => r.value === 'Breakdown coming soon'), bot.metrics.botId).toBe(true);
      }
    }
  });

  it('shows every generated coin on the card as a number', () => {
    const now = 1_700_000_000_000;
    const desk = adaptStatus({
      spotsAt: now,
      lps: [
        {
          id: 'bun', mode: 'paper', status: 'running', chainId: 1, label: 'BUN/ETH', base: 'BUN', quote: 'ETH',
          dexName: 'Example', usdPerQuote: 2000, price: 0.00005, startedAt: now - 3 * 86_400_000,
          inRange: true, startValue: 1, config: { capital: 1 },
          position: { lower: 0.00004, upper: 0.00006 },
          totals: { gas: 0.02051, swapCost: 0, moveLoss: 0 },
          pnl: {
            net: 0, price: 0, fees: 0, gas: 0.02051, swapCost: 0, moveLoss: 0, equity: 1,
            feeCoins: { base: 233.06, quote: 0.01 },
          },
        },
        {
          id: 'other', mode: 'paper', status: 'running', chainId: 1, label: 'USDC/ETH', base: 'USDC', quote: 'ETH',
          dexName: 'Example', usdPerQuote: 2000, price: 0.0005, startedAt: now - 3 * 86_400_000,
          inRange: true, startValue: 1, config: { capital: 1 },
          position: { lower: 0.0004, upper: 0.0006 },
          pnl: {
            net: 0, price: 0, fees: 0, gas: 0, swapCost: 0, moveLoss: 0, equity: 1,
            feeCoins: { base: 10, quote: 0.05 },
          },
        },
      ],
    }, [], now);
    const html = renderToStaticMarkup(
      <HomeView portfolio={desk.portfolio} bots={desk.bots} onOpen={() => {}} />,
    );
    const card = html.split('data-bot="bun"')[1]?.split('card-details')[0] ?? '';
    const text = card.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const gen = desk.bots.find((b) => b.metrics.botId === 'bun')!.metrics.generated;
    expect(text).not.toContain('All paper');
    for (const part of tokenLineParts(gen)) expect(text).toContain(part);
    expect(text).toContain('−0.01051 ETH');
    expect(generatedCardLine(gen)?.text).toBe(formatTokenLine(gen));
  });

  it('uses the same multi-coin generated string on the card and the hero', () => {
    const now = 1_700_000_000_000;
    const lp = (id: string, baseAmt: number, quoteAmt: number) => ({
      id, mode: 'paper' as const, status: 'running', chainId: 1, label: 'USDG/ETH', base: 'USDG', quote: 'ETH',
      dexName: 'Example', usdPerQuote: 2000, price: 0.0005, startedAt: now - 3 * 86_400_000,
      inRange: true, startValue: 1, config: { capital: 1 },
      position: { lower: 0.0004, upper: 0.0006 },
      pnl: {
        net: 0, price: 0, fees: 0, gas: 0, swapCost: 0, moveLoss: 0, equity: 1,
        feeCoins: { base: baseAmt, quote: quoteAmt },
      },
    });
    const desk = adaptStatus({ spotsAt: now, lps: [lp('one', 65.04, 0.01531), lp('two', 6, 0.01)] }, [], now);
    const bot = desk.bots.find((b) => b.metrics.botId === 'one');
    const line = formatTokenLine(bot?.metrics.generated ?? []);
    expect(line).toBe('+65.04 USDG + 0.01531 ETH');
    const home = textOf(renderToStaticMarkup(
      <HomeView portfolio={desk.portfolio} bots={desk.bots} onOpen={() => {}} />,
    ));
    const hero = textOf(renderToStaticMarkup(
      <BotView bot={bot!} activity={[]} prices={[]} onBack={() => {}} onActivity={() => {}} showFeed={false} breakdown />,
    ));
    expect(home).toContain(line);
    expect(hero).toContain(line);
    expect(generatedCardLine(bot!.metrics.generated, desk.portfolio.paperTokens, 'paper')?.text).toBe(line);
  });

  it('does not invent trade profit for a grid with no fills', () => {
    const lines = ledgerLines({
      kind: 'grid',
      fillCount: 0,
      grossFees: [],
      feesPaid: [{ symbol: 'PLS', amount: 20300, usd: null }],
      moveLoss: [],
      generated: [],
    } as BotMetrics);
    expect(lines?.gross).toBe('0 PLS');
    expect(lines?.paid).toBe('−20.3k PLS');
    expect(lines?.generated).toBe('0 PLS');
    expect(lines?.gross).not.toContain('20.3k');
    const rows = sheetRows({
      kind: 'grid',
      fillCount: 0,
      grossFees: [],
      feesPaid: [{ symbol: 'PLS', amount: 20300, usd: null }],
      moveLoss: [],
      generated: [],
    } as BotMetrics, { base: 'HEX', quote: 'PLS' });
    expect(rows.find((r) => r.label === 'Trade profit before gas')?.value).toBe('0 PLS');
    expect(rows.find((r) => r.label === 'Generated')?.value).toBe('0 PLS');
    expect(rows.map((r) => r.value).join(' ')).not.toContain('+20.3k');
    expect(rows.some((r) => r.value === 'Breakdown coming soon')).toBe(false);
  });

  it('shows legacy grid capital as quote-coin units, never USD', () => {
    const now = 1_700_000_000_000;
    const desk = adaptStatus({
      spotsAt: now,
      grids: [{
        id: 'usd', mode: 'live', status: 'running', label: 'AAA/USDC', base: 'AAA', quoteSym: 'USDC',
        usdPerQuote: 1, price: 1, startedAt: now - 2 * 86_400_000,
        config: { totalCapitalUsd: 1000 },
        pnl: { realized: 5, unrealized: 0 },
        moveCount: 1,
      }],
    }, [], now);
    expect(desk.bots[0].metrics.invested).toEqual([{ symbol: 'USDC', amount: 1000, usd: null }]);
    const text = textOf(renderToStaticMarkup(
      <BotView bot={desk.bots[0]} activity={[]} prices={[]} onBack={() => {}} onActivity={() => {}} showFeed={false} breakdown />,
    ));
    expect(text).not.toMatch(/\bUSD\b/);
    expect(text).not.toContain('legacy-config');
    expect(text).toContain('1,000.00 USDC');
    expect(text).toContain('No trade log here: the costs are inside the trade profit.');
    expect(text).not.toContain('Breakdown coming soon');
    expect(text).toContain('Est. 24H');
    expect(text).not.toMatch(/\/day/);
  });

  it('shows every hero coin instead of a more pill', () => {
    const html = renderToStaticMarkup(
      <TokenHeadline tokens={[
        { symbol: 'USDG', amount: 89.51, usd: null },
        { symbol: 'USDC', amount: 63.24, usd: null },
        { symbol: 'ETH', amount: 0.001731, usd: null },
      ]} />,
    );
    const text = textOf(html);
    expect(text).toContain('+89.51 USDG + 63.24 USDC + 0.001731 ETH');
    expect(text).not.toContain('more');
  });
});

function overPrecise(raw: string): boolean {
  const body = raw.replace(/^[+\u2212-]/, '').replace(/,/g, '');
  const suffix = body.match(/[kMB]$/)?.[0] ?? '';
  const mantissa = body.replace(/[kMB]$/, '');
  const frac = mantissa.split('.')[1] ?? '';
  if (suffix) return frac.length > 2;
  const n = Number(mantissa);
  if (n >= 1) return frac.length > 2;
  const sig = mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return sig.length > 4 || frac.length > 6;
}
