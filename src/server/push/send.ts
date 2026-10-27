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

export function createWebPush(keys: { publicKey: string; privateKey: string }): PushTransport {
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
            vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
          },
        );
      } catch (e) {
        // WebPushError.message includes the endpoint. Keep only the status code.
        const status = e instanceof webpush.WebPushError ? e.statusCode : 0;
        const err = new Error(status ? `status ${status}` : 'request failed') as Error & { statusCode: number };
        err.statusCode = status;
        throw err;
      }
    },
  };
}

export function sendOpts(payload: PushPayload): PushSendOpts {
  return { ttl: 12 * 60 * 60, urgency: urgencyFor(payload.type), topic: pushTopic(payload.tag) };
}
