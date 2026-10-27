import { QUOTE_HOLD_SEC } from './cache';
import type { BridgeDeps } from './deps';
import { baseHeaders, requestJson } from './http';
import { bad, fractionToBps, lifiFeeAmount, needAddress, needChain, needHex, needId, needInt, needPositive, needToken, needUint, needValue, normalizeRequest, normalizeStatusQuery, nowSec, quoteKey, sameAddress, tokensMatch } from './parse';
import type { BridgeProvider, BridgeQuote, BridgeQuoteRequest, BridgeStatus, BridgeStatusQuery, FeeComponent, ReceivedFill, UnsignedTx } from './types';
import { encodeApprove } from './tx';
import { assertQuoteMatches } from './validate';

/**
 * Li.Fi is discovery-only. GET /quote and GET /status never auto-select a route.
 * DONE + PARTIAL means the transfer finished in a different token than the one requested;
 * the status carries that token and amount. DONE + REFUNDED is a refund. FAILED is final.
 *
 * The 0.25% Li.Fi fee is always a bridge-fee line. When the body includes it, the amount
 * must match 0.25% of amountIn (1 raw unit of slack). When the body omits it, the line is
 * the computed 0.25%.
 *
 * An optional quote key is sent only as the `x-lifi-api-key` header.
 * The deposit must target the Li.Fi diamond. Anything else is rejected.
 */
export const LIFI_API = 'https://li.quest/v1';

/** Li.Fi Diamond. Same address on the EVM chains this desk uses. */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

const P = 'lifi';

export class LifiClient implements BridgeProvider {
  readonly id = 'lifi' as const;
  constructor(private readonly d: BridgeDeps) {}

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const norm = normalizeRequest(P, req);
    const key = quoteKey(this.id, norm);
    const hit = this.d.cache.get(key);
    if (hit) return hit;
    const params = new URLSearchParams({
      fromChain: String(norm.srcChain),
      toChain: String(norm.dstChain),
      fromToken: norm.tokenIn.address,
      toToken: norm.tokenOut.address,
      fromAmount: norm.amountIn.toString(),
      fromAddress: norm.sender,
      toAddress: norm.recipient,
      slippage: bpsFraction(norm.slippageBps ?? 50),
    });
    const body = asObj(await requestJson({
      provider: P,
      limiter: this.d.limiter,
      http: this.d.http,
      sleep: this.d.sleep,
      secrets: this.d.secrets,
      log: this.d.log,
      url: `${LIFI_API}/quote?${params}`,
      method: 'GET',
      headers: baseHeaders(this.d.key ? { name: 'x-lifi-api-key', value: this.d.key } : undefined),
    }));
    const quote = parseQuote(norm, body, nowSec(this.d.now()));
    assertQuoteMatches(norm, quote, this.d.now());
    this.d.cache.set(key, quote);
    return quote;
  }

  async status(q: BridgeStatusQuery): Promise<BridgeStatus> {
    const query = normalizeStatusQuery(P, q);
    if (!query.txHash) bad(P, 'status needs a transaction hash');
    if (query.destinationChainId == null) bad(P, 'destination chain is missing');
    const params = new URLSearchParams({
      txHash: query.txHash,
      fromChain: String(query.originChainId),
      toChain: String(query.destinationChainId),
    });
    const body = asObj(await requestJson({
      provider: P,
      limiter: this.d.limiter,
      http: this.d.http,
      sleep: this.d.sleep,
      secrets: this.d.secrets,
      log: this.d.log,
      url: `${LIFI_API}/status?${params}`,
      method: 'GET',
      headers: baseHeaders(this.d.key ? { name: 'x-lifi-api-key', value: this.d.key } : undefined),
    }));
    const status = typeof body.status === 'string' ? body.status : bad(P, 'status is missing');
    const sub = typeof body.substatus === 'string' ? body.substatus : '';
    const depositId = body.transactionId == null ? null : needId(P, body.transactionId, 'deposit id');
    if (status === 'NOT_FOUND') return base('pending', false, null, depositId, 'not indexed yet');
    if (status === 'PENDING') return base('pending', false, null, depositId, sub || 'pending');
    if (status === 'FAILED') return base('failed', true, null, depositId, 'failed');
    if (status !== 'DONE') bad(P, 'status is missing');
    if (sub === 'COMPLETED') return base('filled', true, readReceived(body.receiving, false), depositId, 'filled');
    if (sub === 'REFUNDED') return { ...base('refunded', true, readReceived(body.receiving, false), depositId, 'refunded'), refundTx: receivedTx(body.receiving) };
    if (sub === 'PARTIAL') {
      const received = readReceived(body.receiving, true);
      return base('partial', true, received, depositId, 'different token arrived');
    }
    bad(P, 'substatus is missing');
  }
}

