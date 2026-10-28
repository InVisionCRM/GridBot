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
  /** Contact on the VAPID key. Already checked; the default is mailto:gridbot@localhost. */
  subject?: string;
  /** Tests skip the real wait. Production sleeps. */
  sleep?: (ms: number) => Promise<void>;
}

const GONE = new Set([404, 410]);

/**
 * Start lock-screen push, or leave it off. A bad key file, a subscription file that cannot be
 * read, or any other init throw is logged and swallowed. The caller keeps the server and the bots up.
 */
export function tryStartPush(o: PushDeps): PushService | null {
  try {
    const svc = new PushService(o);
    svc.view();
    return svc;
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : 'could not start';
    o.log?.('warn', `push: off (${msg})`);
    return null;
  }
}

export class PushService {
  private readonly now: () => number;
  private readonly store: PushStore;
  private readonly keys: { publicKey: string; privateKey: string };
  private readonly transport: PushTransport;
  private readonly digest = new FillDigester(undefined, undefined, undefined, () => this.now());
  private readonly lp: LpWatch;
  private readonly sleep: (ms: number) => Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly o: PushDeps) {
    this.now = o.now ?? Date.now;
    this.store = new PushStore(join(o.dir, 'push.json'), this.now);
    this.keys = loadOrCreateVapid(vapidFile(o.dir));
    this.transport = o.transport ?? createWebPush(this.keys, o.subject);
    this.lp = new LpWatch(this.now);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
      if (!endpoint) throw new Error('Send the test from the phone that should receive it.');
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
      const item = { title: 'GridBot · Grid fill', body: e.msg, tag: `fill-${e.botId ?? 'g'}-${this.now().toString(36)}`, mode: e.mode };
      const r = this.digest.offer(item);
      if (r.kind === 'hold') return;
      await this.deliver(buildPayload('grid_fill', r.body, { title: r.title, tag: r.tag, ts: this.now(), botId: e.botId, mode: r.mode }));
      return;
    }
    await this.deliver(buildPayload(type, e.msg, { ts: this.now(), botId: e.botId, mode: e.mode }));
  }

  private async tickBody() {
    const batch = this.digest.flush();
    if (batch && this.allowed('grid_fill')) {
      const sent = await this.deliver(buildPayload('grid_fill', batch.body, { title: batch.title, tag: batch.tag, ts: this.now(), mode: batch.mode }));
      if (sent > 0) this.digest.commit();
    }
    let snaps: LpSnap[] = [];
    try { snaps = this.o.positions?.() ?? []; } catch (e) { this.warn(e); }
    const notes = this.lp.update(snaps);
    if (this.allowed('lp_range')) {
      for (const n of notes) {
        const sent = await this.deliver(buildPayload('lp_range', n.body, { title: n.title, tag: n.tag, ts: this.now(), botId: n.id, mode: n.mode }));
        if (sent > 0 && n.kind === 'out') this.lp.suppressOut(n.id);
        if (sent > 0 && n.kind === 'near') this.lp.suppressNear(n.id);
      }
    }
    const prefs = this.store.prefs();
    if (!dailyDue(prefs, this.now(), this.store.dailySentOn()) || !this.allowed('daily_summary') || !this.o.summary) return;
    let text: { title: string; body: string };
    try { text = this.o.summary(); } catch (e) { this.warn(e); return; }
    const sent = await this.deliver(buildPayload('daily_summary', text.body, { title: text.title, tag: 'daily-summary', ts: this.now() }));
    if (sent) this.store.markDaily(dayKey(prefs.daily.tz, this.now()));
  }

  /** 404 and 410 are permanent. 429, 5xx, and a timeout are worth another try. */
  private retryable(status: number): boolean {
    return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
  }

  private delayFor(e: unknown, attempt: number): number {
    const hinted = (e as { retryAfter?: number }).retryAfter;
    if (typeof hinted === 'number' && Number.isFinite(hinted) && hinted >= 0) return Math.min(5_000, hinted);
    return Math.min(2_000, 200 * 2 ** (attempt - 1));
  }

  private async postOne(s: { endpoint: string; p256dh: string; auth: string }, body: string, opts: ReturnType<typeof sendOpts>, tries: number): Promise<'ok' | 'gone' | 'fail'> {
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        await this.transport.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts);
        return 'ok';
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode ?? 0;
        if (GONE.has(status)) { this.warn(e); return 'gone'; }
        if (!this.retryable(status) || attempt === tries) { this.warn(e); return 'fail'; }
        await this.sleep(this.delayFor(e, attempt));
      }
    }
    return 'fail';
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
    const tries = payload.type === 'bot_halted' || payload.type === 'tx_failed' ? 3 : 2;
    let sent = 0;
    for (const s of subs) {
      const result = await this.postOne(s, body, opts, tries);
      if (result === 'ok') { this.store.mark(s.endpoint, true, null); sent++; }
      else if (result === 'gone') this.store.remove(s.endpoint);
      else this.store.mark(s.endpoint, false, 'not delivered');
    }
    this.store.record({ at: this.now(), type: payload.type, title: payload.title, body: payload.body, ok: sent > 0 });
    return sent;
  }
}
