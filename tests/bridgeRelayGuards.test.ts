/**
 * Relay deposit sequences and the checks that keep a quote from paying an attacker.
 *
 * Accepted multicalls are exact sequences:
 * 1. Top-level depositErc20 to the depository (the live USDC route).
 * 2. Live WETH unwrap: approve(router, amountIn), withdraw(amountIn), native value
 *    amountIn to the router, cleanupNativeViaCall(0) into depositNative on the depository.
 * 3. One cleanupErc20s of amountIn to the requested recipient (unit fixtures only).
 *
 * cleanupErc20sViaCall is not on that list. R11b deposits amountIn and has no value
 * self-call, and it is still rejected. A wei self-call is never treated as an ERC-20 payment.
 *
 * A read-only recapture on 2026-10-28 with refundTo set to the placeholder still named the
 * solver as refundTo and nftRecipient. Those fields have to be the sender, so the unmodified
 * WETH captures are rejected. The control below rewrites only those two fields to the sender
 * and the live four-call sequence then passes.
 *
 * These rejections are load-bearing:
 * - "exact approval to an attacker" fails if the Relay spender check is removed.
 * - "depositor is an attacker" and "inner depositor is zero" fail if assertDepositor is removed.
 * - "extra call to an attacker contract" fails if the inner-target allowlist throw is removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface, getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { createBridgeProviders, type HttpClient } from '../src/server/bridge';
import {
  ACROSS_PERIPHERY, ACROSS_SPOKE, RELAY_DEPOSITORY, RELAY_PROXY_V3, RELAY_PROXY_V32, RELAY_ROUTER_V32, decodeDeposit,
} from '../src/server/bridge/allow';
import { BRIDGE_CAPTURED_AT_MS } from './fixtures/bridge/captured';
import { ETH_IN, LEGS, SENDER, USDC_IN, relayQuote, requestOf } from './fixtures/bridgeFixtures';

const ATTACKER = getAddress(`0x${'99'.repeat(20)}`);
const MAX = 2n ** 256n - 1n;
const ZERO = getAddress(`0x${'0'.repeat(40)}`);

const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const ERC20 = new Interface([
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function depositErc20(address depositor, address token, uint256 amount, bytes32 id)',
]);
const NATIVE = new Interface(['function depositNative(address depositor, bytes32 id)']);
const WETH = new Interface(['function withdraw(uint256 wad)']);
const ROUTER = new Interface([
  'function cleanupNative(uint256 amount, address recipient)',
  'function cleanupNativeViaCall(uint256 amount, address to, bytes data)',
  'function cleanupErc20s(address[] tokens, address[] recipients, uint256[] amounts)',
  'function cleanupErc20sViaCall(address[] tokens, address[] tos, bytes[] datas, uint256[] amounts)',
]);
const MULTICALL = new Interface([
  'function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool allowFailure, uint256 value, bytes callData)[] calls, address refundTo, address nftRecipient, bytes metadata) payable',
]);

interface Call { target: string; allowFailure: boolean; value: bigint; callData: string }
interface Multicall {
  tokens: string[];
  amounts: bigint[];
  calls: Call[];
  refundTo: string;
  nftRecipient: string;
  metadata: string;
}

function live(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/bridge/live', name), 'utf8')) as Record<string, unknown>;
}

function steps(body: Record<string, unknown>): Array<{ id?: string; items?: Array<{ data?: Record<string, unknown> }> }> {
  return body.steps as Array<{ id?: string; items?: Array<{ data?: Record<string, unknown> }> }>;
}

function txOf(body: Record<string, unknown>, id: string): Record<string, unknown> {
  const step = steps(body).find((s) => s.id === id);
  const data = step?.items?.[0]?.data;
  if (!data) throw new Error(`missing ${id}`);
  return data;
}

function decodeMc(data: string): Multicall {
  const row = MULTICALL.decodeFunctionData('transferAndMulticall', data);
  return {
    tokens: [...row.tokens].map(String),
    amounts: [...row.amounts].map((v) => BigInt(v as bigint)),
    calls: [...row.calls].map((c) => ({
      target: String(c.target),
      allowFailure: Boolean(c.allowFailure),
      value: BigInt(c.value as bigint),
      callData: String(c.callData),
    })),
    refundTo: String(row.refundTo),
    nftRecipient: String(row.nftRecipient),
    metadata: String(row.metadata),
  };
}

function encodeMc(mc: Multicall): string {
  return MULTICALL.encodeFunctionData('transferAndMulticall', [
    mc.tokens,
    mc.amounts,
    mc.calls.map((c) => [c.target, c.allowFailure, c.value, c.callData]),
    mc.refundTo,
    mc.nftRecipient,
    mc.metadata,
  ]);
}

/** Live WETH multicall with refundTo and nftRecipient rewritten to the sender. */
function weth(edit?: (mc: Multicall) => void): Record<string, unknown> {
  const body = live('relay-weth-1-4663.json');
  const tx = txOf(body, 'deposit');
  const mc = decodeMc(String(tx.data));
  mc.refundTo = SENDER;
  mc.nftRecipient = SENDER;
  edit?.(mc);
  tx.data = encodeMc(mc);
  return body;
}

