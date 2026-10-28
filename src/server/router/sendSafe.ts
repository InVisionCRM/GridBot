/**
 * One broadcast of an exact {from, to, data, value} transaction.
 * eth_call at 'pending', then estimateGas against the kind's cap, then an explicit gasLimit,
 * then a fee check, all of that again after the chain's TxGate is acquired (a bot tx may have
 * been ahead of us). The router halt is read immediately before the shared nonce is taken.
 * Fees: EIP-1559 pays the network's suggested tip when it is within the per-chain tip cap, and
 * maxFee = 2×base + that tip. feeHistory uses the 10th-percentile reward. A suggestion above the cap
 * aborts (code fee) instead of underpaying,
 * which would stick the tx and block this chain's shared nonce. A legacy chain puts the price in
 * gasPrice. The hash is keccak256 of the signed bytes, so a send timeout or "already known" still
 * has a hash. A timeout that no endpoint already has is rebroadcast as those same bytes. If it is
 * still unknown when the wait ends, the shared nonce is dropped. Not used by bots.
 *
 * The caller, when one exists, must use that chain's runtime: hub.rt(chainId).gate and
 * hub.rt(chainId).nonce (or the runtime itself), and halted: routerSendHalted(router).
 */
import { Interface, keccak256, toQuantity } from 'ethers';
import { isRealRevert, isTransportError } from '../chains/fallback';
import { redact } from '../bot/logger';
import type { SharedNonce, TxGate } from '../bot/txGate';
import type { TxKind } from './settings';

const REVERT = new Interface(['error Error(string)', 'error Panic(uint256)']);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const BLOCK_SCAN = 8;

export type SendSafeCode =
  | 'revert' | 'gas_cap' | 'fee' | 'sim' | 'halt' | 'rpc'
  | 'underpriced' | 'stale_nonce' | 'broadcast';

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
  getTransactionCount(address: string, blockTag: 'pending' | 'latest'): Promise<number>;
  /**
   * eth_sendRawTransaction on one endpoint, with no rotation. FallbackReader implements this.
   * When absent, send('eth_sendRawTransaction') is used.
   */
  broadcastRaw?(raw: string): Promise<unknown>;
  /**
   * Same signed bytes on the next endpoint (same hash). Rejects with code NO_ENDPOINT when none remain.
   * When absent, a timed-out broadcast is not tried again.
   */
  broadcastNext?(raw: string): Promise<unknown>;
  /** True when this hash is already known (any endpoint). When absent, one send() lookup is used. */
  hasTx?(hash: string): Promise<boolean>;
}

/** Signs one tx. The hub's wallet does this; sendSafe broadcasts the raw bytes itself. */
export interface GasSender {
  getAddress(): Promise<string>;
  signTransaction(tx: {
    to: string; data: string; value: bigint; nonce: number; gasLimit: bigint; chainId: number;
    type: 0 | 2;
    gasPrice?: bigint;
    maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint;
  }): Promise<string>;
}

export interface SendSafeOpts {
  tx: ExactTx;
  kind: TxKind;
  chainId: number;
  reader: SafeReader;
  signer: GasSender;
  gate: TxGate;
  nonce: SharedNonce;
  /** Gas units. estimateGas above this aborts before a send. */
  gasCap: bigint;
  /** Wei. Abort when the per-gas price × gasLimit (+ optional L1 fee) is above this. */
  gasBudgetWei: bigint;
  /** Wei per gas. Abort when the price itself is above this (router maxGasPriceWei). */
  maxGasPriceWei: bigint;
  /**
   * Wei. Abort when the network's suggested tip is above this (router maxPriorityFeeWei).
   * The tip on the tx is the suggestion, never a lower clamp.
   */
  maxPriorityFeeWei: bigint;
  /** Extra wei (Orbit L1 component) added to the fee check. Omit on an L1. */
  l1FeeWei?: bigint;
  /**
   * Receipt wait, ms. Clamped to 180s. The gate budget, fixed when the gate is taken, is that plus 60s.
   * Omit for 120s.
   */
  receiptTimeoutMs?: number;
  /**
   * Required. Read inside the gate, immediately before the nonce is taken.
   * Stop all sets the router halt while this send may still be queued behind a bot tx.
   * Pass routerSendHalted(router). A missing check is a halt, not a send.
   */
  halted: () => boolean;
  /** Called with a safe reason. Must not receive a raw RPC error (that can carry an endpoint). */
  warn?: (msg: string) => void;
}

