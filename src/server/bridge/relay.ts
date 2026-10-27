import { assertDepositTarget, capApproval } from './allow';
import { QUOTE_HOLD_SEC, loadQuote } from './cache';
import type { BridgeDeps } from './deps';
import { baseHeaders, requestJson } from './http';
import { sanitizeText } from './errors';
import { bad, needAddress, needChain, needHex, needId, needPositive, needToken, needUint, needUint32, needValue, normalizeRequest, normalizeStatusQuery, nowSec, quoteKey, readGasLimit, sameAddress, tokensMatch } from './parse';
import type { BridgeProvider, BridgeQuote, BridgeQuoteRequest, BridgeStatus, BridgeStatusQuery, FeeComponent, UnsignedTx } from './types';
import { APPROVE_SELECTOR } from './tx';
import { assertQuoteMatches } from './validate';

/**
 * Relay keyless quote: POST /quote (the public endpoint that returns an executable deposit).
 * Status is GET /intents/status/v3. Only `success` and `refund` are final. `failure` stays
 * non-final because Relay may retry the fill or refund it later.
 *
 * The body does not publish an expiry. The quote is marked to expire after QUOTE_HOLD_SEC,
 * the same window as the cache, so a caller cannot keep a Relay quote longer than we cache it.
 *
 * An optional quote key is sent only as the `x-api-key` header.
 */
export const RELAY_API = 'https://api.relay.link';
const P = 'relay';

export class RelayClient implements BridgeProvider {
  readonly id = 'relay' as const;
  private readonly inflight = new Map<string, Promise<BridgeQuote>>();
  constructor(private readonly d: BridgeDeps) {}

  quote(req: BridgeQuoteRequest): Promise<BridgeQuote> {
    const norm = normalizeRequest(P, req);
    const key = quoteKey(this.id, norm);
    return loadQuote(this.d.cache, this.inflight, key, () => this.fetchQuote(norm));
  }

  private async fetchQuote(norm: BridgeQuoteRequest): Promise<BridgeQuote> {
    const body = asObj(await requestJson({
      provider: P,
      limiter: this.d.limiter,
      http: this.d.http,
      sleep: this.d.sleep,
      secrets: this.d.secrets,
      now: this.d.now,
      log: this.d.log,
      url: `${RELAY_API}/quote`,
      method: 'POST',
      headers: { ...baseHeaders(this.d.key ? { name: 'x-api-key', value: this.d.key } : undefined), 'content-type': 'application/json' },
      body: JSON.stringify({
        user: norm.sender,
        recipient: norm.recipient,
        originChainId: norm.srcChain,
        destinationChainId: norm.dstChain,
        originCurrency: norm.tokenIn.address,
        destinationCurrency: norm.tokenOut.address,
        amount: norm.amountIn.toString(),
        tradeType: 'EXACT_INPUT',
        slippageTolerance: String(norm.slippageBps ?? 50),
      }),
    }));
    const quote = parseQuote(norm, body, nowSec(this.d.now()));
    assertQuoteMatches(norm, quote, this.d.now());
    return quote;
  }

