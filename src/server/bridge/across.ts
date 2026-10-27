import { Interface, getAddress } from 'ethers';
import type { BridgeDeps } from './deps';
import { baseHeaders, requestJson } from './http';
import { bad, needAddress, needHex, needId, needPositive, needToken, needUint, needUint32, needValue, normalizeRequest, normalizeStatusQuery, nowSec, quoteKey, sameAddress, tokensMatch } from './parse';
import type { BridgeProvider, BridgeQuote, BridgeQuoteRequest, BridgeStatus, BridgeStatusQuery, FeeComponent, UnsignedTx } from './types';
import { decodeApprove, encodeApprove } from './tx';
import { assertQuoteMatches } from './validate';

/**
 * Across keyless public API.
 *
 * Same-asset routes (WETH on Ethereum ↔ Robinhood) use GET /suggested-fees. The approve and the
 * SpokePool depositV3 are built here and never sent. The spoke address must be one published for
 * that chain; a response that names a different spender is rejected.
 *
 * Different-asset routes (USDC → USDG) use GET /swap/approval, which returns the approve and the
 * deposit already built. Those transactions are returned unchanged and never sent.
 *
 * GET /deposit/status maps `expired` to a non-final state: the fill deadline passed and the refund
 * has not been executed yet (`awaitingRefund`). `refunded` is final.
 *
 * An optional quote key is sent only as `Authorization: Bearer`. It is never written on the URL.
 */
export const ACROSS_API = 'https://app.across.to/api';

/** SpokePool per chain. Duplicated from the route table so this module does not import unmerged code. */
export const ACROSS_SPOKE: Readonly<Record<number, string>> = {
  1: getAddress('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'),
  4663: getAddress('0xD29C85F15DF544bA632C9E25829fd29d767d7978'),
};

const DEPOSIT = new Interface([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
]);

const QUOTE_WINDOW_SEC = 600;
const P = 'across';

function unpricedSourceGas(chainId: number): FeeComponent {
  return { amount: 0n, decimals: 18, token: getAddress('0x0000000000000000000000000000000000000000'), chainId, label: 'source-gas-unpriced' };
}

function fee(label: string, amount: bigint, token: string, chainId: number, decimals: number): FeeComponent {
  return { label, amount, token, chainId, decimals };
}

function fillSeconds(body: Record<string, unknown>): number {
  const v = body.estimatedFillTimeSec ?? body.expectedFillTimeSec;
  return needUint32(P, v, 'fill time');
}

export class AcrossClient implements BridgeProvider {
  readonly id = 'across' as const;
  constructor(private readonly d: BridgeDeps) {}

