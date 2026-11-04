/**
 * Charts of days and hours, from the server's per-bot figures (no money worked out here, only where it is drawn):
 *  - Calendar ("Day by day"; no "30 days" on a page, which reads as a month's estimate): the last 30 days of Generated, one square a day, brighter for a better day, coral for a losing one
 *    (bot.daily, metrics/daily.ts). Hover or tap a square for that day's figure per coin.
 *  - TodayByBot: Home's bars of today per hour, each split by bot (bot.todayHours, metrics/todayHours.ts).
 *  - LevelHeat: the grid page's levels, longer for more round trips today (bot.levelHeat), with the price among them.
 * Squares and bars are sized in dollars where a bot has a rate (they add coins together); the figures shown are coins.
 */
import { useMemo, useState } from 'react';
import { qty } from './fmt';
import type { AnyObj } from './model';
import type { DayResult } from '../metrics/daily';

const DAY = 86_400_000;
const keyOf = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const coinsText = (g: Record<string, number>) => Object.entries(g).filter(([, v]) => v !== 0).map(([sym, v]) => qty(v, sym, 4)).join(' · ') || 'nothing';
const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** Adds bots' days together, per date: coins per coin, dollars where every bot that day has them. */
export function sumDays(lists: DayResult[][]): DayResult[] {
  const by = new Map<string, DayResult>();
  for (const list of lists) for (const r of list) {
    const cur = by.get(r.d) ?? { d: r.d, from: r.from, gen: {}, usd: 0 };
    for (const [sym, v] of Object.entries(r.gen)) cur.gen[sym] = (cur.gen[sym] ?? 0) + v;
    cur.usd = cur.usd == null || r.usd == null ? null : cur.usd + r.usd;
    cur.from = Math.max(cur.from, r.from);
    by.set(r.d, cur);
  }
  return [...by.values()].sort((a, b) => a.d.localeCompare(b.d));
}

/** The day's size for its colour: dollars, or the coin when a bot has one coin and no rate; null = no figure. */
function score(r: DayResult | undefined): number | null {
  if (!r) return null;
  if (r.usd != null) return r.usd;
  const e = Object.values(r.gen);
  return e.length === 1 ? e[0] : null;
}