/**
 * The halted predicate a router send must use. True unless this process has the router on, in live
 * mode, and not panic-halted. Off (the default) and paper both block a send. Stop all sets the panic halt.
 */
export function routerSendHalted(router: {
  isHalted(): boolean;
  status(): { on: boolean; mode: 'paper' | 'live' };
}): () => boolean {
  return () => {
    if (router.isHalted()) return true;
    const s = router.status();
    return s.on !== true || s.mode !== 'live';
  };
}

export type SendSafeStatus = 'confirmed' | 'pending' | 'reverted' | 'replaced' | 'cancelled';

/** Receipt wait is never longer than this. Settings validation uses the same cap. */
export const RECEIPT_TIMEOUT_CAP_MS = 180_000;
/** Slack after the capped receipt wait. One deadline for the whole time the chain gate is held. */
export const GATE_SLACK_MS = 60_000;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;

export function clampedReceiptTimeoutMs(ms: number | undefined): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFAULT_RECEIPT_TIMEOUT_MS;
  if (n < 1) return 1;
  return Math.min(RECEIPT_TIMEOUT_CAP_MS, n);
}

/**
 * Two marks, both fixed when the gate is taken.
 * The receipt wait stops at the capped receipt timeout.
 * The next 60s is only for the known-tx check, so a slow RPC can still say the broadcast is unknown.
 */
export function sendDeadlines(receiptTimeoutMs: number | undefined, now = Date.now()): { receipt: number; gate: number } {
  const receipt = now + clampedReceiptTimeoutMs(receiptTimeoutMs);
  return { receipt, gate: receipt + GATE_SLACK_MS };
}

/** Absolute time when a send that already holds the chain gate must stop. */
export function gateDeadlineAt(receiptTimeoutMs: number | undefined, now = Date.now()): number {
  return sendDeadlines(receiptTimeoutMs, now).gate;
}

export const GATE_BUDGET_REASON = 'time budget elapsed while this chain\'s gate was held; the transaction may still be in the mempool';

export interface SendSafeResult {
  status: SendSafeStatus;
  /** pending → source_sent. A receipt for this hash → source_confirmed. A different hash at this nonce → source_replaced. */
  state: 'source_sent' | 'source_confirmed' | 'source_replaced';
  hash: string;
  gasLimit: bigint;
  nonce: number;
  replacementHash?: string;
  /** Set when the gate budget expired. The tx may still be pending. */
  reason?: string;
}

interface Plan {
  gasLimit: bigint;
  unit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

interface Outcome {
  status: SendSafeStatus;
  state: SendSafeResult['state'];
  hash: string;
  replacementHash?: string;
  reason?: string;
}

class GateBudget extends Error {
  constructor() {
    super(GATE_BUDGET_REASON);
    this.name = 'GateBudget';
  }
}

function budgetPending(hash: string): Outcome {
  return { status: 'pending', state: 'source_sent', hash, reason: GATE_BUDGET_REASON };
}

/** Stop waiting on one RPC when the gate deadline is reached, and drop the timer either way. */
async function withinBudget<T>(deadline: number, work: Promise<T>): Promise<T> {
  const left = deadline - Date.now();
  void work.catch(() => undefined);
  // A call that has already missed its deadline must not wait. Callers that still need an answer
  // use a later deadline (the gate mark) so a slow known-tx check can finish.
  if (left <= 0) throw new GateBudget();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GateBudget()), left);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function rpc(o: SendSafeOpts, deadline: number | undefined, method: string, params: unknown[]): Promise<unknown> {
  const work = o.reader.send(method, params);
  if (deadline == null) return work;
  return withinBudget(deadline, work);
}

