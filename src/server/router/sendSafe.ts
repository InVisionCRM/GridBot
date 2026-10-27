/**
 * One broadcast of an exact {from, to, data, value} transaction.
 * eth_call at 'pending', then estimateGas against the kind's cap, then an explicit gasLimit,
 * then a fee check, then one send through the chain's TxGate and shared nonce.
 * A timeout is pending / source_sent with the hash. Nothing here sends a second time.
 * Not used by bots. chain.ts is unchanged.
 */
import { Interface, toQuantity } from 'ethers';
import type { ReceiptLike, SentTx } from '../bot/chain';
import type { SharedNonce, TxGate } from '../bot/txGate';
import type { TxKind } from './settings';

const REVERT = new Interface(['error Error(string)', 'error Panic(uint256)']);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;

export type SendSafeCode = 'revert' | 'gas_cap' | 'fee' | 'sim';

export class SendSafeAbort extends Error {
  constructor(message: string, readonly code: SendSafeCode) {
    super(message);
    this.name = 'SendSafeAbort';
  }
}

export interface ExactTx { from: string; to: string; data: string; value: bigint }

export interface SafeReader {
  send(method: string, params: unknown[]): Promise<unknown>;
  getFeeData(): Promise<{ gasPrice: bigint | null; maxFeePerGas: bigint | null }>;
  getTransactionCount(address: string, blockTag: 'pending'): Promise<number>;
}

/** Signer that accepts the gas fields chain.ts's TxSender type does not list. The hub forwards unknown fields to ethers. */
export interface GasSender {
  getAddress(): Promise<string>;
  sendTransaction(tx: {
    to: string; data: string; value: bigint; nonce: number; gasLimit: bigint;
    maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint;
  }): Promise<SentTx>;
}

export interface SendSafeOpts {
  tx: ExactTx;
  kind: TxKind;
  reader: SafeReader;
  signer: GasSender;
  gate: TxGate;
  nonce: SharedNonce;
  /** Gas units. estimateGas above this aborts before a send. */
  gasCap: bigint;
  /** Wei. Abort when maxFeePerGas × gasLimit (+ optional L1 fee) is above this. */
  gasBudgetWei: bigint;
  /** Extra wei (Orbit L1 component) added to the fee check. Omit on an L1. */
  l1FeeWei?: bigint;
  receiptTimeoutMs?: number;
  /** Called with the decoded reason. Must not receive the raw RPC error (that can carry an endpoint). */
  warn?: (msg: string) => void;
}

export interface SendSafeResult {
  status: 'confirmed' | 'pending' | 'reverted';
  /** pending → source_sent (broadcast, outcome unknown). A mined receipt → source_confirmed. */
  state: 'source_sent' | 'source_confirmed';
  hash: string;
  gasLimit: bigint;
  nonce: number;
}

/** gasLimit = min(estimate × 1.2, cap). estimate above the cap throws. */
export function explicitGasLimit(estimate: bigint, cap: bigint, kind: string): bigint {
  if (cap <= 0n) throw new SendSafeAbort(`gas cap for ${kind} is 0`, 'gas_cap');
  if (estimate <= 0n) throw new SendSafeAbort('estimateGas returned no gas', 'sim');
  if (estimate > cap) throw new SendSafeAbort(`gas estimate ${estimate} for ${kind} is above the ${cap} cap`, 'gas_cap');
  const padded = (estimate * 12n) / 10n;
  return padded > cap ? cap : padded;
}

function fail(o: SendSafeOpts, code: SendSafeCode, message: string): never {
  o.warn?.(`router send aborted (${o.kind}): ${message}`);
  throw new SendSafeAbort(message, code);
}

function rpcTx(tx: ExactTx) {
  return { from: tx.from, to: tx.to, data: tx.data, value: toQuantity(tx.value) };
}

