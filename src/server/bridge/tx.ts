import { Interface, getAddress, type Result } from 'ethers';
import { BridgeError } from './errors';
import type { UnsignedTx } from './types';

const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);

/**
 * ethers decodeFunctionData ignores trailing bytes. The original calldata must be the
 * re-encoding, byte for byte. A non-empty suffix is allowed only as exactly those extra bytes.
 */
export function matchesCanonical(data: string, encoded: string, suffix = ''): boolean {
  const got = data.toLowerCase();
  const enc = encoded.toLowerCase();
  const extra = suffix.toLowerCase();
  return got === enc || (extra !== '' && got === `${enc}${extra}`);
}

export const APPROVE_SELECTOR = APPROVE.getFunction('approve')!.selector.toLowerCase();

export function encodeApprove(token: string, spender: string, amount: bigint, chainId: number): UnsignedTx {
  return {
    chainId,
    to: getAddress(token),
    data: APPROVE.encodeFunctionData('approve', [spender, amount]).toLowerCase(),
    value: 0n,
  };
}

export function decodeApprove(provider: string, data: string): { spender: string; amount: bigint } {
  let decoded: Result;
  try {
    decoded = APPROVE.decodeFunctionData('approve', data);
  } catch {
    throw new BridgeError(provider, 'invalid', `${provider}: approval is not an ERC-20 approve`);
  }
  let encoded: string;
  try {
    encoded = APPROVE.encodeFunctionData('approve', decoded);
  } catch {
    throw new BridgeError(provider, 'invalid', `${provider}: approval is not an ERC-20 approve`);
  }
  if (!matchesCanonical(data, encoded)) {
    throw new BridgeError(provider, 'invalid', `${provider}: approval calldata is not canonical`);
  }
  const spender = decoded[0];
  const amount = decoded[1];
  return { spender: getAddress(String(spender)), amount: BigInt(amount as bigint) };
}
