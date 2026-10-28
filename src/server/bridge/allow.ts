import { Interface, getAddress, zeroPadValue } from 'ethers';
import { bad, lifiFeeAmount, sameAddress } from './parse';
import { APPROVE_SELECTOR, decodeApprove, encodeApprove } from './tx';
import type { BridgeId, BridgeQuoteRequest, UnsignedTx } from './types';

/**
 * Deposit targets and approval spenders, per chain. An address that is not on this list
 * is rejected. Solver addresses are not deposit destinations.
 *
 * Across SpokePool and SpokePoolPeriphery, from https://docs.across.to/chains-and-contracts
 * (Ethereum and Robinhood Chain rows). SpokePool.deposit is the bytes32 form published in
 * across-protocol/contracts (selector 0xad5425c6):
 *   SpokePool Ethereum  0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5
 *   SpokePool Robinhood 0xD29C85F15DF544bA632C9E25829fd29d767d7978
 *   SpokePoolPeriphery  0x97CCDBea4632140639aD5eA9b944aa034eb15fD4
 *
 * Li.Fi Diamond is per chain. Ethereum keeps the address in
 * https://docs.li.fi/introduction/lifi-architecture/smart-contract-addresses.
 * Robinhood Chain is LiFiDiamond in
 * https://github.com/lifinance/contracts/blob/main/deployments/robinhood.json
 *   1     0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
 *   4663  0xB477751B76CF82d00a686A1232f5fCD772414Af3
 * Across V4 selectors are taken from AcrossFacetV4.sol (swap 0x1794958f, direct 0xa1f1ce43).
 *
 * Relay Cancun router and approval proxy, v3 and v3.2
 * (https://docs.relay.link/references/api/api_resources/contract-addresses).
 * The v2 depository is the same address on Ethereum and Robinhood, checked against
 * GET /chains `protocol.v2.depository` on 2026-10-27:
 *   0x4cD00E387622C35bDDB9b4c962C136462338BC31
 * depositErc20 is selector 0xe8017952. depositNative is selector 0x49290c1c
 * (https://docs.relay.link/references/protocol/contracts/evm-depository).
 * A zero depositor credits msg.sender. That is the user only on a top-level
 * depositErc20 sent to the depository. On an inner call msg.sender is the router,
 * so a zero depositor would make the refund sweepable.
 * transferAndMulticall is selector 0xf9e4bab4 with call tuples
 * (address target, bool allowFailure, uint256 value, bytes callData).
 * Accepted multicalls are an exact sequence, not a sum of wei and token units:
 * the live WETH unwrap (approve, withdraw, native value to the router,
 * cleanupNativeViaCall into depositNative), or one cleanupErc20s of amountIn
 * to the requested recipient. cleanupErc20sViaCall is not accepted. refundTo
 * and nftRecipient must be the sender.
 */

const addr = (hex: string) => getAddress(hex.toLowerCase());

export const ACROSS_SPOKE: Readonly<Record<number, string>> = {
  1: addr('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'),
  4663: addr('0xD29C85F15DF544bA632C9E25829fd29d767d7978'),
};

/** Same SpokePoolPeriphery on Ethereum and Robinhood Chain. */
export const ACROSS_PERIPHERY = addr('0x97CCDBea4632140639aD5eA9b944aa034eb15fD4');

export const LIFI_DIAMOND = addr('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE');

export const LIFI_DIAMONDS: Readonly<Record<number, string>> = {
  1: LIFI_DIAMOND,
  4663: addr('0xB477751B76CF82d00a686A1232f5fCD772414Af3'),
};

export function lifiDiamond(chainId: number): string | undefined {
  return LIFI_DIAMONDS[chainId];
}

export const RELAY_ROUTER_V3 = addr('0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f');
export const RELAY_PROXY_V3 = addr('0xccc88a9d1b4ed6b0eaba998850414b24f1c315be');
export const RELAY_ROUTER_V32 = addr('0x0729e2a4716d9f7dd17858d5d504426d228697f7');
export const RELAY_PROXY_V32 = addr('0x5567954cd026cebfe486062cb75848e0f1c12e58');

/** Relay v2 depository. Same contract on Ethereum and Robinhood Chain. */
export const RELAY_DEPOSITORY = addr('0x4cD00E387622C35bDDB9b4c962C136462338BC31');

