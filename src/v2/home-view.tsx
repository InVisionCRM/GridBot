import { motion } from 'motion/react';
import { useState } from 'react';
import { CoinMark } from './coin-mark';
import { EquityCurve, Spark } from './equity-curve';
import { cardReadout, estimatesVisible, investedLine, normFigure, uniqueTape, type CardReadout } from './figures';
import { formatAmt, formatBag, formatQuotePx, formatTokenLine, pct, tokenLineParts } from './format';
import type { BotDesk, BotStatus, PortfolioSnapshot, TapePrice, TokenQty } from './metrics';
import { sheetRows } from './figures';
import { useReducedMotion } from './motion';
import { PairLabel, PairTitle } from './pair-label';
import { press } from './press';
import { RangeSelect, type RangeKey } from './range-tabs';
import { RangeTrack } from './range-track';
import { StatusMark } from './status-mark';
import { TokenHeadline, TokenLine } from './tokens';

function TapeItem({ p }: { p: TapePrice }) {
  return (
    <span className={p.change24h == null ? '' : p.change24h >= 0 ? 'up' : 'down'}>
      <PairLabel pair={p.symbol} chain={p.chain} />
      {p.fee && <i className="tape-fee">{p.fee}</i>}
      <em className="px">{formatQuotePx(p.price, p.symbol.split('/')[1] || '')}</em>
      {p.change24h != null && <em>{pct(p.change24h, 2, true)}</em>}
    </span>
  );
}

export function Ticker({ prices }: { prices: TapePrice[] }) {
  const reduced = useReducedMotion();
  const [page, setPage] = useState(0);
  const rows = uniqueTape(prices);
  if (reduced) {
    const size = 3;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const slice = rows.slice((page % pages) * size, (page % pages) * size + size);
    return (
      <div className="ticker ticker-static" aria-label="Pairs">
        <div className="ticker-track">
          {slice.map((p, i) => <TapeItem key={`${p.symbol}-${i}`} p={p} />)}
          {!slice.length && <span>—</span>}
        </div>
        {pages > 1 && (
          <div className="ticker-pages">
            <button type="button" onClick={() => setPage((n) => (n - 1 + pages) % pages)}>Prev</button>
            <span>{(page % pages) + 1}/{pages}</span>
            <button type="button" onClick={() => setPage((n) => (n + 1) % pages)}>Next</button>
          </div>
        )}
      </div>
    );
  }
  const loop = rows;
  return (
    <div className="ticker" aria-label="Pairs">
      <div className="ticker-track">
        {loop.map((p, i) => <TapeItem key={`${p.symbol}-${i}`} p={p} />)}
        {typeof document !== 'undefined' && (
          <span className="ticker-clone" aria-hidden="true">
            {loop.map((p, i) => <TapeItem key={`clone-${p.symbol}-${i}`} p={p} />)}
          </span>
        )}
      </div>
    </div>
  );
}

function shownPairParts(pair: string): { base: string; quote: string } {
  const [base, quote] = pair.split('/');
  return { base: base || pair, quote: quote || '' };
}

function hasDigit(text: string | null | undefined): boolean {
  return !!text && /\d/.test(text);
}

function readoutText(readout: CardReadout): string {
  return readout.kind === 'line' || readout.kind === 'note' ? readout.text : '';
}

/** Coins on this bot that are the whole of that coin in the section. */
function wholeCoins(bot: TokenQty[], section: TokenQty[], bag: boolean): string[] {
  const fmt = (rows: TokenQty[]) => normFigure(bag ? formatBag(rows) : formatTokenLine(rows));
  const totals = new Map(section.filter((t) => t.amount !== 0 && formatAmt(t.amount) !== '0').map((t) => [t.symbol, fmt([t])]));
  return bot.filter((t) => t.amount !== 0 && totals.get(t.symbol) === fmt([t])).map((t) => t.symbol);
}

function omitCoins(tokens: TokenQty[], drop: Set<string>): TokenQty[] {
  return tokens.filter((t) => !drop.has(t.symbol));
}

interface CardModel {
  bot: BotDesk;
  readout: CardReadout;
  invested: string | null;
  covered: string;
  dropGen: string[];
  dropInv: string[];
}

