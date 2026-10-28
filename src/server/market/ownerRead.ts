/**
 * Paced, cached owner / EIP-1967 reads for the token trader's owner-powers check.
 * The trader calls this only when that flag is on, so the default path makes no extra RPC calls.
 * No log scans: Robinhood Chain has one public RPC.
 */
import { id } from 'ethers';
import {
  assessOwnerPowers, decodeSlot, decodeAddressWord, isRenouncedOwner, powersInBytecode,
  unverifiedOwnerReport, EIP1967_ADMIN, EIP1967_BEACON, EIP1967_IMPLEMENTATION,
  type CallRead, type OwnerReport, type SlotRead,
} from '../../market/ownerPowers';

const OWNER = id('owner()').slice(0, 10);
const GET_OWNER = id('getOwner()').slice(0, 10);
const IMPLEMENTATION = id('implementation()').slice(0, 10);
const CACHE_MS = 10 * 60_000;

export interface OwnerReader {
  call(tx: { to: string; data: string }): Promise<string>;
  getCode?(a: string): Promise<string>;
  getStorage?(a: string, slot: string): Promise<string>;
}

const cache = new Map<string, { at: number; report: OwnerReport }>();
let nextAt = 0;

export function clearOwnerCache(): void {
  cache.clear();
  nextAt = 0;
}

async function paced<T>(paceMs: number, fn: () => Promise<T>): Promise<T> {
  if (paceMs > 0) {
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAt = Date.now() + paceMs;
  }
  return fn();
}

async function readCode(reader: OwnerReader, addr: string, paceMs: number): Promise<string | null> {
  try {
    const code = await paced(paceMs, () => reader.getCode!(addr));
    if (!code || code === '0x' || code === '0x0') return null;
    return code;
  } catch { return null; }
}

async function readSlot(reader: OwnerReader, token: string, slot: string, paceMs: number): Promise<SlotRead> {
  try { return decodeSlot(await paced(paceMs, () => reader.getStorage!(token, slot))); } catch { return { state: 'fail' }; }
}

/** owner(), then getOwner() if that call reverts or returns something that is not an address. */
async function readOwner(reader: OwnerReader, to: string, paceMs: number): Promise<CallRead> {
  for (const data of [OWNER, GET_OWNER]) {
    try {
      const a = decodeAddressWord(await paced(paceMs, () => reader.call({ to, data })));
      if (a.ok) return { state: 'address', address: a.address };
    } catch { /* try the other view */ }
  }
  return { state: 'fail' };
}

async function readImplementation(reader: OwnerReader, beacon: string, paceMs: number): Promise<string | null> {
  try {
    const a = decodeAddressWord(await paced(paceMs, () => reader.call({ to: beacon, data: IMPLEMENTATION })));
    if (!a.ok || isRenouncedOwner(a.address)) return null;
    return a.address;
  } catch { return null; }
}

function hasUpgrade(code: string | null | undefined): boolean {
  return powersInBytecode(code)?.some((p) => p.kind === 'upgrade') ?? false;
}

/**
 * One token. Results are reused for 10 minutes. `paceMs` spaces this check's own calls (default 200).
 * A reader without getCode or getStorage is unverified and makes no calls.
 */
export async function readOwnerPowers(reader: OwnerReader, chainId: number, token: string, opts?: { paceMs?: number; now?: () => number }): Promise<OwnerReport> {
  const paceMs = opts?.paceMs ?? 200;
  const now = opts?.now ?? Date.now;
  const key = `${chainId}:${token.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_MS) return hit.report;
  const report = await load(reader, token, paceMs);
  cache.set(key, { at: now(), report });
  return report;
}

async function load(reader: OwnerReader, token: string, paceMs: number): Promise<OwnerReport> {
  if (!reader.getCode || !reader.getStorage) return unverifiedOwnerReport('owner powers could not be verified');
  try {
    const tokenCode = await readCode(reader, token, paceMs);
    const impl = await readSlot(reader, token, EIP1967_IMPLEMENTATION, paceMs);
    const admin = await readSlot(reader, token, EIP1967_ADMIN, paceMs);
    const beacon = await readSlot(reader, token, EIP1967_BEACON, paceMs);
    const owner = await readOwner(reader, token, paceMs);

    const chunks: string[] = [];
    let implFailed = false;
    const seen = new Set<string>([token.toLowerCase()]);
    const take = async (addr: string) => {
      if (isRenouncedOwner(addr)) return;
      const idAddr = addr.toLowerCase();
      if (seen.has(idAddr)) return;
      seen.add(idAddr);
      const code = await readCode(reader, addr, paceMs);
      if (code == null) implFailed = true;
      else chunks.push(code.toLowerCase().replace(/^0x/, ''));
    };

    if (impl.state === 'address') await take(impl.address);

    let beaconOwner: CallRead | undefined;
    let beaconImplFailed = false;
    if (beacon.state === 'address' && !isRenouncedOwner(beacon.address)) {
      beaconOwner = await readOwner(reader, beacon.address, paceMs);
      const implAddr = await readImplementation(reader, beacon.address, paceMs);
      if (!implAddr) beaconImplFailed = true;
      else await take(implAddr);
    }

    let adminOwner: CallRead | undefined;
    if (admin.state === 'address' && !isRenouncedOwner(admin.address)) adminOwner = await readOwner(reader, admin.address, paceMs);

    const implIsToken = impl.state === 'address' && impl.address.toLowerCase() === token.toLowerCase();
    const implCode = implFailed ? null : chunks.length ? `0x${chunks.join('')}` : implIsToken ? tokenCode : undefined;
    const slotsFailed = impl.state === 'fail' || admin.state === 'fail' || beacon.state === 'fail';
    const adminEmpty = admin.state === 'empty' || (admin.state === 'address' && isRenouncedOwner(admin.address));
    const beaconEmpty = beacon.state === 'empty' || (beacon.state === 'address' && isRenouncedOwner(beacon.address));
    let implOwner: CallRead | undefined;
    if (!slotsFailed && impl.state === 'address' && !isRenouncedOwner(impl.address) && adminEmpty && beaconEmpty && (hasUpgrade(tokenCode) || hasUpgrade(implCode))) {
      implOwner = await readOwner(reader, impl.address, paceMs);
    }

    return assessOwnerPowers({
      tokenCode, implCode, impl, admin, beacon, owner, adminOwner, beaconOwner, beaconImplFailed, implOwner,
    });
  } catch {
    return unverifiedOwnerReport('owner powers could not be verified');
  }
}
