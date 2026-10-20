/**
 * ⓘ next to a label or number: hover (mouse) or tap (phone) to read what it means. The box is placed on the page
 * itself (fixed, kept inside the screen), so cards that clip their content never cut it off.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const BOX = 300, EDGE = 12;

export function Tip({ children, label = 'What does this mean?' }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const [pinned, setPinned] = useState(false);
  const show = () => {
    const r = ref.current!.getBoundingClientRect(), half = Math.min(BOX, window.innerWidth - 2 * EDGE) / 2;
    const below = r.top < 160;
    setPos({ x: Math.min(window.innerWidth - EDGE - half, Math.max(EDGE + half, r.left + r.width / 2)), y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => { setPos(null); setPinned(false); };
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) hide(); };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('pointerdown', close);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('pointerdown', close); };
  }, [pos]);
  return (
    <>
      <button type="button" ref={ref} className={`tip ${pos ? 'on' : ''}`} aria-label={label} aria-expanded={!!pos}
        onMouseEnter={show} onMouseLeave={() => { if (!pinned) setPos(null); }} onFocus={show} onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (pinned) hide(); else { show(); setPinned(true); } }}>i</button>
      {pos && createPortal(<div role="tooltip" className={`tip-box ${pos.below ? 'below' : ''}`} style={{ left: pos.x, top: pos.y }}>{children}</div>, document.body)}
    </>
  );
}

/** A label with its tip: "Max drawdown ⓘ". */
export function L({ children, tip }: { children: ReactNode; tip: ReactNode }) {
  return <span className="with-tip">{children}<Tip>{tip}</Tip></span>;
}
