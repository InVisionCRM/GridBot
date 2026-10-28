/**
 * Lock-screen push: subscription file, payload, digest, and which types are allowed to send.
 * No network. The transport is a fake, and nothing here signs a transaction.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_PREFS, dailyDue, pushAllowed, type PushPrefs } from '../src/live/pushRules';
import { pctToEdge, rangeZone } from '../src/live/rangeBand';
import { redact, Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { createApp } from '../src/server/app';
import { MockChain, NET } from './helpers/mockChain';
import { classifyPush } from '../src/server/push/classify';
import { DIGEST_HOLD_CAP, FillDigester } from '../src/server/push/digest';
import { LpWatch, type LpSnap } from '../src/server/push/lpWatch';
import { buildPayload, pushTopic, serializePayload, testPayload, urgencyFor } from '../src/server/push/payload';
import { PushService, tryStartPush } from '../src/server/push/service';
import { dailySummary } from '../src/server/push/summary';
import { PushStore, pushStoreFile } from '../src/server/push/store';
import { retryAfterMs, VAPID_SUBJECT, vapidSubjectFrom, type PushTransport } from '../src/server/push/send';
import { loadOrCreateVapid, vapidFile } from '../src/server/push/vapid';
import { normalizeView } from '../src/ui/model';
import { PUSH_OPT_IN_KEY, pushOptedIn, setPushOptIn, shouldRestorePush, unsubscribePush } from '../src/ui/pushClient';

const ENDPOINT = 'https://web.push.apple.com/device-a';
const OTHER = 'https://fcm.googleapis.com/fcm/send/device-b';
const KEYS = { p256dh: 'abc12345', auth: 'def67890' };

function mode(file: string) {
  return statSync(file).mode & 0o777;
}

function dir() {
  return mkdtempSync(join(tmpdir(), 'push-'));
}

function prefs(patch: { types?: Partial<PushPrefs['types']>; quiet?: Partial<PushPrefs['quiet']>; daily?: Partial<PushPrefs['daily']> } = {}): PushPrefs {
  return {
    types: { ...DEFAULT_PUSH_PREFS.types, ...(patch.types ?? {}) },
    quiet: { ...DEFAULT_PUSH_PREFS.quiet, ...(patch.quiet ?? {}) },
    daily: { ...DEFAULT_PUSH_PREFS.daily, ...(patch.daily ?? {}) },
  };
}

describe('subscription storage', () => {
  it('keeps a subscription across a reload and updates keys in place', () => {
    const file = pushStoreFile(dir());
    const store = new PushStore(file, () => 10);
    store.upsert({ endpoint: ENDPOINT, keys: KEYS }, 'iphone');
    const again = new PushStore(file, () => 11);
    expect(again.subscriptions()).toHaveLength(1);
    expect(again.subscriptions()[0].p256dh).toBe(KEYS.p256dh);
    again.upsert({ endpoint: ENDPOINT, keys: { p256dh: 'zzzzzzzz', auth: KEYS.auth } }, null);
    expect(again.subscriptions()).toHaveLength(1);
    expect(again.subscriptions()[0].p256dh).toBe('zzzzzzzz');
    expect(again.subscriptions()[0].ua).toBe('iphone');
    expect(mode(file)).toBe(0o600);
  });

  it('accepts only browser push services', () => {
    const store = new PushStore(pushStoreFile(dir()));
    const ok = [
      'https://web.push.apple.com/abc',
      'https://api.push.apple.com/abc',
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/abc',
      'https://wns.notify.windows.com/abc',
    ];
    for (const endpoint of ok) store.upsert({ endpoint, keys: KEYS }, null);
    expect(store.subscriptions()).toHaveLength(ok.length);
    const bad = [
      'https://127.0.0.1/push',
      'https://10.1.2.3/push',
      'https://192.168.1.5/push',
      'https://172.16.0.4/push',
      'https://100.64.0.8/push',
      'https://169.254.1.1/push',
      'https://[::1]/push',
      'https://printer.local/push',
      'https://mac.tailnet.ts.net/push',
      'https://push.example/device',
      'https://evil.push.apple.com.evil.com/x',
      'https://notfcm.googleapis.com/x',
      'http://web.push.apple.com/x',
      'https://user:pass@web.push.apple.com/x',
    ];
    for (const endpoint of bad) {
      expect(() => store.upsert({ endpoint, keys: KEYS }, null)).toThrow(/not usable/);
      try { store.upsert({ endpoint, keys: KEYS }, null); } catch (e) {
        expect((e as Error).message).not.toContain(endpoint);
      }
    }
    expect(store.subscriptions()).toHaveLength(ok.length);
  });

  it('rejects a non-https endpoint without echoing the address', () => {
    const store = new PushStore(pushStoreFile(dir()));
    const bad = 'http://push.example/secret-path';
    expect(() => store.upsert({ endpoint: bad, keys: KEYS }, null)).toThrow(/not usable/);
    try { store.upsert({ endpoint: bad, keys: KEYS }, null); } catch (e) {
      expect((e as Error).message).not.toContain('secret-path');
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it('round-trips toggles', () => {
    const file = pushStoreFile(dir());
    const store = new PushStore(file, () => 1);
    const next = store.setPrefs({ types: { grid_fill: false, daily_summary: true }, quiet: { on: true } });
    expect(next.types.grid_fill).toBe(false);
    expect(next.types.daily_summary).toBe(true);
    expect(next.types.sniper).toBe(true);
    expect(next.quiet.on).toBe(true);
    expect(new PushStore(file).prefs().types.grid_fill).toBe(false);
  });

  it('leaves a corrupt file in place', () => {
    const file = pushStoreFile(dir());
    writeFileSync(file, '{', { mode: 0o600 });
    const store = new PushStore(file);
    expect(() => store.subscriptions()).toThrow(/left as it is/);
    expect(readFileSync(file, 'utf8')).toBe('{');
  });
});

describe('vapid key file', () => {
  it('creates the key once, mode 600, and does not put it in the public view or a log line', () => {
    const root = dir();
    const file = vapidFile(root);
    const first = loadOrCreateVapid(file);
    const second = loadOrCreateVapid(file);
    expect(second.publicKey).toBe(first.publicKey);
    expect(mode(file)).toBe(0o600);
    expect(redact(`leak ${first.privateKey}`)).toBe('leak [REDACTED]');

    const sent: { endpoint: string; body: string }[] = [];
    const logs: string[] = [];
    const transport: PushTransport = { async send(sub, body) { sent.push({ endpoint: sub.endpoint, body }); } };
    const svc = new PushService({ dir: root, transport, log: (_level, msg) => logs.push(msg) });
    const view = JSON.stringify(svc.view());
    expect(view).not.toContain(first.privateKey);
    expect(view).not.toContain('privateKey');
    svc.subscribe({ endpoint: ENDPOINT, keys: KEYS }, 'test');
    expect(JSON.stringify(svc.view())).not.toContain(ENDPOINT);
    expect(logs.join('\n')).not.toContain(ENDPOINT);
    expect(sent).toHaveLength(0);
  });

  it('does not replace an incomplete key file', () => {
    const file = vapidFile(dir());
    const raw = '{"publicKey":"abc"}';
    writeFileSync(file, raw);
    chmodSync(file, 0o600);
    expect(() => loadOrCreateVapid(file)).toThrow(/incomplete/);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  });
});

describe('payload', () => {
  it('collapses whitespace, caps the body, and refuses an off-site url', () => {
    const p = buildPayload('grid_fill', `  a \n b  ${'x'.repeat(400)}`, { url: 'https://evil.example/phish', tag: 'a:b' });
    expect(p.body.startsWith('a b ')).toBe(true);
    expect(p.body.length).toBeLessThanOrEqual(280);
    expect(p.url).toBe('/');
    expect(p.title.length).toBeLessThanOrEqual(120);
    expect(buildPayload('gas_low', 'low', { url: '//evil.example' }).url).toBe('/');
  });

  it('picks urgency, a topic, and a round-trippable test payload', () => {
    expect(urgencyFor('bot_halted')).toBe('high');
    expect(urgencyFor('tx_failed')).toBe('high');
    expect(urgencyFor('gas_low')).toBe('high');
    expect(urgencyFor('lp_range')).toBe('high');
    expect(urgencyFor('grid_fill')).toBe('normal');
    expect(pushTopic('a:b')).toBe('ab');
    expect(pushTopic('!!!')).toBeUndefined();
    const test = testPayload(5);
    const back = JSON.parse(serializePayload(test)) as typeof test;
    expect(back).toEqual(test);
    expect(back.type).toBe('test');
  });
});

describe('digest', () => {
  it('sends the first six and holds the rest until the burst goes quiet', () => {
    let now = 0;
    const d = new FillDigester(10 * 60_000, 6, 60_000, () => now);
    const kinds: string[] = [];
    for (let i = 0; i < 8; i++) kinds.push(d.offer({ title: 't', body: `fill ${i}`, tag: `t${i}` }).kind);
    expect(kinds.filter((k) => k === 'send')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'hold')).toHaveLength(2);
    expect(d.flush()).toBeNull();
    now = 59_000;
    expect(d.flush()).toBeNull();
    now = 60_000;
    const batch = d.flush();
    expect(batch?.title).toMatch(/2 more grid fills/);
    expect(batch?.count).toBe(2);
    expect(d.flush()?.count).toBe(2);
    d.commit();
    expect(d.flush()).toBeNull();
  });

  it('caps a digest at the held-list limit and counts the rest', () => {
    expect(DIGEST_HOLD_CAP).toBe(200);
    let now = 0;
    const d = new FillDigester(10 * 60_000, 1, 60_000, () => now, 3);
    d.offer({ title: 't', body: 'first', tag: 'a' });
    for (let i = 0; i < 5; i++) d.offer({ title: 't', body: `held ${i}`, tag: `h${i}` });
    now = 60_000;
    const batch = d.flush();
    expect(batch?.count).toBe(5);
    expect(batch?.title).toMatch(/5 more grid fills/);
    expect(batch?.body).toMatch(/\(\+2 more\)$/);
    expect(d.flush()?.count).toBe(5);
  });

  it('sends individually again after the window', () => {
    let now = 0;
    const d = new FillDigester(10 * 60_000, 6, 60_000, () => now);
    for (let i = 0; i < 8; i++) d.offer({ title: 't', body: `fill ${i}`, tag: `t${i}` });
    now = 10 * 60_000;
    expect(d.offer({ title: 't', body: 'next', tag: 'n' }).kind).toBe('send');
  });
});

describe('toggle filtering', () => {
  const quiet = prefs({ quiet: { on: true, start: '23:00', end: '07:00', tz: 'America/New_York' } });
  const at = (iso: string) => Date.parse(iso);

  it('sends only when a phone is subscribed and the type is on', () => {
    const base = { prefs: prefs(), at: at('2026-01-15T17:00:00Z') };
    expect(pushAllowed({ ...base, hasSubscription: false, type: 'grid_fill' })).toBe(false);
    expect(pushAllowed({ ...base, hasSubscription: true, type: 'grid_fill' })).toBe(true);
    expect(pushAllowed({ ...base, hasSubscription: true, type: 'daily_summary' })).toBe(false);
    const off = prefs({ types: { grid_fill: false } });
    expect(pushAllowed({ hasSubscription: true, prefs: off, type: 'grid_fill', at: base.at })).toBe(false);
  });

  it('holds ordinary alerts during quiet hours and still sends a halt or a failed transaction', () => {
    const night = at('2026-01-15T11:30:00Z');
    const day = at('2026-01-15T17:00:00Z');
    const late = at('2026-01-16T04:30:00Z');
    expect(pushAllowed({ hasSubscription: true, prefs: quiet, type: 'grid_fill', at: night })).toBe(false);
    expect(pushAllowed({ hasSubscription: true, prefs: quiet, type: 'grid_fill', at: day })).toBe(true);
    expect(pushAllowed({ hasSubscription: true, prefs: quiet, type: 'grid_fill', at: late })).toBe(false);
    expect(pushAllowed({ hasSubscription: true, prefs: quiet, type: 'bot_halted', at: night })).toBe(true);
    expect(pushAllowed({ hasSubscription: true, prefs: quiet, type: 'tx_failed', at: late })).toBe(true);
  });

  it('sends the daily summary once inside the evening window', () => {
    const on = prefs({ types: { daily_summary: true } });
    const due = at('2026-01-16T02:05:00Z');
    const late = at('2026-01-16T02:30:00Z');
    expect(dailyDue(on, due, null)).toBe(true);
    expect(dailyDue(on, late, null)).toBe(false);
    expect(dailyDue(on, due, '2026-01-15')).toBe(false);
    expect(dailyDue(prefs(), due, null)).toBe(false);
  });
});

describe('classify', () => {
  it('maps activity events onto push types and leaves user stops alone', () => {
    expect(classifyPush({ type: 'filled', kind: 'grid', msg: 'bought' })).toBe('grid_fill');
    expect(classifyPush({ type: 'filled', kind: 'trend', msg: 'Trend bought' })).toBeNull();
    expect(classifyPush({ type: 'range', kind: 'lp', msg: 'moved' })).toBe('lp_range');
    expect(classifyPush({ type: 'range', kind: 'grid', msg: 'left the range' })).toBeNull();
    expect(classifyPush({ type: 'stopped', level: 'error', msg: 'tax', data: { halt: { origin: 'system', what: 'safety' } } })).toBe('bot_halted');
    expect(classifyPush({ type: 'stopped', level: 'info', msg: 'stopped', data: { halt: { what: 'button', origin: 'localhost' } } })).toBeNull();
    expect(classifyPush({ type: 'info', msg: 'PulseChain low gas: 1 PLS' })).toBe('gas_low');
    expect(classifyPush({ type: 'info', msg: 'bought HEX', data: { push: 'sniper' } })).toBe('sniper');
    expect(classifyPush({ type: 'info', msg: 'swap reverted' })).toBe('tx_failed');
    expect(classifyPush({ type: 'stopped', level: 'success', msg: 'closed', data: { halt: { origin: 'system', what: 'close' } } })).toBeNull();
  });
});

describe('range band', () => {
  it('calls 86% of the way across near, and keeps a little hysteresis', () => {
    expect(pctToEdge(86, 0, 100)).toBe(86);
    expect(rangeZone(86, 0, 100, true, 'in')).toBe('near');
    expect(rangeZone(78, 0, 100, true, 'near')).toBe('near');
    expect(rangeZone(78, 0, 100, true, 'in')).toBe('in');
    expect(rangeZone(110, 0, 100, true, 'in')).toBe('out');
    expect(rangeZone(50, 0, 100, false, 'in')).toBe('out');
  });
});

describe('lp watch', () => {
  const snap = (price: number, extra: Partial<LpSnap> = {}): LpSnap => ({
    id: 'lp1', label: 'ETH/USDG', chainId: 1, price, lower: 0, upper: 100, inRange: price >= 0 && price <= 100, outSince: null, ...extra,
  });

  it('seeds the first sight, then reports a near edge and a stay outside', () => {
    let now = 1_000_000;
    const w = new LpWatch(() => now);
    expect(w.update([snap(50)])).toEqual([]);
    const near = w.update([snap(86)]);
    expect(near).toHaveLength(1);
    expect(near[0].kind).toBe('near');
    expect(near[0].body).toMatch(/86% to the edge/);

    const since = now - 11 * 60_000;
    const fresh = new LpWatch(() => now);
    expect(fresh.update([snap(110, { inRange: false, outSince: since })])).toEqual([]);
    const out = fresh.update([snap(110, { inRange: false, outSince: since })]);
    expect(out.map((n) => n.kind)).toEqual(['out']);
    fresh.suppressOut('lp1');
    expect(fresh.update([snap(110, { inRange: false, outSince: since })])).toEqual([]);
    fresh.update([snap(50)]);
    expect(fresh.update([snap(110, { inRange: false, outSince: now })]).map((n) => n.kind)).toEqual([]);
  });
});

describe('push service', () => {
  function harness(snaps: LpSnap[] = []) {
    const root = dir();
    let now = Date.parse('2026-06-01T16:00:00Z');
    const sent: { endpoint: string; body: string }[] = [];
    const logs: string[] = [];
    let fail: { statusCode: number; message: string } | null = null;
    const transport: PushTransport = {
      async send(sub, body) {
        if (fail) throw Object.assign(new Error(fail.message), { statusCode: fail.statusCode });
        sent.push({ endpoint: sub.endpoint, body });
      },
    };
    const svc = new PushService({
      dir: root,
      now: () => now,
      transport,
      log: (_level, msg) => logs.push(msg),
      positions: () => snaps,
      summary: () => ({ title: 'GridBot · daily summary', body: 'PulseChain: +$1.00' }),
    });
    return { svc, sent, logs, root, setNow: (n: number) => { now = n; }, failWith: (statusCode: number, message: string) => { fail = { statusCode, message }; } };
  }

  const sub = { endpoint: ENDPOINT, keys: KEYS };

  it('sends a grid fill only while that toggle is on and a phone is subscribed', async () => {
    const h = harness();
    await h.svc.onActivity({ type: 'filled', kind: 'grid', msg: 'Grid buy', botId: 'g1' });
    expect(h.sent).toHaveLength(0);
    h.svc.subscribe(sub, 'test');
    await h.svc.onActivity({ type: 'filled', kind: 'grid', msg: 'Grid buy', botId: 'g1' });
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].body).type).toBe('grid_fill');
    expect(h.sent[0].endpoint).toBe(ENDPOINT);
    h.svc.setPrefs({ types: { grid_fill: false } });
    await h.svc.onActivity({ type: 'filled', kind: 'grid', msg: 'Grid buy again', botId: 'g1' });
    expect(h.sent).toHaveLength(1);
  });

  it('digests a burst on the next tick after a quiet minute', async () => {
    const h = harness();
    h.svc.subscribe(sub, 'test');
    for (let i = 0; i < 8; i++) await h.svc.onActivity({ type: 'filled', kind: 'grid', msg: `Grid fill ${i}`, botId: 'g' });
    expect(h.sent).toHaveLength(6);
    h.setNow(Date.parse('2026-06-01T16:00:00Z') + 60_000);
    await h.svc.tick();
    expect(h.sent).toHaveLength(7);
    expect(JSON.parse(h.sent[6].body).title).toMatch(/2 more grid fills/);
  });

  it('ignores a button stop and sends a safety halt', async () => {
    const h = harness();
    h.svc.subscribe(sub, 'test');
    await h.svc.onActivity({ type: 'stopped', level: 'info', msg: 'stopped', data: { halt: { what: 'stop-all', origin: 'localhost' } } });
    expect(h.sent).toHaveLength(0);
    await h.svc.onActivity({ type: 'stopped', level: 'error', msg: 'tax too high', data: { halt: { origin: 'system', what: 'safety' } } });
    expect(JSON.parse(h.sent[0].body).type).toBe('bot_halted');
  });

  it('drops a subscription the push service has forgotten, without logging the endpoint or the key', async () => {
    const h = harness();
    h.svc.subscribe(sub, 'test');
    const key = JSON.parse(readFileSync(vapidFile(h.root), 'utf8')).privateKey as string;
    h.failWith(410, `https://push.example/SECRET ${key}`);
    await expect(h.svc.test(ENDPOINT)).rejects.toThrow(/not subscribed|did not accept|Turn on push/);
    expect(h.svc.view().subscribed).toBe(0);
    const text = h.logs.join('\n');
    expect(text).toContain('push: status 410');
    expect(text).not.toContain(ENDPOINT);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain(key);
  });

  it('reports a near edge from the read-only watcher', async () => {
    const snaps: LpSnap[] = [{ id: 'lp1', label: 'ETH/USDG', chainId: 1, price: 50, lower: 0, upper: 100, inRange: true, outSince: null }];
    const h = harness(snaps);
    h.svc.subscribe(sub, 'test');
    await h.svc.tick();
    expect(h.sent).toHaveLength(0);
    snaps[0] = { ...snaps[0], price: 86 };
    await h.svc.tick();
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].body).type).toBe('lp_range');
    expect(JSON.parse(h.sent[0].body).body).toMatch(/86% to the edge/);
  });

  it('sends the daily summary once', async () => {
    const h = harness();
    h.svc.subscribe(sub, 'test');
    h.svc.setPrefs({ types: { daily_summary: true } });
    h.setNow(Date.parse('2026-01-16T02:05:00Z'));
    await h.svc.tick();
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].body).type).toBe('daily_summary');
    await h.svc.tick();
    expect(h.sent).toHaveLength(1);
  });

  it('keeps the key and the phone when a new process opens the same directory', () => {
    const h = harness();
    h.svc.subscribe(sub, 'test');
    const key = h.svc.publicKey();
    const again = new PushService({ dir: h.root, now: () => 1, transport: { async send() { /* unused */ } } });
    expect(again.publicKey()).toBe(key);
    expect(again.view().subscribed).toBe(1);
    expect(JSON.stringify(again.view())).not.toContain(ENDPOINT);
  });

  it('keeps a grid-fill digest through quiet hours until it is delivered', async () => {
    const h = harness();
    h.setNow(Date.parse('2026-01-15T17:00:00Z'));
    h.svc.subscribe(sub, 'test');
    for (let i = 0; i < 8; i++) await h.svc.onActivity({ type: 'filled', kind: 'grid', msg: `Grid fill ${i}`, botId: 'g' });
    expect(h.sent).toHaveLength(6);
    h.svc.setPrefs({ quiet: { on: true } });
    h.setNow(Date.parse('2026-01-16T04:30:00Z'));
    await h.svc.tick();
    await h.svc.tick();
    expect(h.sent).toHaveLength(6);
    h.setNow(Date.parse('2026-01-16T17:00:00Z'));
    await h.svc.tick();
    expect(h.sent).toHaveLength(7);
    expect(JSON.parse(h.sent[6].body).title).toMatch(/2 more grid fills/);
    await h.svc.tick();
    expect(h.sent).toHaveLength(7);
  });

  it('retries an LP near-edge note that quiet hours blocked', async () => {
    const snaps: LpSnap[] = [{ id: 'lp1', label: 'ETH/USDG', chainId: 1, price: 50, lower: 0, upper: 100, inRange: true, outSince: null }];
    const h = harness(snaps);
    h.setNow(Date.parse('2026-01-16T04:30:00Z'));
    h.svc.subscribe(sub, 'test');
    h.svc.setPrefs({ quiet: { on: true } });
    await h.svc.tick();
    snaps[0] = { ...snaps[0], price: 86 };
    await h.svc.tick();
    await h.svc.tick();
    expect(h.sent).toHaveLength(0);
    h.setNow(Date.parse('2026-01-16T17:00:00Z'));
    await h.svc.tick();
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].body).body).toMatch(/86% to the edge/);
    await h.svc.tick();
    expect(h.sent).toHaveLength(1);
  });

  it('retries 429 and server errors and does not retry a gone subscription', async () => {
    const sleeps: number[] = [];
    const root = dir();
    let gate: { statusCode: number; retryAfter?: number } | null = { statusCode: 429, retryAfter: 1_500 };
    let calls = 0;
    const svc = new PushService({
      dir: root,
      now: () => Date.parse('2026-06-01T16:00:00Z'),
      sleep: async (ms) => { sleeps.push(ms); },
      transport: { async send() { calls++; if (gate) throw Object.assign(new Error('push failed'), gate); } },
    });
    svc.subscribe(sub, 'test');
    await svc.onActivity({ type: 'filled', kind: 'grid', msg: 'Grid buy', botId: 'g' });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_500]);
    expect(svc.view().subscribed).toBe(1);

    calls = 0;
    sleeps.length = 0;
    gate = { statusCode: 503, retryAfter: 9_999_000 };
    await svc.onActivity({ type: 'stopped', level: 'error', msg: 'tax', data: { halt: { origin: 'system', what: 'safety' } } });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(svc.view().subscribed).toBe(1);

    calls = 0;
    gate = { statusCode: 410 };
    await svc.onActivity({ type: 'filled', kind: 'grid', msg: 'Grid buy', botId: 'g' });
    expect(calls).toBe(1);
    expect(svc.view().subscribed).toBe(0);

    svc.subscribe(sub, 'test');
    calls = 0;
    gate = { statusCode: 404 };
    await svc.onActivity({ type: 'error', msg: 'reverted' });
    expect(calls).toBe(1);
    expect(svc.view().subscribed).toBe(0);
  });

  it('sends a test only to the named phone', async () => {
    const root = dir();
    const sent: string[] = [];
    const svc = new PushService({
      dir: root,
      now: () => 1,
      transport: { async send(s) { sent.push(s.endpoint); } },
    });
    svc.subscribe(sub, 'a');
    svc.subscribe({ endpoint: OTHER, keys: { p256dh: 'zzzzzzzz', auth: KEYS.auth } }, 'b');
    await expect(svc.test()).rejects.toThrow(/phone that should receive it/);
    expect(sent).toEqual([]);
    await svc.test(OTHER);
    expect(sent).toEqual([OTHER]);
  });
});

