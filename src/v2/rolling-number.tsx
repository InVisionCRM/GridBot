/** Tweens a server value into the label. The tween is display-only. */
import { animate, useMotionValue, useMotionValueEvent } from 'motion/react';
import { useEffect, useState } from 'react';
import { pct } from './format';

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function RollingPct({ value, className = '' }: { value: number | null; className?: string }) {
  const shown = value ?? 0;
  const mv = useMotionValue(shown);
  const [text, setText] = useState(() => (value == null ? '—' : pct(value, 1, true)));
  useMotionValueEvent(mv, 'change', (v) => { if (value != null) setText(pct(v, 1, true)); });
  useEffect(() => {
    if (value == null) { setText('—'); return; }
    if (reduced()) { mv.set(value); setText(pct(value, 1, true)); return; }
    const controls = animate(mv, value, { duration: 0.85, ease: [0.22, 1, 0.36, 1] });
    return () => controls.stop();
  }, [mv, value]);
  return <span className={className}>{text}</span>;
}
