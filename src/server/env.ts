import { resolve } from 'node:path';
import { FetchRequest, JsonRpcProvider, Wallet } from 'ethers';
import { getNetwork, type NetworkKey } from '../live/networks';
import { registerSecret } from './bot/logger';
import { ownerLoginFrom, parsePassHash, type OwnerConfig } from './friends/owner';

/** Load .env from the working directory (Node ≥ 20.12). Missing file is fine. */
export function loadEnv(file = '.env') {
  try {
    process.loadEnvFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function readSettings() {
  const network = (process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet') as NetworkKey;
  const net = getNetwork(network);
  return {
    net,
    rpcUrl: process.env.RPC_URL?.trim() || net.rpcUrl,
    port: Number(process.env.PORT || 3847),
    stateFile: resolve(process.env.STATE_FILE || 'data/state.json'),
    pollMs: Math.max(2000, Number(process.env.POLL_MS || 10_000)),
    approval: (process.env.APPROVAL_MODE === 'max' ? 'max' : 'exact') as 'exact' | 'max',
    maxRetries: Math.max(0, Number(process.env.MAX_RETRIES ?? 1)),
    retryDelayMs: Math.max(0, Number(process.env.RETRY_DELAY_MS ?? 5000)),
  };
}

/**
 * FRIENDS_SECRET (64 hex, written once by npm run friends:setup) seals friends' keys and signs their logins. Like
 * PRIVATE_KEY it is removed from process.env at once and redacted from logs. null = friends' copies are off.
 */
export function takeFriendsSecret(): Buffer | null {
  const raw = process.env.FRIENDS_SECRET;
  delete process.env.FRIENDS_SECRET;
  if (!raw || !raw.trim()) return null;
  const v = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error('FRIENDS_SECRET in .env must be 64 hex characters. Run npm run friends:setup to make one.');
  registerSecret(v);
  return Buffer.from(v, 'hex');
}

/**
 * Owner phone login (npm run host:password). The hash is removed from process.env at once, like FRIENDS_SECRET, and
 * redacted from logs. null = the gateway has no owner login. The plaintext password is never stored.
 */
export function takeHostAuth(): OwnerConfig | null {
  const hash = process.env.HOST_PASSWORD_HASH;
  const loginRaw = process.env.HOST_LOGIN;
  const sessionRaw = process.env.HOST_SESSION;
  delete process.env.HOST_PASSWORD_HASH;
  delete process.env.HOST_LOGIN;
  delete process.env.HOST_SESSION;
  if (!hash?.trim()) return null;
  registerSecret(hash.trim());
  const pass = parsePassHash(hash);
  const n = Number(sessionRaw);
  return { login: ownerLoginFrom(loginRaw), pass, session: Number.isInteger(n) && n > 0 ? n : 1 };
}

/** What a friend's copy knows about itself: set by the host app that starts it (friends/copies.ts). */
export interface CopyInfo { friend: string; host: string; hostUrl: string }

/** A friend's copy has FRIEND_NAME, HOST_NAME and HOST_URL; the host's own app has none of them. */
export function readCopy(): CopyInfo | null {
  const friend = process.env.FRIEND_NAME, host = process.env.HOST_NAME, hostUrl = process.env.HOST_URL;
  if (friend == null && host == null && hostUrl == null) return null;
  if (!friend || !host || !hostUrl) throw new Error('A friend\'s copy needs FRIEND_NAME, HOST_NAME and HOST_URL; it is started by the host app.');
  return { friend, host, hostUrl };
}

/**
 * A friend's copy: ask the host for the friend's key over the IPC channel (friends/copies.ts answers once). null = the
 * friend gave no key (paper only). The key is registered for log redaction and never put in process.env.
 */
export function receiveFriendKey(timeoutMs = 15_000): Promise<string | null> {
  const send = process.send?.bind(process);
  if (!send) return Promise.reject(new Error('A friend\'s copy is started by the host app.'));
  return new Promise((resolve, reject) => {
    const done = (f: () => void) => { clearTimeout(timer); process.off('message', on); f(); };
    const on = (m: unknown) => {
      const msg = m as { type?: unknown; key?: unknown } | null;
      if (msg?.type !== 'friend-key') return;
      const key = typeof msg.key === 'string' && msg.key ? msg.key : null;
      if (key) registerSecret(key.trim().startsWith('0x') ? key.trim() : `0x${key.trim()}`);
      done(() => resolve(key));
    };
    const timer = setTimeout(() => done(() => reject(new Error("The host app didn't hand over the friend's key."))), timeoutMs);
    process.on('message', on);
    send({ type: 'friend-key?' });
  });
}

/** JSON-RPC provider with a 30 s request timeout (ethers' default is 5 min, which can stall a poll or backfill). */
export function makeProvider(rpcUrl: string, chainId: number, timeoutMs = 30_000): JsonRpcProvider {
  const req = new FetchRequest(rpcUrl);
  req.timeout = timeoutMs;
  return new JsonRpcProvider(req, chainId, { staticNetwork: true });
}

/**
 * Build the signing wallet from PRIVATE_KEY. The raw value is removed from process.env immediately,
 * registered for log redaction, and never included in any error, log line, or API response.
 */
export function createSigner(provider: JsonRpcProvider): Wallet | null {
  const raw = process.env.PRIVATE_KEY;
  delete process.env.PRIVATE_KEY;
  if (!raw || !raw.trim()) return null;
  const v = raw.trim();
  const key = v.startsWith('0x') ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('PRIVATE_KEY in .env is not a 64-hex-character private key.');
  registerSecret(key);
  return new Wallet(key, provider);
}

function parseKey(raw: string | undefined, name: string): string | null {
  if (!raw || !raw.trim()) return null;
  const v = raw.trim();
  const key = v.startsWith('0x') ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${name} in .env is not a 64-hex-character private key.`);
  registerSecret(key);
  return key;
}

/**
 * Multi-chain signers: PRIVATE_KEY (same EVM address on every chain) plus optional per-chain overrides
 * PRIVATE_KEY_<envSlug> (e.g. PRIVATE_KEY_ETHEREUM). Every PRIVATE_KEY* variable is removed from process.env
 * immediately and registered for log redaction; keys never leave this module except inside Wallet objects.
 */
export function createSigners(chains: { id: number; envSlug: string; provider: JsonRpcProvider }[], o: { friendKey?: string | null } = {}): Map<number, Wallet> {
  const shared = process.env.PRIVATE_KEY;
  delete process.env.PRIVATE_KEY;
  const per = new Map<string, string | undefined>();
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith('PRIVATE_KEY_')) continue;
    per.set(name.slice('PRIVATE_KEY_'.length), process.env[name]);
    delete process.env[name];
  }
  // A friend's copy: only the key the host handed over (receiveFriendKey), on every chain; nothing from its environment.
  if ('friendKey' in o) per.clear();
  const sharedKey = 'friendKey' in o ? parseKey(o.friendKey ?? undefined, "The friend's key") : parseKey(shared, 'PRIVATE_KEY');
  const out = new Map<number, Wallet>();
  for (const c of chains) {
    const k = parseKey(per.get(c.envSlug), `PRIVATE_KEY_${c.envSlug}`) ?? sharedKey;
    if (k) out.set(c.id, new Wallet(k, c.provider));
  }
  return out;
}