describe('push opt-in', () => {
  it('unsubscribes the browser even when the endpoint is already known', async () => {
    let disabled = 0;
    const posted: string[] = [];
    await unsubscribePush({
      knownEndpoint: ENDPOINT,
      disable: async () => { disabled++; return ENDPOINT; },
      post: async (ep) => { posted.push(ep); },
    });
    expect(disabled).toBe(1);
    expect(posted).toEqual([ENDPOINT]);
  });

  it('does not restore a subscription unless push was turned on', () => {
    let value: string | null = null;
    const mem = {
      getItem: () => value,
      setItem: (_k: string, v: string) => { value = v; },
      removeItem: () => { value = null; },
    };
    expect(shouldRestorePush(pushOptedIn(mem))).toBe(false);
    setPushOptIn(true, mem);
    expect(mem.getItem()).toBe('1');
    expect(PUSH_OPT_IN_KEY).toBe('gridbot-push-opt-in');
    expect(shouldRestorePush(pushOptedIn(mem))).toBe(true);
    setPushOptIn(false, mem);
    expect(mem.getItem()).toBe('0');
    expect(shouldRestorePush(pushOptedIn(mem))).toBe(false);
  });

  it('stays off after Turn off stores an opt-out', async () => {
    let value: string | null = '1';
    const mem = {
      getItem: () => value,
      setItem: (_k: string, v: string) => { value = v; },
      removeItem: () => { value = null; },
    };
    const posted: string[] = [];
    setPushOptIn(false, mem);
    await unsubscribePush({
      knownEndpoint: ENDPOINT,
      disable: async () => OTHER,
      post: async (ep) => { posted.push(ep); },
    });
    expect(mem.getItem()).toBe('0');
    expect(posted).toEqual([ENDPOINT, OTHER]);
    expect(shouldRestorePush(pushOptedIn(mem))).toBe(false);
  });
});

