import { Interface, getAddress, zeroPadValue } from 'ethers';
import { bad, sameAddress } from './parse';
import { decodeApprove, encodeApprove } from './tx';
import type { BridgeId, BridgeQuoteRequest, UnsignedTx } from './types';

/**
 * Deposit targets and approval spenders, per chain. An address that is not on this list
 * is rejected. Solver and router addresses that the docs say are not deposit destinations
 * are not listed.
 *
 * Across SpokePool and SpokePoolPeriphery, from https://docs.across.to/chains-and-contracts
 * (Ethereum and Robinhood Chain rows):
 *   SpokePool Ethereum  0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5
 *   SpokePool Robinhood 0xD29C85F15DF544bA632C9E25829fd29d767d7978
 *   SpokePoolPeriphery  0x97CCDBea4632140639aD5eA9b944aa034eb15fD4
 *   (the same periphery address on Ethereum and Robinhood)
 *
 * Li.Fi Diamond, from https://docs.li.fi/introduction/lifi-architecture/smart-contract-addresses
 *   0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE on the EVM chains this desk quotes.
 *
 * Relay router and approval proxy. Both the v3 and v3.2 Cancun pairs stay allowlisted
 * through the migration (https://docs.relay.link/references/api/api_resources/contract-addresses
 * and https://docs.relay.link/changelog). Ethereum and Robinhood Chain use the Cancun
 * bytecode, not the London pair:
 *   v3   router 0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f
 *        proxy  0xccc88a9d1b4ed6b0eaba998850414b24f1c315be
 *   v3.2 router 0x0729e2a4716d9f7dd17858d5d504426d228697f7
 *        proxy  0x5567954cd026cebfe486062cb75848e0f1c12e58
 */

const addr = (hex: string) => getAddress(hex.toLowerCase());

export const ACROSS_SPOKE: Readonly<Record<number, string>> = {
  1: addr('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'),
  4663: addr('0xD29C85F15DF544bA632C9E25829fd29d767d7978'),
};

/** Same SpokePoolPeriphery on Ethereum and Robinhood Chain. */
export const ACROSS_PERIPHERY = addr('0x97CCDBea4632140639aD5eA9b944aa034eb15fD4');

export const LIFI_DIAMOND = addr('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');

export const RELAY_ROUTER_V3 = addr('0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f');
export const RELAY_PROXY_V3 = addr('0xccc88a9d1b4ed6b0eaba998850414b24f1c315be');
export const RELAY_ROUTER_V32 = addr('0x0729e2a4716d9f7dd17858d5d504426d228697f7');
export const RELAY_PROXY_V32 = addr('0x5567954cd026cebfe486062cb75848e0f1c12e58');

const RELAY_PAIRS = [
  { router: RELAY_ROUTER_V3, proxy: RELAY_PROXY_V3 },
  { router: RELAY_ROUTER_V32, proxy: RELAY_PROXY_V32 },
] as const;

const DEPOSIT_V3 = new Interface([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
]);

const SWAP = new Interface([
  'function swapAndBridge(((uint256 amount, address recipient) submissionFees, (address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce) swapAndDepositData) payable',
]);

const LIFI = new Interface([
  'function startBridgeTokensViaAcross((bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall) bridgeData, (int64 relayerFeePct, uint32 quoteTimestamp, bytes message, uint256 maxCount) acrossData)',
]);

const RELAY = new Interface([
  'function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bytes data, uint256 value)[] calls, address refundTo, address nftRecipient, bytes metadata) payable',
]);

const INNER = new Interface(['function bridge(address recipient, address token, uint256 amount)']);

export interface DecodedDeposit {
  recipient: string;
  token: string;
  /** Input amount, when the calldata carries it. */
  amount: bigint | null;
  /** Destination minimum, when the calldata carries that instead of the input amount. */
  minAmount: bigint | null;
  outputToken: string | null;
  fillDeadline: number | null;
}

function bytes32Address(provider: string, word: string): string {
  const hex = word.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) bad(provider, 'deposit recipient does not match');
  if (!/^0x0{24}[0-9a-f]{40}$/.test(hex)) bad(provider, 'deposit recipient does not match');
  return getAddress(`0x${hex.slice(-40)}`);
}

