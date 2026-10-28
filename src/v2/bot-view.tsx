import { motion } from 'motion/react';
import { useState } from 'react';
import { CoinMark } from './coin-mark';
import type { View } from '../ui/model';
import { ActivityTape } from './activity-tape';
import { CandlePane } from './candle-pane';
import { estimatesVisible, hasEarnings, hasGenerated, ledgerLines, sheetRows } from './figures';
import { formatBag, formatQuotePx, formatStamp, shortenFigures } from './format';
import { LpRangeSlot } from './lp-range-slot';
import type { ActivityItem, BotDesk, BotMetrics, TapePrice } from './metrics';
import { PairTitle } from './pair-label';
import { press } from './press';
import { candlesInRange, RangeSelect, type RangeKey } from './range-tabs';
import { RangeTrack } from './range-track';
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

function Row({ label, value }: { label: string; value: string }) {
  const est = label.startsWith('Est.');
  const total = label === 'Generated';
  return <li><span>{label}</span><b {...(est ? { 'data-est': '' } : {})} {...(total ? { 'data-ledger': '' } : {})}>{value}</b></li>;
}

export function BotView({
  bot, activity, prices = [], onBack, onActivity,   breakdown = false,
  showFeed = true,
}: {
  bot: BotDesk;
  activity: ActivityItem[];
  prices?: TapePrice[];
  onBack: () => void;
  onActivity: () => void;
  /** Opens the breakdown sheet. `projected` also opens the pace toggle. */
  breakdown?: boolean | 'projected';
  /** Desktop hides this feed in CSS and shows the side tape instead. */
  showFeed?: boolean;
}) {
  const [shot, setShot] = useState<BotMetrics | null>(() => (breakdown ? structuredClone(bot.metrics) : null));
  const [span, setSpan] = useState<RangeKey>('ALL');
  const m = bot.metrics;
  const timed = bot.candles.length > 0 && bot.candles.every((c) => c.t > 0);
  const candles = candlesInRange(bot.candles, span, m.asOf);
  const [shownBase, shownQuote] = bot.pair.split('/');
  const beside = `${activity.map((a) => shortenFigures(a.text).replace(/\$/g, '')).join('\n')} ${prices.map((p) => formatQuotePx(p.price, p.symbol.split('/')[1] || '')).join(' ')}`;
  const rows = shot ? sheetRows(shot, { base: shownBase || bot.base, quote: shownQuote || bot.quote }, beside) : [];
  const day = m.est.d1;
  const showEst = estimatesVisible(m);
  return (
    <div className="bot-page" data-bot={m.botId}>
      <button type="button" className="text-btn" onClick={() => { press(); onBack(); }}>Home</button>
      <header className="bot-head">
        <CoinMark symbol={bot.base} size={36} />
        <div>
          <motion.h1 layoutId={`pair-${m.botId}`}><PairTitle pair={bot.pair} chainName={bot.chainName} dex={bot.dex} /></motion.h1>
          <p>{m.kind} · {m.mode === 'paper' ? 'Paper' : 'Live'}</p>
        </div>
        <StatusMark tone={bot.tone} status={m.status} />
      </header>
      <section className="stat-strip glass" aria-label="Generated">
        <p className="eyebrow">Invested</p>
        <p className="hero-rate">{formatBag(m.invested)}</p>
        <p className="eyebrow">Generated</p>
        {hasGenerated(m) ? (
          <div className="hero-gen">{ledgerLines(m)?.generated ?? <TokenHeadline tokens={m.generated} />}</div>
        ) : (
          <>
            <div className="hero-gen">—</div>
            <p className="muted small">Not calculated yet</p>
          </>
        )}
        {showEst && (
          <>
            <p className="hero-rate" data-est="">
              {day?.length ? <TokenLine tokens={day} /> : '—'}
              <span>Est. 24H</span>
            </p>
            <p className="muted small">Estimate, not a forecast.</p>
          </>
        )}
        {!hasEarnings(m) && m.status !== 'closed' && m.status !== 'stopped' && (
          <p className="muted small">No earnings yet, so no estimate.</p>
        )}
      </section>
      <div className={candles.length > 1 ? 'chart-frame' : 'chart-frame is-empty'}>
        <RangeSelect value={span} onChange={setSpan} timed={timed} />
        {candles.length > 1
          ? <CandlePane candles={candles} levels={bot.levels} fills={bot.fills} flashLevel={bot.flashLevel} />
          : <p className="curve-empty">Chart fills in as history builds</p>}
        <div className="range-on-chart">
          <RangeTrack range={m.range} tone={bot.tone} />
        </div>
      </div>
      <button type="button" className="v2-btn" data-open="breakdown" onClick={() => { press(); setShot(structuredClone(m)); }}>Breakdown</button>
      {showFeed && (
        <section className="bot-feed">
          <header>
            <h2>Activity</h2>
            <button type="button" className="text-btn" onClick={() => { press(); onActivity(); }}>All activity</button>
          </header>
          <ActivityTape items={activity} />
        </section>
      )}
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
            <ul className="break">
              {rows.filter((row) => row.label !== 'Note').map((row) => <Row key={row.label} label={row.label} value={row.value} />)}
            </ul>
            {rows.some((row) => row.label === 'Note') && (
              <p className="sheet-notes">{rows.filter((row) => row.label === 'Note').map((row) => <span key={row.value}>{row.value}</span>)}</p>
            )}
            {showEst && <p className="muted small">Estimate, not a forecast.</p>}
            {shot.kind === 'lp' && <LpRangeSlot pair={bot.pair} closed={m.status === 'closed' || m.status === 'stopped'} />}
            <button type="button" className="text-btn" onClick={() => openClassic(classicView(shot))}>Open the classic page</button>
          </motion.aside>
        </div>
      )}
    </div>
  );
}