function presentCard(bot: BotDesk, sectionGen: TokenQty[], sectionInv: TokenQty[], scope: 'live' | 'paper', prices: TapePrice[]): CardModel {
  let readout = cardReadout(bot.metrics, sectionGen, scope);
  let invested = investedLine(bot.metrics.invested, sectionInv, scope);
  const dropGen: string[] = [];
  const dropInv: string[] = [];
  if (!hasDigit(readoutText(readout)) && !hasDigit(invested)) {
    const shown = bot.metrics.generated.filter((t) => t.amount !== 0 && formatAmt(t.amount) !== '0');
    if (shown.length) {
      readout = { kind: 'line', text: formatTokenLine(shown), parts: tokenLineParts(shown) };
      dropGen.push(...wholeCoins(shown, sectionGen, false));
    } else if (bot.metrics.invested.length) {
      invested = bot.metrics.invested.map((t) => formatBag([t])).join(' + ');
      dropInv.push(...wholeCoins(bot.metrics.invested, sectionInv, true));
    }
  }
  const covered = `${formatTokenLine(sectionGen)} ${formatBag(sectionInv)} ${uniqueTape(prices).map((p) => formatQuotePx(p.price, p.symbol.split('/')[1] || '')).join(' ')}`;
  return { bot, readout, invested, covered, dropGen, dropInv };
}

function sumBags(rows: TokenQty[][]): TokenQty[] {
  const map = new Map<string, number>();
  for (const row of rows) for (const t of row) map.set(t.symbol, (map.get(t.symbol) ?? 0) + t.amount);
  return [...map.entries()].filter(([, amount]) => amount !== 0).map(([symbol, amount]) => ({ symbol, amount, usd: null }));
}

export function HomeView({
  portfolio, bots, prices = [], onOpen,
}: {
  portfolio: PortfolioSnapshot;
  bots: BotDesk[];
  prices?: TapePrice[];
  onOpen: (id: string) => void;
}) {
  const [span, setSpan] = useState<RangeKey>('ALL');
  const live = bots.filter((b) => b.metrics.mode === 'live');
  const paperBots = bots.filter((b) => b.metrics.mode === 'paper');
  const series = span === 'ALL' ? portfolio.madeSeries : [];
  const liveInvested = sumBags(live.map((b) => b.metrics.invested));
  const paperInvested = sumBags(paperBots.map((b) => b.metrics.invested));
  const liveBuilt = live.map((bot) => presentCard(bot, portfolio.tokens, liveInvested, 'live', prices));
  const paperBuilt = paperBots.map((bot) => presentCard(bot, portfolio.paperTokens, paperInvested, 'paper', prices));
  const liveDropGen = new Set(liveBuilt.flatMap((c) => c.dropGen));
  const liveDropInv = new Set(liveBuilt.flatMap((c) => c.dropInv));
  const paperDropGen = new Set(paperBuilt.flatMap((c) => c.dropGen));
  const paperDropInv = new Set(paperBuilt.flatMap((c) => c.dropInv));
  const liveHeroGen = omitCoins(portfolio.tokens, liveDropGen);
  const liveHeroInv = omitCoins(liveInvested, liveDropInv);
  const paperHeroGen = omitCoins(portfolio.paperTokens, paperDropGen);
  const paperHeroInv = omitCoins(paperInvested, paperDropInv);
  const liveCards = liveBuilt;
  const paperCards = paperBuilt;
  return (
    <div className="home">
      <section className="hero glass">
        <p className="eyebrow">Invested</p>
        <p className="hero-rate bag-line">{liveHeroInv.length ? <BagLine tokens={liveHeroInv} /> : '—'}</p>
        <p className="eyebrow">Generated</p>
        <div className="hero-top">
          <div className="hero-units">
            {liveHeroGen.length ? <TokenHeadline tokens={liveHeroGen} /> : '—'}
          </div>
        </div>
        <p className="hero-rate" data-est="">
          {portfolio.generatedPerDay?.length ? <TokenHeadline tokens={portfolio.generatedPerDay} /> : '—'}
          <span>Est. 24H</span>
        </p>
        <p className="muted small">Estimate, not a forecast.</p>
        <div className="hero-meta">
          <p className="hero-stat"><span>Running</span> <b>{portfolio.botsRunning}/{portfolio.botsTotal}</b></p>
        </div>
        <div className="hero-curve">
          <RangeSelect value={span} onChange={setSpan} timed={false} />
          {series.length > 1 ? <EquityCurve points={series} /> : <p className="curve-empty">Chart fills in as history builds</p>}
        </div>
      </section>
      <ModeSection title="Live" cards={liveCards} onOpen={onOpen} />
      <ModeSection title="Paper" cards={paperCards} tokens={paperHeroGen} invested={paperHeroInv} onOpen={onOpen} />
    </div>
  );
}