/** gasLimit = min(estimate × 1.2, cap). estimate above the cap throws. */
export function explicitGasLimit(estimate: bigint, cap: bigint, kind: string): bigint {
  if (cap <= 0n) throw new SendSafeAbort(`gas cap for ${kind} is 0`, 'gas_cap');
  if (estimate <= 0n) throw new SendSafeAbort('estimateGas returned no gas', 'sim');
  if (estimate > cap) throw new SendSafeAbort(`gas estimate ${estimate} for ${kind} is above the ${cap} cap`, 'gas_cap');
  const padded = (estimate * 12n) / 10n;
  return padded > cap ? cap : padded;
}

/** Strip endpoints and registered secrets from a provider error before it leaves this module. */
export function sanitizeBroadcastError(e: unknown): string {
  const err = e as { message?: string; shortMessage?: string } | null;
  const raw = typeof err?.message === 'string' && err.message
    ? err.message
    : typeof err?.shortMessage === 'string' ? err.shortMessage : String(e ?? '');
  const stripped = raw
    .replace(/https?:\/\/[^\s)\]"'<>]+/gi, '[rpc]')
    .replace(/(?:api[_-]?key|apikey|key|token)=([^&\s]+)/gi, 'key=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  const red = redact(stripped);
  return (red.slice(0, 180) || 'broadcast failed');
}

function fail(o: SendSafeOpts, code: SendSafeCode, message: string): never {
  o.warn?.(`router send aborted (${o.kind}): ${message}`);
  throw new SendSafeAbort(message, code);
}

function rpcTx(tx: ExactTx) {
  return { from: tx.from, to: tx.to, data: tx.data, value: toQuantity(tx.value) };
}

function failureCode(e: unknown): 'revert' | 'rpc' {
  if (isRealRevert(e)) return 'revert';
  const msg = e instanceof Error ? e.message : String(e ?? '');
  // ethers wraps a dead RPC as CALL_EXCEPTION "missing revert data". That is not a revert.
  if (/missing revert data/i.test(msg)) return 'rpc';
  if (isTransportError(e)) return 'rpc';
  if (revertData(e)) return 'revert';
  if (/execution reverted/i.test(msg) || typeof (e as { reason?: unknown })?.reason === 'string') return 'revert';
  return 'rpc';
}

function abortFromRpc(o: SendSafeOpts, e: unknown): never {
  if (e instanceof GateBudget) throw e;
  if (e instanceof SendSafeAbort) fail(o, e.code, e.message);
  if (failureCode(e) === 'revert') fail(o, 'revert', decodeRevertReason(e));
  const detail = sanitizeBroadcastError(e);
  fail(o, 'rpc', detail && detail !== 'broadcast failed' ? `RPC request failed: ${detail}` : 'RPC request failed');
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
  if (m?.[1] && !/missing revert data/i.test(m[1]) && !/https?:\/\//i.test(m[1])) return clip(clean(m[1]));
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

function qtyOrNull(v: unknown): bigint | null {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  if (typeof v === 'bigint' && v >= 0n) return v;
  return null;
}

async function tryQty(o: SendSafeOpts, method: string, params: unknown[], deadline?: number): Promise<bigint | null> {
  try { return qtyOrNull(await rpc(o, deadline, method, params)); }
  catch (e) { if (e instanceof GateBudget) throw e; return null; }
}

/** Pay the suggestion, or abort. A lower tip would sit unmined and hold this chain's nonce. */
function payTip(o: SendSafeOpts, suggested: bigint): bigint {
  const cap = o.maxPriorityFeeWei;
  if (suggested < 0n) fail(o, 'fee', 'priority fee is negative');
  if (suggested > cap) fail(o, 'fee', `priority fee ${suggested} wei exceeds the ${cap} wei tip cap`);
  return suggested;
}

/** Lowest tenth of the sorted rewards. A median would follow a spike; the gas budget still caps the cost. */
function percentile10(sortedAsc: bigint[]): bigint {
  const i = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * 0.1));
  return sortedAsc[i]!;
}

/** eth_maxPriorityFeePerGas, else the 10th-percentile tip from eth_feeHistory. Never a guessed tip below the network. */
async function priorityFee(o: SendSafeOpts, deadline?: number): Promise<bigint> {
  const direct = await tryQty(o, 'eth_maxPriorityFeePerGas', [], deadline);
  if (direct != null) return payTip(o, direct);
  try {
    const hist = await rpc(o, deadline, 'eth_feeHistory', ['0xa', 'latest', [10]]) as { reward?: unknown };
    const tips: bigint[] = [];
    if (Array.isArray(hist?.reward)) {
      for (const row of hist.reward) {
        const cell = Array.isArray(row) ? row[0] : null;
        const n = qtyOrNull(cell);
        if (n != null) tips.push(n);
      }
    }
    tips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (tips.length) return payTip(o, percentile10(tips));
  } catch (e) { if (e instanceof GateBudget) throw e; /* no history: do not invent a tip */ }
  fail(o, 'fee', 'no priority fee from the chain');
}

async function resolveFee(o: SendSafeOpts, deadline?: number): Promise<Pick<Plan, 'unit' | 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'>> {
  let block: unknown;
  try { block = await rpc(o, deadline, 'eth_getBlockByNumber', ['latest', false]); }
  catch (e) { abortFromRpc(o, e); }
  if (!block || typeof block !== 'object') fail(o, 'rpc', 'RPC request failed: no latest block');
  const baseRaw = (block as { baseFeePerGas?: unknown }).baseFeePerGas;
  const base = qtyOrNull(baseRaw);
  if (base == null) {
    let gasPrice = await tryQty(o, 'eth_gasPrice', [], deadline);
    if (gasPrice == null) {
      try {
        const fee = deadline == null ? await o.reader.getFeeData() : await withinBudget(deadline, o.reader.getFeeData());
        gasPrice = fee.gasPrice ?? fee.maxFeePerGas;
      } catch (e) { abortFromRpc(o, e); }
    }
    if (gasPrice == null || gasPrice <= 0n) fail(o, 'fee', 'no gas price from the chain');
    return { gasPrice, unit: gasPrice };
  }
  const priority = await priorityFee(o, deadline);
  const maxFee = base * 2n + priority;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, unit: maxFee };
}

