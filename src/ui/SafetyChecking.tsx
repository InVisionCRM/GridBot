/**
 * "Checking safety…" while a LIVE start or resume waits for its fresh safety check (up to 3 tries, a few seconds),
 * and for live bots held after a restart until their market's check answers. So the page doesn't look frozen.
 */
import { useState, type ReactNode } from 'react';
import { offersStartAnyway } from './api';

export function SafetyChecking({ what = 'Checking safety…' }: { what?: string }) {
  return (
    <div className="banner info checking" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="grow">{what} <span className="muted small">(a fresh check of the token, up to 3 tries)</span></span>
    </div>
  );
}

/** `run(live, fn)`: shows the spinner while fn runs, for live only (paper doesn't check). */
export function useSafetyChecking() {
  const [on, setOn] = useState(false);
  const run = async <T,>(live: boolean, fn: () => Promise<T>): Promise<T> => {
    if (!live) return fn();
    setOn(true);
    try { return await fn(); } finally { setOn(false); }
  };
  return { on, run };
}

/** A live bot the server holds after a restart (status.safetyChecking). */
export const heldForSafety = (s: { safetyChecking?: string[] } | null | undefined, id: string) => !!s?.safetyChecking?.includes(id);

/** Extra body for a start request, and the button name the server records (audit). */
export type Send = (extra: { startAnyway?: true }, from?: string) => Promise<unknown>;

/**
 * A LIVE start: "Checking safety…" while the server runs the fresh check. Refused because the check couldn't complete
 * after 3 tries, and the token's last measured check passed: the reason with a Start anyway button, which asks for a
 * confirm, then sends the same start with startAnyway (recorded on the bot: who pressed it and why it was blocked).
 * A check that completed and failed has no Start anyway; its reason shows like any other error.
 */
export function useLiveStart(act: (fn: () => Promise<unknown>) => void, busy: boolean) {
  const [blocked, setBlocked] = useState<{ msg: string; send: Send } | null>(null);
  const chk = useSafetyChecking();
  const run = (live: boolean, send: Send) => act(async () => {
    setBlocked(null);
    try { await chk.run(live, () => send({})); } catch (e) {
      if (offersStartAnyway(e)) { setBlocked({ msg: e.message, send }); return; }
      throw e;
    }
  });
  const anyway = () => {
    const b = blocked;
    if (!b || !confirm(`${b.msg}\n\nStart anyway? It starts LIVE on the last known safety report, without a fresh check. Who pressed it (this computer, the phone or a friend copy), when, and why the check was blocked are recorded on the bot.`)) return;
    act(async () => { await chk.run(true, () => b.send({ startAnyway: true }, 'start-anyway')); setBlocked(null); });
  };
  const banner: ReactNode = <>
    {chk.on && <SafetyChecking />}
    {blocked && (
      <div className="banner error">
        <span>{blocked.msg}</span>{' '}
        <button type="button" className="btn live small-btn" disabled={busy} onClick={anyway}>Start anyway</button>
      </div>
    )}
  </>;
  return { run, banner };
}
