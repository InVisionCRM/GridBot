/**
 * Read-only picture of who can still change a token: owner, EIP-1967 proxy admin, and setter selectors
 * in the bytecode. The token trader uses this only when its owner-powers flag is on.
 *
 * Selector matching is the same kind of bytecode search as mintInBytecode: a 4-byte selector can also
 * show up inside constructor arguments or constants, so a hit is a power that exists in the code, not
 * a proof the call still succeeds.
 */
import { getAddress, id } from 'ethers';

export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** Common burn address. Holding ownership here is treated as renounced. */
export const DEAD_ADDRESS = `0x${'0'.repeat(36)}dead`;

/** EIP-1967 slots: keccak256(name) − 1. */
export const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

export type PowerKind = 'mint' | 'blacklist' | 'pause' | 'tax' | 'limit' | 'trading' | 'feeExempt' | 'upgrade';

export interface PowerSig {
  kind: PowerKind;
  sig: string;
  /** 8 hex chars, no 0x prefix, for a bytecode search. */
  selector: string;
  /**
   * Safe and medium skip when a non-renounced owner can call this.
   * Mint (Kyle, 2026-10-30: launcher tokens carry mint functions), trading, fee-exempt, and upgrade selectors are
   * reported and do not by themselves skip.
   */
  blocks: boolean;
}

const SIGS: { kind: PowerKind; sig: string; blocks: boolean }[] = [
  { kind: 'mint', sig: 'mint(address,uint256)', blocks: false },
  { kind: 'mint', sig: 'mint(uint256)', blocks: false },
  { kind: 'mint', sig: 'mint(address,uint256,bytes)', blocks: false },
  { kind: 'mint', sig: 'mintTo(address,uint256)', blocks: false },
  { kind: 'blacklist', sig: 'setBlacklist(address,bool)', blocks: true },
  { kind: 'blacklist', sig: 'blacklistAddress(address)', blocks: true },
  { kind: 'blacklist', sig: 'setBot(address,bool)', blocks: true },
  { kind: 'blacklist', sig: 'addBot(address)', blocks: true },
  { kind: 'blacklist', sig: 'setIsBlacklisted(address,bool)', blocks: true },
  { kind: 'blacklist', sig: 'setWhitelist(address,bool)', blocks: true },
  { kind: 'blacklist', sig: 'whitelist(address,bool)', blocks: true },
  { kind: 'blacklist', sig: 'setWhitelisted(address,bool)', blocks: true },
  { kind: 'pause', sig: 'pause()', blocks: true },
  { kind: 'pause', sig: 'unpause()', blocks: true },
  { kind: 'pause', sig: 'setPaused(bool)', blocks: true },
  { kind: 'tax', sig: 'setFee(uint256)', blocks: true },
  { kind: 'tax', sig: 'setTax(uint256)', blocks: true },
  { kind: 'tax', sig: 'setBuyFee(uint256)', blocks: true },
  { kind: 'tax', sig: 'setSellFee(uint256)', blocks: true },
  { kind: 'tax', sig: 'setBuyTax(uint256)', blocks: true },
  { kind: 'tax', sig: 'setSellTax(uint256)', blocks: true },
  { kind: 'tax', sig: 'setTaxes(uint256,uint256)', blocks: true },
  { kind: 'tax', sig: 'setFees(uint256,uint256)', blocks: true },
  { kind: 'tax', sig: 'updateBuyTax(uint256)', blocks: true },
  { kind: 'tax', sig: 'updateSellTax(uint256)', blocks: true },
  { kind: 'limit', sig: 'setMaxTx(uint256)', blocks: true },
  { kind: 'limit', sig: 'setMaxTxAmount(uint256)', blocks: true },
  { kind: 'limit', sig: 'setMaxWallet(uint256)', blocks: true },
  { kind: 'limit', sig: 'setMaxWalletAmount(uint256)', blocks: true },
  { kind: 'limit', sig: 'setMaxTransactionAmount(uint256)', blocks: true },
  { kind: 'trading', sig: 'enableTrading()', blocks: false },
  { kind: 'trading', sig: 'disableTrading()', blocks: false },
  { kind: 'trading', sig: 'setTradingEnabled(bool)', blocks: false },
  { kind: 'trading', sig: 'openTrading()', blocks: false },
  { kind: 'feeExempt', sig: 'setFeeExempt(address,bool)', blocks: false },
  { kind: 'feeExempt', sig: 'excludeFromFee(address,bool)', blocks: false },
  { kind: 'feeExempt', sig: 'setIsFeeExempt(address,bool)', blocks: false },
  { kind: 'feeExempt', sig: 'setExcludedFromFees(address,bool)', blocks: false },
  { kind: 'upgrade', sig: 'upgradeTo(address)', blocks: false },
  { kind: 'upgrade', sig: 'upgradeToAndCall(address,bytes)', blocks: false },
];

