/**
 * The bottom drawer every screen uses (home and More): slides up, Escape, the scrim, Close or a swipe down on its
 * handle put it away. `auto` (a profit moment) has no scrim and isn't modal; it closes itself.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A swipe down this far on the handle closes the drawer */
const SWIPE_CLOSE_PX = 80;

export function Sheet({ label, close, tall = false, auto = false, closeButton = true, children }: {
  label: string; close: () => void; tall?: boolean; auto?: boolean; closeButton?: boolean; children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [drag, setDrag] = useState(0);
  const from = useRef<number | null>(null);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [close]);
  const handle = {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { from.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => { if (from.current != null) setDrag(Math.max(0, e.clientY - from.current)); },
    onPointerUp: () => { if (from.current == null) return; from.current = null; if (drag > SWIPE_CLOSE_PX) close(); else setDrag(0); },
    onPointerCancel: () => { from.current = null; setDrag(0); },
  };
  return (
    <>
      {!auto && <div className={`dk-scrim ${shown ? 'on' : ''}`} onClick={close} />}
      <div className={`dk-sheet-wrap ${shown ? 'on' : ''}`} role="dialog" aria-modal={!auto} aria-label={label}
        style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}>
        <div className={`dk-sheet ${tall ? 'tall' : ''}`}>
          <div className="dk-handle" {...handle}><span className="dk-grab" aria-hidden="true" /></div>
          {children}
          {closeButton && <button type="button" className="dk-btn dk-close" onClick={close}>Close</button>}
        </div>
      </div>
    </>
  );
}
