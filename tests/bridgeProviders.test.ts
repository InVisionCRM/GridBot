import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Interface, getAddress } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACROSS_API, ACROSS_SPOKE, DEFAULT_LIMITS, LIFI_API, LIFI_DIAMOND, RELAY_API,
  assertQuoteMatches,   createBridgeProviders, createFetchHttp, filterByEta, lifiFeeAmount, withinEta,
  type BridgeId, type BridgeQuote, type HttpClient,
} from '../src/server/bridge';
import { BridgeError } from '../src/server/bridge/errors';
import {
  ETH_CAPITAL, ETH_DEST_GAS, ETH_IN, ETH_LP, ETH_OUT, FILL_TX, LEGS, NOW_MS, NOW_SEC, ORIGIN_GAS,
  OTHER, RECIPIENT, RELAYER, REQUEST_ID, SENDER, USDC_CAPITAL, USDC_DEST_GAS, USDC_IN, USDC_LP, USDC_MIN, USDC_OUT,
  WETH_ETH, WETH_HOOD, acrossSuggested, acrossSwap, lifiQuote, relayQuote, requestOf,
  type Leg,
} from './fixtures/bridgeFixtures';

const DEPOSIT = new Interface([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
]);
const APPROVE = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);

const KEY = 'BridgeTestKeyDoNotLeak0123456789abcd';

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
type Queued = { status: number; body: unknown; retryAfterMs: number | null } | { error: string };

function ok(body: unknown): Queued {
  return { status: 200, body, retryAfterMs: null };
}

function harness(keys?: { across?: string; relay?: string; lifi?: string }) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const queue: Queued[] = [];
  let t = NOW_MS;
  const http: HttpClient = async (req) => {
    calls.push({ url: req.url, method: req.method, headers: { ...req.headers }, body: req.body });
    const next = queue.shift();
    if (!next) return { status: 599, body: { message: 'fixture miss' }, retryAfterMs: null };
    if ('error' in next) throw new Error(next.error);
    return next;
  };
  const clients = createBridgeProviders({
    keys,
    http,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); },
    log: (_level, msg) => { logs.push(msg); },
  });
  return { clients, calls, sleeps, logs, queue, advance: (ms: number) => { t += ms; } };
}

