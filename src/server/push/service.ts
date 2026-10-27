/**
 * Lock-screen alerts. Subscriptions live beside the other local data. Delivery is a direct POST
 * to the endpoint the browser handed us (Apple or Google). The app itself stays on the tailnet.
 */
import { join } from 'node:path';
import { dayKey, dailyDue, pushAllowed, type PushPublicView, type PushType } from '../../live/pushRules';
import { classifyPush, type PushEvent } from './classify';
import { FillDigester } from './digest';
import { LpWatch, type LpSnap } from './lpWatch';
import { buildPayload, serializePayload, testPayload, type PushPayload } from './payload';
import { createWebPush, sendOpts, type PushTransport } from './send';
import { PushStore } from './store';
import { loadOrCreateVapid, vapidFile } from './vapid';

export interface PushDeps {
  dir: string;
  now?: () => number;
  /** Tests pass a fake. Production uses Web Push. */
  transport?: PushTransport;
  log?: (level: 'info' | 'warn', msg: string) => void;
  positions?: () => LpSnap[];
  summary?: () => { title: string; body: string };
}

const GONE = new Set([404, 410]);

export class PushService {
  private readonly now: () => number;
  private readonly store: PushStore;
  private readonly keys: { publicKey: string; privateKey: string };
  private readonly transport: PushTransport;
  private readonly digest = new FillDigester(undefined, undefined, undefined, () => this.now());
  private readonly lp: LpWatch;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly o: PushDeps) {
    this.now = o.now ?? Date.now;
    this.store = new PushStore(join(o.dir, 'push.json'), this.now);
    this.keys = loadOrCreateVapid(vapidFile(o.dir));
    this.transport = o.transport ?? createWebPush(this.keys);
    this.lp = new LpWatch(this.now);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.then(() => undefined, () => undefined);
    return p;
  }

  private warn(e: unknown) {
    // Status only. Error text from the push library includes the endpoint, which is a capability URL.
    const status = (e as { statusCode?: number }).statusCode ?? 0;
    this.o.log?.('warn', status ? `push: status ${status}` : 'push: request failed');
  }

  publicKey(): string { return this.keys.publicKey; }

  view(): PushPublicView {
    const deliveries = this.store.deliveries();
    const last = deliveries.find((d) => d.ok)?.at ?? null;
    return {
      publicKey: this.keys.publicKey,
      subscribed: this.store.subscriptions().length,
      prefs: this.store.prefs(),
      lastDeliveredAt: last,
      deliveries,
    };
  }

  setPrefs(patch: unknown) { return this.store.setPrefs(patch); }

  subscribe(body: unknown, ua: string | null) {
    this.store.upsert(body, ua ? ua.slice(0, 180) : null);
    return { ok: true as const };
  }

  unsubscribe(endpoint: string) {
    if (typeof endpoint === 'string' && endpoint) this.store.remove(endpoint);
    return { ok: true as const };
  }

  onActivity(e: PushEvent): Promise<void> {
    return this.run(() => this.handle(e));
  }

  tick(): Promise<void> {
    return this.run(() => this.tickBody());
  }

  test(endpoint?: string): Promise<{ ok: true; sent: number }> {
    return this.run(async () => {
      const sent = await this.deliver(testPayload(this.now()), endpoint);
      if (!sent) throw new Error(this.store.subscriptions().length ? 'The push service did not accept the test.' : 'Turn on push on this phone first.');
      return { ok: true as const, sent };
    });
  }

  private allowed(type: PushType): boolean {
    return pushAllowed({
      hasSubscription: this.store.subscriptions().length > 0,
      prefs: this.store.prefs(),
      type,
      at: this.now(),
    });
  }

  private async handle(e: PushEvent) {
    const type = classifyPush(e);
    if (!type) return;
    if (!this.allowed(type)) return;
    // The auto-move text is the alert. Don't also send "out for 10 min" for this same stay outside.
    if (type === 'lp_range' && e.botId) this.lp.suppressOut(e.botId);
    if (type === 'grid_fill') {
      const item = { title: 'GridBot · Grid fill', body: e.msg, tag: `fill-${e.botId ?? 'g'}-${this.now().toString(36)}` };
      const r = this.digest.offer(item);
      if (r.kind === 'hold') return;
      await this.deliver(buildPayload('grid_fill', r.body, { title: r.title, tag: r.tag, ts: this.now(), botId: e.botId }));
      return;
    }
    await this.deliver(buildPayload(type, e.msg, { ts: this.now(), botId: e.botId }));
  }

  private async tickBody() {
    const batch = this.digest.flush();
    if (batch && this.allowed('grid_fill')) {
      await this.deliver(buildPayload('grid_fill', batch.body, { title: batch.title, tag: batch.tag, ts: this.now() }));
    }
    let snaps: LpSnap[] = [];
    try { snaps = this.o.positions?.() ?? []; } catch (e) { this.warn(e); }
    const notes = this.lp.update(snaps);
    if (this.allowed('lp_range')) {
      for (const n of notes) {
        if (n.kind === 'out') this.lp.suppressOut(n.id);
        await this.deliver(buildPayload('lp_range', n.body, { title: n.title, tag: n.tag, ts: this.now(), botId: n.id }));
      }
    }
    const prefs = this.store.prefs();
    if (!dailyDue(prefs, this.now(), this.store.dailySentOn()) || !this.allowed('daily_summary') || !this.o.summary) return;
    let text: { title: string; body: string };
    try { text = this.o.summary(); } catch (e) { this.warn(e); return; }
    const sent = await this.deliver(buildPayload('daily_summary', text.body, { title: text.title, tag: 'daily-summary', ts: this.now() }));
    if (sent) this.store.markDaily(dayKey(prefs.daily.tz, this.now()));
  }

  /** How many phones accepted it. A 404 or 410 means that browser unsubscribed, so the row is dropped. */
  private async deliver(payload: PushPayload, only?: string): Promise<number> {
    const subs = this.store.subscriptions().filter((s) => !only || s.endpoint === only);
    if (!subs.length) {
      if (only) throw new Error('This phone is not subscribed.');
      return 0;
    }
    const body = serializePayload(payload);
    const opts = sendOpts(payload);
    let sent = 0;
    for (const s of subs) {
      try {
        await this.transport.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts);
        this.store.mark(s.endpoint, true, null);
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        if (GONE.has(status)) this.store.remove(s.endpoint);
        else this.store.mark(s.endpoint, false, status ? `status ${status}` : 'request failed');
        this.warn(e);
      }
    }
    this.store.record({ at: this.now(), type: payload.type, title: payload.title, body: payload.body, ok: sent > 0 });
    return sent;
  }
}
