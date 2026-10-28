/**
 * Uniswap V4 hook permission bits. They live in the least significant 14 bits of the hook address
 * (v4-core Hooks.sol, ALL_HOOK_MASK = (1 << 14) - 1).
 *
 * A pool with hooks == address(0) has no hook and is allowed. Any other hook is rejected unless its
 * address is on the explicit allowlist. The four *RETURNS_DELTA flags can change what a swap settles;
 * they are unsafe, and the allowlist is the only way to accept one.
 */
export const ALL_HOOK_MASK = (1n << 14n) - 1n;

/** Bit 13 (BEFORE_INITIALIZE) down to bit 0 (AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA). */
export const HOOK_FLAG_BITS = [
  ['BEFORE_INITIALIZE', 1n << 13n],
  ['AFTER_INITIALIZE', 1n << 12n],
  ['BEFORE_ADD_LIQUIDITY', 1n << 11n],
  ['AFTER_ADD_LIQUIDITY', 1n << 10n],
  ['BEFORE_REMOVE_LIQUIDITY', 1n << 9n],
  ['AFTER_REMOVE_LIQUIDITY', 1n << 8n],
  ['BEFORE_SWAP', 1n << 7n],
  ['AFTER_SWAP', 1n << 6n],
  ['BEFORE_DONATE', 1n << 5n],
  ['AFTER_DONATE', 1n << 4n],
  ['BEFORE_SWAP_RETURNS_DELTA', 1n << 3n],
  ['AFTER_SWAP_RETURNS_DELTA', 1n << 2n],
  ['AFTER_ADD_LIQUIDITY_RETURNS_DELTA', 1n << 1n],
  ['AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA', 1n << 0n],
] as const;

export type HookFlag = (typeof HOOK_FLAG_BITS)[number][0];

/** Flags that let a hook rewrite the deltas the PoolManager settles. */
export const DELTA_FLAGS: readonly HookFlag[] = [
  'BEFORE_SWAP_RETURNS_DELTA',
  'AFTER_SWAP_RETURNS_DELTA',
  'AFTER_ADD_LIQUIDITY_RETURNS_DELTA',
  'AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA',
];

const ZERO = 0n;

export interface HookPermissions {
  /** Set flag names, bit 13 first. */
  flags: HookFlag[];
  mask: bigint;
}

export interface HookDecision {
  address: string;
  allowed: boolean;
  /** One of the RETURNS_DELTA flags is set. */
  unsafe: boolean;
  /** Non-zero hook that is not on the allowlist. */
  unknown: boolean;
  reason: string | null;
  flags: HookFlag[];
}

const named = (mask: bigint): HookFlag[] => HOOK_FLAG_BITS.filter(([, bit]) => (mask & bit) !== ZERO).map(([name]) => name);

/** Decode the permission flags encoded in a hook address. address(0) has none. */
export function decodeHookPermissions(hooks: string): HookPermissions {
  let mask = ZERO;
  try { mask = BigInt(hooks) & ALL_HOOK_MASK; } catch { mask = ZERO; }
  return { flags: named(mask), mask };
}

function listed(hooks: string, allowlist: readonly string[] | undefined): boolean {
  const h = hooks.toLowerCase();
  return !!allowlist?.some((a) => a.toLowerCase() === h);
}

/**
 * Default policy: address(0) is allowed; everything else is rejected unless `allowlist` names it.
 * An allowlisted hook is accepted even when it carries a delta flag — the list is the operator's override.
 */
export function assessHook(hooks: string | null | undefined, allowlist?: readonly string[]): HookDecision {
  if (hooks == null || !/^0x[0-9a-fA-F]{40}$/.test(hooks)) {
    return { address: hooks ?? '', allowed: false, unsafe: false, unknown: true, flags: [], reason: 'V4 pool is missing its hook address' };
  }
  const { flags, mask } = decodeHookPermissions(hooks);
  if (mask === ZERO && BigInt(hooks) === ZERO) {
    return { address: hooks, allowed: true, unsafe: false, unknown: false, flags, reason: null };
  }
  const unsafe = flags.some((f) => (DELTA_FLAGS as readonly string[]).includes(f));
  if (listed(hooks, allowlist)) {
    return { address: hooks, allowed: true, unsafe, unknown: false, flags, reason: null };
  }
  const list = flags.length ? flags.join(', ') : 'no permission bits';
  const reason = unsafe
    ? `Unsafe V4 hook ${hooks}: ${list} can change the swap output. Rejected until it is added to hookAllowlist.`
    : `Unknown V4 hook ${hooks} (${list}). Rejected until it is added to hookAllowlist.`;
  return { address: hooks, allowed: false, unsafe, unknown: true, flags, reason };
}
