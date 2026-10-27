import { motion } from 'motion/react';
import { TokenMark } from '../ui/icons';
import { Spark } from './equity-curve';
import { formatPx, formatUsd, pct } from './format';
import type { BotDesk, PortfolioSnapshot, TapePrice, TokenQty } from './metrics';
import { press } from './press';
import { RangeTrack } from './range-track';
import { RollingUsd } from './rolling-number';
import { TokenLine } from './tokens';

export function Ticker({ prices }: { prices: TapePrice[] }) {
  const loop = prices.length ? [...prices, ...prices] : [];
  return (
    <div className="ticker" aria-label="Pairs">
      <div className="ticker-track">
        {loop.map((p, i) => (
          <span key={`${p.symbol}-${i}`} className={p.change24h == null ? '' : p.change24h >= 0 ? 'up' : 'down'}>
            <b>{p.symbol}</b>
            <em className="px">{formatPx(p.price)}</em>
            {p.change24h != null && <em>{pct(p.change24h, 2, true)}</em>}
          </span>
        ))}
      </div>
    </div>
  );
}

function Chips({ tokens }: { tokens: TokenQty[] }) {
  if (!tokens.length) return null;
  return (
    <div className="chips">
      {tokens.map((t) => (
        <span key={t.symbol} className={t.amount < 0 ? 'chip down' : 'chip'}>
          <TokenLine tokens={[t]} />
        </span>
      ))}
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
  const live = bots.filter((b) => b.metrics.mode === 'live');
  const paper = bots.filter((b) => b.metrics.mode === 'paper');
  return (
    <div className="home">
      <section className="hero glass">
        <div className="hero-main">
          <p className="eyebrow">Generated</p>
          <div className="hero-num">
            {portfolio.generatedUsd == null ? '—' : <RollingUsd value={portfolio.generatedUsd} rollIn />}
          </div>
          <p className="paper-line">Live bots</p>
        </div>
        <Chips tokens={portfolio.tokens} />
        <p className="paper-line paper-span">
          Paper {portfolio.paperGeneratedUsd == null ? '—' : formatUsd(portfolio.paperGeneratedUsd, true)}
        </p>
        <div className="paper-span"><Chips tokens={portfolio.paperTokens} /></div>
      </section>
      <section className="strip" aria-label="Desk strip">
        <div>
          <span>Running</span>
          <b>{portfolio.botsRunning}/{portfolio.botsTotal}</b>
          <small>bots</small>
        </div>
      </section>
      <BotGroup title="Live" bots={live} onOpen={onOpen} />
      <BotGroup title="Paper" bots={paper} onOpen={onOpen} />
    </div>
  );
}

function BotGroup({ title, bots, onOpen }: { title: string; bots: BotDesk[]; onOpen: (id: string) => void }) {
  if (!bots.length) return null;
  return (
    <section>
      <h2 className="group-title">{title}</h2>
      <ul className="bot-list">
        {bots.map((b) => (
          <li key={b.metrics.botId}>
            <motion.button
              type="button"
              className="bot-card glass"
              data-bot={b.metrics.botId}
              onClick={() => { press(); onOpen(b.metrics.botId); }}
              whileTap={{ scale: 0.985 }}
              transition={{ type: 'spring', bounce: 0, visualDuration: 0.22 }}
            >
              <header>
                <TokenMark symbol={b.base} size={28} />
                <div>
                  <motion.strong layoutId={`pair-${b.metrics.botId}`}>{b.pair}</motion.strong>
                  <em>{b.dex} · {b.chain} · {b.metrics.kind} · {b.metrics.mode} · {b.metrics.status}</em>
                </div>
                <i className={`status-ring tone-${b.tone}`} title={b.metrics.status} />
              </header>
              {b.spark.length > 1 && <Spark points={b.spark} />}
              <RangeTrack range={b.metrics.range} tone={b.tone} />
              <p className="card-made">
                <span>Generated</span>
                <TokenLine tokens={b.metrics.generated} usd={b.metrics.generatedUsd} />
              </p>
              <p className="usd-under">{formatUsd(b.metrics.generatedUsd, true)}</p>
            </motion.button>
          </li>
        ))}
      </ul>
    </section>
  );
}
