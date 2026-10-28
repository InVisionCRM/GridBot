/** Cheap extra checks the token trader adds in front of the existing safety classifier. */
import { id } from 'ethers';

/** mint(address,uint256), the usual owner-mint selector. */
export const MINT_SELECTOR = id('mint(address,uint256)').slice(2, 10);

/** True when the bytecode contains that selector. Not a proof the mint still works; unknown code is not a block. */
export function mintInBytecode(code: string | null | undefined): boolean | null {
  if (!code || code === '0x' || code === '0x0') return null;
  return code.toLowerCase().includes(MINT_SELECTOR);
}

/**
 * V2 LP token: burned (or dead) share vs the owner's share.
 * false = at least 90% burned (treated as locked). true = the owner still holds more than half. null = not clear.
 * V3 liquidity is a position NFT, not this token — see v3LpLock.ts. The gate does not call this helper.
 */
export function lpRemovable(total: bigint, burned: bigint, ownerBalance: bigint): boolean | null {
  if (total <= 0n) return null;
  if (burned * 100n >= total * 90n) return false;
  if (ownerBalance * 2n > total) return true;
  return null;
}