describe('vapid subject and saved view', () => {
  it('uses a configured VAPID subject and otherwise the local default', () => {
    expect(vapidSubjectFrom(undefined)).toBe(VAPID_SUBJECT);
    expect(vapidSubjectFrom('  mailto:desk@example.com ')).toBe('mailto:desk@example.com');
    expect(vapidSubjectFrom('https://gridbot.example/push')).toBe('https://gridbot.example/push');
    const junk = 'not-a-subject SECRET';
    expect(vapidSubjectFrom(junk)).toBe(VAPID_SUBJECT);
    expect(VAPID_SUBJECT).not.toContain('SECRET');
    expect(retryAfterMs({ 'retry-after': '2' })).toBe(2_000);
    expect(retryAfterMs({ 'retry-after': 'not-a-date' })).toBeUndefined();
    const httpDate = new Date(Date.parse('2026-01-15T12:00:03Z')).toUTCString();
    expect(retryAfterMs({ 'Retry-After': httpDate }, Date.parse('2026-01-15T12:00:00Z'))).toBe(3_000);
  });

  it('opens the Alerts screen instead of the old tools tab', () => {
    expect(normalizeView({ v: 'tools', tab: 'alerts' })).toEqual({ v: 'alerts' });
    expect(normalizeView({ v: 'tools', tab: 'chart' })).toMatchObject({ v: 'tools', tab: 'chart' });
    expect(normalizeView(null)).toBeNull();
  });
});