function bodyFor(id: BridgeId, leg: Leg): unknown {
  if (id === 'across') return leg.sameAsset ? acrossSuggested(leg) : acrossSwap(leg);
  if (id === 'relay') return relayQuote(leg);
  return lifiQuote(leg);
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('live network is not allowed in tests')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bridge quote normalization', () => {
  it('normalizes ETH and USDC to USDG, both directions, for each provider', async () => {
    const h = harness();
    for (const id of ['across', 'relay', 'lifi'] as const) {
      for (const leg of LEGS) {
        h.queue.push(ok(bodyFor(id, leg)));
        const quote = await h.clients[id].quote(requestOf(leg));
        expect(quote.provider).toBe(id);
        expect(quote.discoveryOnly).toBe(id === 'lifi');
        expect(quote.srcChain).toBe(leg.src.chainId);
        expect(quote.dstChain).toBe(leg.dst.chainId);
        expect(quote.tokenIn.address).toBe(leg.src.address);
        expect(quote.tokenOut.address).toBe(leg.dst.address);
        expect(quote.amountIn).toBe(leg.amountIn);
        expect(quote.recipient).toBe(RECIPIENT);
        expect(quote.sender).toBe(SENDER);
        expect(quote.deposit.chainId).toBe(leg.src.chainId);
        expect(quote.deposit.value).toBe(0n);
        expect(quote.deposit.data.startsWith('0x')).toBe(true);
        expect(quote.approval).not.toBeNull();
        expect(quote.approval!.to).toBe(leg.src.address);
        expect(quote.approval!.value).toBe(0n);
        expect(quote.minOut <= quote.amountOut).toBe(true);
        expect(quote.eta.p90Sec).toBeGreaterThan(0);
        expect(quote.expiresAt).toBeGreaterThan(NOW_SEC);
        if (leg.sameAsset) {
          expect(quote.amountOut).toBe(ETH_OUT);
          expect(quote.amountOut < quote.amountIn).toBe(true);
        } else {
          expect(quote.amountOut).toBe(USDC_OUT);
          expect(quote.minOut).toBe(USDC_MIN);
        }
        if (id === 'across' && leg.sameAsset) {
          expect(quote.fees.bridge.amount).toBe(ETH_LP);
          expect(quote.fees.bridge.label).toBe('lp');
          expect(quote.fees.relayer.amount).toBe(ETH_CAPITAL);
          expect(quote.fees.relayer.label).toBe('relayer-capital');
          expect(quote.fees.destinationGas?.amount).toBe(ETH_DEST_GAS);
          expect(quote.fees.sourceGas.amount).toBe(0n);
          expect(quote.fees.sourceGas.label).toBe('source-gas-unpriced');
          expect(quote.deposit.to).toBe(ACROSS_SPOKE[leg.src.chainId]);
          const decoded = DEPOSIT.decodeFunctionData('depositV3', quote.deposit.data);
          expect(getAddress(String(decoded[0]))).toBe(SENDER);
          expect(getAddress(String(decoded[1]))).toBe(RECIPIENT);
          expect(getAddress(String(decoded[2]))).toBe(leg.src.address);
          expect(getAddress(String(decoded[3]))).toBe(leg.dst.address);
          expect(decoded[4]).toBe(leg.amountIn);
          expect(decoded[5]).toBe(ETH_OUT);
          expect(decoded[6]).toBe(BigInt(leg.dst.chainId));
          expect(getAddress(String(decoded[7]))).toBe(RELAYER);
          const [spender, amount] = APPROVE.decodeFunctionData('approve', quote.approval!.data);
          expect(getAddress(String(spender))).toBe(ACROSS_SPOKE[leg.src.chainId]);
          expect(amount).toBe(leg.amountIn);
          expect(h.calls.at(-1)!.url).toContain('/suggested-fees');
        }
        if (id === 'across' && !leg.sameAsset) {
          expect(quote.fees.bridge.amount).toBe(USDC_LP);
          expect(quote.fees.relayer.amount).toBe(USDC_CAPITAL);
          expect(quote.fees.destinationGas?.amount).toBe(USDC_DEST_GAS);
          expect(quote.fees.sourceGas.amount).toBe(ORIGIN_GAS);
          expect(quote.deposit.gasLimit).toBe(250_000n);
          expect(h.calls.at(-1)!.url).toContain('/swap/approval');
          const [spender, amount] = APPROVE.decodeFunctionData('approve', quote.approval!.data);
          expect(getAddress(String(spender))).toBe(OTHER);
          expect(amount).toBe(leg.amountIn);
        }
        if (id === 'relay') {
          expect(quote.fees.relayer.label).toBe('solver');
          expect(quote.fees.relayer.amount).toBe(leg.sameAsset ? ETH_CAPITAL : USDC_CAPITAL);
          expect(quote.fees.bridge.amount).toBe(1_000n);
          expect(quote.fees.sourceGas.amount).toBe(ORIGIN_GAS);
          expect(quote.fees.destinationGas?.amount).toBe(leg.sameAsset ? ETH_DEST_GAS : USDC_DEST_GAS);
          expect(quote.expiresAt).toBe(NOW_SEC + 60);
          expect(quote.quoteId).toBe(REQUEST_ID);
          expect(h.calls.at(-1)!.method).toBe('POST');
          expect(h.calls.at(-1)!.url).toBe(`${RELAY_API}/quote`);
        }
        if (id === 'lifi') {
          expect(quote.fees.bridge.label).toBe('lifi-0.25%');
          expect(quote.fees.bridge.amount).toBe(lifiFeeAmount(leg.amountIn));
          expect(quote.fees.relayer.amount).toBe(leg.sameAsset ? ETH_CAPITAL : USDC_CAPITAL);
          expect(quote.fees.sourceGas.amount).toBe(ORIGIN_GAS);
          expect(quote.fees.destinationGas).toBeNull();
          expect(quote.deposit.to).toBe(getAddress(LIFI_DIAMOND));
          const [spender, amount] = APPROVE.decodeFunctionData('approve', quote.approval!.data);
          expect(getAddress(String(spender))).toBe(getAddress(LIFI_DIAMOND));
          expect(amount).toBe(leg.amountIn);
          expect(h.calls.at(-1)!.url.startsWith(`${LIFI_API}/quote`)).toBe(true);
        }
      }
    }
    for (const call of h.calls) {
      expect(call.url.startsWith(ACROSS_API) || call.url.startsWith(RELAY_API) || call.url.startsWith(LIFI_API)).toBe(true);
      expect(call.url.includes('?')).toBe(idHasQuery(call));
    }
  });

  it('notes the 0.25% Li.Fi fee when the body omits the line', async () => {
    const h = harness();
    const leg = LEGS[2];
    h.queue.push(ok(lifiQuote(leg, { omitLifiFee: true })));
    const quote = await h.clients.lifi.quote(requestOf(leg));
    expect(quote.fees.bridge.label).toBe('lifi-0.25%');
    expect(quote.fees.bridge.amount).toBe(lifiFeeAmount(USDC_IN));
    expect(quote.fees.bridge.amount).toBe(25_000n);
  });
});

