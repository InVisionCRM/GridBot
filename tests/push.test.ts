/**
 * Lock-screen push: subscription file, payload, digest, and which types are allowed to send.
 * No network. The transport is a fake, and nothing here signs a transaction.
 */
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_PREFS, dailyDue, pushAllowed, type PushPrefs } from '../src/live/pushRules';
import { pctToEdge, rangeZone } from '../src/live/rangeBand';
import { redact } from '../src/server/bot/logger';
import { classifyPush } from '../src/server/push/classify';
import { FillDigester } from '../src/server/push/digest';
import { LpWatch, type LpSnap } from '../src/server/push/lpWatch';
import { buildPayload, pushTopic, serializePayload, testPayload, urgencyFor } from '../src/server/push/payload';
import { PushService } from '../src/server/push/service';
import { PushStore, pushStoreFile } from '../src/server/push/store';
import type { PushTransport } from '../src/server/push/send';
import { loadOrCreateVapid, vapidFile } from '../src/server/push/vapid';

const ENDPOINT = 'https://push.example/device-a';
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
    expect(d.flush()).toBeNull();
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
});
