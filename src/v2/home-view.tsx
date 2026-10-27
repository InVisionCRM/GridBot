import { motion } from 'motion/react';
import { useState } from 'react';
import { TokenMark } from '../ui/icons';
import { EquityCurve, Spark } from './equity-curve';
import { formatPx, formatUsd, pct, showsNoFills } from './format';
import type { BotDesk, BotMetrics, BotStatus, PortfolioSnapshot, TapePrice, TokenQty } from './metrics';
import { usePhone, useReducedMotion } from './motion';
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
      <em className="px">{formatPx(p.price)}</em>
      {p.change24h != null && <em>{pct(p.change24h, 2, true)}</em>}
    </span>
  );
}

export function Ticker({ prices }: { prices: TapePrice[] }) {
  const reduced = useReducedMotion();
  const [page, setPage] = useState(0);
  if (reduced) {
    const size = 3;
    const pages = Math.max(1, Math.ceil(prices.length / size));
    const slice = prices.slice((page % pages) * size, (page % pages) * size + size);
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
  const loop = prices.length ? [...prices, ...prices] : [];
  return (
    <div className="ticker" aria-label="Pairs">
      <div className="ticker-track">
        {loop.map((p, i) => <TapeItem key={`${p.symbol}-${i}`} p={p} />)}
      </div>
    </div>
  );
}

function Chips({ tokens }: { tokens: TokenQty[] }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  if (!tokens.length) return null;
  const fold = phone && !open && tokens.length >= 3;
  const ranked = [...tokens].sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0) || Math.abs(b.amount) - Math.abs(a.amount));
  const shown = fold ? [ranked[0]] : tokens;
  return (
    <div className="chips">
      {shown.map((t) => (
        <span key={t.symbol} className={t.amount < 0 ? 'chip down' : 'chip'}>
          <TokenLine tokens={[t]} />
        </span>
      ))}
      {fold && (
        <button type="button" className="chip more" onClick={() => setOpen(true)}>
          +{tokens.length - 1} more
        </button>
      )}
    </div>
  );
}

export function HomeView({
  portfolio, bots, onOpen,
}: {
  portfolio: PortfolioSnapshot;
  bots: BotDesk[];
  onOpen: (id: string) => void;
}) {
  const [paper, setPaper] = useState(false);
  const [span, setSpan] = useState<RangeKey>('ALL');
  const live = bots.filter((b) => b.metrics.mode === 'live');
  const paperBots = bots.filter((b) => b.metrics.mode === 'paper');
  const series = span === 'ALL' ? portfolio.madeSeries : [];
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
          <button type="button" className="paper-toggle" aria-expanded={paper} onClick={() => setPaper((v) => !v)}>
            Paper {portfolio.paperGeneratedUsd == null ? '—' : formatUsd(portfolio.paperGeneratedUsd, false)}
          </button>
          <p className="hero-stat"><span>Running</span> <b>{portfolio.botsRunning}/{portfolio.botsTotal}</b></p>
        </div>
        {paper && (
          <div className="paper-chips">
            {portfolio.paperTokens.length ? <Chips tokens={portfolio.paperTokens} /> : <p className="curve-empty">—</p>}
          </div>
        )}
        <div className="hero-curve">
          <RangeSelect value={span} onChange={setSpan} timed={false} />
          {series.length > 1 ? <EquityCurve points={series} /> : <p className="curve-empty">Chart fills in as history builds</p>}
        </div>
      </section>
      <ModeSection title="Live" bots={live} onOpen={onOpen} />
      <ModeSection title="Paper" bots={paperBots} onOpen={onOpen} />
    </div>
  );
}

function ModeSection({ title, bots, onOpen }: { title: string; bots: BotDesk[]; onOpen: (id: string) => void }) {
  const open = bots.filter((b) => b.metrics.status !== 'closed');
  const closed = bots.filter((b) => b.metrics.status === 'closed');
  if (!open.length && !closed.length) return null;
  return (
    <section>
      <h2 className="group-title">{title}</h2>
      {open.length > 0 && (
        <ul className="bot-list">
          {open.map((b) => <BotCard key={b.metrics.botId} bot={b} onOpen={onOpen} />)}
        </ul>
      )}
      {closed.length > 0 && (
        <details className="closed-group">
          <summary>Closed · {closed.length}</summary>
          <ul className="bot-list">
            {closed.map((b) => <BotCard key={b.metrics.botId} bot={b} onOpen={onOpen} />)}
          </ul>
        </details>
      )}
    </section>
  );
}

function CardMade({ metrics }: { metrics: BotMetrics }) {
  if (showsNoFills(metrics)) return <p className="card-made"><span>Generated</span> No fills yet</p>;
  return (
    <>
      <p className="card-made">
        <span>Generated</span>
        <TokenHeadline tokens={metrics.generated} usd={metrics.generatedUsd} />
      </p>
      <p className="usd-under">{metrics.generatedUsd == null ? '—' : `≈ ${formatUsd(metrics.generatedUsd, false)}`}</p>
    </>
  );
}

function BotCard({ bot, onOpen }: { bot: BotDesk; onOpen: (id: string) => void }) {
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
        <CardMade metrics={bot.metrics} />
      </motion.div>
    </li>
  );
}