function idHasQuery(call: Call): boolean {
  return call.method === 'GET';
}

describe('bridge status', () => {
  const origin = { provider: 'across' as const, originChainId: 1, depositId: '42' };

  it('maps Across pending, filled, expired, and refunded', async () => {
    const h = harness();
    const cases: Array<[unknown, { state: string; final: boolean; awaitingRefund: boolean }]> = [
      [{ status: 'pending', originChainId: 1, depositId: '42' }, { state: 'pending', final: false, awaitingRefund: false }],
      [{ status: 'filled', originChainId: 1, depositId: '42', fillTx: FILL_TX }, { state: 'filled', final: true, awaitingRefund: false }],
      [{ status: 'expired', originChainId: 1, depositId: '42' }, { state: 'expired', final: false, awaitingRefund: true }],
      [{ status: 'refunded', originChainId: 1, depositId: '42', depositRefundTxHash: FILL_TX }, { state: 'refunded', final: true, awaitingRefund: false }],
    ];
    for (const [body, want] of cases) {
      h.queue.push(ok(body));
      const st = await h.clients.across.status(origin);
      expect(st.state).toBe(want.state);
      expect(st.final).toBe(want.final);
      expect(st.awaitingRefund).toBe(want.awaitingRefund);
      if (want.state === 'expired') expect(st.detail).toBe('awaiting refund');
      if (want.state === 'refunded') expect(st.refundTx).toBe(FILL_TX);
    }
    expect(h.calls.at(-1)!.url).toContain('/deposit/status');
    expect(h.calls.at(-1)!.url).toContain('depositId=42');
  });

  it('rejects an unknown Across status instead of guessing', async () => {
    const h = harness();
    h.queue.push(ok({ status: 'mystery', originChainId: 1, depositId: '42' }));
    await expect(h.clients.across.status(origin)).rejects.toThrow(/status is missing/);
  });

  it('maps Relay progress, and treats only success and refund as final', async () => {
    const h = harness();
    const q = { provider: 'relay' as const, originChainId: 1, depositId: REQUEST_ID };
    for (const status of ['waiting', 'depositing', 'pending', 'submitted', 'delayed']) {
      h.queue.push(ok({ status }));
      const st = await h.clients.relay.status(q);
      expect(st.state).toBe('pending');
      expect(st.final).toBe(false);
    }
    h.queue.push(ok({ status: 'success', txHashes: [FILL_TX] }));
    const filled = await h.clients.relay.status(q);
    expect(filled.state).toBe('filled');
    expect(filled.final).toBe(true);
    expect(filled.fillTx).toBe(FILL_TX);

    h.queue.push(ok({ status: 'refund', txHashes: [FILL_TX] }));
    const refunded = await h.clients.relay.status(q);
    expect(refunded.state).toBe('refunded');
    expect(refunded.final).toBe(true);
    expect(refunded.refundTx).toBe(FILL_TX);

    h.queue.push(ok({ status: 'failure', failReason: 'SLIPPAGE' }));
    const failed = await h.clients.relay.status(q);
    expect(failed.state).toBe('failed');
    expect(failed.final).toBe(false);
    expect(failed.detail).toContain('may still retry');
    expect(failed.detail).toContain('SLIPPAGE');
    expect(h.calls.at(-1)!.url).toContain('/intents/status/v3');
  });

  it('maps Li.Fi DONE, PARTIAL, refund, and failure', async () => {
    const h = harness();
    const q = { provider: 'lifi' as const, originChainId: 1, destinationChainId: 4663, txHash: FILL_TX };
    const receiving = {
      amount: ETH_OUT.toString(),
      chainId: 4663,
      token: { address: WETH_HOOD.address, decimals: 18, chainId: 4663 },
    };
    h.queue.push(ok({ status: 'NOT_FOUND', transactionId: 'tx-1' }));
    expect((await h.clients.lifi.status(q)).state).toBe('pending');

    h.queue.push(ok({ status: 'PENDING', substatus: 'WAIT_SOURCE_CONFIRMATIONS', transactionId: 'tx-1' }));
    expect((await h.clients.lifi.status(q)).final).toBe(false);

    h.queue.push(ok({ status: 'DONE', substatus: 'COMPLETED', transactionId: 'tx-1', receiving }));
    const filled = await h.clients.lifi.status(q);
    expect(filled.state).toBe('filled');
    expect(filled.final).toBe(true);
    expect(filled.received?.token).toBe(WETH_HOOD.address);
    expect(filled.received?.amount).toBe(ETH_OUT);

    h.queue.push(ok({ status: 'DONE', substatus: 'PARTIAL', transactionId: 'tx-1', receiving }));
    const partial = await h.clients.lifi.status(q);
    expect(partial.state).toBe('partial');
    expect(partial.final).toBe(true);
    expect(partial.detail).toBe('different token arrived');
    expect(partial.received).toEqual({ token: WETH_HOOD.address, amount: ETH_OUT, chainId: 4663, decimals: 18 });

    h.queue.push(ok({ status: 'DONE', substatus: 'REFUNDED', transactionId: 'tx-1' }));
    expect((await h.clients.lifi.status(q)).state).toBe('refunded');

    h.queue.push(ok({ status: 'FAILED', transactionId: 'tx-1' }));
    const failed = await h.clients.lifi.status(q);
    expect(failed.state).toBe('failed');
    expect(failed.final).toBe(true);

    h.queue.push(ok({ status: 'DONE', transactionId: 'tx-1' }));
    await expect(h.clients.lifi.status(q)).rejects.toThrow(/substatus is missing/);

    h.queue.push(ok({ status: 'DONE', substatus: 'PARTIAL', transactionId: 'tx-1' }));
    await expect(h.clients.lifi.status(q)).rejects.toThrow(/received token is missing/);
    expect(h.calls[0].url).toContain('/status');
    expect(h.calls[0].url).toContain('fromChain=1');
    expect(h.calls[0].url).toContain('toChain=4663');
  });
});

