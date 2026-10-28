/** Notification JSON the service worker shows. No secrets, no endpoints. */
import type { PushType } from '../../live/pushRules';

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  type: string;
  url: string;
  ts: number;
}

const TITLES: Record<PushType, string> = {
  grid_fill: 'Grid fill',
  lp_range: 'LP range',
  bot_halted: 'Bot halted',
  tx_failed: 'Transaction failed',
  gas_low: 'Gas low',
  sniper: 'Sniper',
  daily_summary: 'Daily summary',
};

export function urgencyFor(type: string): 'high' | 'normal' {
  return type === 'bot_halted' || type === 'tx_failed' || type === 'gas_low' || type === 'lp_range' ? 'high' : 'normal';
}

/** Web Push topic: 1–32 URL-safe characters. A bad tag is omitted rather than rejected by the push service. */
export function pushTopic(tag: string): string | undefined {
  const t = tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return t.length ? t : undefined;
}

export function buildPayload(type: PushType, body: string, o: { tag?: string; title?: string; url?: string; ts?: number; botId?: string; mode?: 'paper' | 'live' } = {}): PushPayload {
  // Keep line breaks (the daily summary puts paper on its own line). Collapse the other whitespace.
  const text = body.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim().slice(0, 280);
  const url = o.url && o.url.startsWith('/') && !o.url.startsWith('//') ? o.url : '/';
  let title = o.title ?? `GridBot · ${TITLES[type]}`;
  if (o.mode === 'paper' && !title.startsWith('(paper)')) title = `(paper) ${title}`;
  return {
    title: title.slice(0, 120),
    body: text || 'GridBot',
    tag: (o.tag ?? `${type}:${o.botId ?? 'app'}`).slice(0, 64),
    type,
    url,
    ts: o.ts ?? Date.now(),
  };
}

export function testPayload(ts: number): PushPayload {
  return {
    title: 'GridBot',
    body: 'Test push. If this is on the lock screen, iPhone alerts are working.',
    tag: 'gridbot-test',
    type: 'test',
    url: '/',
    ts,
  };
}

/** The bytes the service worker receives. The push service only sees the encrypted form. */
export function serializePayload(p: PushPayload): string {
  return JSON.stringify({ title: p.title, body: p.body, tag: p.tag, url: p.url, type: p.type, ts: p.ts });
}
