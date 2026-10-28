/**
 * VAPID key for Web Push. Created once, next to the other local data (not in .env).
 * The private key is registered with the log redactor and is never written to a log line here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { registerSecret } from '../bot/logger';
import { writePrivate } from './files';

export interface VapidPair { publicKey: string; privateKey: string }

function remember(pair: VapidPair): VapidPair {
  if (pair.privateKey) registerSecret(pair.privateKey);
  return pair;
}

function usable(v: unknown): v is VapidPair {
  if (!v || typeof v !== 'object') return false;
  const o = v as VapidPair;
  return typeof o.publicKey === 'string' && o.publicKey.length > 20
    && typeof o.privateKey === 'string' && o.privateKey.length > 20
    && o.publicKey !== o.privateKey;
}

export function vapidFile(dir: string) { return join(dir, 'push-vapid.json'); }

/** Load the key, or create it the first time. A broken file is left in place so a restart cannot rotate it by accident. */
export function loadOrCreateVapid(file: string): VapidPair {
  let raw: string | null = null;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The push key file is unreadable and was left as it is.');
  }
  if (raw != null) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('The push key file is unreadable and was left as it is.'); }
    if (!usable(parsed)) throw new Error('The push key file is incomplete and was left as it is.');
    return remember(parsed);
  }
  const created = webpush.generateVAPIDKeys();
  if (!usable(created)) throw new Error('Could not create a push key.');
  writePrivate(file, `${JSON.stringify({ publicKey: created.publicKey, privateKey: created.privateKey }, null, 2)}\n`);
  return remember(created);
}