describe('quote cache, rate limit, and retries', () => {
  it('serves a second quote from the 60s cache and refetches after the ttl or the expiry', async () => {
    const h = harness();
    const leg = LEGS[0];
    h.queue.push(ok(acrossSuggested(leg)));
    h.queue.push(ok(acrossSuggested(leg)));
    const first = await h.clients.across.quote(requestOf(leg));
    const second = await h.clients.across.quote(requestOf(leg));
    expect(second).toBe(first);
    expect(h.calls).toHaveLength(1);
    h.advance(60_000);
    await h.clients.across.quote(requestOf(leg));
    expect(h.calls).toHaveLength(2);

    const swapLeg = LEGS[2];
    // The clock has already moved 60s. The first swap quote expires one second after that.
    h.queue.push(ok(acrossSwap(swapLeg, { quoteExpiryTimestamp: NOW_SEC + 61 })));
    h.queue.push(ok(acrossSwap(swapLeg, { quoteExpiryTimestamp: NOW_SEC + 500 })));
    await h.clients.across.quote(requestOf(swapLeg));
    h.advance(2_000);
    await h.clients.across.quote(requestOf(swapLeg));
    expect(h.calls).toHaveLength(4);
  });

  it('does not cache a quote the parser rejected', async () => {
    const h = harness();
    const leg = LEGS[0];
    const bad = acrossSuggested(leg) as { outputAmount?: string };
    delete bad.outputAmount;
    h.queue.push(ok(bad));
    h.queue.push(ok(acrossSuggested(leg)));
    await expect(h.clients.across.quote(requestOf(leg))).rejects.toThrow(/amountOut is missing/);
    const quote = await h.clients.across.quote(requestOf(leg));
    expect(quote.amountOut).toBe(ETH_OUT);
    expect(h.calls).toHaveLength(2);
  });

  it('stops Li.Fi at 30 requests per 2 hours and leaves Across and Relay on the conservative default', async () => {
    expect(DEFAULT_LIMITS.lifi).toEqual({ max: 30, windowMs: 2 * 60 * 60 * 1000 });
    expect(DEFAULT_LIMITS.across).toEqual({ max: 20, windowMs: 60_000 });
    expect(DEFAULT_LIMITS.relay).toEqual({ max: 20, windowMs: 60_000 });
    const h = harness();
    const leg = LEGS[2];
    for (let i = 0; i < 30; i++) {
      const amount = USDC_IN + BigInt(i);
      const one = { ...leg, amountIn: amount };
      h.queue.push(ok(lifiQuote(one)));
      const quote = await h.clients.lifi.quote(requestOf(one));
      expect(quote.fees.bridge.amount).toBe(lifiFeeAmount(amount));
    }
    expect(h.calls).toHaveLength(30);
    const extra = { ...leg, amountIn: USDC_IN + 30n };
    await expect(h.clients.lifi.quote(requestOf(extra))).rejects.toThrow(/lifi: rate limit, 30 requests per 7200s/);
    expect(h.calls).toHaveLength(30);
  });

  it('retries 429 and 5xx with backoff and does not retry a 400', async () => {
    const h = harness();
    const leg = LEGS[0];
    const ask = () => h.clients.across.quote(requestOf(leg));
    h.queue.push({ status: 429, body: { message: 'slow down' }, retryAfterMs: 50 });
    h.queue.push(ok(acrossSuggested(leg)));
    expect((await ask()).amountOut).toBe(ETH_OUT);
    expect(h.sleeps).toEqual([50]);
    expect(h.calls).toHaveLength(2);

    h.advance(61_000);
    h.queue.push({ status: 500, body: { message: 'down' }, retryAfterMs: null });
    h.queue.push(ok(acrossSuggested(leg)));
    await ask();
    expect(h.sleeps).toEqual([50, 200]);

    h.advance(61_000);
    h.queue.push({ status: 400, body: { message: 'bad request' }, retryAfterMs: null });
    await expect(ask()).rejects.toThrow(/HTTP 400/);
    expect(h.sleeps).toEqual([50, 200]);
    expect(h.calls).toHaveLength(5);

    h.advance(61_000);
    for (let i = 0; i < 3; i++) h.queue.push({ status: 429, body: { message: 'later' }, retryAfterMs: null });
    await expect(ask()).rejects.toThrow(/HTTP 429/);
    expect(h.calls).toHaveLength(8);
    expect(h.sleeps).toEqual([50, 200, 200, 400]);
  });
});

