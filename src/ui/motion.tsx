/** Small motion primitives. Motion is kept for real events (a fill); routine price ticks change values quietly. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Roll } from './Roll';

export function useReducedMotion() {
  const q = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const [r, setR] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setR(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, [q]);
  return r;
}

/**
 * A live figure (Kyle: "the component we are using is too basic"): its digits roll to the new value (Roll), it glows
 * mint when it goes up and coral when it goes down, and a chip with the change ("+0.0004 ETH") floats up and fades in
 * the top-right corner of its card (one live figure with a chip per card; `chip={false}` for the others).
 * The first paint shows the value as it is (no count-up from 0), so a server render reads the real figure.
 */
export function AnimatedNumber({ value, format, className = '', chip = true }: { value: number | null | undefined; format: (x: number) => string; className?: string; chip?: boolean }) {
  const ch = useChange(value);
  const ref = useGlow(ch);
  if (value == null) return <span className={className}>—</span>;
  return (
    <span ref={ref} className={`num live-fig ${className}`}>
      <Roll text={format(value)} />
      {chip && ch.delta != null && ch.delta !== 0 && <span key={ch.n} className={`live-chip ${ch.delta > 0 ? 'up' : 'down'}`} aria-hidden="true">{signed(format(Math.abs(ch.delta)), ch.delta)}</span>}
    </span>
  );
}

/** A figure in a list or a table cell: it glows when it changes (up mint, down coral), no chip and no roll. */
export function Flash({ v, children, className = '' }: { v: number | string | null | undefined; children: ReactNode; className?: string }) {
  const ch = useChange(typeof v === 'number' ? v : null, typeof v === 'string' ? v : null);
  const ref = useGlow(ch);
  return <span ref={ref} className={`${className} flash-fig`.trim()}>{children}</span>;
}

/** "+" or "−" in front of a formatted size, replacing a sign the format put there */
const signed = (t: string, d: number) => `${d > 0 ? '+' : '−'}${t.replace(/^[+\-−]\s?/, '')}`;

interface Change { n: number; delta: number | null; dir: 1 | -1 | 0 }
/** Counts each change of a figure after the first paint, with its size (numbers) or just that it changed (text). */
function useChange(value: number | null | undefined, text?: string | null): Change {
  const prev = useRef<{ v: number | null | undefined; t: string | null | undefined } | null>(null);
  const [c, setC] = useState<Change>({ n: 0, delta: null, dir: 0 });
  useEffect(() => {
    const p = prev.current;
    prev.current = { v: value, t: text };
    if (!p) return;
    if (typeof value === 'number' && typeof p.v === 'number' && value !== p.v) setC((x) => ({ n: x.n + 1, delta: value - p.v!, dir: value > p.v! ? 1 : -1 }));
    else if (text != null && p.t != null && text !== p.t) setC((x) => ({ n: x.n + 1, delta: null, dir: 0 }));
  }, [value, text]);
  return c;
}

/** Plays a short glow on the element at each change (the Web Animations API, so a fast run of changes restarts it). */
function useGlow(c: Change) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!c.n || !el || reduced || typeof el.animate !== 'function') return;
    const color = c.dir < 0 ? '242, 112, 107' : '92, 208, 141';
    // text-shadow only: a filter would make the figure the box its change chip is placed in (CSS containing block)
    el.animate([{ textShadow: `0 0 18px rgba(${color}, 0.75)` }, { textShadow: '0 0 0 transparent' }], { duration: 900, easing: 'ease-out' });
  }, [c.n, c.dir, reduced]);
  return ref;
}

/** Still status dot coloured by state; dims when the last price read is older than `staleMs`. */
export function StatusDot({ beat, state, staleMs = 30_000, title }: { beat: number | null | undefined; state: string; staleMs?: number; title?: string }) {
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((x) => x + 1), 5000); return () => clearInterval(id); }, []);
  const stale = !beat || Date.now() - beat > staleMs;
  return <span className={`hb hb-${state} ${stale && state === 'running' ? 'hb-stale' : ''}`} title={title ?? (beat ? `last price ${Math.round((Date.now() - beat) / 1000)}s ago` : 'no price yet')} />;
}

/** True for `ms` after `k` changes (e.g. trade count), skipping the first render. */
export function useFlash(k: unknown, ms = 1200) {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [k, ms]);
  return on;
}

export function Spark({ data, w = 90, h = 24, className = '' }: { data: number[]; w?: number; h?: number; className?: string }) {
  if (data.length < 2) return <svg width={w} height={h} />;
  const lo = Math.min(...data), hi = Math.max(...data), r = hi - lo || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / r) * (h - 4)).toFixed(1)}`).join(' ');
  const up = data[data.length - 1] >= data[0];
  return <svg width={w} height={h} className={`spark ${up ? 'up' : 'down'} ${className}`}><polyline points={pts} fill="none" strokeWidth="1.5" /></svg>;
}
