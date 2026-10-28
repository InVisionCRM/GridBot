/**
 * Lock-screen push rules shared by the server and the Alerts screen.
 * Nothing is sent until a browser has subscribed. Trading is not involved.
 */

export const PUSH_TYPES = ['grid_fill', 'lp_range', 'bot_halted', 'tx_failed', 'gas_low', 'sniper', 'daily_summary'] as const;
export type PushType = (typeof PUSH_TYPES)[number];

/** More than this many grid fills inside the window become one digest. The first ones still go out one by one. */
export const FILL_DIGEST_LIMIT = 6;
export const FILL_DIGEST_WINDOW_MS = 10 * 60_000;
/** A burst that has gone quiet for this long is sent as the digest, without waiting out the whole window. */
export const FILL_DIGEST_QUIET_MS = 60_000;
/** An LP that stays outside its band this long is a push, unless an auto-move already reported it. */
export const LP_OUT_MS = 10 * 60_000;
/** How long after 21:00 the daily summary may still go out if the clock tick was late. */
export const DAILY_WINDOW_MIN = 20;

export interface QuietHours {
  on: boolean;
  /** HH:MM in `tz`, 24-hour. */
  start: string;
  end: string;
  tz: string;
}

export interface DailyWhen { hour: number; minute: number; tz: string }

export interface PushPrefs {
  types: Record<PushType, boolean>;
  quiet: QuietHours;
  daily: DailyWhen;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  types: {
    grid_fill: true,
    lp_range: true,
    bot_halted: true,
    tx_failed: true,
    gas_low: true,
    sniper: true,
    daily_summary: false,
  },
  quiet: { on: false, start: '23:00', end: '07:00', tz: 'America/New_York' },
  daily: { hour: 21, minute: 0, tz: 'America/New_York' },
};

/** A halt or a failed transaction still rings during quiet hours. Everything else waits. */
const QUIET_BYPASS: ReadonlySet<PushType> = new Set(['bot_halted', 'tx_failed']);

export interface PushDelivery {
  at: number;
  type: string;
  title: string;
  body: string;
  ok: boolean;
}

export interface PushPublicView {
  publicKey: string;
  subscribed: number;
  prefs: PushPrefs;
  lastDeliveredAt: number | null;
  deliveries: PushDelivery[];
}

export function isPushType(v: unknown): v is PushType {
  return typeof v === 'string' && (PUSH_TYPES as readonly string[]).includes(v);
}

function hhmm(v: unknown): v is string {
  if (typeof v !== 'string' || !/^(\d{2}):(\d{2})$/.test(v)) return false;
  const [h, m] = v.split(':').map(Number);
  return h <= 23 && m <= 59;
}

function zoneOk(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Keep a saved or posted prefs object inside the known shape. Unknown fields are dropped. */
export function sanitizePrefs(raw: unknown, base: PushPrefs = DEFAULT_PUSH_PREFS): PushPrefs {
  const r = raw && typeof raw === 'object' ? raw as Partial<PushPrefs> : {};
  const types = { ...base.types };
  if (r.types && typeof r.types === 'object') {
    for (const k of PUSH_TYPES) {
      const v = (r.types as Partial<Record<PushType, boolean>>)[k];
      if (typeof v === 'boolean') types[k] = v;
    }
  }
  const quiet: QuietHours = { ...base.quiet };
  if (r.quiet && typeof r.quiet === 'object') {
    if (typeof r.quiet.on === 'boolean') quiet.on = r.quiet.on;
    if (hhmm(r.quiet.start)) quiet.start = r.quiet.start;
    if (hhmm(r.quiet.end)) quiet.end = r.quiet.end;
    if (typeof r.quiet.tz === 'string' && r.quiet.tz.length <= 80 && zoneOk(r.quiet.tz)) quiet.tz = r.quiet.tz;
  }
  const daily: DailyWhen = { ...base.daily };
  if (r.daily && typeof r.daily === 'object') {
    if (Number.isInteger(r.daily.hour) && (r.daily.hour as number) >= 0 && (r.daily.hour as number) <= 23) daily.hour = r.daily.hour as number;
    if (Number.isInteger(r.daily.minute) && (r.daily.minute as number) >= 0 && (r.daily.minute as number) <= 59) daily.minute = r.daily.minute as number;
    if (typeof r.daily.tz === 'string' && r.daily.tz.length <= 80 && zoneOk(r.daily.tz)) daily.tz = r.daily.tz;
  }
  return { types, quiet, daily };
}

export function zonedParts(tz: string, at: number): { hour: number; minute: number; day: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { hour, minute: Number(parts.minute), day: `${parts.year}-${parts.month}-${parts.day}` };
}

function minutes(hhmmText: string): number | null {
  if (!hhmm(hhmmText)) return null;
  const [h, m] = hhmmText.split(':').map(Number);
  return h * 60 + m;
}

/** Quiet hours wrap midnight: 23:00–07:00 covers the evening and the early morning. */
export function inQuietHours(q: QuietHours, at: number): boolean {
  if (!q.on) return false;
  const start = minutes(q.start), end = minutes(q.end);
  if (start == null || end == null || start === end) return false;
  let cur: number;
  try {
    const p = zonedParts(q.tz, at);
    cur = p.hour * 60 + p.minute;
  } catch { return false; }
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

export function dayKey(tz: string, at: number): string {
  return zonedParts(tz, at).day;
}

/** True once, inside the day's send window, when the daily summary toggle is on. */
export function dailyDue(prefs: PushPrefs, at: number, lastSentOn: string | null): boolean {
  if (!prefs.types.daily_summary) return false;
  let parts: { hour: number; minute: number; day: string };
  try { parts = zonedParts(prefs.daily.tz, at); } catch { return false; }
  if (lastSentOn === parts.day) return false;
  const cur = parts.hour * 60 + parts.minute;
  const target = prefs.daily.hour * 60 + prefs.daily.minute;
  return cur >= target && cur < target + DAILY_WINDOW_MIN;
}

export function pushAllowed(o: { hasSubscription: boolean; prefs: PushPrefs; type: PushType; at: number }): boolean {
  if (!o.hasSubscription) return false;
  if (!o.prefs.types[o.type]) return false;
  if (o.prefs.quiet.on && !QUIET_BYPASS.has(o.type) && inQuietHours(o.prefs.quiet, o.at)) return false;
  return true;
}
