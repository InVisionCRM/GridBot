import { motion } from 'motion/react';
import { useState } from 'react';
import { TokenMark } from '../ui/icons';
import { EquityCurve, Spark } from './equity-curve';
import { cardReadout, coverFigures, uniqueTape, type CardReadout } from './figures';
import { formatPx, formatTokenLine, formatUsd, pct } from './format';
import type { BotDesk, BotStatus, PortfolioSnapshot, TapePrice, TokenQty } from './metrics';
import { useReducedMotion } from './motion';
import { PairLabel } from './pair-label';
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
      <em className="px">{formatPx(p.price)}</em>
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
  const used = new Set<string>();
  coverFigures([
    formatTokenLine(portfolio.tokens),
    portfolio.generatedPerDay ? formatTokenLine(portfolio.generatedPerDay) : '',
    formatUsd(portfolio.generatedUsd, false),
    formatUsd(portfolio.generatedPerDayUsd, false),
    uniqueTape(prices).map((p) => formatPx(p.price)).join(' '),
  ].join(' '), used);
  const liveCards = live.map((bot) => ({ bot, readout: cardReadout(bot.metrics, portfolio.tokens, 'live', used) }));
  coverFigures(`${formatTokenLine(portfolio.paperTokens)} ${formatUsd(portfolio.paperGeneratedUsd, false)}`, used);
  const paperCards = paperBots.map((bot) => ({ bot, readout: cardReadout(bot.metrics, portfolio.paperTokens, 'paper', used) }));
  return (
    <div className="home">
      <section className="hero glass">
        <p className="eyebrow">Generated</p>
        <div className="hero-top">
          <div className="hero-units">
            {portfolio.tokens.length
              ? <TokenHeadline tokens={portfolio.tokens} usd={portfolio.generatedUsd} />
              : '—'}
          </div>
        </div>
        <p className="hero-rate">
          {portfolio.generatedPerDay == null ? '—' : portfolio.generatedPerDay.length ? <TokenLine tokens={portfolio.generatedPerDay} /> : '0'}
          <span>/day</span>
        </p>
        <p className="usd-under">
          {portfolio.generatedUsd == null ? '—' : `≈ ${formatUsd(portfolio.generatedUsd, false)}`}
          {' · '}
          {portfolio.generatedPerDayUsd == null ? '—' : `${formatUsd(portfolio.generatedPerDayUsd, false)}/day`}
        </p>
        <div className="hero-meta">
          <p className="hero-stat"><span>Running</span> <b>{portfolio.botsRunning}/{portfolio.botsTotal}</b></p>
        </div>
        <div className="hero-curve">
          <RangeSelect value={span} onChange={setSpan} timed={false} />
          {series.length > 1 ? <EquityCurve points={series} /> : <p className="curve-empty">Chart fills in as history builds</p>}
        </div>
      </section>
      <ModeSection title="Live" cards={liveCards} onOpen={onOpen} />
      <ModeSection title="Paper" cards={paperCards} tokens={portfolio.paperTokens} usd={portfolio.paperGeneratedUsd} onOpen={onOpen} />
    </div>
  );
}

function ModeSection({
  title, cards, tokens = [], usd = null, onOpen,
}: {
  title: string;
  cards: { bot: BotDesk; readout: CardReadout }[];
  tokens?: TokenQty[];
  usd?: number | null;
  onOpen: (id: string) => void;
}) {
  const open = cards.filter((c) => c.bot.metrics.status !== 'closed');
  const closed = cards.filter((c) => c.bot.metrics.status === 'closed');
  if (!open.length && !closed.length) return null;
  const item = ({ bot, readout }: { bot: BotDesk; readout: CardReadout }) => (
    <BotCard key={bot.metrics.botId} bot={bot} readout={readout} onOpen={onOpen} />
  );
  return (
    <section>
      <h2 className="group-title">
        <span className="section-name">{title}</span>
        {tokens.length > 0 && <span className="section-units"><TokenLine tokens={tokens} /></span>}
        {tokens.length > 0 && usd != null && <small>≈ {formatUsd(usd, false)}</small>}
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

function CardMade({ readout }: { readout: CardReadout }) {
  if (readout.kind === 'empty') return <p className="card-made"><span>Generated</span> No fills yet</p>;
  if (readout.kind === 'note') return <p className="card-made"><span>Generated</span> <em className="card-note">{readout.text}</em></p>;
  return (
    <>
      <p className="card-made">
        <span>Generated</span>
        {readout.tokens.length > 0 && <TokenHeadline tokens={readout.tokens} />}
      </p>
      {readout.usd && <p className="usd-under">≈ {readout.usd}</p>}
    </>
  );
}

function BotCard({ bot, readout, onOpen }: { bot: BotDesk; readout: CardReadout; onOpen: (id: string) => void }) {
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
          <TokenMark symbol={bot.base} size={28} />
          <div>
            <motion.strong layoutId={`pair-${bot.metrics.botId}`}>
              <PairLabel pair={bot.pair} chain={bot.chain} />
            </motion.strong>
            <em>{bot.dex} · {bot.metrics.kind} · {bot.metrics.mode}</em>
          </div>
          <StatusMark tone={bot.tone} status={bot.metrics.status as BotStatus} />
        </header>
        <div className="card-chart">
          {bot.spark.length > 1 && <Spark points={bot.spark} />}
          <RangeTrack range={bot.metrics.range} tone={bot.tone} />
        </div>
        <CardMade readout={readout} />
      </motion.div>
    </li>
  );
}
