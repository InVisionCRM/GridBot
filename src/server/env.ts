import { resolve } from 'node:path';
import { FetchRequest, JsonRpcProvider, Wallet } from 'ethers';
import { getNetwork, type NetworkKey } from '../live/networks';
import { registerSecret } from './bot/logger';

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
 * PRIVATE_KEY_<envSlug> (e.g. PRIVATE_KEY_BASE). Every PRIVATE_KEY* variable is removed from process.env
 * immediately and registered for log redaction; keys never leave this module except inside Wallet objects.
 */
export function createSigners(chains: { id: number; envSlug: string; provider: JsonRpcProvider }[]): Map<number, Wallet> {
  const shared = process.env.PRIVATE_KEY;
  delete process.env.PRIVATE_KEY;
  const per = new Map<string, string | undefined>();
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith('PRIVATE_KEY_')) continue;
    per.set(name.slice('PRIVATE_KEY_'.length), process.env[name]);
    delete process.env[name];
  }
  const sharedKey = parseKey(shared, 'PRIVATE_KEY');
  const out = new Map<number, Wallet>();
  for (const c of chains) {
    const k = parseKey(per.get(c.envSlug), `PRIVATE_KEY_${c.envSlug}`) ?? sharedKey;
    if (k) out.set(c.id, new Wallet(k, c.provider));
  }
  return out;
}