function ModeSection({
  title, cards, tokens = [], invested = [], onOpen,
}: {
  title: string;
  cards: CardModel[];
  tokens?: TokenQty[];
  invested?: TokenQty[];
  onOpen: (id: string) => void;
}) {
  const open = cards.filter((c) => c.bot.metrics.status !== 'closed');
  const closed = cards.filter((c) => c.bot.metrics.status === 'closed');
  if (!open.length && !closed.length) return null;
  const item = (card: CardModel) => (
    <BotCard key={card.bot.metrics.botId} bot={card.bot} readout={card.readout} invested={card.invested} covered={card.covered} onOpen={onOpen} />
  );
  return (
    <section>
      <h2 className="group-title">
        <span className="section-name">{title}</span>
        {invested.length > 0 && <span className="section-units"><span className="section-name">Invested</span> {formatBag(invested)}</span>}
        {tokens.length > 0 && <span className="section-units"><span className="section-name">Generated</span> <TokenLine tokens={tokens} /></span>}
      </h2>
      {open.length > 0 && <ul className="bot-list">{open.map(item)}</ul>}
      {closed.length > 0 && (
        <details className="closed-group">
          <summary>Closed · {closed.length}</summary>
          <ul className="bot-list">{closed.map(item)}</ul>
        </details>
      )}
    </section>
  );
}

function BagLine({ tokens }: { tokens: TokenQty[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span key={t.symbol} className="bag-part">
          {i > 0 && <span className="bag-plus"> + </span>}
          <span className="bag-coin">{formatBag([t])}</span>
        </span>
      ))}
    </>
  );
}

function CardMade({ readout }: { readout: CardReadout }) {
  if (readout.kind === 'note' && readout.text === 'Not calculated yet') {
    return <p className="card-made"><span>Generated</span> — <em className="card-note">Not calculated yet</em></p>;
  }
  if (readout.kind === 'note') return <p className="card-made"><span>Generated</span> <em className="card-note">{readout.text}</em></p>;
  if (readout.kind !== 'line') return <p className="card-made"><span>Generated</span> — <em className="card-note">Not calculated yet</em></p>;
  return (
    <p className="card-made">
      <span>Generated</span>
      <span className="card-gen bag-line">
        {readout.parts.map((part, i) => (
          <span key={`${part}-${i}`} className="bag-part">
            {i > 0 && ' '}
            <span className="bag-coin">{part}</span>
          </span>
        ))}
      </span>
    </p>
  );
}

function BotCard({
  bot, readout, invested, covered, onOpen,
}: {
  bot: BotDesk;
  readout: CardReadout;
  invested: string | null;
  covered: string;
  onOpen: (id: string) => void;
}) {
  const open = () => { press(); onOpen(bot.metrics.botId); };
  return (
    <li>
      <motion.div
        role="link"
        tabIndex={0}
        className="bot-card glass"
        data-bot={bot.metrics.botId}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        }}
        whileTap={{ scale: 0.985 }}
        transition={{ type: 'spring', bounce: 0, visualDuration: 0.22 }}
      >
        <header>
          <CoinMark symbol={bot.base} size={28} />
          <div>
            <motion.strong layoutId={`pair-${bot.metrics.botId}`}>
              <PairTitle pair={bot.pair} chainName={bot.chainName} dex={bot.dex} />
            </motion.strong>
            <em>{bot.metrics.kind} · {bot.metrics.mode === 'paper' ? 'Paper' : 'Live'}</em>
          </div>
          <StatusMark tone={bot.tone} status={bot.metrics.status as BotStatus} />
        </header>
        <div className="card-chart">
          {bot.spark.length > 1 && <Spark points={bot.spark} />}
          <RangeTrack range={bot.metrics.range} tone={bot.tone} />
        </div>
        {invested && <p className="card-made"><span>Invested</span> {invested}</p>}
        <CardMade readout={readout} />
        <details className="card-details" onClick={(e) => e.stopPropagation()}>
          <summary>Details</summary>
          <ul className="break">
            {sheetRows(bot.metrics, shownPairParts(bot.pair), covered, true).map((row) => (
              row.label === 'Note' || row.label === 'Adds'
                ? <li key={row.label} className="note"><span>{row.value}</span></li>
                : <li key={row.label}><span>{row.label}</span><b {...(row.label.startsWith('Est.') ? { 'data-est': '' } : {})}>{row.value}</b></li>
            ))}
          </ul>
          {estimatesVisible(bot.metrics) && <p className="muted small">Estimate, not a forecast.</p>}
        </details>
      </motion.div>
    </li>
  );
}
