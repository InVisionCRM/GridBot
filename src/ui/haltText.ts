/** Plain sentence for a stored stop/close reason. Kept out of the server module so the page does not pull in node. */
import { ago } from './fmt';

export interface HaltView {
  at?: number;
  what?: string;
  detail?: string;
  origin?: string;
}

export function haltText(h: HaltView | null | undefined, now = Date.now()): string | null {
  if (!h?.detail) return null;
  const where = h.origin === 'gateway-owner' ? 'from the phone'
    : h.origin === 'friend-copy' ? 'from a friend copy'
    : h.origin === 'localhost' ? 'from this computer'
    : h.origin === 'system' ? 'by the app'
    : '';
  const when = typeof h.at === 'number' ? ago(h.at, now) : '';
  const head = [h.detail, where].filter(Boolean).join(' ');
  return when && when !== '—' ? `${head}, ${when}` : head;
}

/** Shown once the bot is no longer running, and while a close is still unwinding. */
export function showHalt(b: { status?: string; closing?: boolean; halt?: HaltView | null }, closing = false, now = Date.now()): string | null {
  if (!b.halt) return null;
  if (b.status === 'running' && !closing && !b.closing) return null;
  return haltText(b.halt, now);
}