export const POWER_SIGS: PowerSig[] = SIGS.map((s) => ({ ...s, selector: id(s.sig).slice(2, 10).toLowerCase() }));

export function isRenouncedOwner(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ZERO_ADDRESS || a === DEAD_ADDRESS;
}

/** ABI address word. A zero address is a successful read (renounced). Short or dirty words are not. */
export function decodeAddressWord(raw: string | null | undefined): { ok: true; address: string } | { ok: false } {
  if (raw == null) return { ok: false };
  const h = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 64) return { ok: false };
  const word = h.slice(-64);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return { ok: false };
  try { return { ok: true, address: getAddress(`0x${word.slice(24)}`) }; } catch { return { ok: false }; }
}

export type SlotRead = { state: 'empty' } | { state: 'address'; address: string } | { state: 'fail' };
export type CallRead = { state: 'address'; address: string } | { state: 'fail' };

/** Storage word. 32 zero bytes is an empty slot, not the zero address. */
export function decodeSlot(raw: string | null | undefined): SlotRead {
  if (raw == null) return { state: 'fail' };
  const h = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length < 64) return { state: 'fail' };
  const word = h.slice(-64);
  if (/^0{64}$/.test(word)) return { state: 'empty' };
  const a = decodeAddressWord(`0x${word}`);
  return a.ok ? { state: 'address', address: a.address } : { state: 'fail' };
}

/**
 * Selectors present in bytecode. null when the code is missing or empty: that is unverified, not "no powers".
 */
export function powersInBytecode(code: string | null | undefined): PowerSig[] | null {
  if (!code || code === '0x' || code === '0x0') return null;
  const h = code.toLowerCase().replace(/^0x/, '');
  if (!h || /^0+$/.test(h)) return null;
  return POWER_SIGS.filter((p) => h.includes(p.selector));
}

export interface OwnerFacts {
  /** Token bytecode. null = missing or unreadable. */
  tokenCode: string | null;
  /**
   * Implementation bytecode when an EIP-1967 implementation (or a beacon's implementation) was found.
   * undefined = there was nothing to read. null = that read failed.
   */
  implCode?: string | null;
  impl: SlotRead;
  admin: SlotRead;
  beacon: SlotRead;
  /** owner() then getOwner() on the token. fail = both reverted. */
  owner: CallRead;
  /** Set when the admin slot holds a live address. fail = owner() reverted, so the admin address itself can upgrade. */
  adminOwner?: CallRead;
  /** Set when the beacon slot holds an address. fail = owner() reverted (unverified, not "the beacon is an EOA"). */
  beaconOwner?: CallRead;
  /** True when a beacon is set and implementation() could not be read. */
  beaconImplFailed?: boolean;
  /** Set for a UUPS proxy (implementation slot, no admin, no beacon, upgrade selector present). fail = unverified. */
  implOwner?: CallRead;
}

export interface OwnerReport {
  unverified: boolean;
  /** Skip text when a live owner holds a blocking power or a live admin can upgrade. null = no extra block. */
  why: string | null;
  /** What was found. The trader appends this to a buy that is allowed. */
  note: string;
  powers: string[];
  owner: string | null;
  renounced: boolean | null;
  liveAdmin: string | null;
}

export function unverifiedOwnerReport(detail: string): OwnerReport {
  const note = detail.startsWith('owner powers could not be verified') ? detail : `owner powers could not be verified: ${detail}`;
  return { unverified: true, why: note, note, powers: [], owner: null, renounced: null, liveAdmin: null };
}

function shortAddr(a: string): string {
  const x = a.toLowerCase();
  if (x === ZERO_ADDRESS) return '0x0000…0000';
  if (x === DEAD_ADDRESS) return '0x0000…dead';
  return `${a.slice(0, 6)}…`;
}

function dedupe(list: PowerSig[]): PowerSig[] {
  const seen = new Set<string>();
  const out: PowerSig[] = [];
  for (const p of list) {
    if (seen.has(p.sig)) continue;
    seen.add(p.sig);
    out.push(p);
  }
  return out;
}

function liveAddress(read: CallRead | SlotRead | undefined): string | null {
  if (!read || read.state !== 'address') return null;
  return isRenouncedOwner(read.address) ? null : read.address;
}

/**
 * Decide from reads already taken. A definite live owner or live admin blocks even if some other read failed.
 * Anything that could hide a blocking power or a live admin, with no definite block, is unverified.
 */