async function assess(o: SendSafeOpts, deadline?: number): Promise<Plan> {
  const tx = o.tx;
  try {
    const out = await rpc(o, deadline, 'eth_call', [rpcTx(tx), 'pending']);
    if (typeof out !== 'string') fail(o, 'sim', 'eth_call returned no result');
  } catch (e) {
    if (e instanceof SendSafeAbort || e instanceof GateBudget) throw e;
    abortFromRpc(o, e);
  }

  let estimate: bigint;
  try { estimate = asQuantity(await rpc(o, deadline, 'eth_estimateGas', [rpcTx(tx), 'pending'])); }
  catch (e) {
    if (e instanceof SendSafeAbort) fail(o, e.code, e.message);
    if (e instanceof GateBudget) throw e;
    abortFromRpc(o, e);
  }

  let gasLimit: bigint;
  try { gasLimit = explicitGasLimit(estimate, o.gasCap, o.kind); }
  catch (e) { if (e instanceof SendSafeAbort) fail(o, e.code, e.message); throw e; }

  const fee = await resolveFee(o, deadline);
  if (fee.unit > o.maxGasPriceWei) fail(o, 'fee', `gas price ${fee.unit} wei exceeds the ${o.maxGasPriceWei} wei cap`);
  const l1 = o.l1FeeWei ?? 0n;
  if (l1 < 0n) fail(o, 'fee', 'L1 fee is negative');
  const cost = fee.unit * gasLimit + l1;
  if (cost > o.gasBudgetWei) fail(o, 'fee', `gas cost ${cost} wei exceeds budget ${o.gasBudgetWei} wei`);
  return { gasLimit, ...fee };
}

