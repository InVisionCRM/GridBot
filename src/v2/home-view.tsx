import { motion } from 'motion/react';
import { useState } from 'react';
import { CoinMark } from './coin-mark';
import { EquityCurve, Spark } from './equity-curve';
import { cardReadout, investedLine, uniqueTape, type CardReadout } from './figures';
import { formatBag, formatQuotePx, formatTokenLine, pct } from './format';
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
  const liveCards = live.map((bot) => ({
    bot,
    readout: cardReadout(bot.metrics, portfolio.tokens, 'live'),
    invested: investedLine(bot.metrics.invested, liveInvested, 'live'),
    covered: `${formatTokenLine(portfolio.tokens)} ${formatBag(liveInvested)} ${uniqueTape(prices).map((p) => formatQuotePx(p.price, p.symbol.split('/')[1] || '')).join(' ')}`,
  }));
  const paperCards = paperBots.map((bot) => ({
    bot,
    readout: cardReadout(bot.metrics, portfolio.paperTokens, 'paper'),
    invested: investedLine(bot.metrics.invested, paperInvested, 'paper'),
    covered: `${formatTokenLine(portfolio.paperTokens)} ${formatBag(paperInvested)} ${uniqueTape(prices).map((p) => formatQuotePx(p.price, p.symbol.split('/')[1] || '')).join(' ')}`,
  }));
  return (
    <div className="home">
      <section className="hero glass">
        <p className="eyebrow">Invested</p>
        <p className="hero-rate bag-line">{liveInvested.length ? <BagLine tokens={liveInvested} /> : '—'}</p>
        <p className="eyebrow">Generated</p>
        <div className="hero-top">
          <div className="hero-units">
            {portfolio.tokens.length ? <TokenHeadline tokens={portfolio.tokens} /> : '—'}
          </div>
        </div>
        <p className="hero-rate" data-est="">
          {portfolio.generatedPerDay == null ? '—' : portfolio.generatedPerDay.length ? <TokenLine tokens={portfolio.generatedPerDay} /> : '0'}
          <span>/day</span>
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
      <ModeSection title="Paper" cards={paperCards} tokens={portfolio.paperTokens} invested={paperInvested} onOpen={onOpen} />
    </div>
  );
}

function ModeSection({
  title, cards, tokens = [], invested = [], onOpen,
}: {
  title: string;
  cards: { bot: BotDesk; readout: CardReadout; invested: string | null; covered: string }[];
  tokens?: TokenQty[];
  invested?: TokenQty[];
  onOpen: (id: string) => void;
}) {
  const open = cards.filter((c) => c.bot.metrics.status !== 'closed');
  const closed = cards.filter((c) => c.bot.metrics.status === 'closed');
  if (!open.length && !closed.length) return null;
  const item = (card: { bot: BotDesk; readout: CardReadout; invested: string | null; covered: string }) => (
    <BotCard key={card.bot.metrics.botId} {...card} onOpen={onOpen} />
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
  if (readout.kind === 'empty') return <p className="card-made"><span>Generated</span> No fills yet</p>;
  if (readout.kind === 'note') return <p className="card-made"><span>Generated</span> <em className="card-note">{readout.text}</em></p>;
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
          <p className="muted small">Estimate, not a forecast.</p>
        </details>
      </motion.div>
    </li>
  );
}
