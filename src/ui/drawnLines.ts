/**
 * The trend bot's drawn lines, painted by the price chart itself (a series primitive) so they follow every pan and zoom,
 * plus the pointer handling that draws and drags them. Points sit exactly where they were clicked: lightweight-charts
 * only converts whole bars (coordinateToLogical rounds up to a bar, logicalToCoordinate returns 0 for a fraction), so the
 * position between two candles is worked out here from the bar spacing.
 */
import type {
  ChartOptions, IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, ISeriesPrimitiveAxisView, Logical,
  PrimitiveHoveredItem, SeriesAttachedParameter, Time,
} from 'lightweight-charts';
import { lineValue, type DrawnLine } from '../market/strategy';
import type { Candle } from '../market/candles';
import { defaultRule, lineColor, lineDashed, lineTitle, logicalAt, timeAt } from './lines';
import { T } from './theme';

export type Pt = { t: number; p: number };
export type Geom = Pick<DrawnLine, 'kind' | 'a' | 'b'>;
/** What a press grabbed: one end of a trend line, or a whole line (a level moves up and down). */
export type Grab = { id: string; part: 'a' | 'b' | 'line' };
type Ctx = CanvasRenderingContext2D;

/** Pixels: end handle radius, how close a press must be to an end, and to a line; a finger gets TOUCH times the reach. */
const HANDLE = 4, NEAR_END = 8, NEAR_LINE = 5, TOUCH = 3;

/** A trend line from two points, earlier point first. */
const ordered = (p: Pt, q: Pt): Geom => ({ kind: 'trend', a: p.t < q.t ? p : q, b: p.t < q.t ? q : p });