const RELAY_PAIRS = [
  { router: RELAY_ROUTER_V3, proxy: RELAY_PROXY_V3 },
  { router: RELAY_ROUTER_V32, proxy: RELAY_PROXY_V32 },
] as const;

const DEPOSIT_V3 = new Interface([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
]);

/** SpokePool.deposit. Addresses are bytes32. Selector 0xad5425c6. */
const SPOKE_DEPOSIT = new Interface([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message)',
]);

const SWAP = new Interface([
  'function swapAndBridge(((uint256 amount, address recipient) submissionFees, (address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce) swapAndDepositData) payable',
]);

const BRIDGE = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const SWAP_DATA = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const ACROSS_V4 = '(bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId, uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)';
const RELAY_DATA = '(bytes32 orderId, address depositorAddress)';

const LIFI_V1 = new Interface([
  `function startBridgeTokensViaAcross(${BRIDGE} bridgeData, (int64 relayerFeePct, uint32 quoteTimestamp, bytes message, uint256 maxCount) acrossData)`,
]);

const LIFI_V4 = new Interface([
  `function startBridgeTokensViaAcrossV4(${BRIDGE} _bridgeData, ${ACROSS_V4} _acrossData) payable`,
  `function swapAndStartBridgeTokensViaAcrossV4(${BRIDGE} _bridgeData, ${SWAP_DATA}[] _swapData, ${ACROSS_V4} _acrossData) payable`,
]);

const LIFI_RELAY = new Interface([
  `function startBridgeTokensViaRelayDepository(${BRIDGE} _bridgeData, ${RELAY_DATA} _relayDepositoryData) payable`,
  `function swapAndStartBridgeTokensViaRelayDepository(${BRIDGE} _bridgeData, ${SWAP_DATA}[] _swapData, ${RELAY_DATA} _relayDepositoryData) payable`,
]);

const RELAY = new Interface([
  'function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata) payable',
]);

const RELAY_ERC20 = new Interface([
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
]);

const RELAY_NATIVE = new Interface([
  'function depositNative(address depositor, bytes32 id)',
]);

const ROUTER_CALLS = new Interface([
  'function cleanupNative(uint256 amount, address recipient)',
  'function cleanupNativeViaCall(uint256 amount, address to, bytes data)',
  'function cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts)',
  'function cleanupErc20sViaCall(address[] tokens, address[] tos, bytes[] datas, uint256[] amounts)',
]);

const WETH_WITHDRAW = new Interface(['function withdraw(uint256 wad)']);
const ERC20_TRANSFER = new Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

const ZERO = '0x0000000000000000000000000000000000000000';

export interface DecodedDeposit {
  /** Set when the calldata has a bridge recipient. Null when only an order id names them. */
  recipient: string | null;
  recipientInCalldata: boolean;
  token: string;
  /** Quoted input inside the calldata, before a submission fee is added. */
  amount: bigint | null;
  /** ERC-20 amount the deposit will pull. The approval is set to this. */
  pullAmount: bigint;
  submissionFee: bigint;
  /**
   * Li.Fi bridgeData.minAmount. This is the pre-bridge amount after the integrator fee,
   * not the destination minimum.
   */
  preBridgeAmount: bigint | null;
  outputToken: string | null;
  outputAmount: bigint | null;
  fillDeadline: number | null;
  destinationChainId: number | null;
  depositId: string | null;
}

function bytes32Address(provider: string, word: string, label: string): string {
  const hex = word.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex) || !/^0x0{24}[0-9a-f]{40}$/.test(hex)) bad(provider, `${label} does not match`);
  return getAddress(`0x${hex.slice(-40)}`);
}

function asBig(v: unknown): bigint {
  return typeof v === 'bigint' ? v : BigInt(v as string | number);
}

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase();
}

function emptyBytes(data: string): boolean {
  return data === '0x' || data === '0x0';
}

function relayPair(chainId: number, target: string): { router: string; proxy: string } | null {
  if (chainId !== 1 && chainId !== 4663) return null;
  return RELAY_PAIRS.find((p) => sameAddress(p.router, target) || sameAddress(p.proxy, target)) ?? null;
}

function isDepository(chainId: number, target: string): boolean {
  return (chainId === 1 || chainId === 4663) && sameAddress(target, RELAY_DEPOSITORY);
}