  async quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const norm = normalizeRequest(P, req);
    const key = quoteKey(this.id, norm);
    const hit = this.d.cache.get(key);
    if (hit) return hit;
    const quote = norm.sameAsset ? await this.fromSuggestedFees(norm) : await this.fromSwap(norm);
    assertQuoteMatches(norm, quote, this.d.now());
    this.d.cache.set(key, quote);
    return quote;
  }

  async status(q: BridgeStatusQuery): Promise<BridgeStatus> {
    const query = normalizeStatusQuery(P, q);
    const params = new URLSearchParams({ originChainId: String(query.originChainId) });
    if (query.depositId) params.set('depositId', query.depositId);
    if (query.txHash) params.set('depositTxnRef', query.txHash);
    const body = asObj(await this.get(`/deposit/status?${params}`));
    const status = typeof body.status === 'string' ? body.status : bad(P, 'status is missing');
    const origin = needUint32(P, body.originChainId, 'origin chain');
    if (origin !== query.originChainId) bad(P, 'origin chain does not match');
    const depositId = body.depositId == null ? query.depositId ?? null : needId(P, String(body.depositId), 'deposit id');
    const fillTx = txOrNull(body.fillTx ?? body.fillTxnRef);
    const refundTx = txOrNull(body.depositRefundTxHash ?? body.depositRefundTxnRef);
    if (status === 'pending' || status === 'received') {
      return row('pending', false, false, fillTx, refundTx, depositId ?? null, status === 'received' ? 'received, waiting for fill' : 'pending');
    }
    if (status === 'filled') return row('filled', true, false, fillTx, refundTx, depositId ?? null, 'filled');
    if (status === 'expired') return row('expired', false, true, fillTx, refundTx, depositId ?? null, 'awaiting refund');
    if (status === 'refunded') return row('refunded', true, false, fillTx, refundTx, depositId ?? null, 'refunded');
    bad(P, 'status is missing');
  }

  private async fromSuggestedFees(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const spoke = ACROSS_SPOKE[req.srcChain];
    if (!spoke) bad(P, `no spoke pool on chain ${req.srcChain}`);
    const params = new URLSearchParams({
      inputToken: req.tokenIn.address,
      outputToken: req.tokenOut.address,
      originChainId: String(req.srcChain),
      destinationChainId: String(req.dstChain),
      amount: req.amountIn.toString(),
      recipient: req.recipient,
      allowUnmatchedDecimals: req.tokenIn.decimals === req.tokenOut.decimals ? 'false' : 'true',
    });
    const body = asObj(await this.get(`/suggested-fees?${params}`));
    if (body.isAmountTooLow !== false) bad(P, 'amount is below the route minimum');
    if (typeof body.recipient === 'string' && !sameAddress(needAddress(P, body.recipient, 'recipient'), req.recipient)) bad(P, 'recipient does not match');
    const input = needToken(P, body.inputToken, 'input token');
    const output = needToken(P, body.outputToken, 'output token');
    if (!tokensMatch(input, req.tokenIn)) bad(P, 'token in does not match');
    if (!tokensMatch(output, req.tokenOut)) bad(P, 'token out does not match');
    const spokePool = needAddress(P, body.spokePoolAddress, 'spoke pool');
    if (!sameAddress(spokePool, spoke)) bad(P, 'spoke pool does not match');
    const lp = needUint(P, asObj(body.lpFee).total, 'lp fee');
    const capital = needUint(P, asObj(body.relayerCapitalFee).total, 'relayer fee');
    const destGas = needUint(P, asObj(body.relayerGasFee).total, 'destination gas');
    const total = needUint(P, asObj(body.totalRelayFee).total, 'total fee');
    if (lp + capital + destGas !== total) bad(P, 'fee components do not add up');
    const amountOut = needPositive(P, body.outputAmount, 'amountOut');
    if (req.tokenIn.decimals === req.tokenOut.decimals && amountOut + total !== req.amountIn) bad(P, 'output plus fees does not equal the input');
    const timestamp = needUint32(P, body.timestamp, 'quote timestamp');
    const fillDeadline = needUint32(P, body.fillDeadline, 'fill deadline');
    const exclusivityDeadline = needUint32(P, body.exclusivityDeadline, 'exclusivity deadline');
    const exclusiveRelayer = needAddress(P, body.exclusiveRelayer, 'exclusive relayer');
    if (fillDeadline <= timestamp) bad(P, 'fill deadline is missing');
    const exclusive = exclusivityDeadline !== 0;
    if (exclusive && (exclusivityDeadline < timestamp || exclusivityDeadline > fillDeadline)) bad(P, 'exclusivity deadline is missing');
    if (exclusive === sameAddress(exclusiveRelayer, '0x0000000000000000000000000000000000000000')) bad(P, 'exclusive relayer is missing');
    const sec = nowSec(this.d.now());
    if (timestamp > sec + 120) bad(P, 'quote timestamp is missing');
    const expiresAt = timestamp + QUOTE_WINDOW_SEC;
    const seconds = fillSeconds(body);
    const data = DEPOSIT.encodeFunctionData('depositV3', [
      req.sender,
      req.recipient,
      req.tokenIn.address,
      req.tokenOut.address,
      req.amountIn,
      amountOut,
      BigInt(req.dstChain),
      exclusiveRelayer,
      timestamp,
      fillDeadline,
      exclusivityDeadline,
      '0x',
    ]).toLowerCase();
    const deposit: UnsignedTx = { chainId: req.srcChain, to: spoke, data, value: 0n };
    const approval = encodeApprove(req.tokenIn.address, spoke, req.amountIn, req.srcChain);
    return {
      provider: P,
      srcChain: req.srcChain,
      dstChain: req.dstChain,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn,
      amountOut,
      minOut: amountOut,
      fees: {
        bridge: fee('lp', lp, req.tokenIn.address, req.srcChain, req.tokenIn.decimals),
        relayer: fee('relayer-capital', capital, req.tokenIn.address, req.srcChain, req.tokenIn.decimals),
        sourceGas: unpricedSourceGas(req.srcChain),
        destinationGas: fee('relayer-gas', destGas, req.tokenIn.address, req.srcChain, req.tokenIn.decimals),
      },
      eta: { p50Sec: seconds, p90Sec: seconds },
      expiresAt,
      approval,
      deposit,
      quoteId: needId(P, body.id, 'quote id'),
      recipient: req.recipient,
      sender: req.sender,
      discoveryOnly: false,
      sameAsset: true,
    };
  }

  private async fromSwap(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const params = new URLSearchParams({
      tradeType: 'exactInput',
      amount: req.amountIn.toString(),
      inputToken: req.tokenIn.address,
      outputToken: req.tokenOut.address,
      originChainId: String(req.srcChain),
      destinationChainId: String(req.dstChain),
      depositor: req.sender,
      recipient: req.recipient,
      slippage: bpsFraction(req.slippageBps ?? 50),
    });
    const body = asObj(await this.get(`/swap/approval?${params}`));
    const input = needToken(P, body.inputToken, 'input token');
    const output = needToken(P, body.outputToken, 'output token');
    if (!tokensMatch(input, req.tokenIn)) bad(P, 'token in does not match');
    if (!tokensMatch(output, req.tokenOut)) bad(P, 'token out does not match');
    const recipient = needAddress(P, body.recipient, 'recipient');
    if (!sameAddress(recipient, req.recipient)) bad(P, 'recipient does not match');
    const amountOut = needPositive(P, body.expectedOutputAmount, 'amountOut');
    const minOut = needPositive(P, body.minOutputAmount, 'minOut');
    const swapTx = asObj(body.swapTx);
    if (swapTx.simulationSuccess !== true) bad(P, 'swap simulation failed');
    const txChain = needUint32(P, swapTx.chainId, 'deposit chain');
    if (txChain !== req.srcChain) bad(P, 'deposit is not on the source chain');
    const deposit: UnsignedTx = {
      chainId: req.srcChain,
      to: needAddress(P, swapTx.to, 'deposit'),
      data: needHex(P, swapTx.data, 'deposit'),
      value: needValue(P, swapTx.value, 'deposit value'),
    };
    if (swapTx.gas != null) deposit.gasLimit = needPositive(P, swapTx.gas, 'gas');
    const approval = readApproval(body.approvalTxns, req);
    const details = asObj(asObj(asObj(asObj(body.steps).bridge).fees).details);
    const lp = readFee(asObj(details.lp), req, 'bridge fee');
    const capital = readFee(asObj(details.relayerCapital), req, 'relayer fee');
    const dest = readFee(asObj(details.destinationGas), req, 'destination gas');
    const origin = readOriginGas(body.fees, req);
    const seconds = needUint32(P, body.expectedFillTime, 'fill time');
    const p90 = body.expectedFillTimeP90 == null ? seconds : needUint32(P, body.expectedFillTimeP90, 'fill time');
    return {
      provider: P,
      srcChain: req.srcChain,
      dstChain: req.dstChain,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: req.amountIn,
      amountOut,
      minOut,
      fees: { bridge: lp, relayer: capital, sourceGas: origin, destinationGas: dest },
      eta: { p50Sec: seconds, p90Sec: Math.max(seconds, p90) },
      expiresAt: needUint32(P, body.quoteExpiryTimestamp, 'expiry'),
      approval,
      deposit,
      quoteId: needId(P, body.id, 'quote id'),
      recipient: req.recipient,
      sender: req.sender,
      discoveryOnly: false,
      sameAsset: false,
    };
  }

  private get(path: string): Promise<unknown> {
    return requestJson({
      provider: P,
      limiter: this.d.limiter,
      http: this.d.http,
      sleep: this.d.sleep,
      secrets: this.d.secrets,
      log: this.d.log,
      url: `${ACROSS_API}${path}`,
      method: 'GET',
      headers: baseHeaders(this.d.key ? { name: 'Authorization', value: `Bearer ${this.d.key}` } : undefined),
    });
  }
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