export function Calendar({ days, title = 'Day by day', hint }: { days: DayResult[]; title?: string; hint?: string }) {
  const [on, setOn] = useState<number | null>(null);
  const now = Date.now();
  const cells = useMemo(() => {
    const by = new Map(days.map((r) => [r.d, r]));
    return Array.from({ length: 30 }, (_, i) => { const t = now - (29 - i) * DAY; return { t, r: by.get(keyOf(t)) }; });
  }, [days, now]);
  const top = Math.max(0, ...cells.map((c) => Math.abs(score(c.r) ?? 0)));
  const shade = (v: number | null) => {
    if (v == null) return 'none';
    if (v < 0) return 'loss';
    const k = top > 0 ? v / top : 0;
    return k > 0.66 ? 'l4' : k > 0.33 ? 'l3' : k > 0.05 ? 'l2' : v > 0 ? 'l1' : 'zero';
  };
  const c = on != null ? cells[on] : null;
  return (
    <section className="card cal-card" data-testid="calendar">
      <div className="card-head"><h3>{title}</h3><span className="muted small">{hint ?? 'Generated each day, the last month · hover or tap a day'}</span></div>
      <div className="cal" onMouseLeave={() => setOn(null)}>
        {cells.map((x, i) => (
          <button key={i} type="button" className={`cal-d ${shade(score(x.r))} ${on === i ? 'on' : ''} ${i === 29 ? 'today' : ''}`} aria-label={new Date(x.t).toDateString()}
            onMouseEnter={() => setOn(i)} onFocus={() => setOn(i)} onClick={() => setOn(on === i ? null : i)} style={{ animationDelay: `${i * 0.015}s` }} />
        ))}
      </div>
      <div className="cal-foot">
        {c ? <span className="cal-tip" role="status">
          <b>{new Date(c.t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{on === 29 ? ' (today, so far)' : ''}</b>
          {c.r ? <> {coinsText(c.r.gen)}{new Date(c.r.from).getHours() * 60 + new Date(c.r.from).getMinutes() > 10 ? <span className="muted"> · from {hhmm(c.r.from)}</span> : null}</> : <span className="muted"> no reading that day</span>}
        </span> : <span className="cal-legend">less <i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> more · <i className="loss" /> a losing day · <i className="none" /> no reading</span>}
      </div>
    </section>
  );
}

const PALETTE = ['#5CD08D', '#5B8DEF', '#F5B841', '#F2706B', '#9B8CF2', '#4FC1D9', '#E94BD1'];

/** Home: today per hour, each bar split by bot (dollars for the height; each bot's own coin on hover). */
export function TodayByBot({ bots }: { bots: AnyObj[] }) {
  const [on, setOn] = useState<number | null>(null);
  const rows = bots.filter((b) => Array.isArray(b.todayHours) && b.todayHours.length && typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0);
  const left = bots.filter((b) => Array.isArray(b.todayHours) && b.todayHours.length && !(typeof b.usdPerQuote === 'number' && b.usdPerQuote > 0)).length;
  const hours: number[] = rows[0]?.todayHours.map((h: [number, number | null]) => h[0]) ?? [];
  const sym = (b: AnyObj) => String(b.quoteSym ?? b.quote ?? '').split(':').pop()!.split('/').pop()!;
  const name = (b: AnyObj) => b.label ?? b.name ?? b.id;
  const cell = (b: AnyObj, i: number) => (b.todayHours[i]?.[1] ?? null) as number | null;
  const usdAt = (b: AnyObj, i: number) => Math.max(0, (cell(b, i) ?? 0) * b.usdPerQuote);
  const top = Math.max(0, ...hours.map((_, i) => rows.reduce((a, b) => a + usdAt(b, i), 0)));
  if (!rows.length) return <p className="muted small dk-empty-s">Each bot's hours show here once it has run today{left ? ` (${left} without a dollar rate yet)` : ''}.</p>;
  return (
    <div className="tbb" data-testid="today-by-bot">
      <div className="tbb-bars" onMouseLeave={() => setOn(null)}>
        {Array.from({ length: 24 }, (_, i) => (
          <button key={i} type="button" className={`tbb-col ${i >= hours.length ? 'future' : ''} ${on === i ? 'on' : ''}`} disabled={i >= hours.length}
            onMouseEnter={() => setOn(i)} onFocus={() => setOn(i)} onClick={() => setOn(on === i ? null : i)}>
            {i < hours.length && rows.map((b, k) => { const v = usdAt(b, i); return v > 0 ? <span key={b.id} style={{ height: `${top > 0 ? (v / top) * 100 : 0}%`, background: PALETTE[k % PALETTE.length], animationDelay: `${i * 0.02}s` }} /> : null; })}
          </button>
        ))}
      </div>
      <div className="tbb-foot">
        {on != null && hours[on] != null ? (
          <span className="tbb-tip" role="status"><b>{hhmm(hours[on])}–{hhmm(hours[on] + 3_600_000)}</b>
            {rows.map((b, k) => { const v = cell(b, on); return v ? <span key={b.id}><i style={{ background: PALETTE[k % PALETTE.length] }} />{name(b)} {qty(v, sym(b), 4)}</span> : null; })}
          </span>
        ) : (
          <span className="tbb-keys">{rows.map((b, k) => <span key={b.id}><i style={{ background: PALETTE[k % PALETTE.length] }} />{name(b)}</span>)}{left ? <span className="muted">· {left} without a dollar rate left out</span> : null}</span>
        )}
      </div>
    </div>
  );
}

/** Grid page: each level (lowest = 1), its bar as long as its round trips today, and the price among the levels. */
export function LevelHeat({ g }: { g: AnyObj }) {
  const ivs = ((g.intervals ?? []) as AnyObj[]).slice().sort((a, b) => b.buyPrice - a.buyPrice);
  if (!ivs.length) return null;
  const heat = (g.levelHeat ?? {}) as Record<number, number>;
  const top = Math.max(1, ...Object.values(heat));
  const total = Object.values(heat).reduce((a, n) => a + n, 0);
  const price = g.price as number | null;
  const n = ivs.length;
  return (
    <section className="card heat-card" data-testid="level-heat">
      <div className="card-head"><h3>Level heat · today</h3><span className="muted small">{total ? `${total === 1 ? 'one round trip' : `${total} round trips`} today · hover a level for its prices` : 'no round trip yet today'}</span></div>
      <div className="heat">
        {ivs.map((iv, i) => {
          const c = heat[iv.index] ?? 0;
          const priceHere = price != null && price < iv.sellPrice && price >= iv.buyPrice;
          return (
            <div key={iv.index} className={`heat-row ${priceHere ? 'here' : ''}`} title={`buys at ${iv.buyPrice}, sells at ${iv.sellPrice}`}>
              <span className="heat-n">L{n - i}</span>
              <span className="heat-track"><b style={{ width: `${(c / top) * 100}%`, animationDelay: `${i * 0.03}s` }} className={c / top > 0.66 ? 'hot' : c / top > 0.33 ? 'warm' : ''} /></span>
              <span className="heat-c">{c ? `${c}×` : ''}{priceHere ? <em> price here</em> : null}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