describe('response validation', () => {
  it('rejects a mismatched chain, token, or recipient and a missing amount', async () => {
    const leg = LEGS[2];
    const h = harness();
    const swapped = acrossSwap(leg) as { outputToken: { address: string; chainId: number }; recipient: string; expectedOutputAmount?: string };
    swapped.outputToken = { ...swapped.outputToken, address: WETH_ETH.address };
    h.queue.push(ok(swapped));
    await expect(h.clients.across.quote(requestOf(leg))).rejects.toThrow(/token out does not match/);

    const chain = acrossSwap(leg) as { outputToken: { chainId: number } };
    chain.outputToken = { ...chain.outputToken, chainId: 1 };
    h.queue.push(ok(chain));
    await expect(h.clients.across.quote(requestOf(leg))).rejects.toThrow(/token out|destination chain|not a supported chain/);

    const who = acrossSwap(leg) as { recipient: string };
    who.recipient = OTHER;
    h.queue.push(ok(who));
    await expect(h.clients.across.quote(requestOf(leg))).rejects.toThrow(/recipient does not match/);

    const relay = relayQuote(leg) as { details: { recipient: string } };
    relay.details.recipient = OTHER;
    h.queue.push(ok(relay));
    await expect(h.clients.relay.quote(requestOf(leg))).rejects.toThrow(/recipient does not match/);

    const lifi = lifiQuote(leg) as { action: { toAddress: string } };
    lifi.action.toAddress = OTHER;
    h.queue.push(ok(lifi));
    await expect(h.clients.lifi.quote(requestOf(leg))).rejects.toThrow(/recipient does not match/);

    const missing = acrossSuggested(LEGS[0]) as { outputAmount?: string };
    delete missing.outputAmount;
    h.queue.push(ok(missing));
    await expect(h.clients.across.quote(requestOf(LEGS[0]))).rejects.toThrow(/amountOut is missing/);
  });

  it('rejects a same-asset output above the 1 bp tolerance, including a decimal scale change', () => {
    const req = requestOf(LEGS[0]);
    const quote = baseQuote(req);
    expect(() => assertQuoteMatches(req, { ...quote, amountOut: ETH_IN + ETH_IN / 10_000n, minOut: ETH_IN }, NOW_MS)).not.toThrow();
    expect(() => assertQuoteMatches(req, { ...quote, amountOut: ETH_IN + ETH_IN / 5_000n, minOut: ETH_IN }, NOW_MS)).toThrow(/same-asset output exceeds the input/);

    const one = 10n ** 18n;
    const oddOut = { ...WETH_HOOD, decimals: 6 };
    const oddReq = { ...req, amountIn: one, tokenOut: oddOut };
    const oneBp = baseQuote(oddReq);
    oneBp.amountOut = 1_000_100n;
    oneBp.minOut = 1_000_100n;
    expect(() => assertQuoteMatches(oddReq, oneBp, NOW_MS)).not.toThrow();
    const twoBp = { ...oneBp, amountOut: 1_000_200n, minOut: 1_000_200n };
    expect(() => assertQuoteMatches(oddReq, twoBp, NOW_MS)).toThrow(/same-asset output exceeds the input/);
  });

  it('rejects a Relay same-asset quote that pays more than was deposited', async () => {
    const h = harness();
    const leg = LEGS[0];
    h.queue.push(ok(relayQuote(leg, { amountOut: ETH_IN * 2n, minOut: ETH_IN * 2n })));
    await expect(h.clients.relay.quote(requestOf(leg))).rejects.toThrow(/same-asset output exceeds the input/);
  });

  it('rejects a poisoned spoke, a failed simulation, a Li.Fi fee that is not 0.25%, and a non-diamond deposit', async () => {
    const h = harness();
    const eth = LEGS[0];
    const usd = LEGS[2];
    const poisoned = acrossSuggested(eth) as { spokePoolAddress: string };
    poisoned.spokePoolAddress = OTHER;
    h.queue.push(ok(poisoned));
    await expect(h.clients.across.quote(requestOf(eth))).rejects.toThrow(/spoke pool does not match/);

    const low = acrossSuggested(eth) as { isAmountTooLow: boolean };
    low.isAmountTooLow = true;
    h.queue.push(ok(low));
    await expect(h.clients.across.quote(requestOf(eth))).rejects.toThrow(/below the route minimum/);

    const sim = acrossSwap(usd) as { swapTx: { simulationSuccess: boolean } };
    sim.swapTx.simulationSuccess = false;
    h.queue.push(ok(sim));
    await expect(h.clients.across.quote(requestOf(usd))).rejects.toThrow(/swap simulation failed/);

    h.queue.push(ok(lifiQuote(usd, { percentage: '0.01', feeAmount: lifiFeeAmount(USDC_IN) })));
    await expect(h.clients.lifi.quote(requestOf(usd))).rejects.toThrow(/fee is not 0\.25%/);

    h.queue.push(ok(lifiQuote(usd, { feeAmount: 1n })));
    await expect(h.clients.lifi.quote(requestOf(usd))).rejects.toThrow(/fee amount does not match 0\.25%/);

    h.queue.push(ok(lifiQuote(usd, { diamond: OTHER })));
    await expect(h.clients.lifi.quote(requestOf(usd))).rejects.toThrow(/Li\.Fi diamond/);

    h.queue.push(ok({ ...acrossSwap(usd), expectedOutputAmount: '1e6' }));
    await expect(h.clients.across.quote(requestOf(usd))).rejects.toThrow(/amountOut is missing/);
  });
});

