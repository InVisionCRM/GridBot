import { getAddress } from 'ethers';
import { BridgeError } from './errors';
import type { BridgeId, BridgeQuoteRequest, BridgeStatusQuery, BridgeToken } from './types';

/** Chains this desk can bridge. PulseChain is listed so a later OmniBridge client can share the check. */
export const BRIDGE_CHAIN_IDS = new Set([1, 4663, 369]);

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;

/** Same-asset output may exceed the input by at most 1 basis point after decimals are aligned. */
export const SAME_ASSET_SURPLUS_BPS = 1n;
const BPS = 10_000n;

/** Li.Fi's published service fee. Always recorded on a Li.Fi quote, whether or not the body repeats it. */
export const LIFI_FEE_BPS = 25n;

export const MAX_ETA_SEC = 30 * 24 * 60 * 60;
const UINT32 = 4_294_967_295;

export function bad(provider: string, message: string): never {
  throw new BridgeError(provider, 'invalid', `${provider}: ${message}`);
}

export function asRecord(provider: string, v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) bad(provider, `${label} is missing`);
  return v as Record<string, unknown>;
}

/** Decimal integer string only. JSON numbers are rejected so a value above 2^53 cannot be rounded. */
export function needUint(provider: string, v: unknown, label: string): bigint {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) bad(provider, `${label} is missing`);
  return BigInt(v);
}

export function needPositive(provider: string, v: unknown, label: string): bigint {
  const n = needUint(provider, v, label);
  if (n <= 0n) bad(provider, `${label} must be positive`);
  return n;
}

export function needValue(provider: string, v: unknown, label: string): bigint {
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  bad(provider, `${label} is missing`);
}

export function needInt(provider: string, v: unknown, label: string, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isInteger(v)) n = v;
  else if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) n = Number(v);
  else bad(provider, `${label} is missing`);
  if (!Number.isSafeInteger(n) || n < min || n > max) bad(provider, `${label} is missing`);
  return n;
}

export function needAddress(provider: string, v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) bad(provider, `${label} is missing`);
  try {
    return getAddress(v);
  } catch {
    bad(provider, `${label} is missing`);
  }
}

export function needHex(provider: string, v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v) || v.length < 10 || v.length % 2 !== 0) bad(provider, `${label} is missing`);
  return v.toLowerCase();
}

export function needChain(provider: string, v: unknown, label: string): number {
  const n = needInt(provider, v, label, 1, 1_000_000_000);
  if (!BRIDGE_CHAIN_IDS.has(n)) bad(provider, `${label} is not a supported chain`);
  return n;
}

export function needId(provider: string, v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 128 || /[\s?#&]/.test(v)) bad(provider, `${label} is missing`);
  return v;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function scaleAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals >= fromDecimals) return amount * 10n ** BigInt(toDecimals - fromDecimals);
  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}

/** True when `amountOut` is more than 1 bp above `amountIn` once both amounts share a decimal scale. */
export function sameAssetSurplus(amountIn: bigint, decIn: number, amountOut: bigint, decOut: number): boolean {
  const d = Math.max(decIn, decOut);
  const inn = scaleAmount(amountIn, decIn, d);
  const out = scaleAmount(amountOut, decOut, d);
  const tol = (inn * SAME_ASSET_SURPLUS_BPS) / BPS;
  const slack = tol < 1n ? 1n : tol;
  return out > inn + slack;
}

export function lifiFeeAmount(amountIn: bigint): bigint {
  return (amountIn * LIFI_FEE_BPS) / BPS;
}

/**
 * Decimal fraction to whole basis points. "0.0025" → 25.
 * A fraction that is not a whole number of basis points (8.5 bps) returns null.
 * Only the Li.Fi 0.25% integrator row requires a whole number. Other fee rows keep
 * the token amount, which already has the protocol's exact precision.
 */
export function tryWholeBps(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  const digits = (whole + frac).replace(/^0+/, '') || '0';
  const num = BigInt(digits) * BPS;
  const den = 10n ** BigInt(frac.length);
  if (num % den !== 0n) return null;
  return num / den;
}

/** "0.0025" → 25. Rejects fractions that are not a whole number of basis points. */
export function fractionToBps(provider: string, v: unknown, label: string): bigint {
  const bps = tryWholeBps(v);
  if (bps == null) bad(provider, `${label} is missing`);
  return bps;
}

/**
 * Gas limit as hex ("0x425a5") or decimal. Zero and a missing field mean the caller
 * still has to estimate gas. A positive value is returned as a bigint.
 */
export function readGasLimit(provider: string, v: unknown): bigint | null {
  if (v == null) return null;
  let n: bigint;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) bad(provider, 'gas is missing');
    n = BigInt(v);
  } else if (typeof v === 'string' && (v === '0' || /^0x0*$/i.test(v))) {
    return null;
  } else {
    n = needValue(provider, v, 'gas');
  }
  return n === 0n ? null : n;
}

