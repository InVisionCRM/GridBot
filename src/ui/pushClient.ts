/** Browser side of Web Push. The server's public key is not a secret. The private key never comes here. */
import { http } from './api';
import type { PushPublicView } from '../live/pushRules';

export type { PushPublicView };

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** iOS delivers Web Push only to a Home Screen app (16.4+), not to a Safari tab. */
export function needsHomeScreen(): boolean {
  if (!isIos() || typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
  return !standalone;
}

export function preparePushWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve();
  return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(() => undefined, () => undefined);
}

function decodeKey(key: string): Uint8Array {
  const pad = '='.repeat((4 - (key.length % 4)) % 4);
  const b64 = (key + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const cur = sub.options.applicationServerKey;
  if (!cur) return false;
  const a = new Uint8Array(cur);
  const b = decodeKey(key);
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser cannot receive lock-screen alerts.');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  return reg;
}

/** This phone's subscription, when it was made with the server's current key. */
export async function localSubscription(publicKey: string): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  if (!sameKey(sub, publicKey)) return null;
  return sub;
}

export async function enablePush(publicKey: string): Promise<PushSubscriptionJSON> {
  if (typeof Notification === 'undefined') throw new Error('This browser has no notifications.');
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed.');
  const reg = await registration();
  let existing = await reg.pushManager.getSubscription();
  if (existing && !sameKey(existing, publicKey)) {
    await existing.unsubscribe();
    existing = null;
  }
  const key = decodeKey(publicKey);
  const sub = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
  });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('The browser did not return a push subscription.');
  return json;
}

export async function disablePush(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  const endpoint = sub?.endpoint ?? null;
  await sub?.unsubscribe();
  return endpoint;
}

export function loadPushStatus(): Promise<PushPublicView> {
  return http<PushPublicView>('/api/push/status');
}

export function savePushPrefs(patch: unknown): Promise<PushPublicView['prefs']> {
  return http('/api/push/prefs', 'PUT', patch);
}
