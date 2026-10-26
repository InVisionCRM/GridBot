/**
 * Friends' keys at rest: AES-256-GCM under a key derived from FRIENDS_SECRET (which lives in the host's .env, not in
 * data/). Each box is bound to its friend's id, so a box copied onto another friend doesn't open. The host opens a key
 * only to start that friend's copy (copies.ts), which reads it once from its environment like the host's PRIVATE_KEY.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { computeAddress } from 'ethers';
import { registerSecret } from '../bot/logger';

export interface SealedKey { iv: string; tag: string; data: string }

/** One 32-byte key per use of FRIENDS_SECRET, so the session signer and the key box never share a key. */
export function subKey(secret: Buffer, use: 'vault' | 'session'): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `gridbot-friends-${use}`, 32));
}

/** A pasted private key as 0x + 64 hex. The error never repeats what was pasted. */
export function cleanKey(raw: string): string {
  const v = raw.trim();
  const key = v.startsWith('0x') ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('That isn\'t a private key. It is 64 letters and numbers (0-9, a-f), sometimes starting with 0x.');
  registerSecret(key);
  return key;
}

/** The public address a key signs for (shown so the friend can check it is the right account). */
export const keyAddress = (key: string): string => computeAddress(key);

export function sealKey(secret: Buffer, friendId: string, key: string): SealedKey {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', subKey(secret, 'vault'), iv);
  c.setAAD(Buffer.from(friendId));
  const data = Buffer.concat([c.update(cleanKey(key), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openKey(secret: Buffer, friendId: string, box: SealedKey): string {
  const d = createDecipheriv('aes-256-gcm', subKey(secret, 'vault'), Buffer.from(box.iv, 'base64'));
  d.setAAD(Buffer.from(friendId));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  let key: string;
  try {
    key = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new Error('A friend\'s key can\'t be opened: FRIENDS_SECRET in .env is not the one it was saved with.');
  }
  registerSecret(key);
  return key;
}