describe('daily summary text', () => {
  it('separates live and paper generated amounts in token units', () => {
    const both = dailySummary({
      chains: [{ id: 369, name: 'PulseChain' }],
      grids: [
        { mode: 'live', chainId: 369, quoteSym: 'DAI', pnl: { realized: 1.5 }, stats: { roundTrips: 2 } },
        { mode: 'paper', chainId: 369, quoteSym: 'DAI', pnl: { realized: 9 }, stats: { roundTrips: 1 } },
      ],
      trends: [
        { mode: 'live', chainId: 369, quoteSym: 'HEX', pnl: { realized: -0.25 }, stats: { count: 1 } },
      ],
      lps: [
        { mode: 'paper', chainId: 369, quote: 'DAI', pnl: { net: 0.5, price: 100 } },
      ],
    });
    expect(both.body.startsWith('Generated')).toBe(true);
    expect(both.body.indexOf('Generated')).toBeLessThan(both.body.indexOf('Paper'));
    expect(both.body).toContain('PulseChain +1.5 DAI');
    expect(both.body).toContain('PulseChain −0.25 HEX');
    expect(both.body).toContain('PulseChain +9.5 DAI');
    expect(both.body).not.toContain('100');
    expect(both.body).not.toMatch(/\$|Realized|Unrealized/);

    const liveOnly = dailySummary({
      chains: [{ id: 369, name: 'PulseChain' }],
      grids: [{ mode: 'live', chainId: 369, quoteSym: 'DAI', pnl: { realized: 2 }, stats: { roundTrips: 1 } }],
    });
    expect(liveOnly.body).toContain('Generated');
    expect(liveOnly.body).not.toContain('Paper');
    expect(liveOnly.body).not.toMatch(/\$|Realized|Unrealized/);
  });
});