function readFee(node: Record<string, unknown>, req: BridgeQuoteRequest, label: string): FeeComponent {
  const amount = needUint(P, node.amount, label);
  const token = node.token == null ? req.tokenIn : needToken(P, node.token, label);
  return { label: label === 'bridge fee' ? 'lp' : label === 'relayer fee' ? 'relayer-capital' : 'destination-gas', amount, token: token.address, chainId: token.chainId, decimals: token.decimals };
}

function readOriginGas(fees: unknown, req: BridgeQuoteRequest): FeeComponent {
  const node = asObj(fees).originGas;
  if (typeof node === 'string') {
    return { label: 'origin-gas', amount: needUint(P, node, 'source gas'), token: req.tokenIn.address, chainId: req.srcChain, decimals: req.tokenIn.decimals };
  }
  const o = asObj(node);
  const amount = needUint(P, o.amount, 'source gas');
  const token = o.token == null ? req.tokenIn : needToken(P, o.token, 'source gas');
  if (token.chainId !== req.srcChain) bad(P, 'source gas is not on the source chain');
  return { label: 'origin-gas', amount, token: token.address, chainId: token.chainId, decimals: token.decimals };
}

function readApproval(v: unknown, req: BridgeQuoteRequest): UnsignedTx | null {
  if (!Array.isArray(v)) bad(P, 'approval is missing');
  if (v.length === 0) return null;
  if (v.length !== 1) bad(P, 'approval is missing');
  const tx = asObj(v[0]);
  const chainId = needUint32(P, tx.chainId, 'approval chain');
  if (chainId !== req.srcChain) bad(P, 'approval is not on the source chain');
  const to = needAddress(P, tx.to, 'approval');
  if (!sameAddress(to, req.tokenIn.address)) bad(P, 'approval is not for the input token');
  const data = needHex(P, tx.data, 'approval');
  if (decodeApprove(P, data).amount < req.amountIn) bad(P, 'approval is below the input');
  const value = tx.value == null ? 0n : needValue(P, tx.value, 'approval value');
  if (value !== 0n) bad(P, 'approval value must be zero');
  return { chainId, to, data, value };
}

function txOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) bad(P, 'transaction hash is missing');
  return v;
}

function row(state: BridgeStatus['state'], final: boolean, awaitingRefund: boolean, fillTx: string | null, refundTx: string | null, depositId: string | null, detail: string): BridgeStatus {
  return { provider: P, state, final, awaitingRefund, received: null, fillTx, refundTx, depositId, detail };
}