function asBig(v: unknown): bigint {
  return typeof v === 'bigint' ? v : BigInt(v as string | number);
}

function relayPair(chainId: number, target: string): { router: string; proxy: string } | null {
  if (chainId !== 1 && chainId !== 4663) return null;
  return RELAY_PAIRS.find((p) => sameAddress(p.router, target) || sameAddress(p.proxy, target)) ?? null;
}

export function assertDepositTarget(provider: BridgeId, chainId: number, target: string) {
  if (provider === 'lifi') {
    if ((chainId === 1 || chainId === 4663) && sameAddress(target, LIFI_DIAMOND)) return;
    bad(provider, 'deposit target is not allowlisted');
  }
  if (provider === 'across') {
    const spoke = ACROSS_SPOKE[chainId];
    if (spoke && (sameAddress(target, spoke) || sameAddress(target, ACROSS_PERIPHERY))) return;
    bad(provider, 'deposit target is not allowlisted');
  }
  if (provider === 'relay') {
    if (relayPair(chainId, target)) return;
    bad(provider, 'deposit target is not allowlisted');
  }
  bad(provider, 'deposit target is not allowlisted');
}

function assertSpender(provider: BridgeId, chainId: number, spender: string, depositTo: string) {
  if (provider === 'across' || provider === 'lifi') {
    assertDepositTarget(provider, chainId, spender);
    if (!sameAddress(spender, depositTo)) bad(provider, 'approval spender does not match the deposit');
    return;
  }
  const pair = relayPair(chainId, depositTo);
  if (!pair || !sameAddress(spender, pair.proxy)) bad(provider, 'approval spender is not allowlisted');
}

/** Rewrite an approval larger than the input (including unlimited) down to amountIn. */
export function capApproval(provider: string, tx: UnsignedTx, token: string, amountIn: bigint): UnsignedTx {
  const decoded = decodeApprove(provider, tx.data);
  if (!sameAddress(tx.to, token)) bad(provider, 'approval is not for the input token');
  if (decoded.amount < amountIn) bad(provider, 'approval is below the input');
  if (decoded.amount === amountIn) return tx;
  return encodeApprove(token, decoded.spender, amountIn, tx.chainId);
}

export function decodeDeposit(provider: BridgeId, data: string, req: BridgeQuoteRequest): DecodedDeposit {
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (provider === 'across' && selector === DEPOSIT_V3.getFunction('depositV3')!.selector.toLowerCase()) {
      const d = DEPOSIT_V3.decodeFunctionData('depositV3', data);
      const spoke = ACROSS_SPOKE[req.srcChain];
      if (!spoke) bad(provider, 'deposit target is not allowlisted');
      return {
        recipient: getAddress(String(d.recipient)),
        token: getAddress(String(d.inputToken)),
        amount: asBig(d.inputAmount),
        minAmount: null,
        outputToken: getAddress(String(d.outputToken)),
        fillDeadline: Number(d.fillDeadline),
      };
    }
    if (provider === 'across' && selector === SWAP.getFunction('swapAndBridge')!.selector.toLowerCase()) {
      const d = SWAP.decodeFunctionData('swapAndBridge', data)[0];
      const spoke = ACROSS_SPOKE[req.srcChain];
      if (!spoke || !sameAddress(String(d.spokePool), spoke)) bad(provider, 'spoke pool does not match');
      return {
        recipient: bytes32Address(provider, String(d.depositData.recipient)),
        token: getAddress(String(d.swapToken)),
        amount: asBig(d.swapTokenAmount),
        minAmount: null,
        outputToken: bytes32Address(provider, String(d.depositData.outputToken)),
        fillDeadline: Number(d.depositData.fillDeadline),
      };
    }
    if (provider === 'lifi' && selector === LIFI.getFunction('startBridgeTokensViaAcross')!.selector.toLowerCase()) {
      const bridge = LIFI.decodeFunctionData('startBridgeTokensViaAcross', data)[0];
      if (Number(bridge.destinationChainId) !== req.dstChain) bad(provider, 'destination chain does not match');
      return {
        recipient: getAddress(String(bridge.receiver)),
        token: getAddress(String(bridge.sendingAssetId)),
        amount: null,
        minAmount: asBig(bridge.minAmount),
        outputToken: null,
        fillDeadline: null,
      };
    }
    if (provider === 'relay' && selector === RELAY.getFunction('transferAndMulticall')!.selector.toLowerCase()) {
      const d = RELAY.decodeFunctionData('transferAndMulticall', data);
      const tokens = d[0] as readonly string[];
      const amounts = d[1] as readonly bigint[];
      const idx = tokens.findIndex((t, i) => sameAddress(String(t), req.tokenIn.address) && asBig(amounts[i]) === req.amountIn);
      if (idx < 0) bad(provider, 'deposit amount does not match');
      const word = req.recipient.toLowerCase().slice(2).padStart(64, '0');
      if (!data.toLowerCase().includes(word)) bad(provider, 'deposit recipient does not match');
      return { recipient: getAddress(req.recipient), token: getAddress(req.tokenIn.address), amount: req.amountIn, minAmount: null, outputToken: null, fillDeadline: null };
    }
  } catch (e) {
    if (e && typeof e === 'object' && (e as { name?: string }).name === 'BridgeError') throw e;
    bad(provider, 'deposit calldata is not decodable');
  }
  bad(provider, 'deposit calldata is not decodable');
}

