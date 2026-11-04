/**
 * The live ticker: the latest fills, fees, range moves and sends of every bot, scrolling under the header.
 * Not on Home, whose Live card lists the same events (a figure once per screen), and on a bot's page it leaves out
 * that bot's own events, which its log lists. Hover pauses it.
 */
import type { ActivityEvent } from './useStream';

const TYPES = new Set(['filled', 'range', 'sent', 'alert']);
const SHOWN = 12;

export function Ticker({ events, skipBot }: { events: ActivityEvent[]; skipBot: string | null }) {
  const rows = events.filter((e) => TYPES.has(e.type) && (skipBot == null || e.botId !== skipBot)).slice(-SHOWN).reverse();
  if (!rows.length) return null;
  const run = rows.map((e) => (
    <span key={e.id} className={`tick-ev ${e.level === 'success' ? 'pos' : e.level === 'error' ? 'neg' : e.level === 'warn' ? 'warn-t' : ''}`}>{e.msg}</span>
  ));
  return (
    <div className="ticker" aria-label="Latest activity" data-testid="ticker">
      {/* the run twice, so the loop has no gap; the copy is hidden from screen readers */}
      <div className="ticker-run" style={{ animationDuration: `${Math.max(20, rows.length * 7)}s` }}>
        <span className="ticker-set">{run}</span>
        <span className="ticker-set" aria-hidden="true">{run}</span>
      </div>
    </div>
  );
}