export function assessOwnerPowers(f: OwnerFacts): OwnerReport {
  const slotsFailed = f.impl.state === 'fail' || f.admin.state === 'fail' || f.beacon.state === 'fail';
  const tokenPowers = powersInBytecode(f.tokenCode);
  const implPowers = f.implCode === undefined ? undefined : powersInBytecode(f.implCode);
  const powers = dedupe([...(tokenPowers ?? []), ...(implPowers ?? [])]);
  const blocking = powers.filter((p) => p.blocks);
  const ownerAddr = f.owner.state === 'address' ? f.owner.address : null;
  const renounced = ownerAddr == null ? null : isRenouncedOwner(ownerAddr);
  const liveOwner = ownerAddr != null && renounced === false ? ownerAddr : null;

  const gaps: string[] = [];
  if (tokenPowers == null) gaps.push('bytecode unread');
  if (slotsFailed) gaps.push('proxy slots unread');
  const implWanted = f.implCode !== undefined || (f.impl.state === 'address' && !isRenouncedOwner(f.impl.address));
  if (implWanted && implPowers == null) gaps.push('implementation bytecode unread');
  if (f.beaconImplFailed) gaps.push('beacon implementation unread');

  let liveAdmin: string | null = null;
  if (!slotsFailed) {
    if (f.admin.state === 'address' && !isRenouncedOwner(f.admin.address)) {
      if (!f.adminOwner) gaps.push('proxy admin unread');
      else if (f.adminOwner.state === 'fail') liveAdmin = f.admin.address;
      else {
        const who = liveAddress(f.adminOwner);
        if (who) liveAdmin = who;
      }
    }
    if (f.beacon.state === 'address' && !isRenouncedOwner(f.beacon.address)) {
      if (!f.beaconOwner || f.beaconOwner.state === 'fail') gaps.push('beacon admin unread');
      else {
        const who = liveAddress(f.beaconOwner);
        if (who) liveAdmin = liveAdmin ?? who;
      }
    }
    const adminEmpty = f.admin.state === 'empty' || (f.admin.state === 'address' && isRenouncedOwner(f.admin.address));
    const beaconEmpty = f.beacon.state === 'empty' || (f.beacon.state === 'address' && isRenouncedOwner(f.beacon.address));
    const implSet = f.impl.state === 'address' && !isRenouncedOwner(f.impl.address);
    if (implSet && adminEmpty && beaconEmpty && powers.some((p) => p.kind === 'upgrade')) {
      if (!f.implOwner || f.implOwner.state === 'fail') gaps.push('implementation owner unread');
      else {
        const who = liveAddress(f.implOwner);
        if (who) liveAdmin = liveAdmin ?? who;
      }
    }
  }

  const sigs = powers.map((p) => p.sig);
  const holds = liveOwner != null && blocking.length > 0;
  if (holds || liveAdmin) {
    const extra = powers.filter((p) => !p.blocks).map((p) => p.sig);
    const why = [
      holds ? `owner ${shortAddr(liveOwner!)} holds ${blocking.map((p) => p.sig).join(', ')}` : null,
      liveAdmin ? `upgradeable by live admin ${shortAddr(liveAdmin)}` : null,
      extra.length ? `bytecode has ${extra.join(', ')}` : null,
    ].filter((s): s is string => !!s).join('; ');
    return { unverified: false, why, note: why, powers: sigs, owner: ownerAddr, renounced, liveAdmin };
  }

  if (f.owner.state === 'fail' && blocking.length > 0) gaps.push(`owner unread; bytecode has ${blocking.map((p) => p.sig).join(', ')}`);
  if (gaps.length) {
    const note = `owner powers could not be verified: ${[...new Set(gaps)].join('; ')}`;
    return { unverified: true, why: note, note, powers: sigs, owner: ownerAddr, renounced, liveAdmin: null };
  }

  const ownerBit = ownerAddr == null
    ? 'owner unread'
    : renounced
      ? `owner renounced (${shortAddr(ownerAddr)})`
      : `owner ${shortAddr(ownerAddr)}`;
  const listed = powers.map((p) => p.sig);
  const powerBit = blocking.length
    ? `bytecode has ${listed.join(', ')}`
    : listed.length
      ? `bytecode has ${listed.join(', ')}; no mint, blacklist, pause, or tax/limit powers`
      : 'no mint, blacklist, pause, or tax/limit powers';
  const note = `${ownerBit}; ${powerBit}; not upgradeable`;
  return { unverified: false, why: null, note, powers: sigs, owner: ownerAddr, renounced, liveAdmin: null };
}
