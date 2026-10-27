import { motion } from 'motion/react';
import { TokenMark } from '../ui/icons';
import { EquityCurve, Spark } from './equity-curve';
import { pct, usd } from './format';
import type { BotDesk, PortfolioSnapshot, TapePrice } from './metrics';
import { RangeTrack } from './range-track';
import { RollingUsd } from './rolling-number';
import { press } from './press';

export function Ticker({ prices }: { prices: TapePrice[] }) {
  const loop = prices.length ? [...prices, ...prices] : [];
  return (
    <div className="ticker" aria-label="Pairs">
      <div className="ticker-track">
        {loop.map((p, i) => (
          <span key={`${p.symbol}-${i}`} className={p.change24h >= 0 ? 'up' : 'down'}>
            <b>{p.symbol}</b>
            <em className="px">{usd(p.price, false)}</em>
            <em>{pct(p.change24h, 2, true)}</em>
          </span>
        ))}
      </div>
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
  return (
    <div className="home">
      <section className="hero glass">
        <p className="eyebrow">Dollars made</p>
        <div className="hero-num"><RollingUsd value={portfolio.dollarsMadeUsd} /></div>
        <p className="secondary">
          Price change <RollingUsd value={portfolio.priceChangeUsd} />
        </p>
        <p className="secondary">
          Value {usd(portfolio.currentValueUsd, false)} · deposited {usd(portfolio.capitalInUsd, false)}
        </p>
        <p className="paper-line">Paper made <RollingUsd value={portfolio.paperDollarsMadeUsd} /></p>
        <EquityCurve points={portfolio.madeSeries} />
      </section>
      <section className="strip" aria-label="Desk strip">
        <div>
          <span>Fees today</span>
          <b><RollingUsd value={portfolio.feesTodayLiveUsd} sign={false} /></b>
          <small>Paper {usd(portfolio.feesTodayPaperUsd, false)}</small>
        </div>
        <div>
          <span>Bots</span>
          <b>{portfolio.botsRunning}/{portfolio.botsTotal}</b>
          <small>running</small>
        </div>
      </section>
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
                  <em>{b.dex} · {b.chain} · {b.metrics.kind} · {b.metrics.mode}</em>
                </div>
                <i className={`status-ring tone-${b.tone}`} title={b.metrics.status} />
              </header>
              <Spark points={b.spark} />
              <RangeTrack range={b.metrics.range} tone={b.tone} />
              <p className="card-made"><span>Made</span> <RollingUsd value={b.metrics.dollarsMadeUsd} /></p>
              <p className="secondary">Price change <RollingUsd value={b.metrics.priceChangeUsd} /></p>
              <p className="secondary">Value {usd(b.metrics.currentValueUsd, false)} · deposited {usd(b.metrics.capitalInUsd, false)}</p>
            </motion.button>
          </li>
        ))}
      </ul>
    </div>
  );
}