function assertNotHalted(o: SendSafeOpts) {
  if (typeof o.halted !== 'function') fail(o, 'halt', 'halt check is missing');
  if (o.halted()) fail(o, 'halt', 'router halted before the nonce was taken');
}

type BroadcastKind = 'already_known' | 'timeout' | 'underpriced' | 'stale_nonce' | 'other';

function broadcastKind(e: unknown): BroadcastKind {
  const err = e as { code?: string; message?: string; shortMessage?: string };
  const code = String(err?.code ?? '');
  const msg = `${err?.shortMessage ?? ''} ${err?.message ?? e ?? ''}`.toLowerCase();
  if (code === 'REPLACEMENT_UNDERPRICED' || /replacement transaction underpriced|replacement fee too low|underpriced/.test(msg)) return 'underpriced';
  if (code === 'NONCE_EXPIRED' || /nonce too low|nonce has already been used|nonce expired|old nonce|stale nonce/.test(msg)) return 'stale_nonce';
  if (/already known|alreadyknown|known transaction/.test(msg)) return 'already_known';
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || /timeout|timed out|etimedout/.test(msg)) return 'timeout';
  return 'other';
}

function localHash(raw: string): string {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw) || (raw.length % 2) !== 0) {
    throw new SendSafeAbort('signer returned no signed transaction', 'broadcast');
  }
  return keccak256(raw);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function parseReceipt(v: unknown, expectHash: string): { status: number; hash: string; blockNumber: bigint | null } | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as { status?: string | number | null; transactionHash?: string; blockNumber?: unknown };
  let status: number | null = null;
  if (r.status === 1 || r.status === '0x1' || r.status === '0x01') status = 1;
  else if (r.status === 0 || r.status === '0x0' || r.status === '0x00') status = 0;
  if (status == null) return null;
  const hash = typeof r.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.transactionHash) ? r.transactionHash : expectHash;
  return { status, hash, blockNumber: qtyOrNull(r.blockNumber) };
}

interface MinedTx { hash?: string; from?: string; to?: string | null; nonce?: string | number; value?: string; input?: string; data?: string }

function nonceOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return Number(BigInt(v));
  return null;
}

function sameAddr(a: string | null | undefined, b: string) {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isCancel(tx: MinedTx, from: string): boolean {
  if (!sameAddr(tx.to, from)) return false;
  const value = qtyOrNull(tx.value) ?? 0n;
  const input = String(tx.input ?? tx.data ?? '0x').toLowerCase();
  return value === 0n && (input === '0x' || input === '0x0' || input === '');
}

function txsOf(block: unknown): MinedTx[] {
  const txs = (block as { transactions?: unknown } | null)?.transactions;
  if (!Array.isArray(txs)) return [];
  return txs.filter((t): t is MinedTx => !!t && typeof t === 'object');
}

function blockNum(block: unknown): bigint | null {
  return qtyOrNull((block as { number?: unknown } | null)?.number);
}

/** The nonce was mined under a different hash: cancelled (0-value self-send) or replaced. Never our confirmation. */
async function detectReplacement(o: SendSafeOpts, from: string, nonce: number, ourHash: string, deadline: number): Promise<Outcome | null> {
  const mined = await withinBudget(deadline, o.reader.getTransactionCount(from, 'latest'));
  if (mined <= nonce) return null;
  if (Date.now() >= deadline) throw new GateBudget();
  let block = await withinBudget(deadline, o.reader.send('eth_getBlockByNumber', ['latest', true]));
  let latest: bigint | null = null;
  for (let i = 0; i < BLOCK_SCAN && block; i++) {
    const n = blockNum(block);
    if (latest == null) latest = n;
    for (const tx of txsOf(block)) {
      if (!sameAddr(tx.from, from) || nonceOf(tx.nonce) !== nonce) continue;
      const hash = typeof tx.hash === 'string' ? tx.hash : '';
      // A missing or short hash is not a different transaction. Keep tracking ours.
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) continue;
      if (hash.toLowerCase() === ourHash.toLowerCase()) return null;
      // One block built on top, so a reorg of the tip cannot still drop it.
      if (n == null || latest == null || latest <= n) continue;
      const kind = isCancel(tx, from) ? 'cancelled' : 'replaced';
      return { status: kind, state: 'source_replaced', hash: ourHash, replacementHash: hash };
    }
    if (i + 1 >= BLOCK_SCAN) break;
    if (n == null || n <= 0n) break;
    if (Date.now() >= deadline) throw new GateBudget();
    block = await withinBudget(deadline, o.reader.send('eth_getBlockByNumber', [toQuantity(n - 1n), true]));
  }
  // Not in the recent window, only in the tip, or the reads did not name a different hash.
  return null;
}

