/**
 * Re-encoded calldata must equal the original bytes.
 * Across depositV3 may also be that encoding plus 1dc0de and the configured 4-hex integrator id.
 * Any other extra byte is rejected, including the live SpokePool tail 73c0de.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface, zeroPadValue } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  ACROSS_PERIPHERY, ACROSS_SPOKE, DEPOSIT_V3, RELAY, RELAY_DEPOSITORY, RELAY_PROXY_V3, RELAY_ROUTER_V3,
  decodeDeposit, encodeAcrossSwap, encodeLifiDeposit, encodeRelayDeposit, encodeRelayErc20Deposit,
} from '../src/server/bridge/allow';
import { decodeApprove, encodeApprove } from '../src/server/bridge/tx';
import {
  ETH_OUT, LEGS, NOW_SEC, RECIPIENT, REQUEST_ID, SENDER, USDC_IN, USDC_OUT, ZERO, requestOf,
} from './fixtures/bridgeFixtures';
import type { BridgeQuoteRequest } from '../src/server/bridge';

const ID = 'abcd';
const MARK = `1dc0de${ID}`;

const SPOKE = new Interface([
  'function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message)',
]);
const BRIDGE = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)';
const SWAP_DATA = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)';
const LIFI_RELAY = new Interface([
  `function startBridgeTokensViaRelayDepository(${BRIDGE} _bridgeData, (bytes32 orderId, address depositorAddress) _relayDepositoryData) payable`,
  `function swapAndStartBridgeTokensViaRelayDepository(${BRIDGE} _bridgeData, ${SWAP_DATA}[] _swapData, (bytes32 orderId, address depositorAddress) _relayDepositoryData) payable`,
]);
const LIFI_V1 = new Interface([
  `function startBridgeTokensViaAcross(${BRIDGE} bridgeData, (int64 relayerFeePct, uint32 quoteTimestamp, bytes message, uint256 maxCount) acrossData)`,
]);
const ROUTER = new Interface([
  'function cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts)',
  'function cleanupNativeViaCall(uint256 amount, address to, bytes data)',
]);
const NATIVE = new Interface(['function depositNative(address depositor, bytes32 id)']);
const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const WETH = new Interface(['function withdraw(uint256 wad)']);

function tails(data: string): string[] {
  return [
    `${data}ff`,
    `${data}ff${MARK}`,
    `${data}${MARK}${MARK}`,
    `${data}1dc0deab`,
    `${data}1dc0deabcdef`,
    `${data}1dc0de`,
    // The integrator tail is not final: more bytes follow it.
    `${data}${MARK}ff`,
  ];
}

function rejects(provider: 'across' | 'relay' | 'lifi', data: string, req: BridgeQuoteRequest, target?: string, integratorId?: string) {
  expect(() => decodeDeposit(provider, data, req, target, integratorId)).toThrow(/not canonical/);
}

function word(addr: string): string {
  return zeroPadValue(addr, 32);
}

function bridgeTuple(req: BridgeQuoteRequest, hasSourceSwaps = false) {
  return [
    `0x${'11'.repeat(32)}`,
    'across',
    'gridbot',
    req.sender,
    req.tokenIn.address,
    req.recipient,
    req.amountIn,
    BigInt(req.dstChain),
    hasSourceSwaps,
    false,
  ];
}

function multicall(req: BridgeQuoteRequest, calls: Array<[string, boolean, bigint, string]>): string {
  return RELAY.encodeFunctionData('transferAndMulticall', [
    [req.tokenIn.address],
    [req.amountIn],
    calls,
    req.sender,
    req.sender,
    '0x',
  ]);
}

function live(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/bridge/live', name), 'utf8')) as Record<string, unknown>;
}

function liveDeposit(name: string): { data: string; to?: string } {
  const body = live(name);
  const swap = body.swapTx as { data?: string; to?: string } | undefined;
  if (typeof swap?.data === 'string') return { data: swap.data, to: swap.to };
  const tx = body.transactionRequest as { data?: string; to?: string } | undefined;
  if (typeof tx?.data === 'string') return { data: tx.data, to: tx.to };
  const steps = body.steps as Array<{ items?: Array<{ data?: { data?: string; to?: string } }> }> | undefined;
  for (const step of steps ?? []) {
    for (const item of step.items ?? []) {
      const data = item.data?.data;
      if (typeof data === 'string' && !data.toLowerCase().startsWith('0x095ea7b3')) return { data, to: item.data?.to };
    }
  }
  throw new Error(`${name} has no deposit`);
}

describe('canonical deposit calldata', () => {
  const weth = requestOf(LEGS[0]);
  const usd = requestOf(LEGS[2]);

  const depositV3 = DEPOSIT_V3.encodeFunctionData('depositV3', [
    weth.sender,
    weth.recipient,
    weth.tokenIn.address,
    weth.tokenOut.address,
    weth.amountIn,
    ETH_OUT,
    BigInt(weth.dstChain),
    ZERO,
    NOW_SEC,
    NOW_SEC + 3_600,
    0,
    '0x',
  ]).toLowerCase();

  const spoke = SPOKE.encodeFunctionData('deposit', [
    word(usd.sender),
    word(usd.recipient),
    word(usd.tokenIn.address),
    word(usd.tokenOut.address),
    usd.amountIn,
    USDC_OUT,
    BigInt(usd.dstChain),
    word(ZERO),
    NOW_SEC,
    NOW_SEC + 3_600,
    0,
    '0x',
  ]).toLowerCase();

  const swap = encodeAcrossSwap({
    swapToken: usd.tokenIn.address,
    amount: usd.amountIn,
    outputToken: usd.tokenOut.address,
    outputAmount: USDC_OUT,
    depositor: usd.sender,
    recipient: usd.recipient,
    dstChain: usd.dstChain,
    spoke: ACROSS_SPOKE[usd.srcChain],
    fillDeadline: NOW_SEC + 10_000,
  }).toLowerCase();

  const lifiSwap = encodeLifiDeposit({
    token: usd.tokenIn.address,
    outputToken: usd.tokenOut.address,
    recipient: usd.recipient,
    sender: usd.sender,
    amountIn: usd.amountIn,
    minOut: USDC_OUT,
    dstChain: usd.dstChain,
  }).toLowerCase();

  const lifiDirect = encodeLifiDeposit({
    token: usd.tokenIn.address,
    outputToken: usd.tokenOut.address,
    recipient: usd.recipient,
    sender: usd.sender,
    amountIn: usd.amountIn,
    minOut: USDC_OUT,
    dstChain: usd.dstChain,
    variant: 'direct',
  }).toLowerCase();

  const lifiRelay = LIFI_RELAY.encodeFunctionData('startBridgeTokensViaRelayDepository', [
    bridgeTuple(usd),
    [REQUEST_ID, usd.sender],
  ]).toLowerCase();

  const lifiRelaySwap = LIFI_RELAY.encodeFunctionData('swapAndStartBridgeTokensViaRelayDepository', [
    bridgeTuple(usd, true),
    [[usd.sender, usd.sender, usd.tokenIn.address, usd.tokenIn.address, usd.amountIn, '0x', true]],
    [REQUEST_ID, usd.sender],
  ]).toLowerCase();

  const lifiV1 = LIFI_V1.encodeFunctionData('startBridgeTokensViaAcross', [
    bridgeTuple(usd),
    [0, NOW_SEC, '0x', 0],
  ]).toLowerCase();

  const relayErc20 = encodeRelayErc20Deposit({
    depositor: SENDER,
    token: usd.tokenIn.address,
    amount: USDC_IN,
    id: REQUEST_ID,
  }).toLowerCase();

  const relayCalls = encodeRelayDeposit({
    token: usd.tokenIn.address,
    amount: usd.amountIn,
    recipient: RECIPIENT,
    sender: SENDER,
    router: RELAY_ROUTER_V3,
  }).toLowerCase();

  const cases: Array<{ name: string; provider: 'across' | 'relay' | 'lifi'; data: string; req: BridgeQuoteRequest; target?: string }> = [
    { name: 'depositV3', provider: 'across', data: depositV3, req: weth, target: ACROSS_SPOKE[weth.srcChain] },
    { name: 'spoke deposit', provider: 'across', data: spoke, req: usd, target: ACROSS_SPOKE[usd.srcChain] },
    { name: 'swapAndBridge', provider: 'across', data: swap, req: usd, target: ACROSS_PERIPHERY },
    { name: 'lifi across v4 swap', provider: 'lifi', data: lifiSwap, req: usd },
    { name: 'lifi across v4 direct', provider: 'lifi', data: lifiDirect, req: usd },
    { name: 'lifi relay depository', provider: 'lifi', data: lifiRelay, req: usd },
    { name: 'lifi relay depository swap', provider: 'lifi', data: lifiRelaySwap, req: usd },
    { name: 'lifi across v1', provider: 'lifi', data: lifiV1, req: usd },
    { name: 'relay depositErc20', provider: 'relay', data: relayErc20, req: usd, target: RELAY_DEPOSITORY },
    { name: 'relay transferAndMulticall', provider: 'relay', data: relayCalls, req: usd, target: RELAY_PROXY_V3 },
  ];

  it.each(cases)('accepts canonical $name calldata', ({ provider, data, req, target }) => {
    expect(decodeDeposit(provider, data, req, target).pullAmount).toBeGreaterThan(0n);
  });

  it.each(cases)('rejects junk on $name', ({ provider, data, req, target }) => {
    for (const bad of tails(data)) rejects(provider, bad, req, target, provider === 'across' ? ID : undefined);
  });

  it('allows depositV3 plus the configured integrator id and nothing else', () => {
    const target = ACROSS_SPOKE[weth.srcChain];
    expect(decodeDeposit('across', `${depositV3}${MARK}`, weth, target, ID).pullAmount).toBe(weth.amountIn);
    expect(decodeDeposit('across', depositV3, weth, target, ID).pullAmount).toBe(weth.amountIn);
    rejects('across', `${depositV3}${MARK}`, weth, target);
    rejects('across', `${depositV3}1dc0de1234`, weth, target, ID);
    rejects('across', `${depositV3}${MARK}`, weth, target, '1234');
    rejects('across', swap + MARK, usd, ACROSS_PERIPHERY, ID);
    rejects('across', spoke + MARK, usd, ACROSS_SPOKE[usd.srcChain], ID);
  });

  it('rejects trailing bytes on a nested Relay call while the outer multicall stays canonical', () => {
    const inner = ROUTER.encodeFunctionData('cleanupErc20s', [[usd.tokenIn.address], [usd.recipient], [usd.amountIn]]);
    const approve = APPROVE.encodeFunctionData('approve', [RELAY_ROUTER_V3, usd.amountIn]);
    const withdraw = WETH.encodeFunctionData('withdraw', [usd.amountIn]);
    const native = NATIVE.encodeFunctionData('depositNative', [SENDER, REQUEST_ID]);
    const cleanup = ROUTER.encodeFunctionData('cleanupNativeViaCall', [0, RELAY_DEPOSITORY, native]);
    const nested = [
      ['cleanupErc20s', multicall(usd, [[RELAY_ROUTER_V3, false, 0n, `${inner}ff`]])],
      ['approve', multicall(weth, [[weth.tokenIn.address, false, 0n, `${approve}ff`]])],
      ['withdraw', multicall(weth, [[weth.tokenIn.address, false, 0n, `${withdraw}ff`]])],
      ['depositNative', multicall(weth, [[RELAY_ROUTER_V3, false, 0n, ROUTER.encodeFunctionData('cleanupNativeViaCall', [0, RELAY_DEPOSITORY, `${native}ff`])]])],
      ['cleanupNativeViaCall', multicall(weth, [[RELAY_ROUTER_V3, false, 0n, `${cleanup}ff`]])],
    ] as const;
    for (const [name, data] of nested) {
      const req = name === 'cleanupErc20s' ? usd : weth;
      rejects('relay', data, req, RELAY_PROXY_V3);
    }
    const honest = multicall(usd, [[RELAY_ROUTER_V3, false, 0n, inner]]);
    expect(decodeDeposit('relay', honest, usd, RELAY_PROXY_V3).pullAmount).toBe(usd.amountIn);
  });

  it('rejects trailing bytes on an ERC-20 approve', () => {
    const tx = encodeApprove(usd.tokenIn.address, ACROSS_PERIPHERY, usd.amountIn, usd.srcChain);
    expect(decodeApprove('across', tx.data).amount).toBe(usd.amountIn);
    expect(() => decodeApprove('across', `${tx.data}ff`)).toThrow(/approval calldata is not canonical/);
    expect(() => decodeApprove('across', `${tx.data}${MARK}`)).toThrow(/not canonical/);
  });

  it('classifies the captured quotes: five are byte-exact and the rest are not', () => {
    const rows: Array<{ file: string; provider: 'across' | 'relay' | 'lifi'; leg: 0 | 1 | 2 | 3; result: 'exact' | 'not-canonical' | 'unknown-selector' }> = [
      { file: 'across-usdc-1-4663.json', provider: 'across', leg: 2, result: 'not-canonical' },
      { file: 'across-usdc-4663-1.json', provider: 'across', leg: 3, result: 'not-canonical' },
      { file: 'across-weth-1-4663.json', provider: 'across', leg: 0, result: 'not-canonical' },
      { file: 'across-weth-4663-1.json', provider: 'across', leg: 1, result: 'not-canonical' },
      { file: 'relay-usdc-1-4663.json', provider: 'relay', leg: 2, result: 'exact' },
      { file: 'relay-usdc-4663-1.json', provider: 'relay', leg: 3, result: 'exact' },
      { file: 'relay-weth-1-4663.json', provider: 'relay', leg: 0, result: 'not-canonical' },
      { file: 'relay-weth-4663-1.json', provider: 'relay', leg: 1, result: 'not-canonical' },
      { file: 'lifi-usdc-1-4663.json', provider: 'lifi', leg: 2, result: 'exact' },
      { file: 'lifi-usdc-4663-1.json', provider: 'lifi', leg: 3, result: 'exact' },
      { file: 'lifi-weth-1-4663.json', provider: 'lifi', leg: 0, result: 'exact' },
      { file: 'lifi-weth-4663-1.json', provider: 'lifi', leg: 1, result: 'unknown-selector' },
    ];
    const exact: string[] = [];
    for (const row of rows) {
      const found = liveDeposit(row.file);
      const req = { ...requestOf(LEGS[row.leg]), recipient: SENDER, sameAsset: row.file.includes('weth') && row.provider !== 'across' };
      let failed: string | undefined;
      try {
        decodeDeposit(row.provider, found.data, req, found.to);
      } catch (e) {
        failed = String(e);
      }
      if (row.result === 'exact') {
        expect(failed, row.file).toBeUndefined();
        exact.push(row.file);
      } else if (row.result === 'not-canonical') {
        expect(failed, row.file).toMatch(/deposit calldata is not canonical/);
      } else {
        expect(found.data.toLowerCase().startsWith('0x4c279d6b'), row.file).toBe(true);
        expect(failed, row.file).toMatch(/deposit calldata is not decodable/);
        expect(failed, row.file).not.toMatch(/not canonical/);
      }
    }
    expect(exact).toEqual([
      'relay-usdc-1-4663.json',
      'relay-usdc-4663-1.json',
      'lifi-usdc-1-4663.json',
      'lifi-usdc-4663-1.json',
      'lifi-weth-1-4663.json',
    ]);

    for (const file of ['across-usdc-1-4663.json', 'across-usdc-4663-1.json', 'across-weth-1-4663.json', 'across-weth-4663-1.json']) {
      const data = liveDeposit(file).data;
      const decoded = SPOKE.decodeFunctionData('deposit', data);
      const encoded = SPOKE.encodeFunctionData('deposit', decoded).toLowerCase();
      expect(data.toLowerCase(), file).toBe(`${encoded}73c0de`);
    }
    for (const file of ['relay-weth-1-4663.json', 'relay-weth-4663-1.json']) {
      const data = liveDeposit(file).data.toLowerCase();
      const decoded = RELAY.decodeFunctionData('transferAndMulticall', data);
      const encoded = RELAY.encodeFunctionData('transferAndMulticall', decoded).toLowerCase();
      expect(data.startsWith(encoded), file).toBe(true);
      expect(data.length - encoded.length, file).toBe(64);
    }
  });
});