function usdc(): Record<string, unknown> {
  return live('relay-usdc-1-4663.json');
}

function orderOf(body: Record<string, unknown>): string {
  const protocol = body.protocol as { v2: { orderId: string } };
  return protocol.v2.orderId;
}

function setApproval(body: Record<string, unknown>, spender: string, amount: bigint) {
  txOf(body, 'approve').data = APPROVE.encodeFunctionData('approve', [spender, amount]);
}

function setErc20(body: Record<string, unknown>, depositor: string, amount: bigint, id = orderOf(body)) {
  const tx = txOf(body, 'deposit');
  tx.to = RELAY_DEPOSITORY;
  tx.data = ERC20.encodeFunctionData('depositErc20', [depositor, LEGS[2].src.address, amount, id]);
}

function harness() {
  const calls: Array<{ url: string; body?: string }> = [];
  const queue: unknown[] = [];
  const http: HttpClient = async (req) => {
    calls.push({ url: req.url, body: req.body });
    const next = queue.shift();
    if (!next) return { status: 599, body: { message: 'fixture miss' }, retryAfterMs: null };
    return { status: 200, body: next, retryAfterMs: null };
  };
  const clients = createBridgeProviders({
    http,
    now: () => BRIDGE_CAPTURED_AT_MS,
    sleep: async () => {},
    limits: {
      across: { max: 1000, windowMs: 60_000 },
      relay: { max: 1000, windowMs: 60_000 },
      lifi: { max: 1000, windowMs: 60_000 },
    },
  });
  return { clients, calls, queue };
}

function relayReq(leg = LEGS[0]) {
  return { ...requestOf(leg), recipient: SENDER };
}

async function relayQuoteOf(body: unknown, leg = LEGS[0]) {
  const h = harness();
  h.queue.push(body);
  return h.clients.relay.quote(relayReq(leg));
}