async function waitOutcome(o: SendSafeOpts, from: string, hash: string, nonce: number, receiptDeadline: number): Promise<Outcome> {
  for (;;) {
    // Receipt wait stops here. The 60s after this mark is reserved for the known-tx check.
    if (Date.now() >= receiptDeadline) return budgetPending(hash);
    let receipt: { status: number; hash: string; blockNumber: bigint | null } | null = null;
    try { receipt = parseReceipt(await withinBudget(receiptDeadline, o.reader.send('eth_getTransactionReceipt', [hash])), hash); }
    catch (e) {
      if (e instanceof GateBudget) return budgetPending(hash);
      receipt = null;
    }
    if (receipt) {
      if (receipt.hash.toLowerCase() !== hash.toLowerCase()) {
        // Same depth as the block scan: the tip can still reorg, so one confirmation is required.
        try {
          if (await replacementConfirmed(o, receipt.blockNumber, receiptDeadline)) {
            return { status: 'replaced', state: 'source_replaced', hash, replacementHash: receipt.hash };
          }
        } catch (e) {
          if (e instanceof GateBudget) return budgetPending(hash);
          throw e;
        }
      } else {
        if (receipt.status !== 1) return { status: 'reverted', state: 'source_confirmed', hash };
        return { status: 'confirmed', state: 'source_confirmed', hash };
      }
    }
    try {
      const replaced = await detectReplacement(o, from, nonce, hash, receiptDeadline);
      if (replaced) return replaced;
    } catch (e) {
      if (e instanceof GateBudget) return budgetPending(hash);
      /* a read failed; keep waiting. Do not report this hash confirmed. */
    }
    await sleep(Math.min(250, Math.max(1, receiptDeadline - Date.now())));
  }
}

/** One confirmation deeper than the replacement's block. Missing depth stays unconfirmed. */
async function replacementConfirmed(o: SendSafeOpts, blockNumber: bigint | null, deadline: number): Promise<boolean> {
  if (blockNumber == null) return false;
  try {
    const latest = blockNum(await withinBudget(deadline, o.reader.send('eth_getBlockByNumber', ['latest', false])));
    return latest != null && latest > blockNumber;
  } catch (e) {
    if (e instanceof GateBudget) throw e;
    return false;
  }
}

function noMoreEndpoints(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'NO_ENDPOINT';
}

/** Rebroadcasts cannot spin. Each endpoint is one attempt; this caps a reader that never says it is done. */
const MAX_REBROADCASTS = 8;

async function submitRaw(o: SendSafeOpts, raw: string, receiptDeadline: number): Promise<void> {
  // The signature already exists. Refuse to start the send; broadcast() keeps that hash as pending.
  if (Date.now() >= receiptDeadline) throw new GateBudget();
  if (o.reader.broadcastRaw) await withinBudget(receiptDeadline, o.reader.broadcastRaw(raw));
  else await withinBudget(receiptDeadline, o.reader.send('eth_sendRawTransaction', [raw]));
}