describe('quote keys stay out of urls, logs, and errors', () => {
  it('sends each key only as a header and strips it from failures', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ across: KEY, relay: KEY, lifi: KEY });
    const leak = `nope https://app.across.to/api/suggested-fees?apiKey=${KEY} auth ${KEY}`;
    h.queue.push({ error: leak });
    const err = await h.clients.across.quote(requestOf(LEGS[0])).then(() => { throw new Error('expected a failure'); }, (e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeError);
    const blob = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    expect(blob).not.toContain(KEY);
    expect((err as Error).message).not.toContain('?');
    expect((err as Error).message).toContain('[REDACTED]');
    expect((err as Error).message).toContain('app.across.to/api/suggested-fees');
    expect(h.logs.join('\n')).not.toContain(KEY);
    expect(h.calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(h.calls[0].url).not.toContain(KEY);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();

    h.queue.push({ error: leak });
    await expect(h.clients.relay.quote(requestOf(LEGS[2]))).rejects.toThrow();
    expect(h.calls.at(-1)!.headers['x-api-key']).toBe(KEY);
    expect(h.calls.at(-1)!.body ?? '').not.toContain(KEY);
    expect(h.calls.at(-1)!.url).not.toContain(KEY);

    h.queue.push({ error: leak });
    await expect(h.clients.lifi.quote(requestOf(LEGS[2]))).rejects.toThrow();
    expect(h.calls.at(-1)!.headers['x-lifi-api-key']).toBe(KEY);
    expect(h.calls.at(-1)!.url).not.toContain(KEY);

    h.queue.push(ok({ status: 'failure', failReason: `solver said ${KEY}` }));
    const st = await h.clients.relay.status({ provider: 'relay', originChainId: 1, depositId: REQUEST_ID });
    expect(st.detail).not.toContain(KEY);
    expect(st.detail).toContain('[REDACTED]');
    expect(st.final).toBe(false);

    const plain = harness();
    plain.queue.push(ok(acrossSuggested(LEGS[0])));
    await plain.clients.across.quote(requestOf(LEGS[0]));
    expect(plain.calls[0].headers.Authorization).toBeUndefined();
  });

  it('rejects a quote key that is not a single header token, without echoing it', () => {
    expect(() => createBridgeProviders({ keys: { across: 'bad key value' }, http: async () => ({ status: 500, body: null, retryAfterMs: null }) })).toThrow(/^across: quote key was rejected$/);
  });
});