describe('Relay sequences and hostile approvals', () => {
  it('accepts the live WETH sequence once refundTo and nftRecipient are the sender', async () => {
    const quote = await relayQuoteOf(weth());
    const req = relayReq();
    const decoded = decodeDeposit('relay', quote.deposit.data, req, quote.deposit.to);
    const [spender, amount] = APPROVE.decodeFunctionData('approve', quote.approval!.data);
    expect(amount).toBe(decoded.pullAmount);
    expect(amount).toBe(ETH_IN);
    expect(getAddress(String(spender))).toBe(getAddress(quote.deposit.to));
    expect(getAddress(quote.deposit.to)).toBe(RELAY_PROXY_V32);
  });

  it('accepts a top-level depositErc20 whose depositor is zero', async () => {
    const body = usdc();
    setErc20(body, ZERO, USDC_IN);
    const quote = await relayQuoteOf(body, LEGS[2]);
    expect(quote.amountIn).toBe(USDC_IN);
    const [spender, amount] = APPROVE.decodeFunctionData('approve', quote.approval!.data);
    expect(amount).toBe(USDC_IN);
    expect(getAddress(String(spender))).toBe(RELAY_DEPOSITORY);
  });

  it('sends refundTo as the sender on the Relay quote request', async () => {
    const h = harness();
    h.queue.push(relayQuote(LEGS[2]));
    await h.clients.relay.quote(requestOf(LEGS[2]));
    const sent = JSON.parse(h.calls[0].body ?? '{}') as { refundTo?: string };
    expect(getAddress(sent.refundTo ?? '')).toBe(SENDER);
  });

  it('R1 rejects a token transfer to the attacker while the user is only nftRecipient', async () => {
    const body = usdc();
    const token = LEGS[2].src.address;
    const tx = txOf(body, 'deposit');
    tx.to = RELAY_PROXY_V32;
    tx.data = MULTICALL.encodeFunctionData('transferAndMulticall', [
      [token],
      [USDC_IN],
      [[token, false, 0n, ERC20.encodeFunctionData('transfer', [ATTACKER, USDC_IN])]],
      SENDER,
      SENDER,
      '0x',
    ]);
    setApproval(body, RELAY_PROXY_V32, USDC_IN);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit recipient does not match/);
  });

  it('R2 rejects cleanupErc20s to the attacker', async () => {
    const token = LEGS[0].src.address;
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls = [{
        target: RELAY_ROUTER_V32,
        allowFailure: false,
        value: 0n,
        callData: ROUTER.encodeFunctionData('cleanupErc20s', [[token], [ATTACKER], [ETH_IN]]),
      }];
    }))).rejects.toThrow(/deposit recipient does not match/);
  });

  it('R2b rejects cleanupNative to the attacker', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls = [{
        target: RELAY_ROUTER_V32,
        allowFailure: false,
        value: 0n,
        callData: ROUTER.encodeFunctionData('cleanupNative', [ETH_IN, ATTACKER]),
      }];
    }))).rejects.toThrow(/deposit calldata is not decodable/);
  });

  it('R2c rejects cleanupNativeViaCall to the attacker', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      const cleaned = ROUTER.decodeFunctionData('cleanupNativeViaCall', mc.calls[3].callData);
      mc.calls[3].callData = ROUTER.encodeFunctionData('cleanupNativeViaCall', [cleaned.amount, ATTACKER, cleaned.data]);
    }))).rejects.toThrow(/deposit recipient does not match/);
  });

  it('R2d rejects depositNative whose depositor is the attacker', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      const cleaned = ROUTER.decodeFunctionData('cleanupNativeViaCall', mc.calls[3].callData);
      const native = NATIVE.decodeFunctionData('depositNative', String(cleaned.data));
      const inner = NATIVE.encodeFunctionData('depositNative', [ATTACKER, native.id]);
      mc.calls[3].callData = ROUTER.encodeFunctionData('cleanupNativeViaCall', [cleaned.amount, cleaned.to, inner]);
    }))).rejects.toThrow(/deposit depositor does not match/);
  });

  it('R3 rejects an inner approve to the attacker', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls[0].callData = APPROVE.encodeFunctionData('approve', [ATTACKER, ETH_IN]);
    }))).rejects.toThrow(/approval spender is not allowlisted/);
  });

  it('R3b rejects an inner approve of the maximum to the router', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls[0].callData = APPROVE.encodeFunctionData('approve', [RELAY_ROUTER_V32, MAX]);
    }))).rejects.toThrow(/approval is above the input/);
  });

  it('R4 rejects an extra transfer', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls.push({
        target: LEGS[0].src.address,
        allowFailure: false,
        value: 0n,
        callData: ERC20.encodeFunctionData('transfer', [ATTACKER, 1n]),
      });
    }))).rejects.toThrow(/deposit recipient does not match/);
  });

  it('R4b rejects an extra transferFrom', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls.push({
        target: LEGS[0].src.address,
        allowFailure: false,
        value: 0n,
        callData: ERC20.encodeFunctionData('transferFrom', [SENDER, ATTACKER, 1n]),
      });
    }))).rejects.toThrow(/deposit recipient does not match/);
  });

  it('R5 rejects two deposits', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls.push({ ...mc.calls[3] });
    }))).rejects.toThrow(/deposit calldata is not decodable/);
  });

  it('R5b rejects an extra call to an attacker contract, which is the inner-target allowlist', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls.push({ target: ATTACKER, allowFailure: false, value: 0n, callData: '0x' });
    }))).rejects.toThrow(/deposit target is not allowlisted/);
  });

  it('R5c rejects allowFailure on the deposit', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls[3].allowFailure = true;
    }))).rejects.toThrow(/deposit calldata is not decodable/);
  });

  it('R6 rejects refundTo and nftRecipient set to the attacker', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.refundTo = ATTACKER;
      mc.nftRecipient = ATTACKER;
    }))).rejects.toThrow(/refund recipient does not match/);
  });

  it('R7a rejects withdraw of amountIn minus one', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      mc.calls[1].callData = WETH.encodeFunctionData('withdraw', [ETH_IN - 1n]);
    }))).rejects.toThrow(/deposit amount does not match/);
  });

  it('R7b rejects cleanupNativeViaCall of amountIn minus one', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      const cleaned = ROUTER.decodeFunctionData('cleanupNativeViaCall', mc.calls[3].callData);
      mc.calls[3].callData = ROUTER.encodeFunctionData('cleanupNativeViaCall', [ETH_IN - 1n, cleaned.to, cleaned.data]);
    }))).rejects.toThrow(/deposit amount does not match/);
  });

  it('R7c rejects a direct depositNative whose value is amountIn minus one', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      const cleaned = ROUTER.decodeFunctionData('cleanupNativeViaCall', mc.calls[3].callData);
      const native = NATIVE.decodeFunctionData('depositNative', String(cleaned.data));
      mc.calls[3] = {
        target: RELAY_DEPOSITORY,
        allowFailure: false,
        value: ETH_IN - 1n,
        callData: NATIVE.encodeFunctionData('depositNative', [SENDER, native.id]),
      };
    }))).rejects.toThrow(/deposit amount does not match/);
  });

  it('R7d rejects a non-zero top-level transaction value', async () => {
    const body = usdc();
    txOf(body, 'deposit').value = '1';
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit value must be zero/);
  });

  it('R8 rejects an inner depositNative whose depositor is zero, which is the depositor check', async () => {
    await expect(relayQuoteOf(weth((mc) => {
      const cleaned = ROUTER.decodeFunctionData('cleanupNativeViaCall', mc.calls[3].callData);
      const native = NATIVE.decodeFunctionData('depositNative', String(cleaned.data));
      const inner = NATIVE.encodeFunctionData('depositNative', [ZERO, native.id]);
      mc.calls[3].callData = ROUTER.encodeFunctionData('cleanupNativeViaCall', [cleaned.amount, cleaned.to, inner]);
    }))).rejects.toThrow(/deposit depositor does not match/);
  });

  it('R9 rejects a deposit id that is not the order id', async () => {
    const body = usdc();
    setErc20(body, SENDER, USDC_IN, `0x${'ab'.repeat(32)}`);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit id does not match/);
  });

  it('R10 rejects an order payment to the attacker', async () => {
    const body = usdc();
    const protocol = body.protocol as { v2: { orderData: { output: { payments: Array<{ recipient: string }> } } } };
    protocol.v2.orderData.output.payments[0].recipient = ATTACKER;
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit recipient does not match/);
  });

  it('R11 rejects a value self-call plus a 1-unit depositErc20', async () => {
    const body = usdc();
    const token = LEGS[2].src.address;
    const id = orderOf(body);
    const inner = ERC20.encodeFunctionData('depositErc20', [SENDER, token, 1n, id]);
    const via = ROUTER.encodeFunctionData('cleanupErc20sViaCall', [[token], [RELAY_DEPOSITORY], [inner], [1n]]);
    txOf(body, 'deposit').to = RELAY_PROXY_V32;
    txOf(body, 'deposit').data = MULTICALL.encodeFunctionData('transferAndMulticall', [
      [token],
      [USDC_IN],
      [
        [RELAY_ROUTER_V32, false, USDC_IN, '0x'],
        [RELAY_ROUTER_V32, false, 0n, via],
      ],
      SENDER,
      SENDER,
      '0x',
    ]);
    setApproval(body, RELAY_PROXY_V32, USDC_IN);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit calldata is not decodable/);
  });

  it('R11b rejects cleanupErc20sViaCall of amountIn because that sequence is not allowlisted', async () => {
    const body = usdc();
    const token = LEGS[2].src.address;
    const id = orderOf(body);
    const inner = ERC20.encodeFunctionData('depositErc20', [SENDER, token, USDC_IN, id]);
    const via = ROUTER.encodeFunctionData('cleanupErc20sViaCall', [[token], [RELAY_DEPOSITORY], [inner], [USDC_IN]]);
    txOf(body, 'deposit').to = RELAY_PROXY_V32;
    txOf(body, 'deposit').data = MULTICALL.encodeFunctionData('transferAndMulticall', [
      [token],
      [USDC_IN],
      [[RELAY_ROUTER_V32, false, 0n, via]],
      SENDER,
      SENDER,
      '0x',
    ]);
    setApproval(body, RELAY_PROXY_V32, USDC_IN);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit calldata is not decodable/);
  });

  it('R12 rejects a direct depositErc20 whose depositor is the attacker, which is the depositor check', async () => {
    const body = usdc();
    setErc20(body, ATTACKER, USDC_IN);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit depositor does not match/);
  });

  it('R12b rejects a direct depositErc20 whose amount is amountIn minus one', async () => {
    const body = usdc();
    setErc20(body, SENDER, USDC_IN - 1n);
    setApproval(body, RELAY_DEPOSITORY, USDC_IN - 1n);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/deposit amount does not match/);
  });

  it('rejects a Relay maximum approval to the depository', async () => {
    const body = usdc();
    setApproval(body, RELAY_DEPOSITORY, MAX);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/approval does not match the deposit/);
  });

  it('rejects a Relay approval to the proxy while the depository pulls, which is the spender check', async () => {
    const body = usdc();
    setApproval(body, RELAY_PROXY_V32, USDC_IN);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/approval spender/);
  });

  it('rejects a Relay approval to the v3 proxy while the deposit is the v3.2 proxy', async () => {
    const body = weth();
    setApproval(body, RELAY_PROXY_V3, ETH_IN);
    await expect(relayQuoteOf(body)).rejects.toThrow(/approval spender/);
  });

  it('rejects an exact Relay approval to the attacker, which is the spender check', async () => {
    const body = usdc();
    setApproval(body, ATTACKER, USDC_IN);
    await expect(relayQuoteOf(body, LEGS[2])).rejects.toThrow(/approval spender/);
  });

  it('rejects an Across approval whose spender is the spoke while the deposit target differs', async () => {
    const h = harness();
    const body = live('across-usdc-1-4663.json') as { swapTx: { to: string } };
    body.swapTx.to = ACROSS_PERIPHERY;
    h.queue.push(body);
    const req = { ...requestOf(LEGS[2]), recipient: SENDER, sameAsset: false };
    await expect(h.clients.across.quote(req)).rejects.toThrow(/approval spender/);
    expect(ACROSS_SPOKE[1]).not.toBe(ACROSS_PERIPHERY);
  });

  it('rewrites an Across maximum approval to the exact pull', async () => {
    const h = harness();
    h.queue.push(live('across-usdc-1-4663.json'));
    const req = { ...requestOf(LEGS[2]), recipient: SENDER, sameAsset: false };
    const quote = await h.clients.across.quote(req);
    const decoded = decodeDeposit('across', quote.deposit.data, req, quote.deposit.to);
    const [spender, amount] = APPROVE.decodeFunctionData('approve', quote.approval!.data);
    expect(amount).toBe(decoded.pullAmount);
    expect(amount).not.toBe(MAX);
    expect(getAddress(String(spender))).toBe(getAddress(quote.deposit.to));
  });

  it('rejects a Li.Fi approval target that is the attacker', async () => {
    const h = harness();
    const body = live('lifi-usdc-1-4663.json') as { estimate: { approvalAddress: string } };
    body.estimate.approvalAddress = ATTACKER;
    h.queue.push(body);
    const req = { ...requestOf(LEGS[2]), recipient: SENDER, sameAsset: false };
    await expect(h.clients.lifi.quote(req)).rejects.toThrow(/approval spender|not the Li\.Fi diamond|allowlisted/);
  });
});