/**
 * Allowlist the deposit target and the approval spender, cap the approval at amountIn,
 * and check the decoded recipient, input token, and amount against the request.
 */
export function assertGuarded(provider: BridgeId, req: BridgeQuoteRequest, deposit: UnsignedTx, approval: UnsignedTx | null, minOut: bigint) {
  assertDepositTarget(provider, req.srcChain, deposit.to);
  const decoded = decodeDeposit(provider, deposit.data, req);
  if (!sameAddress(decoded.recipient, req.recipient)) bad(provider, 'deposit recipient does not match');
  if (!sameAddress(decoded.token, req.tokenIn.address)) bad(provider, 'deposit token does not match');
  if (decoded.outputToken && !sameAddress(decoded.outputToken, req.tokenOut.address)) bad(provider, 'deposit output token does not match');
  if (decoded.amount != null && decoded.amount !== req.amountIn) bad(provider, 'deposit amount does not match');
  if (decoded.minAmount != null && decoded.minAmount !== minOut) bad(provider, 'deposit min amount does not match');
  if (!approval) return;
  const spent = decodeApprove(provider, approval.data);
  if (spent.amount > req.amountIn) bad(provider, 'approval is above the input');
  if (spent.amount < req.amountIn) bad(provider, 'approval is below the input');
  assertSpender(provider, req.srcChain, spent.spender, deposit.to);
}

export function encodeAcrossSwap(o: {
  swapToken: string;
  amount: bigint;
  outputToken: string;
  outputAmount: bigint;
  depositor: string;
  recipient: string;
  dstChain: number;
  spoke: string;
  fillDeadline: number;
}): string {
  const zero32 = zeroPadValue('0x00', 32);
  return SWAP.encodeFunctionData('swapAndBridge', [[
    [0, o.depositor],
    [
      o.swapToken,
      zeroPadValue(o.outputToken, 32),
      o.outputAmount,
      o.depositor,
      zeroPadValue(o.recipient, 32),
      BigInt(o.dstChain),
      zero32,
      0,
      o.fillDeadline,
      0,
      '0x',
    ],
    o.swapToken,
    o.depositor,
    0,
    o.amount,
    o.amount,
    '0x',
    false,
    o.spoke,
    0,
  ]]);
}

export function encodeLifiDeposit(o: { token: string; recipient: string; sender: string; minOut: bigint; dstChain: number }): string {
  return LIFI.encodeFunctionData('startBridgeTokensViaAcross', [[
    `0x${'11'.repeat(32)}`,
    'across',
    'gridbot',
    o.sender,
    o.token,
    o.recipient,
    o.minOut,
    BigInt(o.dstChain),
    false,
    false,
  ], [0, 0, '0x', 0]]);
}

export function encodeRelayDeposit(o: { token: string; amount: bigint; recipient: string; sender: string; router: string }): string {
  const inner = INNER.encodeFunctionData('bridge', [o.recipient, o.token, o.amount]);
  return RELAY.encodeFunctionData('transferAndMulticall', [
    [o.token],
    [o.amount],
    [[o.router, inner, 0]],
    o.sender,
    o.sender,
    '0x',
  ]);
}

export { DEPOSIT_V3 };