/** Same signed bytes on each remaining endpoint. True once one accepts them or already has the hash. */
async function rebroadcast(o: SendSafeOpts, raw: string, hash: string, receiptDeadline: number, gateDeadline: number): Promise<boolean> {
  if (!o.reader.broadcastNext) return false;
  for (let n = 0; n < MAX_REBROADCASTS; n++) {
    if (Date.now() >= receiptDeadline) throw new GateBudget();
    try {
      await withinBudget(receiptDeadline, o.reader.broadcastNext(raw));
      return true;
    } catch (e) {
      if (e instanceof GateBudget) throw e;
      if (noMoreEndpoints(e)) return ourTxIsKnown(o, hash, gateDeadline);
      const kind = broadcastKind(e);
      if (kind === 'already_known') return true;
      if (kind === 'stale_nonce') {
        if (await ourTxIsKnown(o, hash, gateDeadline)) return true;
        throw e;
      }
      if (kind === 'timeout') {
        if (await ourTxIsKnown(o, hash, gateDeadline)) return true;
        continue;
      }
      throw e;
    }
  }
  return ourTxIsKnown(o, hash, gateDeadline);
}

/** The signed hash is already on an endpoint, so "nonce too low" is this tx, not a lost nonce. */
async function ourTxIsKnown(o: SendSafeOpts, hash: string, deadline: number): Promise<boolean> {
  if (o.reader.hasTx) {
    try { return await withinBudget(deadline, o.reader.hasTx(hash)); }
    catch (e) { if (e instanceof GateBudget) throw e; return false; }
  }
  try {
    const tx = await withinBudget(deadline, o.reader.send('eth_getTransactionByHash', [hash]));
    if (tx && typeof tx === 'object') return true;
  } catch (e) { if (e instanceof GateBudget) throw e; /* one endpoint missed it; a receipt may still exist */ }
  try {
    const receipt = await withinBudget(deadline, o.reader.send('eth_getTransactionReceipt', [hash]));
    if (receipt && typeof receipt === 'object') return true;
  } catch (e) { if (e instanceof GateBudget) throw e; /* not found */ }
  return false;
}

async function broadcast(o: SendSafeOpts, plan: Plan, nonce: number, receiptDeadline: number, gateDeadline: number): Promise<SendSafeResult> {
  // The nonce read uses the gate deadline and can finish after the receipt mark. Do not sign then.
  if (Date.now() >= receiptDeadline) {
    o.nonce.invalidate();
    fail(o, 'broadcast', 'nothing sent');
  }
  const tx = o.tx;
  const common = { to: tx.to, data: tx.data, value: tx.value, nonce, gasLimit: plan.gasLimit, chainId: o.chainId };
  const unsigned = plan.gasPrice != null
    ? { ...common, type: 0 as const, gasPrice: plan.gasPrice }
    : { ...common, type: 2 as const, maxFeePerGas: plan.maxFeePerGas, maxPriorityFeePerGas: plan.maxPriorityFeePerGas };
  let raw: string;
  try { raw = await o.signer.signTransaction(unsigned); }
  catch (e) {
    o.nonce.invalidate();
    if (e instanceof SendSafeAbort) fail(o, e.code, e.message);
    fail(o, 'broadcast', `could not sign: ${sanitizeBroadcastError(e)}`);
  }
  let hash: string;
  try { hash = localHash(raw); }
  catch (e) {
    o.nonce.invalidate();
    if (e instanceof SendSafeAbort) fail(o, e.code, e.message);
    throw e;
  }
  let unconfirmedTimeout = false;
  try {
    await submitRaw(o, raw, receiptDeadline);
  } catch (e) {
    if (e instanceof GateBudget) unconfirmedTimeout = true;
    else {
      try { await settleBroadcastError(e); }
      catch (e2) {
        if (e2 instanceof GateBudget) unconfirmedTimeout = true;
        else throw e2;
      }
    }
  }
  async function settleBroadcastError(e: unknown) {
    const kind = broadcastKind(e);
    if (kind === 'already_known' || (kind === 'stale_nonce' && await ourTxIsKnown(o, hash, gateDeadline))) {
      // These bytes are already out. Track the local hash.
    } else if (kind === 'timeout') {
      if (await ourTxIsKnown(o, hash, gateDeadline)) {
        // The response was lost after an endpoint accepted the bytes.
      } else {
        try {
          // Same signed bytes, next endpoint. A new signature would be a different transaction.
          const landed = await rebroadcast(o, raw, hash, receiptDeadline, gateDeadline);
          unconfirmedTimeout = !landed;
        } catch (e2) {
          if (e2 instanceof GateBudget) { unconfirmedTimeout = true; return; }
          o.nonce.invalidate();
          const k2 = broadcastKind(e2);
          if (k2 === 'underpriced') fail(o, 'underpriced', 'replacement underpriced; not resent');
          if (k2 === 'stale_nonce') fail(o, 'stale_nonce', 'nonce already used; not resent');
          fail(o, 'broadcast', sanitizeBroadcastError(e2));
        }
      }
    } else {
      o.nonce.invalidate();
      if (kind === 'underpriced') fail(o, 'underpriced', 'replacement underpriced; not resent');
      if (kind === 'stale_nonce') fail(o, 'stale_nonce', 'nonce already used; not resent');
      fail(o, 'broadcast', sanitizeBroadcastError(e));
    }
  }
  const outcome = await waitOutcome(o, tx.from, hash, nonce, receiptDeadline);
  // The token trader shares this nonce. A timeout that never showed up must not leave a gap.
  // Every timeout path, including a broadcast the receipt budget cut off, gets the reserved 60s
  // to ask whether any endpoint already has the hash. Drop the nonce only when all of them say no.
  if (unconfirmedTimeout && outcome.status === 'pending' && Date.now() < gateDeadline) {
    let known = true;
    try { known = await ourTxIsKnown(o, hash, gateDeadline); }
    catch (e) { if (!(e instanceof GateBudget)) throw e; }
    if (!known) o.nonce.invalidate();
  }
  return { ...outcome, gasLimit: plan.gasLimit, nonce };
}

