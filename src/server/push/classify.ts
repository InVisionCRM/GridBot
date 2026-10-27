/** Map an activity event onto a push type. Null means the event stays in the tab only. */
import type { PushType } from '../../live/pushRules';

export interface PushEvent {
  type: string;
  level?: string;
  msg: string;
  kind?: string;
  botId?: string;
  data?: Record<string, unknown>;
}

function haltOf(data: Record<string, unknown> | undefined): { origin?: string; what?: string } | null {
  const h = data?.halt;
  if (!h || typeof h !== 'object') return null;
  const o = h as { origin?: unknown; what?: unknown };
  return {
    origin: typeof o.origin === 'string' ? o.origin : undefined,
    what: typeof o.what === 'string' ? o.what : undefined,
  };
}

/**
 * A button, Stop all, or Close is the person at the screen. Those are not "bot halted".
 * A safety pause (tax, impact, startup, loss limit) is.
 */
function halted(e: PushEvent): boolean {
  if (e.level === 'success') return false;
  const h = haltOf(e.data);
  if (h?.what === 'button' || h?.what === 'stop-all' || h?.what === 'chain-stop' || h?.what === 'close') return false;
  return h?.origin === 'system' || e.level === 'error';
}

export function classifyPush(e: PushEvent): PushType | null {
  if (e.data?.push === 'sniper') return 'sniper';
  if (/low gas/i.test(e.msg)) return 'gas_low';
  if (e.type === 'filled' && (e.kind === 'grid' || e.msg.startsWith('Grid '))) return 'grid_fill';
  if (e.type === 'range' && (e.kind === 'lp' || e.msg.startsWith('Liquidity '))) return 'lp_range';
  if (e.type === 'stopped') return halted(e) ? 'bot_halted' : null;
  if (e.type === 'error' || e.type === 'skipped') return 'tx_failed';
  if ((e.type === 'info' || e.type === 'signal') && /reverted|execute failed|couldn't send/i.test(e.msg)) return 'tx_failed';
  return null;
}
