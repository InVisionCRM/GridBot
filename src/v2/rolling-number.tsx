/** Tweens a server value into the label. The tween is display-only. */
import { animate, useMotionValue, useMotionValueEvent } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { pct, usd } from './format';

function reduced() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function RollingUsd({ value, sign = true, className = '', rollIn = false }: { value: number; sign?: boolean; className?: string; rollIn?: boolean }) {
  const mv = useMotionValue(rollIn ? 0 : value);
  const [text, setText] = useState(() => usd(rollIn ? 0 : value, sign));
  const [flash, setFlash] = useState('');
  const prev = useRef(rollIn ? 0 : value);
  useMotionValueEvent(mv, 'change', (v) => setText(usd(v, sign)));
  useEffect(() => {
    const dir = value > prev.current + 0.0001 ? 'up' : value < prev.current - 0.0001 ? 'down' : '';
    prev.current = value;
    if (reduced()) {
      mv.set(value);
      setText(usd(value, sign));
      return;
    }
    if (dir) setFlash(dir);
    const controls = animate(mv, value, { duration: 0.85, ease: [0.22, 1, 0.36, 1] });
    const t = window.setTimeout(() => setFlash(''), 520);
    return () => { controls.stop(); window.clearTimeout(t); };
  }, [mv, sign, value]);
  return <span className={`roll ${flash} ${className}`.trim()}>{text}</span>;
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
