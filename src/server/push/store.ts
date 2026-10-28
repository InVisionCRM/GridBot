/** Subscriptions, toggles, and the short delivery log. Endpoints are not written to the app log. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PUSH_PREFS, sanitizePrefs, type PushDelivery, type PushPrefs,
} from '../../live/pushRules';
import { writePrivate } from './files';

export interface StoredSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string | null;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
}

interface PushFile {
  subscriptions: StoredSub[];
  prefs: PushPrefs;
  dailySentOn: string | null;
  deliveries: PushDelivery[];
}

const MAX_SUBS = 20;
const MAX_DELIVERIES = 40;

function empty(): PushFile {
  return { subscriptions: [], prefs: DEFAULT_PUSH_PREFS, dailySentOn: null, deliveries: [] };
}

/** Hosts a browser actually uses. Anything else (an IP, a tailnet name, a private address) is refused. */
function pushServiceHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'web.push.apple.com' || h.endsWith('.push.apple.com')) return true;
  if (h === 'fcm.googleapis.com') return true;
  if (h === 'updates.push.services.mozilla.com') return true;
  if (h.endsWith('.notify.windows.com') && h !== 'notify.windows.com') return true;
  return false;
}

function httpsEndpoint(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 12 || v.length > 2000) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!pushServiceHost(u.hostname)) return null;
  } catch { return null; }
  // Keep the browser's string. Re-serializing the URL can change it, and then the test button would not match.
  return v;
}

function keyPart(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 8 || v.length > 256) return null;
  if (!/^[A-Za-z0-9_+/=-]+$/.test(v)) return null;
  return v;
}

export class PushStore {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private read(): PushFile {
    let raw: string;
    try { raw = readFileSync(this.file, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw new Error('The push subscription file is unreadable and was left as it is.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error('The push subscription file is unreadable and was left as it is.');
    }
    const o = parsed && typeof parsed === 'object' ? parsed as Partial<PushFile> : {};
    const subscriptions = Array.isArray(o.subscriptions) ? o.subscriptions.filter(isSub) : [];
    return {
      subscriptions,
      prefs: sanitizePrefs(o.prefs),
      dailySentOn: typeof o.dailySentOn === 'string' ? o.dailySentOn : null,
      deliveries: Array.isArray(o.deliveries) ? o.deliveries.filter(isDelivery).slice(0, MAX_DELIVERIES) : [],
    };
  }

  private write(data: PushFile) {
    writePrivate(this.file, JSON.stringify(data, null, 2));
  }

  subscriptions(): StoredSub[] { return this.read().subscriptions; }
  prefs(): PushPrefs { return this.read().prefs; }
  deliveries(): PushDelivery[] { return this.read().deliveries; }
  dailySentOn(): string | null { return this.read().dailySentOn; }

  setPrefs(patch: unknown): PushPrefs {
    const data = this.read();
    const cur = data.prefs;
    const p = patch && typeof patch === 'object' ? patch as Partial<PushPrefs> : {};
    data.prefs = sanitizePrefs({
      types: { ...cur.types, ...(p.types ?? {}) },
      quiet: { ...cur.quiet, ...(p.quiet ?? {}) },
      daily: { ...cur.daily, ...(p.daily ?? {}) },
    });
    this.write(data);
    return data.prefs;
  }

  upsert(body: unknown, ua: string | null): StoredSub {
    const o = body && typeof body === 'object' ? body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } : {};
    const endpoint = httpsEndpoint(o.endpoint);
    const p256dh = keyPart(o.keys?.p256dh);
    const auth = keyPart(o.keys?.auth);
    if (!endpoint || !p256dh || !auth) throw new Error('That push subscription is not usable.');
    const data = this.read();
    const i = data.subscriptions.findIndex((s) => s.endpoint === endpoint);
    if (i >= 0) {
      const prev = data.subscriptions[i];
      data.subscriptions[i] = { ...prev, p256dh, auth, ua: ua ?? prev.ua };
    } else {
      if (data.subscriptions.length >= MAX_SUBS) throw new Error('Too many phones are subscribed. Turn one off first.');
      data.subscriptions.push({ endpoint, p256dh, auth, ua, createdAt: this.now(), lastOkAt: null, lastError: null });
    }
    this.write(data);
    return data.subscriptions.find((s) => s.endpoint === endpoint)!;
  }

  remove(endpoint: string): boolean {
    const data = this.read();
    const next = data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (next.length === data.subscriptions.length) return false;
    data.subscriptions = next;
    this.write(data);
    return true;
  }

  /** `error` is a short status, never the endpoint and never a response body. */
  mark(endpoint: string, ok: boolean, error: string | null) {
    const data = this.read();
    const s = data.subscriptions.find((x) => x.endpoint === endpoint);
    if (!s) return;
    if (ok) { s.lastOkAt = this.now(); s.lastError = null; }
    else s.lastError = error;
    this.write(data);
  }

  markDaily(day: string) {
    const data = this.read();
    data.dailySentOn = day;
    this.write(data);
  }

  record(d: PushDelivery) {
    const data = this.read();
    data.deliveries.unshift(d);
    data.deliveries = data.deliveries.slice(0, MAX_DELIVERIES);
    this.write(data);
  }
}

function isSub(v: unknown): v is StoredSub {
  if (!v || typeof v !== 'object') return false;
  const s = v as StoredSub;
  return typeof s.endpoint === 'string' && typeof s.p256dh === 'string' && typeof s.auth === 'string';
}

function isDelivery(v: unknown): v is PushDelivery {
  if (!v || typeof v !== 'object') return false;
  const d = v as PushDelivery;
  return typeof d.at === 'number' && typeof d.title === 'string' && typeof d.body === 'string' && typeof d.ok === 'boolean';
}

export function pushStoreFile(dir: string) { return join(dir, 'push.json'); }