  async status(q: BridgeStatusQuery): Promise<BridgeStatus> {
    const query = normalizeStatusQuery(P, q);
    if (!query.depositId) bad(P, 'status needs a request id');
    const params = new URLSearchParams({ requestId: query.depositId });
    const body = asObj(await requestJson({
      provider: P,
      limiter: this.d.limiter,
      http: this.d.http,
      sleep: this.d.sleep,
      secrets: this.d.secrets,
      now: this.d.now,
      log: this.d.log,
      url: `${RELAY_API}/intents/status/v3?${params}`,
      method: 'GET',
      headers: baseHeaders(this.d.key ? { name: 'x-api-key', value: this.d.key } : undefined),
    }));
    const status = typeof body.status === 'string' ? body.status : bad(P, 'status is missing');
    const fillTx = firstHash(body.txHashes);
    const depositId = query.depositId;
    if (status === 'waiting' || status === 'depositing' || status === 'pending' || status === 'submitted' || status === 'delayed') {
      return base('pending', false, fillTx, depositId, status);
    }
    if (status === 'success') return base('filled', true, fillTx, depositId, 'filled');
    if (status === 'refund') return { ...base('refunded', true, null, depositId, 'refunded'), refundTx: fillTx, fillTx: null };
    if (status === 'failure') {
      const raw = typeof body.failReason === 'string' ? body.failReason.replace(/\s+/g, ' ').slice(0, 80) : '';
      const reason = sanitizeText(raw, this.d.secrets);
      const detail = reason ? `failure may still retry (${reason})` : 'failure may still retry';
      return base('failed', false, fillTx, depositId, detail);
    }
    return base('pending', false, fillTx, depositId, `unknown: ${sanitizeText(status, this.d.secrets).replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

function parseQuote(req: BridgeQuoteRequest, body: Record<string, unknown>, sec: number): BridgeQuote {
  const details = asObj(body.details);
  const recipient = needAddress(P, details.recipient, 'recipient');
  if (!sameAddress(recipient, req.recipient)) bad(P, 'recipient does not match');
  const sender = needAddress(P, details.sender, 'sender');
  if (!sameAddress(sender, req.sender)) bad(P, 'sender does not match');
  const currencyIn = readLeg(asObj(details.currencyIn), 'token in');
  const currencyOut = readLeg(asObj(details.currencyOut), 'token out');
  if (!tokensMatch(currencyIn.token, req.tokenIn)) bad(P, 'token in does not match');
  if (!tokensMatch(currencyOut.token, req.tokenOut)) bad(P, 'token out does not match');
  if (currencyIn.amount !== req.amountIn) bad(P, 'amountIn does not match');
  const amountOut = currencyOut.amount;
  const minOut = currencyOut.minimum;
  if (minOut == null) bad(P, 'minOut is missing');
  const fees = asObj(body.fees);
  const relayer = readMoney(asObj(fees.relayer), 'relayer fee', req);
  const dest = readMoney(asObj(fees.relayerGas), 'destination gas', req);
  const source = readMoney(asObj(fees.gas), 'source gas', req);
  if (source.chainId !== req.srcChain) bad(P, 'source gas is not on the source chain');
  const bridge = fees.app == null
    ? { amount: 0n, decimals: req.tokenIn.decimals, token: req.tokenIn.address, chainId: req.srcChain, label: 'app' }
    : { ...readMoney(asObj(fees.app), 'bridge fee', req), label: 'app' };
  const built = readSteps(body, req);
  const seconds = needUint32(P, details.timeEstimate, 'fill time');
  return {
    provider: P,
    srcChain: req.srcChain,
    dstChain: req.dstChain,
    tokenIn: currencyIn.token,
    tokenOut: currencyOut.token,
    amountIn: req.amountIn,
    amountOut,
    minOut,
    fees: {
      bridge: { ...bridge, label: 'app' },
      relayer: { ...relayer, label: 'solver' },
      sourceGas: { ...source, label: 'source-gas' },
      destinationGas: { ...dest, label: 'destination-gas' },
    },
    eta: { p50Sec: seconds, p90Sec: seconds },
    expiresAt: sec + QUOTE_HOLD_SEC,
    approval: built.approval,
    deposit: built.deposit,
    quoteId: built.requestId,
    recipient,
    sender: req.sender,
    discoveryOnly: false,
    sameAsset: req.sameAsset,
  };
}

function readLeg(node: Record<string, unknown>, label: string): { token: ReturnType<typeof needToken>; amount: bigint; minimum: bigint | null } {
  const token = needToken(P, node.currency, label);
  const amount = needPositive(P, node.amount, label === 'token out' ? 'amountOut' : 'amountIn');
  const minimum = node.minimumAmount == null ? null : needPositive(P, node.minimumAmount, 'minOut');
  return { token, amount, minimum };
}

function readMoney(node: Record<string, unknown>, label: string, req: BridgeQuoteRequest): FeeComponent {
  const amount = needUint(P, node.amount, label);
  const token = node.currency == null ? req.tokenIn : needToken(P, node.currency, label);
  if (token.chainId !== req.srcChain && token.chainId !== req.dstChain) bad(P, `${label} is missing`);
  return { label, amount, token: token.address, chainId: token.chainId, decimals: token.decimals };
}

function readSteps(body: Record<string, unknown>, req: BridgeQuoteRequest): { approval: UnsignedTx | null; deposit: UnsignedTx; requestId: string } {
  const v = body.steps;
  if (!Array.isArray(v) || v.length === 0) bad(P, 'deposit is missing');
  let approval: UnsignedTx | null = null;
  let deposit: UnsignedTx | null = null;
  let requestId = typeof body.requestId === 'string' ? body.requestId : '';
  for (const step of v) {
    const s = asObj(step);
    if (typeof s.requestId === 'string' && !requestId) requestId = s.requestId;
    if (!Array.isArray(s.items)) continue;
    for (const item of s.items) {
      const data = asObj(asObj(item).data);
      if (typeof data.data !== 'string') continue;
      const tx = readTx(data, req);
      if (tx.data.startsWith(APPROVE_SELECTOR)) {
        if (approval) bad(P, 'approval is missing');
        if (!sameAddress(tx.to, req.tokenIn.address)) bad(P, 'approval is not for the input token');
        approval = capApproval(P, tx, req.tokenIn.address, req.amountIn);
      } else if (deposit) {
        bad(P, 'deposit is missing');
      } else {
        assertDepositTarget(P, req.srcChain, tx.to);
        deposit = tx;
      }
    }
  }
  if (!deposit) bad(P, 'deposit is missing');
  return { approval, deposit, requestId: needId(P, requestId, 'quote id') };
}

function readTx(data: Record<string, unknown>, req: BridgeQuoteRequest): UnsignedTx {
  const chainId = needChain(P, data.chainId, 'deposit chain');
  if (chainId !== req.srcChain) bad(P, 'deposit is not on the source chain');
  const tx: UnsignedTx = {
    chainId,
    to: needAddress(P, data.to, 'deposit'),
    data: needHex(P, data.data, 'deposit'),
    value: data.value == null ? 0n : needValue(P, data.value, 'deposit value'),
  };
  const gas = readGasLimit(P, data.gas);
  if (gas != null) tx.gasLimit = gas;
  return tx;
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(P, 'response is missing');
}

function firstHash(v: unknown): string | null {
  if (v == null) return null;
  if (!Array.isArray(v) || v.length === 0) return null;
  const h = v[0];
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h)) bad(P, 'transaction hash is missing');
  return h;
}

function base(state: BridgeStatus['state'], final: boolean, fillTx: string | null, depositId: string, detail: string): BridgeStatus {
  return { provider: P, state, final, awaitingRefund: false, received: null, fillTx, refundTx: null, depositId, detail };
}