/** Basis points as a decimal fraction without floating point. 50 → "0.005". */
export function formatBpsFraction(bps: number): string {
  const pad = String(bps).padStart(4, '0');
  const whole = pad.slice(0, -4) || '0';
  const frac = pad.slice(-4).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function needToken(provider: string, v: unknown, label: string): BridgeToken {
  const o = asRecord(provider, v, label);
  const chainId = needChain(provider, o.chainId, `${label} chain`);
  const address = needAddress(provider, o.address, `${label} address`);
  const decimals = needInt(provider, o.decimals, `${label} decimals`, 0, 36);
  return { chainId, address, decimals };
}

export function tokensMatch(a: BridgeToken, b: BridgeToken): boolean {
  return a.chainId === b.chainId && a.decimals === b.decimals && sameAddress(a.address, b.address);
}

export function normalizeRequest(provider: BridgeId, req: BridgeQuoteRequest): BridgeQuoteRequest {
  const srcChain = needChain(provider, req.srcChain, 'source chain');
  const dstChain = needChain(provider, req.dstChain, 'destination chain');
  if (srcChain === dstChain) bad(provider, 'source and destination chain are the same');
  const tokenIn = {
    chainId: needChain(provider, req.tokenIn?.chainId, 'token in chain'),
    address: needAddress(provider, req.tokenIn?.address, 'token in'),
    decimals: needInt(provider, req.tokenIn?.decimals, 'token in decimals', 0, 36),
    ...(req.tokenIn?.symbol ? { symbol: req.tokenIn.symbol } : {}),
  };
  const tokenOut = {
    chainId: needChain(provider, req.tokenOut?.chainId, 'token out chain'),
    address: needAddress(provider, req.tokenOut?.address, 'token out'),
    decimals: needInt(provider, req.tokenOut?.decimals, 'token out decimals', 0, 36),
    ...(req.tokenOut?.symbol ? { symbol: req.tokenOut.symbol } : {}),
  };
  if (tokenIn.chainId !== srcChain) bad(provider, 'token in is not on the source chain');
  if (tokenOut.chainId !== dstChain) bad(provider, 'token out is not on the destination chain');
  if (sameAddress(tokenIn.address, ZERO_ADDRESS) || sameAddress(tokenOut.address, ZERO_ADDRESS)) {
    bad(provider, 'native coin must be passed as the wrapped token');
  }
  if (typeof req.amountIn !== 'bigint' || req.amountIn <= 0n) bad(provider, 'amountIn must be a positive bigint');
  const recipient = needAddress(provider, req.recipient, 'recipient');
  const sender = needAddress(provider, req.sender, 'sender');
  if (typeof req.sameAsset !== 'boolean') bad(provider, 'sameAsset is missing');
  const slippageBps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) bad(provider, 'slippage is out of range');
  return { srcChain, dstChain, tokenIn, tokenOut, amountIn: req.amountIn, recipient, sender, sameAsset: req.sameAsset, slippageBps };
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DEPOSIT_ID = /^(0x[0-9a-fA-F]{8,64}|[0-9]{1,78})$/;

export function normalizeStatusQuery(provider: BridgeId, q: BridgeStatusQuery): BridgeStatusQuery {
  if (q.provider !== provider) bad(provider, 'status provider does not match');
  const originChainId = needChain(provider, q.originChainId, 'origin chain');
  let destinationChainId: number | undefined;
  if (q.destinationChainId != null) {
    destinationChainId = needChain(provider, q.destinationChainId, 'destination chain');
    if (destinationChainId === originChainId) bad(provider, 'source and destination chain are the same');
  }
  const txHash = q.txHash == null || q.txHash === '' ? undefined : q.txHash;
  const depositId = q.depositId == null || q.depositId === '' ? undefined : q.depositId;
  if (!txHash && !depositId) bad(provider, 'status needs a transaction hash or a deposit id');
  if (txHash && !TX_HASH.test(txHash)) bad(provider, 'transaction hash is missing');
  if (depositId && !DEPOSIT_ID.test(depositId)) bad(provider, 'deposit id is missing');
  return { provider, originChainId, ...(destinationChainId != null ? { destinationChainId } : {}), ...(txHash ? { txHash } : {}), ...(depositId ? { depositId } : {}) };
}

export function needUint32(provider: string, v: unknown, label: string): number {
  return needInt(provider, v, label, 0, UINT32);
}

export function quoteKey(provider: BridgeId, req: BridgeQuoteRequest): string {
  return [
    provider,
    req.srcChain,
    req.dstChain,
    req.tokenIn.address.toLowerCase(),
    req.tokenIn.decimals,
    req.tokenOut.address.toLowerCase(),
    req.tokenOut.decimals,
    req.amountIn.toString(),
    req.recipient.toLowerCase(),
    req.sender.toLowerCase(),
    req.sameAsset ? '1' : '0',
    req.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
  ].join('|');
}

export function nowSec(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}
