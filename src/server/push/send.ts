/**
 * Hand a payload to the browser's own push service (Apple, Google, Mozilla).
 * This process makes that HTTPS POST itself. There is no relay account in between.
 */
import webpush from 'web-push';
import type { PushPayload } from './payload';
import { pushTopic, urgencyFor } from './payload';

export const VAPID_SUBJECT = 'mailto:gridbot@localhost';

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendOpts { ttl: number; urgency: 'high' | 'normal'; topic?: string }

export interface PushTransport {
  send(sub: PushSub, body: string, opts: PushSendOpts): Promise<void>;
}

/** mailto: or https:// only. Anything else falls back to the local default. The value is not logged. */
export function vapidSubjectFrom(raw: string | undefined): string {
  const v = raw?.trim() ?? '';
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(v)) return v;
  if (/^https:\/\/[^\s]+$/.test(v)) return v;
  return VAPID_SUBJECT;
}

/** Retry-After as milliseconds, or undefined. A delay-seconds value is capped by the sender. */
export function retryAfterMs(headers: { [key: string]: string | string[] | undefined } | undefined, now = Date.now()): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  if (!Number.isFinite(when)) return undefined;
  return Math.max(0, when - now);
}

export function createWebPush(keys: { publicKey: string; privateKey: string }, subject = VAPID_SUBJECT): PushTransport {
  return {
    async send(sub, body, opts) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          {
            TTL: opts.ttl,
            urgency: opts.urgency,
            contentEncoding: 'aes128gcm',
            timeout: 10_000,
            ...(opts.topic ? { topic: opts.topic } : {}),
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          },
        );
      } catch (e) {
        // WebPushError.message includes the endpoint. Keep only the status code and a numeric Retry-After.
        const status = e instanceof webpush.WebPushError ? e.statusCode : 0;
        const retryAfter = e instanceof webpush.WebPushError ? retryAfterMs(e.headers) : undefined;
        const err = new Error(status ? `status ${status}` : 'request failed') as Error & { statusCode: number; retryAfter?: number };
        err.statusCode = status;
        if (retryAfter != null) err.retryAfter = retryAfter;
        throw err;
      }
    },
  };
}

export function sendOpts(payload: PushPayload): PushSendOpts {
  return { ttl: 12 * 60 * 60, urgency: urgencyFor(payload.type), topic: pushTopic(payload.tag) };
}
