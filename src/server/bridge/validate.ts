import { assertGuarded } from './allow';
import { BridgeError } from './errors';
import { APPROVE_SELECTOR } from './tx';
import { DEFAULT_SLIPPAGE_BPS, MAX_ETA_SEC, bad, needAddress, nowSec, sameAddress, sameAssetSurplus } from './parse';
import type { BridgeQuote, BridgeQuoteRequest, FeeComponent, UnsignedTx } from './types';

function feeOk(provider: string, fee: FeeComponent, label: string, chains: number[]) {
  if (fee == null || typeof fee.amount !== 'bigint' || fee.amount < 0n) bad(provider, `${label} is missing`);
  if (!Number.isInteger(fee.decimals) || fee.decimals < 0 || fee.decimals > 36) bad(provider, `${label} is missing`);
  if (!chains.includes(fee.chainId)) bad(provider, `${label} is missing`);
  needAddress(provider, fee.token, label);
  if (typeof fee.label !== 'string' || fee.label.length < 1 || fee.label.length > 40 || /[\s]/.test(fee.label)) bad(provider, `${label} is missing`);
}

function txOk(provider: string, tx: UnsignedTx, label: string, chainId: number) {
  if (tx == null || tx.chainId !== chainId) bad(provider, `${label} is not on the source chain`);
  needAddress(provider, tx.to, label);
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.data) || tx.data.length < 10 || tx.data.length % 2 !== 0) bad(provider, `${label} is missing`);
  if (typeof tx.value !== 'bigint' || tx.value < 0n) bad(provider, `${label} is missing`);
  if (tx.gasLimit != null && (typeof tx.gasLimit !== 'bigint' || tx.gasLimit <= 0n)) bad(provider, `${label} is missing`);
}

/**
 * Reject a quote that does not describe the request: wrong chain, token, or recipient,
 * a same-asset output above the 1 bp tolerance, a minOut above amountOut, or a required hole.
 */
export function assertQuoteMatches(req: BridgeQuoteRequest, quote: BridgeQuote, nowMs: number) {
  const p = quote.provider;
  if (p !== 'across' && p !== 'relay' && p !== 'lifi') bad('bridge', 'provider is missing');
  if ((p === 'lifi') !== quote.discoveryOnly) bad(p, 'discovery flag does not match the provider');
  if (quote.srcChain !== req.srcChain) bad(p, 'source chain does not match');
  if (quote.dstChain !== req.dstChain) bad(p, 'destination chain does not match');
  if (quote.tokenIn.chainId !== req.tokenIn.chainId || quote.tokenIn.decimals !== req.tokenIn.decimals || !sameAddress(quote.tokenIn.address, req.tokenIn.address)) {
    bad(p, 'token in does not match');
  }
  if (quote.tokenOut.chainId !== req.tokenOut.chainId || quote.tokenOut.decimals !== req.tokenOut.decimals || !sameAddress(quote.tokenOut.address, req.tokenOut.address)) {
    bad(p, 'token out does not match');
  }
  if (!sameAddress(quote.recipient, req.recipient)) bad(p, 'recipient does not match');
  if (!sameAddress(quote.sender, req.sender)) bad(p, 'sender does not match');
  if (quote.amountIn !== req.amountIn) bad(p, 'amountIn does not match');
  if (typeof quote.amountOut !== 'bigint' || quote.amountOut <= 0n) bad(p, 'amountOut must be positive');
  if (typeof quote.minOut !== 'bigint' || quote.minOut <= 0n) bad(p, 'minOut must be positive');
  if (quote.minOut > quote.amountOut) bad(p, 'minOut exceeds amountOut');
  const slippage = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const floor = (quote.amountOut * BigInt(10_000 - slippage)) / 10_000n;
  if (quote.minOut < floor) bad(p, 'minOut is below the slippage floor');
  if (req.sameAsset && sameAssetSurplus(req.amountIn, req.tokenIn.decimals, quote.amountOut, req.tokenOut.decimals)) {
    bad(p, 'same-asset output exceeds the input');
  }
  if (!Number.isInteger(quote.expiresAt) || quote.expiresAt <= nowSec(nowMs)) bad(p, 'quote is expired');
  if (!Number.isInteger(quote.eta.p50Sec) || !Number.isInteger(quote.eta.p90Sec)) bad(p, 'eta is missing');
  if (quote.eta.p50Sec < 0 || quote.eta.p90Sec < quote.eta.p50Sec || quote.eta.p90Sec > MAX_ETA_SEC) bad(p, 'eta is missing');
  if (typeof quote.quoteId !== 'string' || quote.quoteId.length < 1) bad(p, 'quote id is missing');
  const chains = [req.srcChain, req.dstChain];
  feeOk(p, quote.fees?.bridge, 'bridge fee', chains);
  feeOk(p, quote.fees?.relayer, 'relayer fee', chains);
  feeOk(p, quote.fees?.sourceGas, 'source gas', [req.srcChain]);
  if (quote.fees.destinationGas != null) feeOk(p, quote.fees.destinationGas, 'destination gas', chains);
  txOk(p, quote.deposit, 'deposit', req.srcChain);
  if (quote.deposit.value !== 0n) bad(p, 'deposit value must be zero for an ERC-20');
  if (quote.approval) {
    txOk(p, quote.approval, 'approval', req.srcChain);
    if (!sameAddress(quote.approval.to, req.tokenIn.address)) bad(p, 'approval is not for the input token');
    if (quote.approval.value !== 0n) bad(p, 'approval value must be zero');
    if (!quote.approval.data.toLowerCase().startsWith(APPROVE_SELECTOR)) {
      throw new BridgeError(p, 'invalid', `${p}: approval is not an ERC-20 approve`);
    }
  }
  assertGuarded(p, req, quote.deposit, quote.approval, quote.minOut);
}
