import { motion } from 'motion/react';
import { useState } from 'react';
import { TokenMark } from '../ui/icons';
import type { View } from '../ui/model';
import { CandlePane } from './candle-pane';
import { formatAge, pct, usd } from './format';
import { LpRangeSlot } from './lp-range-slot';
import type { BotDesk, BotMetrics } from './metrics';
import { press } from './press';
import { RangeTrack } from './range-track';
import { RollingPct, RollingUsd } from './rolling-number';

function openClassic(view: View) {
  try { localStorage.setItem('view', JSON.stringify(view)); } catch { /* storage unavailable */ }
  location.href = '/?classic=1';
}

function classicView(m: BotMetrics): View {
  if (m.kind === 'grid' || m.kind === 'trend' || m.kind === 'lp') return { v: m.kind, id: m.botId };
  return { v: 'tools', tab: 'chart' };
}

export function BotView({ bot, onBack }: { bot: BotDesk; onBack: () => void }) {
  const [sheet, setSheet] = useState(false);
  const m = bot.metrics;
  return (
    <div className="bot-page" data-bot={m.botId}>
      <button type="button" className="text-btn" onClick={() => { press(); onBack(); }}>Home</button>
      <header className="bot-head">
        <TokenMark symbol={bot.base} size={36} />
        <div>
          <motion.h1 layoutId={`pair-${m.botId}`}>{bot.pair}</motion.h1>
          <p>{bot.dex} · {bot.chain} · {m.kind} · {m.mode}</p>
        </div>
        <i className={`status-ring tone-${bot.tone}`} title={m.status} />
      </header>
      <section className="stat-strip glass" aria-label="Dollars made">
        <p className="eyebrow">Dollars made</p>
        <div className="hero-num"><RollingUsd value={m.dollarsMadeUsd} /></div>
        <p className="secondary">Price change <RollingUsd value={m.priceChangeUsd} /></p>
        <p className="secondary">Value {usd(m.currentValueUsd, false)} · deposited {usd(m.capitalInUsd, false)}</p>
        <dl className="ests">
          <div><dt>APR</dt><dd><RollingPct value={m.aprPct} /></dd></div>
          <div><dt>est. d1</dt><dd>{m.est.d1 == null ? '—' : <RollingUsd value={m.est.d1} />}</dd></div>
          <div><dt>est. d7</dt><dd>{m.est.d7 == null ? '—' : <RollingUsd value={m.est.d7} />}</dd></div>
          <div><dt>est. d365</dt><dd>{m.est.d365 == null ? '—' : <RollingUsd value={m.est.d365} />}</dd></div>
        </dl>
        <p className="muted small" title={m.calc}>{m.est.needs}</p>
      </section>
      <CandlePane candles={bot.candles} levels={bot.levels} range={m.range} fills={bot.fills} flashLevel={bot.flashLevel} />
      {(m.kind === 'lp' || m.kind === 'grid') && <RangeTrack range={m.range} tone={bot.tone} />}
      <button type="button" className="v2-btn" data-open="breakdown" onClick={() => { press(); setSheet(true); }}>Breakdown</button>
      {sheet && (
        <div className="sheet-back" onClick={() => setSheet(false)}>
          <motion.aside
            className="sheet glass"
            role="dialog"
            aria-label="Breakdown"
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 28, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', bounce: 0, visualDuration: 0.32 }}
          >
            <header>
              <h2>Breakdown</h2>
              <button type="button" className="text-btn" data-close="sheet" onClick={() => setSheet(false)}>Close</button>
            </header>
            <p className="sheet-eq">
              Total P&L <RollingUsd value={m.totalPnlUsd} /> = dollars made <RollingUsd value={m.dollarsMadeUsd} /> + price change <RollingUsd value={m.priceChangeUsd} />
            </p>
            <ul className="break">
              <li><span>Fees collected</span><b>{usd(m.feesCollectedUsd, false)}</b></li>
              <li><span>Fees owed</span><b>{usd(m.feesUncollectedUsd, false)}</b></li>
              <li><span>Gas</span><b>{usd(m.gasUsd, false)}</b></li>
              <li><span>Swap fees</span><b>{usd(m.swapCostUsd, false)}</b></li>
              <li><span>Taxes</span><b>{usd(m.tokenTaxesUsd, false)}</b></li>
              <li><span>Rebalance loss</span><b>{usd(m.realizedRebalanceLossUsd, false)}</b></li>
              {m.kind !== 'lp' && <li><span>Realized trade profit</span><b>{usd(m.realizedUsd, false)}</b></li>}
              <li><span>APR</span><b>{m.aprPct == null ? '—' : pct(m.aprPct, 1, true)}</b></li>
              <li><span>Age</span><b>{formatAge(m.ageSec)}</b></li>
              <li><span>Moves</span><b>{m.moveCount}</b></li>
              <li><span>Fills</span><b>{m.fillCount}</b></li>
              {m.range && (
                <>
                  <li><span>Range lower</span><b>{m.range.lower}</b></li>
                  <li><span>Range upper</span><b>{m.range.upper}</b></li>
                  <li><span>In range</span><b>{m.range.inRange ? 'yes' : 'no'}</b></li>
                </>
              )}
            </ul>
            <p className="muted small" title={m.calc}>{m.calc}</p>
            {m.kind === 'lp' && <LpRangeSlot pair={bot.pair} />}
            <button type="button" className="text-btn" onClick={() => openClassic(classicView(m))}>Open the classic page</button>
          </motion.aside>
        </div>
      )}
    </div>
  );
}