describe('ETA filter', () => {
  it('compares p90 with maxEta and ignores a faster p50', () => {
    expect(withinEta({ p50Sec: 10, p90Sec: 100 }, 60)).toBe(false);
    expect(withinEta({ p50Sec: 100, p90Sec: 60 }, 60)).toBe(true);
    expect(withinEta({ p50Sec: 1, p90Sec: 60 }, 60)).toBe(true);
    expect(withinEta({ p50Sec: 1, p90Sec: Number.NaN }, 60)).toBe(false);
    expect(() => withinEta({ p50Sec: 1, p90Sec: 1 }, -1)).toThrow(/maxEta must be a non-negative number of seconds/);
    const slow = { eta: { p50Sec: 5, p90Sec: 120 } };
    const fast = { eta: { p50Sec: 80, p90Sec: 90 } };
    expect(filterByEta([slow, fast], 90)).toEqual([fast]);
  });
});

describe('bridge module boundaries', () => {
  it('does not read the environment, name quote-key variables, or send a transaction', () => {
    const dir = join(__dirname, '../src/server/bridge');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      expect(code, f).not.toMatch(/process\.env/);
      expect(code, f).not.toMatch(/sendTransaction|eth_sendRawTransaction|new\s+Wallet/);
      expect(code, f).not.toMatch(/ACROSS_API_KEY|RELAY_API_KEY|LIFI_API_KEY/);
    }
  });

  it('parses a fetch response without keeping the URL from a transport error', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      return new Response(JSON.stringify({ ok: true }), { status: 429, headers: { 'retry-after': '2' } });
    });
    const http = createFetchHttp(fetchImpl as unknown as typeof fetch, 1_000);
    const res = await http({ url: 'https://example.test/quote', method: 'GET', headers: {} });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ ok: true });
    expect(res.retryAfterMs).toBe(2_000);

    const boom = vi.fn(async () => { throw new Error(`connect ${KEY} https://li.quest/v1/quote?x=${KEY}`); });
    const failing = createFetchHttp(boom as unknown as typeof fetch, 1_000);
    await expect(failing({ url: 'https://li.quest/v1/quote', method: 'GET', headers: {} })).rejects.toThrow(/^network request failed$/);

    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const slow = vi.fn(async () => { throw timeout; });
    const timing = createFetchHttp(slow as unknown as typeof fetch, 1_000);
    await expect(timing({ url: 'https://li.quest/v1/quote', method: 'GET', headers: {} })).rejects.toThrow(/^timed out$/);
  });
});

function baseQuote(req: ReturnType<typeof requestOf>): BridgeQuote {
  const fee = { amount: 0n, decimals: req.tokenIn.decimals, token: req.tokenIn.address, chainId: req.srcChain, label: 'lp' };
  return {
    provider: 'relay',
    srcChain: req.srcChain,
    dstChain: req.dstChain,
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    amountIn: req.amountIn,
    amountOut: req.amountIn,
    minOut: req.amountIn,
    fees: {
      bridge: { ...fee, label: 'app' },
      relayer: { ...fee, label: 'solver' },
      sourceGas: { ...fee, label: 'source-gas' },
      destinationGas: null,
    },
    eta: { p50Sec: 5, p90Sec: 5 },
    expiresAt: NOW_SEC + 30,
    approval: null,
    deposit: { chainId: req.srcChain, to: req.tokenIn.address, data: '0x12345678', value: 0n },
    quoteId: 'q',
    recipient: req.recipient,
    sender: req.sender,
    discoveryOnly: false,
    sameAsset: req.sameAsset,
  };
}
