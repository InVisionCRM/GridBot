/**
 * Draw the lines a trend bot trades on: trend lines (two clicks) and levels (one click) on the market's chart, each
 * with a rule that says what it does when a closed candle meets it. Lines can be dragged afterwards. Used in New bot,
 * Backtest and on a running bot.
 */
import { useEffect, useState } from 'react';
import { LINE_RULES, MAX_LINES, type DrawnLine, type LineRule } from '../market/strategy';
import type { Candle, TF } from '../market/candles';
import { Chart } from './Chart';
import { px, time } from './fmt';
import { defaultRule, lineColor, lineDashed } from './lines';
import { Tip } from './Tip';
import type { Ticks } from './useStream';
import type { AnyObj } from './model';

const newId = () => `ln-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function LinesEditor({ s, ticks = null, pair, tf, lines, onChange, busy = false, height = 380 }: {
  s: AnyObj; ticks?: Ticks | null; pair: string; tf: TF; lines: DrawnLine[]; onChange: (lines: DrawnLine[]) => void; busy?: boolean; height?: number;
}) {
  const [mode, setMode] = useState<'level' | 'trend' | null>(null);
  // An edit shows at once; on a running bot it is saved first, and the saved lines replace it when the save is done
  // (or the old lines come back if it failed).
  const [draft, setDraft] = useState<DrawnLine[] | null>(null);
  useEffect(() => { if (!busy) setDraft(null); }, [busy, lines]);
  const shown = draft ?? lines;
  const commit = (next: DrawnLine[]) => { setDraft(next); onChange(next); };
  const full = shown.length >= MAX_LINES;
  const add = (g: Pick<DrawnLine, 'kind' | 'a' | 'b'>, last: Candle) => {
    commit([...shown, { id: newId(), ...g, rule: defaultRule(g, last) }]);
    setMode(null);
  };
  const edit = (id: string, patch: Partial<DrawnLine>) => commit(shown.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const buys = shown.filter((l) => l.rule.startsWith('buy')).length;

  return (
    <div className="lines-ed">
      <div className="lines-bar">
        <strong>Your lines</strong>
        <Tip>
          Draw on the chart. A <b>trend line</b> takes two clicks and carries on to the right; a <b>level</b> is one click (support or
          resistance). Each point lands exactly where you click, and the line follows the pointer while you draw. Drag a line to move it, or drag
          either end of a trend line to change its angle; levels move up and down. Each line does one thing when a closed {tf} candle meets it: buy
          when a candle closes above it, buy when the price dips to it and closes back above, sell when a candle closes below it, or sell when the
          price reaches it. Green lines buy, red lines sell; dashed ones need a touch, solid ones a close through. A trend line only trades from its
          second point on. Stop-loss, take-profit and the cost check still apply.
        </Tip>
        <div className="seg">
          <button type="button" className={mode === 'trend' ? 'on' : ''} disabled={busy || full} onClick={() => setMode(mode === 'trend' ? null : 'trend')}>╱ Trend line</button>
          <button type="button" className={mode === 'level' ? 'on' : ''} disabled={busy || full} onClick={() => setMode(mode === 'level' ? null : 'level')}>─ Level</button>
        </div>
        {/* One button, as wide as its longer label, and the note on its own line: the bar keeps its height whatever the
            state, so the chart never shifts under the pointer between clicks. */}
        <button type="button" className="btn small-btn lines-act" disabled={!mode && (busy || !shown.length)}
          onClick={() => (mode ? setMode(null) : confirm('Remove every line?') && commit([]))}>
          <span className={mode ? '' : 'off'}>Cancel</span><span className={mode ? 'off' : ''}>Clear all</span>
        </button>
        <span className="lines-msg muted small">{full ? `${MAX_LINES} lines is the most` : buys ? '' : 'Draw at least one line that buys.'}</span>
      </div>
      <Chart status={s} ticks={ticks} pairs={[pair]} pair={pair} tf={tf} height={height} compact drawn={shown} drawMode={mode} onDraw={add}
        onMove={busy ? undefined : (id, g) => edit(id, g)} />
      {shown.length > 0 && (
        <ol className="lines-list">
          {shown.map((l, i) => (
            <li key={l.id}>
              <span className="ln-swatch" style={{ borderColor: lineColor(l.rule), borderStyle: lineDashed(l.rule) ? 'dashed' : 'solid' }} aria-hidden />
              <span className="ln-n">{i + 1}</span>
              <span className="ln-what">
                {l.kind === 'level'
                  ? <>Level <input key={l.a.p} className="ln-px" inputMode="decimal" aria-label={`line ${i + 1} price`} defaultValue={String(+l.a.p.toPrecision(6))} disabled={busy}
                      onBlur={(e) => { const v = +e.target.value; if (v > 0 && v !== l.a.p) edit(l.id, { a: { ...l.a, p: v } }); }} /></>
                  : <>Trend line {px(l.a.p)} <span className="muted">({time(l.a.t * 1000)})</span> → {px(l.b!.p)} <span className="muted">({time(l.b!.t * 1000)})</span></>}
              </span>
              <select value={l.rule} disabled={busy} aria-label={`line ${i + 1} rule`} onChange={(e) => edit(l.id, { rule: e.target.value as LineRule })}>
                {LINE_RULES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              <button type="button" className="ln-x" disabled={busy} aria-label={`remove line ${i + 1}`} onClick={() => commit(shown.filter((x) => x.id !== l.id))}>×</button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
