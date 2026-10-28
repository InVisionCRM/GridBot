import { motion } from 'motion/react';
import { useState } from 'react';
import { TokenMark } from '../ui/icons';
import type { View } from '../ui/model';
import { ActivityTape } from './activity-tape';
import { CandlePane } from './candle-pane';
import { figureAtoms, heroFigureText, normFigure, projectedLines, sheetRows } from './figures';
import { formatPx, formatStamp, formatUsd, pct, shortenFigures, showsNoFills } from './format';
import { LpRangeSlot } from './lp-range-slot';
import type { ActivityItem, BotDesk, BotMetrics, TapePrice, TokenQty } from './metrics';
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

function EstCell({ label, tokens, usd }: { label: string; tokens: TokenQty[] | null; usd: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{tokens == null ? '—' : <TokenLine tokens={tokens} />}</dd>
      {usd && <small>{usd}</small>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <li><span>{label}</span><b>{value}</b></li>;
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
  const [projected, setProjected] = useState(breakdown === 'projected');
  const [span, setSpan] = useState<RangeKey>('ALL');
  const phone = usePhone();
  const m = bot.metrics;
  const timed = bot.candles.length > 0 && bot.candles.every((c) => c.t > 0);
  const candles = candlesInRange(bot.candles, span, m.asOf);
  const formula = 'Value change incl. price = generated + price change';
  const beside = `${activity.map((a) => shortenFigures(a.text)).join('\n')} ${prices.map((p) => formatPx(p.price)).join(' ')}`;
  const totalText = shot ? formatUsd(shot.totalPnlUsd, true) : '';
  const totalRepeats = shot != null && totalText !== '—' && figureAtoms(heroFigureText(shot)).some((atom) => normFigure(atom) === normFigure(totalText));
  const totalShown = shot != null && totalText !== '—' && !totalRepeats;
  const rows = shot ? sheetRows(shot, `${beside} ${totalShown ? totalText : ''}`) : [];
  const pace = shot ? projectedLines(shot.est, [heroFigureText(shot), totalShown ? totalText : '', beside, rows.map((r) => r.value).join(' ')].join(' ')) : [];
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
        <dl className="ests">
          <EstCell label="D7" tokens={null} usd={null} />
          <EstCell label="D365" tokens={null} usd={null} />
        </dl>
        {m.est.needs && <p className="muted small">{m.est.needs}</p>}
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
            {totalShown && (
              <p className="sheet-eq">
                <span>Value change incl. price</span>
                <small title={formula}>{totalText}</small>
              </p>
            )}
            {totalRepeats && <p className="muted small" title={formula}>Value change incl. price is the generated dollars above.</p>}
            <ul className="break">
              {rows.map((row) => <Row key={row.label} label={row.label} value={row.value} />)}
            </ul>
            <p className="sheet-eq">
              <button type="button" className="text-btn" aria-expanded={projected} onClick={() => setProjected((v) => !v)}>
                {projected ? 'Hide projected' : 'Projected'}
              </button>
            </p>
            {projected && (
              <>
                <dl className="ests">
                  {pace.map((line) => <EstCell key={line.label} label={line.label} tokens={line.tokens} usd={line.usd} />)}
                </dl>
                <p className="muted small">Pace so far, extended. Not a forecast.</p>
              </>
            )}
            <p className="muted small" title={shot.calc}>{shot.calc}</p>
            {shot.kind === 'lp' && <LpRangeSlot pair={bot.pair} />}
            <button type="button" className="text-btn" onClick={() => openClassic(classicView(shot))}>Open the classic page</button>
          </motion.aside>
        </div>
      )}
    </div>
  );
}