/** Decoded revert string only. The raw provider error is not returned: its text can include the RPC URL. */
export function decodeRevertReason(e: unknown): string {
  const data = revertData(e);
  if (data) {
    const decoded = decodeRevertData(data);
    if (decoded) return clip(decoded);
  }
  const reason = (e as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string' && reason.trim() && !/https?:\/\//i.test(reason)) return clip(clean(reason));
  const msg = e instanceof Error ? e.message : '';
  const m = /execution reverted(?::\s*|\s+)([^(\n]+)/i.exec(msg);
  if (m?.[1] && !/https?:\/\//i.test(m[1])) return clip(clean(m[1]));
  return 'execution reverted';
}

function clean(s: string) { return s.trim().replace(/^["']|["']$/g, ''); }
function clip(s: string) { return s.slice(0, 200) || 'execution reverted'; }

function revertData(e: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== 'object' || depth > 5 || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.data === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(o.data)) return o.data;
    for (const k of ['error', 'info', 'body']) {
      const found = walk(o[k], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(e, 0);
}

function decodeRevertData(data: string): string | null {
  try {
    if (data.startsWith('0x08c379a0')) return String(REVERT.decodeErrorResult('Error', data)[0]);
    if (data.startsWith('0x4e487b71')) return `panic ${String(REVERT.decodeErrorResult('Panic', data)[0])}`;
  } catch { /* selector matched but the payload did not */ }
  return `reverted ${data.slice(0, 10)}`;
}

function asQuantity(v: unknown): bigint {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  throw new SendSafeAbort('estimateGas did not return a gas quantity', 'sim');
}

async function waitFor(tx: SentTx, timeoutMs: number): Promise<ReceiptLike | null> {
  try {
    return (await tx.wait(1, timeoutMs)) ?? null;
  } catch (e) {
    const rec = (e as { receipt?: ReceiptLike }).receipt;
    if (rec) return rec;
    return null;
  }
}

export async function sendSafe(o: SendSafeOpts): Promise<SendSafeResult> {
  const tx = o.tx;
  if (!ADDR.test(tx.from) || !ADDR.test(tx.to)) fail(o, 'sim', 'from and to must be 0x addresses');
  if (!DATA.test(tx.data)) fail(o, 'sim', 'data must be hex');
  if (typeof tx.value !== 'bigint' || tx.value < 0n) fail(o, 'sim', 'value must be a non-negative amount');

  try {
    const out = await o.reader.send('eth_call', [rpcTx(tx), 'pending']);
    if (typeof out !== 'string') fail(o, 'sim', 'eth_call returned no result');
  } catch (e) {
    if (e instanceof SendSafeAbort) throw e;
    fail(o, 'revert', decodeRevertReason(e));
  }

  let estimate: bigint;
  try {
    estimate = asQuantity(await o.reader.send('eth_estimateGas', [rpcTx(tx), 'pending']));
  } catch (e) {
    if (e instanceof SendSafeAbort) fail(o, e.code, e.message);
    fail(o, 'revert', decodeRevertReason(e));
  }

  let gasLimit: bigint;
  try { gasLimit = explicitGasLimit(estimate, o.gasCap, o.kind); }
  catch (e) { if (e instanceof SendSafeAbort) fail(o, e.code, e.message); throw e; }

  const fee = await o.reader.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice;
  if (maxFee == null || maxFee <= 0n) fail(o, 'fee', 'no maxFeePerGas from the chain');
  const l1 = o.l1FeeWei ?? 0n;
  if (l1 < 0n) fail(o, 'fee', 'L1 fee is negative');
  const cost = maxFee * gasLimit + l1;
  if (cost > o.gasBudgetWei) fail(o, 'fee', `gas cost ${cost} wei exceeds budget ${o.gasBudgetWei} wei`);

  // One send, inside the chain gate, with the shared nonce. The wait stays in the gate (same as a bot fill).
  return o.gate.run(async () => {
    const nonce = await o.nonce.next(() => o.reader.getTransactionCount(tx.from, 'pending'));
    let sent: SentTx;
    try {
      sent = await o.signer.sendTransaction({
        to: tx.to, data: tx.data, value: tx.value, nonce, gasLimit,
        maxFeePerGas: maxFee, maxPriorityFeePerGas: maxFee,
      });
    } catch (e) {
      o.nonce.invalidate();
      o.warn?.(`router send aborted (${o.kind}): broadcast failed`);
      throw e;
    }
    // Timeout or any other unknown outcome: return the hash. Do not invalidate, do not send again.
    const receipt = await waitFor(sent, o.receiptTimeoutMs ?? 120_000);
    if (!receipt) return { status: 'pending' as const, state: 'source_sent' as const, hash: sent.hash, gasLimit, nonce };
    if (receipt.status !== 1) return { status: 'reverted' as const, state: 'source_confirmed' as const, hash: sent.hash, gasLimit, nonce };
    return { status: 'confirmed' as const, state: 'source_confirmed' as const, hash: sent.hash, gasLimit, nonce };
  });
}