describe('push init', () => {
  it('starts the app when push init throws', async () => {
    const logs: string[] = [];
    const log = (level: 'info' | 'warn', msg: string) => logs.push(`${level}:${msg}`);
    const badKey = mkdtempSync(join(tmpdir(), 'gridbot-push-key-'));
    writeFileSync(join(badKey, 'push-vapid.json'), '{not json');
    expect(tryStartPush({ dir: badKey, log, transport: { async send() { throw new Error('no send'); } } })).toBeNull();

    const badStore = mkdtempSync(join(tmpdir(), 'gridbot-push-store-'));
    writeFileSync(join(badStore, 'push.json'), '{');
    expect(tryStartPush({ dir: badStore, log, transport: { async send() { throw new Error('no send'); } } })).toBeNull();
    expect(logs.join('\n')).toMatch(/push: off/);
    expect(logs.join('\n')).not.toMatch(/privateKey|not json/);

    const bot = new MultiBot({ net: NET, reader: new MockChain(1e-5), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    bot.startLoop(60_000);
    const app = createApp({ bot, net: NET, heartbeatMs: 60_000, statusThrottleMs: 60_000 });
    const server = http.createServer(app);
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const get = (path: string) => new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      expect(await get('/api/alerts')).toBe(200);
      expect(await get('/api/push/status')).toBe(404);
    } finally {
      bot.stopLoop();
      server.close();
    }
  });
});

describe('push routes on a friend copy', () => {
  it('push routes answer 403 on a friend copy', async () => {
    const bot = new MultiBot({ net: NET, reader: new MockChain(1e-5), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true) });
    const push = {
      publicKey: () => 'pub',
      view: () => ({ ok: true }),
      setPrefs: () => ({}),
      subscribe: () => ({ ok: true }),
      unsubscribe: () => ({ ok: true }),
      test: async () => ({ ok: true as const, sent: 1 }),
    };
    const hit = async (copy: boolean, via?: string) => {
      const app = createApp({ bot, net: NET, copy, push, heartbeatMs: 60_000, statusThrottleMs: 60_000 });
      const server = http.createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      try {
        return await new Promise<{ status: number }>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1', port, path: '/api/push/status', method: 'GET',
            headers: { host: `127.0.0.1:${port}`, ...(via ? { 'x-gridbot-via': via } : {}) },
          }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
          });
          req.on('error', reject);
          req.end();
        });
      } finally { server.close(); }
    };
    expect((await hit(true)).status).toBe(403);
    expect((await hit(false, 'friend')).status).toBe(403);
    expect((await hit(false, 'owner')).status).toBe(200);
  });
});
