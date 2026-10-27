import { motion } from 'motion/react';
import { useState } from 'react';
import { TokenMark } from '../ui/icons';
import type { View } from '../ui/model';
import { ActivityTape } from './activity-tape';
import { CandlePane } from './candle-pane';
import { formatAge, formatStamp, formatTokenLine, formatUsd, pct, shortenFigures, showsNoFills } from './format';
import { LpRangeSlot } from './lp-range-slot';
import type { ActivityItem, BotDesk, BotMetrics, EstimateBlock, TokenQty } from './metrics';
import { usePhone } from './motion';
import { PairLabel } from './pair-label';
import { press } from './press';
import { candlesInRange, RangeSelect, type RangeKey } from './range-tabs';
import { RangeTrack } from './range-track';
import { RollingPct } from './rolling-number';
import { StatusMark } from './status-mark';
import { TokenHeadline, TokenLine } from './tokens';

function openClassic(view: View) {
  try { localStorage.setItem('view', JSON.stringify(view)); } catch { /* storage unavailable */ }
  location.href = '/?classic=1';
}

function classicView(m: BotMetrics): View {
  if (m.kind === 'grid' || m.kind === 'trend' || m.kind === 'lp') return { v: m.kind, id: m.botId };
  return { v: 'tools', tab: 'chart' };
}

function EstCell({ label, tokens, usd }: { label: string; tokens: TokenQty[] | null; usd: number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><TokenLine tokens={tokens} usd={usd} /></dd>
      <small>{tokens == null ? '' : formatUsd(usd, true)}</small>
    </div>
  );
}