export class LinesLayer implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private redraw = () => {};
  private lines: DrawnLine[] = [];
  /** A line being dragged (or just dropped), shown in place of the saved one until lines arrive after the drop */
  private moved: DrawnLine | null = null;
  private holding = false;
  /** The line being drawn, following the pointer */
  private ghost: Geom | null = null;
  /** A trend line's first click, waiting for the second */
  private first: Pt | null = null;
  private editable = false;
  private axis: ISeriesPrimitiveAxisView[] = [];
  /** The chart's own candle array: live ticks append to it, and the layer reads it as it is now. */
  private k: Candle[] = [];
  private readonly views: IPrimitivePaneView[];

  constructor(private readonly tfSec: number, private readonly fmt: (p: number) => string) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => this.paint(context, mediaSize.width)) };
    this.views = [{ zOrder: () => 'top', renderer: () => renderer }];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi; this.series = p.series as ISeriesApi<'Candlestick'>; this.redraw = p.requestUpdate;
  }
  detached() { this.chart = null; this.series = null; this.redraw = () => {}; }
  updateAllViews() { this.axis = this.labels(); }
  paneViews() { return this.views; }
  priceAxisViews() { return this.axis; }
  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const g = this.grab(x, y);
    if (!g) return null;
    const level = this.byId(g.id).kind === 'level';
    return { externalId: g.id, zOrder: 'top', cursorStyle: g.part !== 'line' ? 'move' : level ? 'ns-resize' : 'grab' };
  }

  setCandles(k: Candle[]) { this.k = k; this.redraw(); }
  setLines(lines: DrawnLine[]) { this.lines = lines; if (!this.holding) this.moved = null; this.redraw(); }
  setEditable(on: boolean) { this.editable = on; this.redraw(); }
  setGhost(g: Geom | null) { this.ghost = g; this.redraw(); }
  setFirst(p: Pt | null) { this.first = p; this.redraw(); }
  /** Show l in place of its saved line; holding = still being dragged, so arriving lines don't replace it. */
  setMoved(l: DrawnLine | null, holding: boolean) { this.moved = l; this.holding = holding; this.redraw(); }
  firstPoint() { return this.first; }
  lastCandle() { return this.k[this.k.length - 1]; }
  /** A line as it's shown now (a dragged line where it was dropped). */
  byId(id: string) { return this.shown().find((l) => l.id === id)!; }

  /** The time and price under a chart point, exactly (time to the second). */
  pointAt(x: number, y: number): Pt | null {
    const l = this.logicalOf(x), p = this.series?.coordinateToPrice(y) ?? null;
    if (l == null || p == null || !(p > 0)) return null;
    return { t: Math.round(timeAt(this.k, this.tfSec, l)), p };
  }

  /** The line (or trend line end) under a chart point, if lines can be moved. Ends win over lines. */
  grab(x: number, y: number, reach = 1): Grab | null {
    if (!this.editable || !this.series) return null;
    let best: { id: string; d: number } | null = null;
    for (const l of this.shown()) {
      if (l.kind === 'trend') {
        for (const part of ['a', 'b'] as const) {
          const q = this.screen(l[part]!);
          if (q && Math.hypot(q[0] - x, q[1] - y) <= NEAR_END * reach) return { id: l.id, part };
        }
      }
      const d = this.distance(l, x, y);
      if (d != null && d <= NEAR_LINE * reach && (!best || d < best.d)) best = { id: l.id, d };
    }
    return best && { id: best.id, part: 'line' };
  }

  /**
   * The line after the pointer moved from (x0, y0) to (x, y) while holding part of it: the held part travels with the
   * pointer, so the spot that was grabbed stays under it. A level only moves up and down. Null when the result can't
   * be a line (a price at or below 0, or both ends at the same second).
   */
  shift(l: DrawnLine, part: Grab['part'], x0: number, y0: number, x: number, y: number): DrawnLine | null {
    const s = this.series, l0 = this.logicalOf(x0), l1 = this.logicalOf(x);
    if (!s || l0 == null || l1 == null) return null;
    const move = (q: Pt, sideways: boolean): Pt | null => {
      const yq = s.priceToCoordinate(q.p), p = yq == null ? null : s.coordinateToPrice(yq + y - y0);
      if (p == null || !(p > 0)) return null;
      return { t: sideways ? Math.round(timeAt(this.k, this.tfSec, logicalAt(this.k, this.tfSec, q.t) + l1 - l0)) : q.t, p };
    };
    if (l.kind === 'level') { const a = move(l.a, false); return a && { ...l, a }; }
    const a = part === 'b' ? l.a : move(l.a, true), b = part === 'a' ? l.b! : move(l.b!, true);
    return a && b && a.t !== b.t ? { ...l, a, b } : null;
  }

  private shown(): DrawnLine[] {
    return this.lines.map((l) => (l.id === this.moved?.id ? this.moved : l));
  }

  /** The chart x of a bar index, including the fraction between bars. */
  private xOf(l: number): number | null {
    const ts = this.chart!.timeScale(), i = Math.floor(l);
    const x0 = ts.logicalToCoordinate(i as Logical), x1 = ts.logicalToCoordinate((i + 1) as Logical);
    return x0 == null || x1 == null ? null : x0 + (l - i) * (x1 - x0);
  }

  /** The bar index under a chart x, including the fraction between bars. */
  private logicalOf(x: number): number | null {
    const ts = this.chart?.timeScale(), i = ts?.coordinateToLogical(x) ?? null;
    if (!ts || i == null) return null;
    const x0 = ts.logicalToCoordinate(i), x1 = ts.logicalToCoordinate((i + 1) as Logical);
    return x0 == null || x1 == null ? null : i + (x - x0) / (x1 - x0);
  }

  private screen(q: Pt): [number, number] | null {
    const x = this.xOf(logicalAt(this.k, this.tfSec, q.t)), y = this.series!.priceToCoordinate(q.p);
    return x == null || y == null ? null : [x, y];
  }

  /** The line's path on screen: a level across the chart; a trend line from its first point to the right edge, through each candle. */
  private path(l: Geom, width: number): [number, number][] {
    const s = this.series!;
    if (l.kind === 'level') { const y = s.priceToCoordinate(l.a.p); return y == null ? [] : [[0, y], [width, y]]; }
    const g = { ...l, id: '', rule: 'buy_break' as const };
    const start = logicalAt(this.k, this.tfSec, Math.min(l.a.t, l.b!.t)), end = this.logicalOf(width);
    if (end == null || start >= end) return [];
    const from = Math.max(start, (this.chart!.timeScale().getVisibleLogicalRange()?.from ?? start) - 1);
    const at: number[] = [from];
    for (let i = Math.floor(from) + 1; i < end; i++) at.push(i);
    at.push(end);
    return at.flatMap((i) => {
      const x = this.xOf(i), y = s.priceToCoordinate(lineValue(g, timeAt(this.k, this.tfSec, i)));
      return x == null || y == null ? [] : [[x, y] as [number, number]];
    });
  }

  /** Pixels from a chart point to the line (across it, so steep lines are as easy to catch as flat ones). */
  private distance(l: DrawnLine, x: number, y: number): number | null {
    const s = this.series!;
    if (l.kind === 'level') { const yl = s.priceToCoordinate(l.a.p); return yl == null ? null : Math.abs(y - yl); }
    const i = this.logicalOf(x), i1 = this.logicalOf(x + 1);
    if (i == null || i1 == null || i < logicalAt(this.k, this.tfSec, Math.min(l.a.t, l.b!.t))) return null;
    const y0 = s.priceToCoordinate(lineValue(l, timeAt(this.k, this.tfSec, i))), y1 = s.priceToCoordinate(lineValue(l, timeAt(this.k, this.tfSec, i1)));
    return y0 == null || y1 == null ? null : Math.abs(y - y0) / Math.hypot(1, y1 - y0);
  }

  private paint(c: Ctx, width: number) {
    if (!this.chart || !this.series || !this.k.length) return;
    this.shown().forEach((l, i) => this.stroke(c, l, width, lineTitle(l, i), this.editable, l.id === this.moved?.id));
    if (this.ghost) this.stroke(c, { ...this.ghost, id: '', rule: defaultRule(this.ghost, this.lastCandle()) }, width, null, true, true);
    else if (this.first) this.handle(c, this.first, T.profit);
  }

  private stroke(c: Ctx, l: DrawnLine, width: number, title: string | null, handles: boolean, bold: boolean) {
    const pts = this.path(l, width), color = lineColor(l.rule);
    if (pts.length < 2) return;
    c.save();
    c.strokeStyle = color; c.lineWidth = bold ? 3 : 2; c.lineCap = 'round';
    c.setLineDash(lineDashed(l.rule) ? [7, 5] : []);
    c.beginPath();
    pts.forEach(([x, y], j) => (j ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.stroke();
    c.restore();
    if (title) this.tag(c, title, color, pts[pts.length - 1][1], width);
    if (handles && l.kind === 'trend') { this.handle(c, l.a, color); this.handle(c, l.b!, color); } // over the tag, so an end stays in reach
  }

  private handle(c: Ctx, q: Pt, color: string) {
    const pt = this.screen(q);
    if (!pt) return;
    c.save();
    c.beginPath(); c.arc(pt[0], pt[1], HANDLE, 0, Math.PI * 2);
    c.fillStyle = T.bg; c.fill();
    c.lineWidth = 2; c.strokeStyle = color; c.stroke();
    c.restore();
  }

  /** The line's number and rule, in its colour at the right edge. */
  private tag(c: Ctx, text: string, color: string, y: number, width: number) {
    c.save();
    c.font = `500 11px ${T.font}`;
    const w = c.measureText(text).width + 12, h = 18, x = width - w - 4;
    c.fillStyle = color;
    c.beginPath(); c.roundRect(x, y - h / 2, w, h, 4); c.fill();
    c.fillStyle = T.bg; c.textBaseline = 'middle';
    c.fillText(text, x + 6, y + 0.5);
    c.restore();
  }

  /** Price axis labels: each line's price at the latest candle, which is what the bot compares the next close with. */
  private labels(): ISeriesPrimitiveAxisView[] {
    const s = this.series, last = this.lastCandle();
    if (!s || !last) return [];
    return this.shown().map((l) => {
      const v = lineValue(l, last.t), y = s.priceToCoordinate(v), color = lineColor(l.rule);
      return { coordinate: () => y ?? -100, visible: () => y != null, text: () => this.fmt(v), textColor: () => T.bg, backColor: () => color };
    });
  }
}

export interface DrawCtl {
  mode: 'level' | 'trend' | null;
  onDraw?: (g: Geom, last: Candle) => void;
  onMove?: (id: string, g: Pick<DrawnLine, 'a' | 'b'>) => void;
}

/**
 * Wires the chart's pointer to the layer. Drawing: the line follows the pointer and each click or tap places a point
 * exactly. Moving: a press on a line (or a trend line's end) drags it, with the chart's own panning paused until release,
 * and the drop is handed to onMove once. Returns the unbinding function.
 */
export function bindDrawing(host: HTMLElement, chart: IChartApi, layer: LinesLayer, ctl: () => DrawCtl, onFirst: (p: Pt | null) => void): () => void {
  const local = (ev: MouseEvent) => { const r = host.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const inPane = (x: number, y: number) => x >= 0 && y >= 0 && x <= chart.timeScale().width() && y <= chart.panes()[0].getHeight();
  const here = (ev: MouseEvent) => { const { x, y } = local(ev); return inPane(x, y) ? layer.pointAt(x, y) : null; };
  let drag: { g: Grab; line: DrawnLine; x0: number; y0: number; to: DrawnLine | null; restore: Pick<ChartOptions, 'handleScroll' | 'handleScale'> } | null = null;
  let tap: { id: number; x: number; y: number } | null = null;

  const hover = (ev: PointerEvent) => {
    const { mode } = ctl();
    if (!mode || drag) return;
    const p = here(ev), a = layer.firstPoint();
    layer.setGhost(!p ? null : mode === 'level' ? { kind: 'level', a: p } : a && a.t !== p.t ? ordered(a, p) : null);
  };
  const leave = () => layer.setGhost(null);
  // A point goes down on a press and release that didn't move (a click or a tap; moving pans the chart, as the chart
  // itself counts it: 5px). Not the click event: the chart's own drops a click that follows another within about half a
  // second, and on touch the browser's never comes, because the chart cancels the tap's touchend.
  const release = (ev: PointerEvent) => {
    const t = tap;
    tap = null;
    if (!t || t.id !== ev.pointerId) return;
    const { x, y } = local(ev);
    if (Math.abs(x - t.x) + Math.abs(y - t.y) < 5) place(ev);
  };
  const place = (ev: PointerEvent) => {
    const { mode, onDraw } = ctl();
    if (!mode || !onDraw) return;
    const p = here(ev);
    if (!p) return;
    if (mode === 'level') { layer.setGhost(null); onDraw({ kind: 'level', a: p }, layer.lastCandle()); return; }
    const a = layer.firstPoint();
    if (!a || a.t === p.t) { layer.setFirst(p); onFirst(p); return; }
    layer.setFirst(null); layer.setGhost(null); onFirst(null);
    onDraw(ordered(a, p), layer.lastCandle());
  };

  const press = (ev: PointerEvent) => {
    const { mode, onMove } = ctl();
    if (ev.button !== 0) return;
    if (mode) { tap = { id: ev.pointerId, ...local(ev) }; return; }
    const { x, y } = local(ev);
    if (!onMove || !inPane(x, y)) return; // the price axis and lower panes keep their own dragging
    const g = layer.grab(x, y, ev.pointerType === 'touch' ? TOUCH : 1);
    if (!g) return;
    // Cancelling the press keeps the chart from also seeing it (no compatibility mouse events follow).
    ev.preventDefault(); ev.stopPropagation();
    // A copy: options() is the chart's live object, and applyOptions changes its nested parts in place.
    const o = chart.options();
    drag = { g, line: layer.byId(g.id), x0: x, y0: y, to: null, restore: structuredClone({ handleScroll: o.handleScroll, handleScale: o.handleScale }) };
    chart.applyOptions({ handleScroll: false, handleScale: false });
    window.addEventListener('pointermove', follow);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
  };
  const follow = (ev: PointerEvent) => {
    if (!drag) return;
    const { x, y } = local(ev);
    if (!drag.to && Math.hypot(x - drag.x0, y - drag.y0) < 3) return; // a press without a move changes nothing
    const l = layer.shift(drag.line, drag.g.part, drag.x0, drag.y0, x, y);
    if (!l) return;
    drag.to = l;
    layer.setMoved(l, true);
  };
  const unlisten = () => {
    window.removeEventListener('pointermove', follow);
    window.removeEventListener('pointerup', drop);
    window.removeEventListener('pointercancel', drop);
  };
  const drop = (ev: PointerEvent) => {
    unlisten();
    const d = drag;
    drag = null;
    if (!d) return;
    chart.applyOptions(d.restore);
    const l = d.to, onMove = ctl().onMove;
    if (!l || ev.type === 'pointercancel' || !onMove) { layer.setMoved(null, false); return; }
    layer.setMoved(l, false);
    onMove(l.id, l.kind === 'trend' ? ordered(l.a, l.b!) : { a: l.a });
  };
  // On touch the chart pans from touch events, and the page scrolls: both are held off while a line is being dragged.
  const holdTouch = (ev: TouchEvent) => { if (drag) { ev.preventDefault(); ev.stopPropagation(); } };

  host.addEventListener('pointermove', hover);
  host.addEventListener('pointerleave', leave);
  host.addEventListener('pointerdown', press, true);
  host.addEventListener('pointerup', release, true);
  for (const t of ['touchstart', 'touchmove', 'touchend'] as const) host.addEventListener(t, holdTouch, { capture: true, passive: false });
  return () => {
    unlisten();
    host.removeEventListener('pointermove', hover);
    host.removeEventListener('pointerleave', leave);
    host.removeEventListener('pointerdown', press, true);
    host.removeEventListener('pointerup', release, true);
    for (const t of ['touchstart', 'touchmove', 'touchend'] as const) host.removeEventListener(t, holdTouch, { capture: true });
  };
}