export async function sendSafe(o: SendSafeOpts): Promise<SendSafeResult> {
  const tx = o.tx;
  if (!ADDR.test(tx.from) || !ADDR.test(tx.to)) fail(o, 'sim', 'from and to must be 0x addresses');
  if (!DATA.test(tx.data)) fail(o, 'sim', 'data must be hex');
  if (typeof tx.value !== 'bigint' || tx.value < 0n) fail(o, 'sim', 'value must be a non-negative amount');
  if (!Number.isInteger(o.chainId) || o.chainId <= 0) fail(o, 'sim', 'chain id is missing');
  if (typeof o.maxGasPriceWei !== 'bigint' || o.maxGasPriceWei <= 0n) fail(o, 'fee', 'gas price cap is missing');
  if (typeof o.maxPriorityFeeWei !== 'bigint' || o.maxPriorityFeeWei <= 0n) fail(o, 'fee', 'priority fee cap is missing');
  if (typeof o.halted !== 'function') fail(o, 'halt', 'halt check is missing');

  // Refuse before any read when Stop all already landed. A send that is only queued later is checked inside the gate.
  assertNotHalted(o);
  await assess(o);

  // One send, inside the chain gate, with the shared nonce. The wait stays in the gate (same as a bot fill).
  // The deadline is fixed here: capped receipt wait plus 60s, checked before every later read.
  return o.gate.run(async () => {
    const deadlines = sendDeadlines(o.receiptTimeoutMs);
    try {
      assertNotHalted(o);
      const plan = await assess(o, deadlines.gate);
      // Assess uses the gate deadline, so it can return after the receipt mark. Nothing is signed yet.
      if (Date.now() >= deadlines.receipt) fail(o, 'broadcast', 'nothing sent');
      // Same place a bot send reads canSend: after the gate is held, before the nonce is taken.
      assertNotHalted(o);
      const nonce = await o.nonce.next(() => withinBudget(deadlines.gate, o.reader.getTransactionCount(tx.from, 'pending')));
      return await broadcast(o, plan, nonce, deadlines.receipt, deadlines.gate);
    } catch (e) {
      // Nothing was signed. A pending/source_sent result would look like in-transit money.
      if (e instanceof GateBudget) fail(o, 'broadcast', 'nothing sent');
      throw e;
    }
  });
}