function Estimates({ est }: { est: EstimateBlock }) {
  return (
    <>
      <dl className="ests">
        <EstCell label="D1" tokens={est.d1} usd={est.usd.d1} />
        <EstCell label="D7" tokens={est.d7} usd={est.usd.d7} />
        <EstCell label="D365" tokens={est.d365} usd={est.usd.d365} />
      </dl>
      <p className="muted small">{est.needs}</p>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <li><span>{label}</span><b>{value}</b></li>;
}

export function BotView({
  bot, activity, onBack, onActivity,
}: {
  bot: BotDesk;
  activity: ActivityItem[];
  onBack: () => void;
  onActivity: () => void;
}) {
  const [shot, setShot] = useState<BotMetrics | null>(null);
  const [span, setSpan] = useState<RangeKey>('ALL');
  const phone = usePhone();
  const m = bot.metrics;
  const candles = candlesInRange(bot.candles, span, m.asOf);
  const formula = 'Total P&L = generated + price change';
  return (
    <div className="bot-page" data-bot={m.botId}>
      <button type="button" className="text-btn" onClick={() => { press(); onBack(); }}>Home</button>
      <header className="bot-head">
        <TokenMark symbol={bot.base} size={36} />
        <div>
          <motion.h1 layoutId={`pair-${m.botId}`}><PairLabel pair={bot.pair} chain={bot.chain} /></motion.h1>
          <p>{bot.dex} · {m.kind} · {m.mode}</p>
        </div>
        <StatusMark tone={bot.tone} status={m.status} />
      </header>
      <section className="stat-strip glass" aria-label="Generated">
        <p className="eyebrow">Generated</p>
        {showsNoFills(m) ? <div className="hero-gen">No fills yet</div> : (
          <>
            <div className="hero-gen"><TokenHeadline tokens={m.generated} usd={m.generatedUsd} /></div>
            <p className="hero-rate">
              {m.est.d1 == null ? '—' : m.est.d1.length ? <TokenLine tokens={m.est.d1} /> : '0'}
              <span>/day</span>
            </p>
            <p className="usd-under">
              {m.generatedUsd == null ? '—' : `≈ ${formatUsd(m.generatedUsd, false)}`}
              {' · '}
              {m.est.usd.d1 == null ? '—' : `${formatUsd(m.est.usd.d1, false)}/day`}
            </p>
          </>
        )}
        <dl className="ests">
          <div>
            <dt>APR</dt>
            <dd>{m.aprPct == null ? '—' : phone ? pct(m.aprPct, 1, true) : <RollingPct value={m.aprPct} />}</dd>
          </div>
        </dl>
        <Estimates est={m.est} />
      </section>
      <div className={candles.length > 1 ? 'chart-frame' : 'chart-frame is-empty'}>
        <RangeSelect value={span} onChange={setSpan} />
        {candles.length > 1
          ? <CandlePane candles={candles} levels={bot.levels} fills={bot.fills} flashLevel={bot.flashLevel} />
          : <p className="curve-empty">Chart fills in as history builds</p>}
        <div className="range-on-chart">
          <RangeTrack range={m.range} tone={bot.tone} />
        </div>
      </div>
      <button type="button" className="v2-btn" data-open="breakdown" onClick={() => { press(); setShot(structuredClone(m)); }}>Breakdown</button>
      <section className="bot-feed">
        <header>
          <h2>Activity</h2>
          <button type="button" className="text-btn" onClick={() => { press(); onActivity(); }}>All activity</button>
        </header>
        <ActivityTape items={activity} />
      </section>
      {shot && (
        <div className="sheet-back" onClick={() => setShot(null)}>
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
              <button type="button" className="text-btn" data-close="sheet" onClick={() => setShot(null)}>Close</button>
            </header>
            <p className="muted small">Snapshot · {formatStamp(shot.asOf)}</p>
            <p className="sheet-eq">
              Total P&L <b title={formula}>{formatUsd(shot.totalPnlUsd, true)}</b>
            </p>
            <ul className="break">
              <Row label="Price change" value={formatUsd(shot.priceChangeUsd, true)} />
              <Row label="Value" value={formatUsd(shot.currentValueUsd, false)} />
              <Row label="Deposited" value={formatUsd(shot.capitalInUsd, false)} />
              <Row label="Fees collected" value={shot.feesCollected.length ? `${formatTokenLine(shot.feesCollected)} · ${formatUsd(shot.feesCollectedUsd, false)}` : formatUsd(shot.feesCollectedUsd, false)} />
              <Row label="Fees owed" value={shot.feesOwed.length ? `${formatTokenLine(shot.feesOwed)} · ${formatUsd(shot.feesUncollectedUsd, false)}` : formatUsd(shot.feesUncollectedUsd, false)} />
              <Row label="Gas" value={formatUsd(shot.gasUsd, false)} />
              <Row label="Swap fees" value={formatUsd(shot.swapCostUsd, false)} />
              <Row label="Taxes" value={formatUsd(shot.tokenTaxesUsd, false)} />
              <Row label="Rebalance loss" value={formatUsd(shot.realizedRebalanceLossUsd, false)} />
              {shot.kind !== 'lp' && <Row label="Realized trade profit" value={formatUsd(shot.realizedUsd, true)} />}
              <Row label="APR" value={shot.aprPct == null ? '—' : pct(shot.aprPct, 1, true)} />
              <Row label="Age" value={formatAge(shot.ageSec)} />
              <Row label="Moves" value={shot.moveCount == null ? '—' : String(shot.moveCount)} />
              <Row label="Fills" value={shot.fillCount == null ? '—' : String(shot.fillCount)} />
              {shot.range && (
                <>
                  <Row label="Range lower" value={shortenFigures(String(shot.range.lower))} />
                  <Row label="Range upper" value={shortenFigures(String(shot.range.upper))} />
                  <Row label="In range" value={shot.range.inRange ? 'yes' : 'no'} />
                </>
              )}
            </ul>
            <p className="muted small" title={shot.calc}>{shot.calc}</p>
            {shot.kind === 'lp' && <LpRangeSlot pair={bot.pair} />}
            <button type="button" className="text-btn" onClick={() => openClassic(classicView(shot))}>Open the classic page</button>
          </motion.aside>
        </div>
      )}
    </div>
  );
}