export function assertDepositTarget(provider: BridgeId, chainId: number, target: string) {
  if (provider === 'lifi') {
    const diamond = lifiDiamond(chainId);
    if (diamond && sameAddress(target, diamond)) return;
    bad(provider, 'deposit target is not allowlisted');
  }
  if (provider === 'across') {
    const spoke = ACROSS_SPOKE[chainId];
    if (spoke && (sameAddress(target, spoke) || sameAddress(target, ACROSS_PERIPHERY))) return;
    bad(provider, 'deposit target is not allowlisted');
  }
  if (provider === 'relay') {
    if (relayPair(chainId, target) || isDepository(chainId, target)) return;
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
  if (isDepository(chainId, depositTo)) {
    if (!sameAddress(spender, RELAY_DEPOSITORY)) bad(provider, 'approval spender does not match the deposit');
    return;
  }
  const pair = relayPair(chainId, depositTo);
  if (!pair || !sameAddress(spender, pair.proxy)) bad(provider, 'approval spender is not allowlisted');
}

/** Rewrite the approval so the allowance is exactly `pull`, which must be at most amountIn. */
export function exactApproval(provider: string, tx: UnsignedTx, token: string, pull: bigint, amountIn: bigint): UnsignedTx {
  if (pull <= 0n) bad(provider, 'approval amount is missing');
  if (pull > amountIn) bad(provider, 'approval is above the input');
  const decoded = decodeApprove(provider, tx.data);
  if (!sameAddress(tx.to, token)) bad(provider, 'approval is not for the input token');
  if (decoded.amount === pull) return tx;
  return encodeApprove(token, decoded.spender, pull, tx.chainId);
}

function baseDecoded(token: string, pull: bigint): DecodedDeposit {
  return {
    recipient: null,
    recipientInCalldata: false,
    token,
    amount: pull,
    pullAmount: pull,
    submissionFee: 0n,
    preBridgeAmount: null,
    outputToken: null,
    outputAmount: null,
    fillDeadline: null,
    destinationChainId: null,
    depositId: null,
  };
}

function assertDepositor(provider: string, depositor: string, sender: string, allowZero: boolean) {
  // Zero credits msg.sender. Inside the router that is not the user.
  if (allowZero && sameAddress(depositor, ZERO)) return;
  if (!sameAddress(depositor, sender)) bad(provider, 'deposit depositor does not match');
}

interface BridgeFields {
  bridge: string;
  integrator: string;
  referrer: string;
  sendingAssetId: string;
  receiver: string;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
}

function bridgeFields(row: { [key: string]: unknown }): BridgeFields {
  return row as unknown as BridgeFields;
}

function lifiPull(provider: string, req: BridgeQuoteRequest, bridge: BridgeFields, swaps: ReadonlyArray<{ sendingAssetId: string; fromAmount: bigint; requiresDeposit: boolean }> | null): bigint {
  if (!bridge.hasSourceSwaps) return asBig(bridge.minAmount);
  if (!swaps || swaps.length === 0) bad(provider, 'approval amount is missing');
  let pull = 0n;
  for (const swap of swaps) {
    if (!swap.requiresDeposit || !sameAddress(String(swap.sendingAssetId), req.tokenIn.address)) continue;
    pull += asBig(swap.fromAmount);
  }
  if (pull <= 0n) bad(provider, 'approval amount is missing');
  return pull;
}

function fromBridge(provider: string, req: BridgeQuoteRequest, bridge: BridgeFields, pull: bigint, outputToken: string | null, outputAmount: bigint | null, depositId: string | null): DecodedDeposit {
  if (bridge.hasDestinationCall) bad(provider, 'destination call is not allowed');
  if (Number(bridge.destinationChainId) !== req.dstChain) bad(provider, 'destination chain does not match');
  return {
    recipient: getAddress(String(bridge.receiver)),
    recipientInCalldata: true,
    token: getAddress(String(bridge.sendingAssetId)),
    amount: pull,
    pullAmount: pull,
    submissionFee: 0n,
    preBridgeAmount: asBig(bridge.minAmount),
    outputToken,
    outputAmount,
    fillDeadline: null,
    destinationChainId: Number(bridge.destinationChainId),
    depositId,
  };
}

function decodeLifi(provider: string, data: string, req: BridgeQuoteRequest): DecodedDeposit | null {
  const sel = selectorOf(data);
  const v4swap = LIFI_V4.getFunction('swapAndStartBridgeTokensViaAcrossV4')!.selector.toLowerCase();
  const v4direct = LIFI_V4.getFunction('startBridgeTokensViaAcrossV4')!.selector.toLowerCase();
  const relaySwap = LIFI_RELAY.getFunction('swapAndStartBridgeTokensViaRelayDepository')!.selector.toLowerCase();
  const relayDirect = LIFI_RELAY.getFunction('startBridgeTokensViaRelayDepository')!.selector.toLowerCase();
  const v1 = LIFI_V1.getFunction('startBridgeTokensViaAcross')!.selector.toLowerCase();
  if (sel === v4swap || sel === v4direct) {
    const decoded = sel === v4swap
      ? LIFI_V4.decodeFunctionData('swapAndStartBridgeTokensViaAcrossV4', data)
      : LIFI_V4.decodeFunctionData('startBridgeTokensViaAcrossV4', data);
    const bridge = bridgeFields(decoded[0]);
    const swaps = sel === v4swap ? decoded[1] as ReadonlyArray<{ sendingAssetId: string; fromAmount: bigint; requiresDeposit: boolean }> : null;
    const across = (sel === v4swap ? decoded[2] : decoded[1]) as {
      receiverAddress: string;
      receivingAssetId: string;
      outputAmount: bigint;
      message: string;
    };
    if (!emptyBytes(String(across.message))) bad(provider, 'deposit message is not empty');
    const receiver = bytes32Address(provider, String(across.receiverAddress), 'deposit recipient');
    if (!sameAddress(receiver, String(bridge.receiver))) bad(provider, 'deposit recipient does not match');
    const outputToken = bytes32Address(provider, String(across.receivingAssetId), 'deposit output token');
    const pull = lifiPull(provider, req, bridge, swaps);
    const row = fromBridge(provider, req, bridge, pull, outputToken, asBig(across.outputAmount), null);
    return row;
  }
  if (sel === relaySwap || sel === relayDirect) {
    const decoded = sel === relaySwap
      ? LIFI_RELAY.decodeFunctionData('swapAndStartBridgeTokensViaRelayDepository', data)
      : LIFI_RELAY.decodeFunctionData('startBridgeTokensViaRelayDepository', data);
    const bridge = bridgeFields(decoded[0]);
    const swaps = sel === relaySwap ? decoded[1] as ReadonlyArray<{ sendingAssetId: string; fromAmount: bigint; requiresDeposit: boolean }> : null;
    const extra = (sel === relaySwap ? decoded[2] : decoded[1]) as { orderId: string; depositorAddress: string };
    assertDepositor(provider, getAddress(String(extra.depositorAddress)), req.sender, false);
    if (sameAddress(String(extra.depositorAddress), ZERO)) bad(provider, 'deposit depositor does not match');
    const pull = lifiPull(provider, req, bridge, swaps);
    return fromBridge(provider, req, bridge, pull, null, null, String(extra.orderId).toLowerCase());
  }
  if (sel === v1) {
    const bridge = bridgeFields(LIFI_V1.decodeFunctionData('startBridgeTokensViaAcross', data)[0]);
    if (bridge.hasSourceSwaps) bad(provider, 'approval amount is missing');
    return fromBridge(provider, req, bridge, asBig(bridge.minAmount), null, null, null);
  }
  return null;
}

interface RelayCall { target: string; allowFailure: boolean; value: bigint; callData: string }

type RelayAction =
  | { kind: 'approve'; spender: string; amount: bigint }
  | { kind: 'withdraw'; amount: bigint }
  | { kind: 'fund'; value: bigint }
  | { kind: 'cleanupNativeViaCall'; amount: bigint; to: string; id: string }
  | { kind: 'cleanupErc20s'; recipient: string; amount: bigint };

function classifyRelayCall(provider: string, req: BridgeQuoteRequest, router: string, call: RelayCall): RelayAction | null {
  const target = getAddress(String(call.target));
  const value = asBig(call.value);
  const data = String(call.callData);
  const sel = data.length >= 10 ? selectorOf(data) : '';
  if (sameAddress(target, req.tokenIn.address)) {
    if (value !== 0n) bad(provider, 'deposit amount does not match');
    if (sel === APPROVE_SELECTOR) {
      const approved = decodeApprove(provider, data);
      if (!sameAddress(approved.spender, router)) bad(provider, 'approval spender is not allowlisted');
      if (approved.amount > req.amountIn) bad(provider, 'approval is above the input');
      if (approved.amount !== req.amountIn) bad(provider, 'deposit amount does not match');
      return { kind: 'approve', spender: approved.spender, amount: approved.amount };
    }
    if (sel === WETH_WITHDRAW.getFunction('withdraw')!.selector.toLowerCase()) {
      const wad = asBig(WETH_WITHDRAW.decodeFunctionData('withdraw', data)[0]);
      if (wad !== req.amountIn) bad(provider, 'deposit amount does not match');
      return { kind: 'withdraw', amount: wad };
    }
    if (sel === ERC20_TRANSFER.getFunction('transfer')!.selector.toLowerCase()) bad(provider, 'deposit recipient does not match');
    if (sel === ERC20_TRANSFER.getFunction('transferFrom')!.selector.toLowerCase()) bad(provider, 'deposit recipient does not match');
    bad(provider, 'deposit calldata is not decodable');
  }
  if (sameAddress(target, router)) {
    if (emptyBytes(data) || data.length < 10) {
      if (value !== req.amountIn) bad(provider, 'deposit amount does not match');
      return { kind: 'fund', value };
    }
    if (sel === ROUTER_CALLS.getFunction('cleanupNativeViaCall')!.selector.toLowerCase()) {
      const cleaned = ROUTER_CALLS.decodeFunctionData('cleanupNativeViaCall', data);
      if (!sameAddress(String(cleaned.to), RELAY_DEPOSITORY)) bad(provider, 'deposit recipient does not match');
      const inner = String(cleaned.data);
      if (selectorOf(inner) !== RELAY_NATIVE.getFunction('depositNative')!.selector.toLowerCase()) bad(provider, 'deposit calldata is not decodable');
      const native = RELAY_NATIVE.decodeFunctionData('depositNative', inner);
      assertDepositor(provider, getAddress(String(native.depositor)), req.sender, false);
      const amt = asBig(cleaned.amount);
      if (amt !== 0n) bad(provider, 'deposit amount does not match');
      if (value !== 0n) bad(provider, 'deposit amount does not match');
      return { kind: 'cleanupNativeViaCall', amount: amt, to: getAddress(String(cleaned.to)), id: String(native.id).toLowerCase() };
    }
    if (sel === ROUTER_CALLS.getFunction('cleanupErc20s')!.selector.toLowerCase()) {
      if (value !== 0n) bad(provider, 'deposit amount does not match');
      const cleaned = ROUTER_CALLS.decodeFunctionData('cleanupErc20s', data);
      const tokens = cleaned[0] as readonly string[];
      const recipients = cleaned[1] as readonly string[];
      const amounts = cleaned[2] as readonly bigint[];
      if (tokens.length !== 1 || recipients.length !== 1 || amounts.length !== 1) bad(provider, 'deposit recipient does not match');
      if (!sameAddress(String(tokens[0]), req.tokenIn.address)) bad(provider, 'deposit token does not match');
      const paid = asBig(amounts[0]);
      if (paid !== req.amountIn) bad(provider, 'deposit amount does not match');
      return { kind: 'cleanupErc20s', recipient: getAddress(String(recipients[0])), amount: paid };
    }
    bad(provider, 'deposit calldata is not decodable');
  }
  if (sameAddress(target, RELAY_DEPOSITORY)) {
    if (sel === RELAY_NATIVE.getFunction('depositNative')!.selector.toLowerCase()) {
      const native = RELAY_NATIVE.decodeFunctionData('depositNative', data);
      assertDepositor(provider, getAddress(String(native.depositor)), req.sender, false);
      if (value !== req.amountIn) bad(provider, 'deposit amount does not match');
    }
    // A direct inner deposit is not one of the two accepted sequences. The ERC-20
    // amount has to be paid in full by cleanupErc20s, not by a 1-unit depositErc20
    // beside a wei self-call.
    bad(provider, 'deposit calldata is not decodable');
  }
  // Reached only when the inner-target allowlist throw above this call was removed.
  return null;
}

/**
 * ERC-20 payment is `paid === amountIn` from cleanupErc20s. Native wei is counted only
 * as the value forwarded to the router after withdraw(amountIn), and only in the live
 * WETH sequence. A wei self-call never satisfies an ERC-20 deposit.
 */
function acceptRelaySequence(provider: string, req: BridgeQuoteRequest, router: string, actions: readonly RelayAction[]): { depositId: string | null; recipient: string | null } {
  const weth = actions.length === 4
    && actions[0].kind === 'approve'
    && actions[1].kind === 'withdraw'
    && actions[2].kind === 'fund'
    && actions[3].kind === 'cleanupNativeViaCall';
  if (weth) {
    const approve = actions[0] as Extract<RelayAction, { kind: 'approve' }>;
    const withdraw = actions[1] as Extract<RelayAction, { kind: 'withdraw' }>;
    const fund = actions[2] as Extract<RelayAction, { kind: 'fund' }>;
    const cleanup = actions[3] as Extract<RelayAction, { kind: 'cleanupNativeViaCall' }>;
    if (!sameAddress(approve.spender, router) || approve.amount !== req.amountIn) bad(provider, 'approval spender is not allowlisted');
    if (withdraw.amount !== req.amountIn || fund.value !== req.amountIn || cleanup.amount !== 0n) bad(provider, 'deposit amount does not match');
    if (!sameAddress(cleanup.to, RELAY_DEPOSITORY)) bad(provider, 'deposit recipient does not match');
    return { depositId: cleanup.id, recipient: null };
  }
  if (actions.length === 1 && actions[0].kind === 'cleanupErc20s') {
    const paid = actions[0];
    if (paid.amount !== req.amountIn) bad(provider, 'deposit amount does not match');
    if (!sameAddress(paid.recipient, req.recipient)) bad(provider, 'deposit recipient does not match');
    return { depositId: null, recipient: paid.recipient };
  }
  bad(provider, 'deposit calldata is not decodable');
}

function auditRelayCalls(provider: string, req: BridgeQuoteRequest, router: string, calls: readonly RelayCall[]): { depositId: string | null; recipient: string | null } {
  const actions: RelayAction[] = [];
  for (const call of calls) {
    if (call.allowFailure) bad(provider, 'deposit calldata is not decodable');
    const target = getAddress(String(call.target));
    const allowed = sameAddress(target, router) || sameAddress(target, RELAY_DEPOSITORY) || sameAddress(target, req.tokenIn.address);
    // R5b depends on this throw. Without it, classifyRelayCall ignores the attacker
    // call and a whitelisted sequence in front of it would be accepted.
    if (!allowed) bad(provider, 'deposit target is not allowlisted');
    const action = classifyRelayCall(provider, req, router, call);
    if (action) actions.push(action);
  }
  return acceptRelaySequence(provider, req, router, actions);
}

function decodeRelay(provider: string, data: string, req: BridgeQuoteRequest, target: string | undefined): DecodedDeposit | null {
  const sel = selectorOf(data);
  if (sel === RELAY_ERC20.getFunction('depositErc20')!.selector.toLowerCase()) {
    const erc = RELAY_ERC20.decodeFunctionData('depositErc20', data);
    // Top-level call to the depository: msg.sender is the user, so address(0) is the user.
    assertDepositor(provider, getAddress(String(erc.depositor)), req.sender, true);
    const token = getAddress(String(erc.token));
    const amount = asBig(erc.amount);
    if (!sameAddress(token, req.tokenIn.address)) bad(provider, 'deposit token does not match');
    if (amount !== req.amountIn) bad(provider, 'deposit amount does not match');
    return {
      ...baseDecoded(token, amount),
      depositId: String(erc.id).toLowerCase(),
    };
  }
  if (sel === RELAY_NATIVE.getFunction('depositNative')!.selector.toLowerCase()) {
    const native = RELAY_NATIVE.decodeFunctionData('depositNative', data);
    assertDepositor(provider, getAddress(String(native.depositor)), req.sender, false);
    bad(provider, 'approval amount is missing');
  }
  if (sel !== RELAY.getFunction('transferAndMulticall')!.selector.toLowerCase()) return null;
  if (!target) bad(provider, 'deposit target is not allowlisted');
  const pair = relayPair(req.srcChain, target);
  if (!pair) bad(provider, 'deposit target is not allowlisted');
  const decoded = RELAY.decodeFunctionData('transferAndMulticall', data);
  if (!sameAddress(getAddress(String(decoded.refundTo)), req.sender) || !sameAddress(getAddress(String(decoded.nftRecipient)), req.sender)) {
    bad(provider, 'refund recipient does not match');
  }
  const tokens = decoded.tokens as readonly string[];
  const amounts = decoded.amounts as readonly bigint[];
  if (tokens.length !== amounts.length || tokens.length !== 1) bad(provider, 'deposit token does not match');
  if (!sameAddress(String(tokens[0]), req.tokenIn.address)) bad(provider, 'deposit token does not match');
  if (asBig(amounts[0]) !== req.amountIn) bad(provider, 'deposit amount does not match');
  const audited = auditRelayCalls(provider, req, pair.router, decoded.calls as readonly RelayCall[]);
  return {
    ...baseDecoded(getAddress(req.tokenIn.address), req.amountIn),
    recipient: audited.recipient,
    recipientInCalldata: audited.recipient != null,
    depositId: audited.depositId,
  };
}

export function decodeDeposit(provider: BridgeId, data: string, req: BridgeQuoteRequest, target?: string): DecodedDeposit {
  const sel = selectorOf(data);
  try {
    if (provider === 'across' && sel === DEPOSIT_V3.getFunction('depositV3')!.selector.toLowerCase()) {
      const d = DEPOSIT_V3.decodeFunctionData('depositV3', data);
      if (!emptyBytes(String(d.message))) bad(provider, 'deposit message is not empty');
      return {
        ...baseDecoded(getAddress(String(d.inputToken)), asBig(d.inputAmount)),
        recipient: getAddress(String(d.recipient)),
        recipientInCalldata: true,
        outputToken: getAddress(String(d.outputToken)),
        outputAmount: asBig(d.outputAmount),
        fillDeadline: Number(d.fillDeadline),
        destinationChainId: Number(d.destinationChainId),
      };
    }
    if (provider === 'across' && sel === SPOKE_DEPOSIT.getFunction('deposit')!.selector.toLowerCase()) {
      const d = SPOKE_DEPOSIT.decodeFunctionData('deposit', data);
      if (!emptyBytes(String(d.message))) bad(provider, 'deposit message is not empty');
      const amount = asBig(d.inputAmount);
      return {
        ...baseDecoded(bytes32Address(provider, String(d.inputToken), 'deposit token'), amount),
        recipient: bytes32Address(provider, String(d.recipient), 'deposit recipient'),
        recipientInCalldata: true,
        outputToken: bytes32Address(provider, String(d.outputToken), 'deposit output token'),
        outputAmount: asBig(d.outputAmount),
        fillDeadline: Number(d.fillDeadline),
        destinationChainId: Number(d.destinationChainId),
      };
    }
    if (provider === 'across' && sel === SWAP.getFunction('swapAndBridge')!.selector.toLowerCase()) {
      const d = SWAP.decodeFunctionData('swapAndBridge', data)[0];
      const spoke = ACROSS_SPOKE[req.srcChain];
      if (!spoke || !sameAddress(String(d.spokePool), spoke)) bad(provider, 'spoke pool does not match');
      if (!emptyBytes(String(d.depositData.message))) bad(provider, 'deposit message is not empty');
      const fee = asBig(d.submissionFees.amount);
      if (fee < 0n) bad(provider, 'approval amount is missing');
      const amount = asBig(d.swapTokenAmount);
      return {
        ...baseDecoded(getAddress(String(d.swapToken)), amount + fee),
        recipient: bytes32Address(provider, String(d.depositData.recipient), 'deposit recipient'),
        recipientInCalldata: true,
        amount,
        submissionFee: fee,
        outputToken: bytes32Address(provider, String(d.depositData.outputToken), 'deposit output token'),
        outputAmount: asBig(d.depositData.outputAmount),
        fillDeadline: Number(d.depositData.fillDeadline),
        destinationChainId: Number(d.depositData.destinationChainId),
      };
    }
    if (provider === 'lifi') {
      const decoded = decodeLifi(provider, data, req);
      if (decoded) return decoded;
    }
    if (provider === 'relay') {
      const decoded = decodeRelay(provider, data, req, target);
      if (decoded) return decoded;
    }
  } catch (e) {
    if (e && typeof e === 'object' && (e as { name?: string }).name === 'BridgeError') throw e;
    bad(provider, 'deposit calldata is not decodable');
  }
  bad(provider, 'deposit calldata is not decodable');
}

/**
 * Allowlist the deposit target and the approval spender, and check the decoded
 * recipient, token, destination, and pull amount. Li.Fi bridgeData.minAmount is
 * checked against the pre-bridge amount (amountIn minus the 0.25% integrator fee).
 * It is not compared with the destination minimum. That minimum is quote.minOut,
 * which assertQuoteMatches floors against slippage on its own.
 */
export function assertGuarded(provider: BridgeId, req: BridgeQuoteRequest, deposit: UnsignedTx, approval: UnsignedTx | null) {
  assertDepositTarget(provider, req.srcChain, deposit.to);
  const decoded = decodeDeposit(provider, deposit.data, req, deposit.to);
  if (decoded.recipientInCalldata) {
    if (!decoded.recipient || !sameAddress(decoded.recipient, req.recipient)) bad(provider, 'deposit recipient does not match');
  }
  if (!sameAddress(decoded.token, req.tokenIn.address)) bad(provider, 'deposit token does not match');
  if (decoded.outputToken && !sameAddress(decoded.outputToken, req.tokenOut.address)) bad(provider, 'deposit output token does not match');
  if (decoded.destinationChainId != null && decoded.destinationChainId !== req.dstChain) bad(provider, 'destination chain does not match');
  if (provider === 'across' && decoded.amount != null && decoded.submissionFee === 0n && decoded.amount !== req.amountIn) {
    bad(provider, 'deposit amount does not match');
  }
  if (provider === 'across' && decoded.amount != null && decoded.amount + decoded.submissionFee !== decoded.pullAmount) {
    bad(provider, 'deposit amount does not match');
  }
  if (decoded.pullAmount <= 0n || decoded.pullAmount > req.amountIn) bad(provider, 'approval is above the input');
  if (provider === 'lifi') {
    if (decoded.preBridgeAmount == null) bad(provider, 'deposit min amount does not match the pre-bridge amount');
    const expected = req.amountIn - lifiFeeAmount(req.amountIn);
    const delta = decoded.preBridgeAmount > expected ? decoded.preBridgeAmount - expected : expected - decoded.preBridgeAmount;
    if (delta > 1n) bad(provider, 'deposit min amount does not match the pre-bridge amount');
  }
  if (!approval) return;
  const spent = decodeApprove(provider, approval.data);
  if (spent.amount !== decoded.pullAmount) bad(provider, 'approval does not match the deposit');
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
  submissionFee?: bigint;
}): string {
  const zero32 = zeroPadValue('0x00', 32);
  const fee = o.submissionFee ?? 0n;
  return SWAP.encodeFunctionData('swapAndBridge', [[
    [fee, o.depositor],
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

export function encodeLifiDeposit(o: {
  token: string;
  outputToken: string;
  recipient: string;
  sender: string;
  amountIn: bigint;
  minOut: bigint;
  dstChain: number;
  variant?: 'swap' | 'direct';
}): string {
  const preBridge = o.amountIn - lifiFeeAmount(o.amountIn);
  const bridge = [
    `0x${'11'.repeat(32)}`,
    'across',
    'gridbot',
    o.sender,
    o.token,
    o.recipient,
    preBridge,
    BigInt(o.dstChain),
    o.variant !== 'direct',
    false,
  ];
  const across = [
    zeroPadValue(o.recipient, 32),
    zeroPadValue(o.sender, 32),
    zeroPadValue(o.token, 32),
    zeroPadValue(o.outputToken, 32),
    o.minOut,
    10n ** 18n,
    zeroPadValue(ZERO, 32),
    0,
    0,
    0,
    '0x',
  ];
  if (o.variant === 'direct') {
    bridge[8] = false;
    return LIFI_V4.encodeFunctionData('startBridgeTokensViaAcrossV4', [bridge, across]);
  }
  const swap = [[
    o.sender,
    o.sender,
    o.token,
    o.token,
    o.amountIn,
    '0x',
    true,
  ]];
  return LIFI_V4.encodeFunctionData('swapAndStartBridgeTokensViaAcrossV4', [bridge, swap, across]);
}

export function encodeRelayDeposit(o: { token: string; amount: bigint; recipient: string; sender: string; router: string }): string {
  const inner = ROUTER_CALLS.encodeFunctionData('cleanupErc20s', [[o.token], [o.recipient], [o.amount]]);
  return RELAY.encodeFunctionData('transferAndMulticall', [
    [o.token],
    [o.amount],
    [[o.router, false, 0, inner]],
    o.sender,
    o.sender,
    '0x',
  ]);
}

export function encodeRelayErc20Deposit(o: { depositor: string; token: string; amount: bigint; id: string }): string {
  return RELAY_ERC20.encodeFunctionData('depositErc20', [o.depositor, o.token, o.amount, o.id]);
}

export { DEPOSIT_V3, RELAY, ERC20_TRANSFER };
