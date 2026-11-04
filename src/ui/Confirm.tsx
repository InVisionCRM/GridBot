/**
 * The one confirmation in the app (it replaces the browser's OK / Cancel pop-up): a sheet that says what is about to
 * happen, with an optional preview (rows of what you get, what it costs), and the button that does it.
 * - Real money (`money: true`): the button is held for HOLD_MS. Letting go early, Escape or Cancel does nothing; a
 *   hold can't happen by a stray click. Mouse, touch and keyboard (Enter or Space held) all work the same way.
 * - Anything else (removing a paper bot's history, clearing lines): an ordinary button.
 * `ask()` resolves true when it was confirmed, false when cancelled. ConfirmHost is mounted once at the root
 * (main.tsx); asking without it throws, so a page can never act without having asked.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export const HOLD_MS = 1200;

export interface AskRow { k: string; v: ReactNode; tone?: 'pos' | 'neg' }
export interface AskOpts {
  title: string;
  /** What will happen, in words */
  body?: ReactNode;
  /** The preview: what you get, what it costs (only figures the bot already has) */
  rows?: AskRow[];
  /** The button's label: what it does ("Close the position") */
  action: string;
  /** Real money moves: hold to confirm */
  money?: boolean;
  /** Something is removed or stopped: the button is drawn in the loss colour */
  danger?: boolean;
}

type Show = (o: AskOpts, done: (ok: boolean) => void) => void;
let show: Show | null = null;

export function ask(o: AskOpts): Promise<boolean> {
  const s = show;
  if (!s) throw new Error('The confirmation sheet is not mounted (ConfirmHost).');
  return new Promise((resolve) => s(o, resolve));
}

/** A button that fires after being held for HOLD_MS; released early it slides back and nothing happens. */
export function HoldButton({ label, onDone, danger }: { label: string; onDone: () => void; danger?: boolean }) {
  const [p, setP] = useState(0);
  const raf = useRef(0), t0 = useRef<number | null>(null), fired = useRef(false);
  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    t0.current = null;
    if (!fired.current) setP(0);
  }, []);
  const start = useCallback(() => {
    if (t0.current != null || fired.current) return;
    t0.current = performance.now();
    const step = (now: number) => {
      if (t0.current == null) return;
      const k = Math.min(1, (now - t0.current) / HOLD_MS);
      setP(k);
      if (k >= 1) { fired.current = true; t0.current = null; onDone(); return; }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [onDone]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  return (
    <button
      type="button" className={`hold-btn ${danger ? 'danger' : ''}`} style={{ ['--p' as string]: p }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); start(); }}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') stop(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <i aria-hidden="true" />
      <span>{p > 0 && p < 1 ? `Keep holding… ${label}` : `Hold to ${label.charAt(0).toLowerCase()}${label.slice(1)}`}</span>
    </button>
  );
}

export function ConfirmHost() {
  const [cur, setCur] = useState<{ o: AskOpts; done: (ok: boolean) => void } | null>(null);
  useEffect(() => {
    show = (o, done) => setCur((prev) => { prev?.done(false); return { o, done }; });
    return () => { show = null; };
  }, []);
  const end = useCallback((ok: boolean) => setCur((c) => { c?.done(ok); return null; }), []);
  useEffect(() => {
    if (!cur) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') end(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [cur, end]);
  if (!cur) return null;
  const { o } = cur;
  return (
    <div className="ask-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) end(false); }}>
      <div className="ask" role="dialog" aria-modal="true" aria-labelledby="ask-title">
        <h3 id="ask-title">{o.title}</h3>
        {o.body && <div className="ask-body">{o.body}</div>}
        {o.rows && o.rows.length > 0 && (
          <div className="ask-rows">
            {o.rows.map((r) => <div key={r.k} className="ask-row"><span>{r.k}</span><b className={r.tone ?? ''}>{r.v}</b></div>)}
          </div>
        )}
        <div className="ask-actions">
          <button type="button" className="btn ghost" onClick={() => end(false)}>Cancel</button>
          {o.money
            ? <HoldButton label={o.action} danger={o.danger} onDone={() => end(true)} />
            : <button type="button" className={`btn ${o.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => end(true)}>{o.action}</button>}
        </div>
        {o.money && <p className="ask-note">Real money. Hold the button until it fills; letting go cancels.</p>}
      </div>
    </div>
  );
}
