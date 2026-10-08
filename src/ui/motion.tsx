/** Small motion primitives. Motion is kept for real events (a fill); routine price ticks change values quietly. */
import { useEffect, useRef, useState } from 'react';

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

/** Number that eases to its new value (no colour flash). */
export function AnimatedNumber({ value, format, className = '', duration = 450 }: { value: number | null | undefined; format: (x: number) => string; className?: string; duration?: number }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value == null) return;
    const start = from.current;
    if (start === value) return;
    if (reduced) { setShown(value); from.current = value; return; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const v = start + (value - start) * (1 - (1 - k) ** 3);
      setShown(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, duration]);
  if (value == null) return <span className={className}>—</span>;
  return <span className={`num ${className}`}>{format(shown)}</span>;
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
