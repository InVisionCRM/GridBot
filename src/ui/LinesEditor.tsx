/**
 * Draw the lines a trend bot trades on: trend lines (two clicks) and levels (one click) on the market's chart, each
 * with a rule that says what it does when a closed candle meets it. Used in New bot, Backtest and on a running bot.
 */
import { useState } from 'react';
import { LINE_RULES, MAX_LINES, lineValue, type DrawnLine, type LineRule } from '../market/strategy';
import type { Candle, TF } from '../market/candles';
import { Chart } from './Chart';
import { px, time } from './fmt';
import { lineColor, lineDashed } from './lines';
import { Tip } from './Tip';
import type { Ticks } from './useStream';
import type { AnyObj } from './model';

const newId = () => `ln-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** A new line's rule from where it sits: above the price it waits for a breakout, below it for a bounce. */
function defaultRule(g: Pick<DrawnLine, 'kind' | 'a' | 'b'>, last: Candle): LineRule {
  return lineValue({ ...g, id: '', rule: 'buy_break' }, last.t) >= last.c ? 'buy_break' : 'buy_bounce';
}

export function LinesEditor({ s, ticks = null, pair, tf, lines, onChange, busy = false, height = 380 }: {
  s: AnyObj; ticks?: Ticks | null; pair: string; tf: TF; lines: DrawnLine[]; onChange: (lines: DrawnLine[]) => void; busy?: boolean; height?: number;
}) {
  const [mode, setMode] = useState<'level' | 'trend' | null>(null);
  const full = lines.length >= MAX_LINES;
  const add = (g: Pick<DrawnLine, 'kind' | 'a' | 'b'>, last: Candle) => {
    onChange([...lines, { id: newId(), ...g, rule: defaultRule(g, last) }]);
    setMode(null);
  };
  const edit = (id: string, patch: Partial<DrawnLine>) => onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const buys = lines.filter((l) => l.rule.startsWith('buy')).length;

  return (
    <div className="lines-ed">
      <div className="lines-bar">
        <strong>Your lines</strong>
        <Tip>
          Draw on the chart. A <b>trend line</b> takes two clicks on two different candles and carries on to the right; a <b>level</b> is one click
          (support or resistance). Each line does one thing when a closed {tf} candle meets it: buy when a candle closes above it, buy when the price
          dips to it and closes back above, sell when a candle closes below it, or sell when the price reaches it. Green lines buy, red lines sell;
          dashed ones need a touch, solid ones a close through. A trend line only trades from its second point on. Stop-loss, take-profit and the
          cost check still apply.
        </Tip>
        <div className="seg">
          <button type="button" className={mode === 'trend' ? 'on' : ''} disabled={busy || full} onClick={() => setMode(mode === 'trend' ? null : 'trend')}>╱ Trend line</button>
          <button type="button" className={mode === 'level' ? 'on' : ''} disabled={busy || full} onClick={() => setMode(mode === 'level' ? null : 'level')}>─ Level</button>
        </div>
        {mode && <button type="button" className="btn small-btn" onClick={() => setMode(null)}>Cancel</button>}
        {lines.length > 0 && !mode && <button type="button" className="btn small-btn" disabled={busy} onClick={() => confirm('Remove every line?') && onChange([])}>Clear all</button>}
        <span className="muted small">{full ? `${MAX_LINES} lines is the most` : buys ? '' : 'Draw at least one line that buys.'}</span>
      </div>
      <Chart status={s} ticks={ticks} pairs={[pair]} pair={pair} tf={tf} height={height} compact drawn={lines} drawMode={mode} onDraw={add} />
      {lines.length > 0 && (
        <ol className="lines-list">
          {lines.map((l, i) => (
            <li key={l.id}>
              <span className="ln-swatch" style={{ borderColor: lineColor(l.rule), borderStyle: lineDashed(l.rule) ? 'dashed' : 'solid' }} aria-hidden />
              <span className="ln-n">{i + 1}</span>
              <span className="ln-what">
                {l.kind === 'level'
                  ? <>Level <input className="ln-px" inputMode="decimal" aria-label={`line ${i + 1} price`} defaultValue={String(+l.a.p.toPrecision(6))} disabled={busy}
                      onBlur={(e) => { const v = +e.target.value; if (v > 0 && v !== l.a.p) edit(l.id, { a: { ...l.a, p: v } }); }} /></>
                  : <>Trend line {px(l.a.p)} <span className="muted">({time(l.a.t * 1000)})</span> → {px(l.b!.p)} <span className="muted">({time(l.b!.t * 1000)})</span></>}
              </span>
              <select value={l.rule} disabled={busy} aria-label={`line ${i + 1} rule`} onChange={(e) => edit(l.id, { rule: e.target.value as LineRule })}>
                {LINE_RULES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              <button type="button" className="ln-x" disabled={busy} aria-label={`remove line ${i + 1}`} onClick={() => onChange(lines.filter((x) => x.id !== l.id))}>×</button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
