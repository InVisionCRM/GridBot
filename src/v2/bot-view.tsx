import { motion } from 'motion/react';
import { useState } from 'react';
import { TokenMark } from '../ui/icons';
import type { View } from '../ui/model';
import { CandlePane } from './candle-pane';
import { formatAge, formatTokenLine, formatUsd, pct } from './format';
import { LpRangeSlot } from './lp-range-slot';
import type { BotDesk, BotMetrics, EstimateBlock, TokenQty } from './metrics';
import { press } from './press';
import { RangeTrack } from './range-track';
import { RollingPct, RollingUsd } from './rolling-number';
import { TokenLine } from './tokens';

function openClassic(view: View) {
  try { localStorage.setItem('view', JSON.stringify(view)); } catch { /* storage unavailable */ }
  location.href = '/?classic=1';
}

function classicView(m: BotMetrics): View {
  if (m.kind === 'grid' || m.kind === 'trend' || m.kind === 'lp') return { v: m.kind, id: m.botId };
  return { v: 'tools', tab: 'chart' };
}

function Money({ value, sign = false }: { value: number | null; sign?: boolean }) {
  if (value == null) return <>—</>;
  return <RollingUsd value={value} sign={sign} />;
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
          <p>{bot.dex} · {bot.chain} · {m.kind} · {m.mode} · {m.status}</p>
        </div>
        <i className={`status-ring tone-${bot.tone}`} title={m.status} />
      </header>
      <section className="stat-strip glass" aria-label="Generated">
        <p className="eyebrow">Generated</p>
        <div className="hero-gen"><TokenLine tokens={m.generated} usd={m.generatedUsd} /></div>
        <p className="usd-under">{m.generatedUsd == null ? '—' : <RollingUsd value={m.generatedUsd} rollIn />}</p>
        <dl className="ests">
          <div>
            <dt>APR</dt>
            <dd>{m.aprPct == null ? '—' : <RollingPct value={m.aprPct} />}</dd>
          </div>
        </dl>
        <Estimates est={m.est} />
      </section>
      {bot.candles.length > 1 && (
        <CandlePane candles={bot.candles} levels={bot.levels} range={m.range} fills={bot.fills} flashLevel={bot.flashLevel} />
      )}
      <RangeTrack range={m.range} tone={bot.tone} />
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
              Total P&L <Money value={m.totalPnlUsd} sign /> = generated <Money value={m.generatedUsd} sign /> + price change <Money value={m.priceChangeUsd} sign />
            </p>
            <ul className="break">
              <Row label="Price change" value={formatUsd(m.priceChangeUsd, true)} />
              <Row label="Value" value={formatUsd(m.currentValueUsd, false)} />
              <Row label="Deposited" value={formatUsd(m.capitalInUsd, false)} />
              <Row label="Fees collected" value={m.feesCollected.length ? `${formatTokenLine(m.feesCollected)} · ${formatUsd(m.feesCollectedUsd, false)}` : formatUsd(m.feesCollectedUsd, false)} />
              <Row label="Fees owed" value={m.feesOwed.length ? `${formatTokenLine(m.feesOwed)} · ${formatUsd(m.feesUncollectedUsd, false)}` : formatUsd(m.feesUncollectedUsd, false)} />
              <Row label="Gas" value={formatUsd(m.gasUsd, false)} />
              <Row label="Swap fees" value={formatUsd(m.swapCostUsd, false)} />
              <Row label="Taxes" value={formatUsd(m.tokenTaxesUsd, false)} />
              <Row label="Rebalance loss" value={formatUsd(m.realizedRebalanceLossUsd, false)} />
              {m.kind !== 'lp' && <Row label="Realized trade profit" value={formatUsd(m.realizedUsd, true)} />}
              <Row label="APR" value={m.aprPct == null ? '—' : pct(m.aprPct, 1, true)} />
              <Row label="Age" value={formatAge(m.ageSec)} />
              <Row label="Moves" value={m.moveCount == null ? '—' : String(m.moveCount)} />
              <Row label="Fills" value={m.fillCount == null ? '—' : String(m.fillCount)} />
              {m.range && (
                <>
                  <Row label="Range lower" value={String(m.range.lower)} />
                  <Row label="Range upper" value={String(m.range.upper)} />
                  <Row label="In range" value={m.range.inRange ? 'yes' : 'no'} />
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