function parseQuote(req: BridgeQuoteRequest, body: Record<string, unknown>, sec: number): BridgeQuote {
  const action = asObj(body.action);
  const fromChain = needChain(P, action.fromChainId, 'source chain');
  const toChain = needChain(P, action.toChainId, 'destination chain');
  if (fromChain !== req.srcChain) bad(P, 'source chain does not match');
  if (toChain !== req.dstChain) bad(P, 'destination chain does not match');
  const fromToken = needToken(P, action.fromToken, 'token in');
  const toToken = needToken(P, action.toToken, 'token out');
  if (!tokensMatch(fromToken, req.tokenIn)) bad(P, 'token in does not match');
  if (!tokensMatch(toToken, req.tokenOut)) bad(P, 'token out does not match');
  const sender = needAddress(P, action.fromAddress, 'sender');
  const recipient = needAddress(P, action.toAddress, 'recipient');
  if (!sameAddress(sender, req.sender)) bad(P, 'sender does not match');
  if (!sameAddress(recipient, req.recipient)) bad(P, 'recipient does not match');
  const estimate = asObj(body.estimate);
  if (needPositive(P, estimate.fromAmount, 'amountIn') !== req.amountIn) bad(P, 'amountIn does not match');
  const amountOut = needPositive(P, estimate.toAmount, 'amountOut');
  const minOut = needPositive(P, estimate.toAmountMin, 'minOut');
  const tx = asObj(body.transactionRequest);
  const txChain = needChain(P, tx.chainId, 'deposit chain');
  if (txChain !== req.srcChain) bad(P, 'deposit is not on the source chain');
  const to = needAddress(P, tx.to, 'deposit');
  if (!sameAddress(to, LIFI_DIAMOND)) bad(P, 'deposit is not the Li.Fi diamond');
  if (tx.from != null && !sameAddress(needAddress(P, tx.from, 'sender'), req.sender)) bad(P, 'sender does not match');
  const deposit: UnsignedTx = {
    chainId: req.srcChain,
    to,
    data: needHex(P, tx.data, 'deposit'),
    value: needValue(P, tx.value, 'deposit value'),
  };
  if (tx.gasLimit != null) deposit.gasLimit = needPositive(P, String(tx.gasLimit), 'gas');
  const approvalAddress = needAddress(P, estimate.approvalAddress, 'approval');
  const approval = encodeApprove(req.tokenIn.address, approvalAddress, req.amountIn, req.srcChain);
  const seconds = needInt(P, estimate.executionDuration, 'fill time', 0, 30 * 24 * 60 * 60);
  const fees = splitFees(estimate.feeCosts, estimate.gasCosts, req);
  return {
    provider: P,
    srcChain: req.srcChain,
    dstChain: req.dstChain,
    tokenIn: req.tokenIn,
    tokenOut: req.tokenOut,
    amountIn: req.amountIn,
    amountOut,
    minOut,
    fees,
    eta: { p50Sec: seconds, p90Sec: seconds },
    expiresAt: sec + QUOTE_HOLD_SEC,
    approval,
    deposit,
    quoteId: needId(P, body.id, 'quote id'),
    recipient: req.recipient,
    sender: req.sender,
    discoveryOnly: true,
    sameAsset: req.sameAsset,
  };
}

