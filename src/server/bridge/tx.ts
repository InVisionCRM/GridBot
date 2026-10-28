import { Interface, getAddress } from 'ethers';
import { BridgeError } from './errors';
import type { UnsignedTx } from './types';

const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);

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
  try {
    const [spender, amount] = APPROVE.decodeFunctionData('approve', data);
    return { spender: getAddress(String(spender)), amount: BigInt(amount as bigint) };
  } catch {
    throw new BridgeError(provider, 'invalid', `${provider}: approval is not an ERC-20 approve`);
  }
}