function splitFees(feeCosts: unknown, gasCosts: unknown, req: BridgeQuoteRequest): BridgeQuote['fees'] {
  const expected = lifiFeeAmount(req.amountIn);
  let bridge: FeeComponent | null = null;
  let relayerAmount = 0n;
  let relayerToken = req.tokenIn.address;
  let relayerDecimals = req.tokenIn.decimals;
  let relayerChain = req.srcChain;
  let sawOther = false;
  if (feeCosts != null) {
    if (!Array.isArray(feeCosts)) bad(P, 'bridge fee is missing');
    for (const row of feeCosts) {
      const o = asObj(row);
      const amount = needUint(P, o.amount, 'bridge fee');
      const token = needToken(P, o.token, 'bridge fee');
      const name = typeof o.name === 'string' ? o.name : '';
      const pct = o.percentage == null ? null : fractionToBps(P, o.percentage, 'bridge fee');
      const isLifi = pct === 25n || /lifi/i.test(name);
      if (isLifi) {
        if (bridge) bad(P, 'bridge fee is missing');
        if (pct != null && pct !== 25n) bad(P, 'fee is not 0.25%');
        if (token.decimals !== req.tokenIn.decimals || !sameAddress(token.address, req.tokenIn.address)) bad(P, 'fee is not 0.25%');
        const delta = amount > expected ? amount - expected : expected - amount;
        if (delta > 1n) bad(P, 'fee amount does not match 0.25%');
        bridge = { label: 'lifi-0.25%', amount, decimals: token.decimals, token: token.address, chainId: token.chainId };
      } else {
        if (sawOther && (token.chainId !== relayerChain || !sameAddress(token.address, relayerToken))) bad(P, 'relayer fee is missing');
        sawOther = true;
        relayerAmount += amount;
        relayerToken = token.address;
        relayerDecimals = token.decimals;
        relayerChain = token.chainId;
      }
    }
  }
  const gas = splitGas(gasCosts, req);
  return {
    bridge: bridge ?? { label: 'lifi-0.25%', amount: expected, decimals: req.tokenIn.decimals, token: req.tokenIn.address, chainId: req.srcChain },
    relayer: { label: 'solver', amount: relayerAmount, decimals: relayerDecimals, token: relayerToken, chainId: relayerChain },
    sourceGas: gas.source,
    destinationGas: gas.destination,
  };
}

function mergeFee(current: FeeComponent | null, next: FeeComponent, missing: string): FeeComponent {
  if (!current) return next;
  if (!sameAddress(current.token, next.token) || current.chainId !== next.chainId || current.decimals !== next.decimals) {
    bad(P, missing);
  }
  return {
    label: current.label,
    amount: current.amount + next.amount,
    decimals: current.decimals,
    token: current.token,
    chainId: current.chainId,
  };
}

function splitGas(v: unknown, req: BridgeQuoteRequest): { source: FeeComponent; destination: FeeComponent | null } {
  if (!Array.isArray(v) || v.length === 0) bad(P, 'source gas is missing');
  let source: FeeComponent | null = null;
  let destination: FeeComponent | null = null;
  for (const row of v) {
    const o = asObj(row);
    const amount = needUint(P, o.amount, 'source gas');
    const token = needToken(P, o.token, 'source gas');
    const type = typeof o.type === 'string' ? o.type.toUpperCase() : '';
    const dest = type === 'DESTINATION' || type === 'DEST' || (token.chainId === req.dstChain && type !== 'SEND');
    const component: FeeComponent = { label: dest ? 'destination-gas' : 'source-gas', amount, decimals: token.decimals, token: token.address, chainId: token.chainId };
    if (dest) {
      destination = mergeFee(destination, component, 'destination gas is missing');
    } else {
      if (token.chainId !== req.srcChain) bad(P, 'source gas is not on the source chain');
      source = mergeFee(source, component, 'source gas is missing');
    }
  }
  if (!source) bad(P, 'source gas is missing');
  return { source, destination };
}

function readReceived(v: unknown, required: boolean): ReceivedFill | null {
  if (v == null) {
    if (required) bad(P, 'received token is missing');
    return null;
  }
  const o = asObj(v);
  const token = needToken(P, o.token, 'received token');
  const amount = needPositive(P, o.amount, 'received amount');
  const chainId = o.chainId == null ? token.chainId : needChain(P, o.chainId, 'received chain');
  if (chainId !== token.chainId) bad(P, 'received token is missing');
  return { token: token.address, amount, chainId, decimals: token.decimals };
}

function receivedTx(v: unknown): string | null {
  if (v == null || typeof v !== 'object') return null;
  const hash = (v as { txHash?: unknown }).txHash;
  if (hash == null) return null;
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) bad(P, 'transaction hash is missing');
  return hash;
}

function base(state: BridgeStatus['state'], final: boolean, received: ReceivedFill | null, depositId: string | null, detail: string): BridgeStatus {
  return { provider: P, state, final, awaitingRefund: false, received, fillTx: null, refundTx: null, depositId, detail };
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(P, 'response is missing');
}

function bpsFraction(bps: number): string {
  const pad = String(bps).padStart(4, '0');
  const whole = pad.slice(0, -4) || '0';
  const frac = pad.slice(-4).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
