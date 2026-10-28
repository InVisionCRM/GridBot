/**
 * sendSafe: eth_call at pending, gas cap, explicit gasLimit, one send through the shared gate and nonce.
 * Fees, halt, replacement and broadcast errors are checked here. No second broadcast. No real RPC.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Interface, keccak256, toQuantity } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { requestHalt } from '../src/server/bot/audit';
import type { SentTx } from '../src/server/bot/chain';
import { MemoryStore } from '../src/server/bot/store';
import { SharedNonce, TxGate } from '../src/server/bot/txGate';
import { FallbackReader } from '../src/server/chains/fallback';
import { Router, type RouterFile } from '../src/server/router/router';
import { DEFAULT_MAX_GAS_PRICE_WEI, DEFAULT_MAX_PRIORITY_FEE_WEI } from '../src/server/router/settings';
import { GATE_SLACK_MS, RECEIPT_TIMEOUT_CAP_MS, routerSendHalted, sendSafe, type ExactTx, type GasSender, type SafeReader } from '../src/server/router/sendSafe';

const FROM = '0x1234567890123456789012345678901234567890';
const TO = '0x2222222222222222222222222222222222222222';
const ERR = new Interface(['error Error(string)']);
const GWEI = 1_000_000_000n;

class Rpc implements SafeReader {
  calls: { method: string; params: unknown[] }[] = [];
  estimate = 100_000n;
  revert: unknown = null;
  /** null = a legacy chain, no baseFeePerGas. */
  baseFee: bigint | null = 40n;
  priority: bigint | null = 20n;
  priorityError: unknown = null;
  feeHistory: { reward: string[][] } | null = null;
  gasPriceWei = 100n;
  pending = 4;
  /** Transactions mined. Greater than the send's nonce means that nonce was included. */
  mined = 0;
  reads = 0;
  broadcasts: string[] = [];
  broadcastError: unknown = null;
  receipt: { status: number; transactionHash?: string; blockNumber?: number } | null | 'throw' = { status: 1 };
  blockTxs: Record<string, unknown>[] = [];
  /** When set, full-block reads use this instead of blockTxs. The argument is the block number. */
  blockTxsAt: ((n: number) => Record<string, unknown>[]) | null = null;
  blockNumber = 16;
  onEstimate: (() => void) | null = null;
  onBlock: (() => void) | null = null;

  async send(method: string, params: unknown[]) {
    this.calls.push({ method, params });
    if (method === 'eth_call') {
      if (this.revert) throw this.revert;
      return '0x';
    }
    if (method === 'eth_estimateGas') {
      this.onEstimate?.();
      return toQuantity(this.estimate);
    }
    if (method === 'eth_getBlockByNumber') {
      this.onBlock?.();
      const num = params[0] === 'latest' ? this.blockNumber : Number(BigInt(String(params[0])));
      const block: Record<string, unknown> = { number: toQuantity(num) };
      if (this.baseFee != null) block.baseFeePerGas = toQuantity(this.baseFee);
      if (params[1] === true) block.transactions = this.blockTxsAt ? this.blockTxsAt(num) : this.blockTxs;
      return block;
    }
    if (method === 'eth_maxPriorityFeePerGas') {
      if (this.priorityError) throw this.priorityError;
      if (this.priority == null) throw new Error('method not found');
      return toQuantity(this.priority);
    }
    if (method === 'eth_feeHistory') {
      if (!this.feeHistory) throw new Error('method not found');
      return this.feeHistory;
    }
    if (method === 'eth_gasPrice') return toQuantity(this.gasPriceWei);
    if (method === 'eth_getTransactionByHash') return null;
    if (method === 'eth_sendRawTransaction') {
      this.broadcasts.push(String(params[0]));
      if (this.broadcastError) throw this.broadcastError;
      return '0x' + 'ab'.repeat(32);
    }
    if (method === 'eth_getTransactionReceipt') {
      if (this.receipt === 'throw') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      if (!this.receipt) return null;
      const hash = String(params[0]);
      const body: Record<string, unknown> = {
        status: this.receipt.status === 1 ? '0x1' : '0x0',
        transactionHash: this.receipt.transactionHash ?? hash,
        gasUsed: '0x1',
      };
      if (this.receipt.blockNumber != null) body.blockNumber = toQuantity(this.receipt.blockNumber);
      return body;
    }
    throw new Error(method);
  }
  async getFeeData() { return { gasPrice: this.gasPriceWei, maxFeePerGas: this.gasPriceWei }; }
  async getTransactionCount(_address: string, blockTag: 'pending' | 'latest') {
    if (blockTag === 'pending') { this.reads++; return this.pending; }
    if (blockTag === 'latest') return this.mined;
    throw new Error(`block tag ${blockTag}`);
  }
}

class Signer implements GasSender {
  signed: Parameters<GasSender['signTransaction']>[0][] = [];
  raws: string[] = [];
  /** A bot sharing the gate records its own send here. sendSafe signs, it does not call this. */
  sent: { nonce: number; gasLimit: bigint }[] = [];
  async getAddress() { return FROM; }
  async signTransaction(tx: Parameters<GasSender['signTransaction']>[0]) {
    this.signed.push(tx);
    const raw = ('0x' + Buffer.from(`signed-${this.raws.length}-${tx.nonce}-${tx.type}`).toString('hex'));
    this.raws.push(raw);
    return raw;
  }
  async sendTransaction(tx: { to: string; data: string; value: bigint; nonce: number; gasLimit: bigint }): Promise<SentTx> {
    this.sent.push(tx);
    return { hash: `0x${tx.nonce.toString(16).padStart(64, '0')}`, async wait() { return { status: 1, gasUsed: tx.gasLimit, logs: [] }; } };
  }
}

function harness(rpc = new Rpc(), signer = new Signer()) {
  const gate = new TxGate();
  const nonce = new SharedNonce();
  const tx: ExactTx = { from: FROM, to: TO, data: '0x1234', value: 0n };
  const go = (over: {
    gasCap?: bigint; gasBudgetWei?: bigint; l1FeeWei?: bigint; maxGasPriceWei?: bigint; maxPriorityFeeWei?: bigint;
    chainId?: number;
    kind?: 'bridge' | 'claim' | 'swap' | 'approve'; warn?: (m: string) => void; halted?: () => boolean;
  } = {}) => sendSafe({
    tx, kind: over.kind ?? 'bridge', chainId: over.chainId ?? 1, reader: rpc, signer, gate, nonce,
    gasCap: over.gasCap ?? 300_000n,
    gasBudgetWei: over.gasBudgetWei ?? 10n ** 18n,
    maxGasPriceWei: over.maxGasPriceWei ?? 10n ** 12n,
    maxPriorityFeeWei: over.maxPriorityFeeWei ?? 10n ** 12n,
    l1FeeWei: over.l1FeeWei,
    receiptTimeoutMs: 30,
    warn: over.warn,
    halted: over.halted ?? (() => false),
  });
  return { rpc, signer, gate, nonce, tx, go };
}

const hashOf = (signer: Signer, i = 0) => keccak256(signer.raws[i] as `0x${string}`);

/** Receipt waits use the gate budget (capped timeout + 60s). Advance a fake clock instead of sleeping it. */
async function withClock<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let settled = false;
    const pending = run().finally(() => { settled = true; });
    const budget = RECEIPT_TIMEOUT_CAP_MS + GATE_SLACK_MS + 1_000;
    // Step so a fast RPC rejection is seen before its budget timer.
    for (let left = budget; left > 0 && !settled; left -= 20) await vi.advanceTimersByTimeAsync(Math.min(20, left));
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('sendSafe', () => {
  it('aborts a revert with the decoded reason and does not send', async () => {
    const { rpc, signer, go } = harness();
    const secret = 'SECRETKEYVALUE123';
    rpc.revert = Object.assign(new Error(`https://rpc.example/${secret} execution reverted: ignored`), {
      code: 'CALL_EXCEPTION',
      data: ERR.encodeErrorResult('Error', ['bridge paused']),
      reason: null,
    });
    const warnings: string[] = [];
    await expect(go({ warn: (m) => warnings.push(m) })).rejects.toMatchObject({ code: 'revert', message: 'bridge paused' });
    expect(signer.raws).toHaveLength(0);
    expect(rpc.broadcasts).toHaveLength(0);
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_call']);
    expect(rpc.calls[0].params[1]).toBe('pending');
    expect(rpc.calls[0].params[0]).toMatchObject({ from: FROM, to: TO, data: '0x1234', value: '0x0' });
    expect(warnings.join('\n')).toContain('bridge paused');
    expect(warnings.join('\n')).not.toContain(secret);
    expect(warnings.join('\n')).not.toMatch(/https?:\/\//);
    expect(rpc.reads).toBe(0);
  });

  it('reports an RPC failure when every endpoint fails, not an execution revert', async () => {
    const { rpc, signer, go } = harness();
    const secret = 'SECRETKEYVALUE123';
    rpc.revert = Object.assign(new Error(`missing revert data https://rpc.example/${secret}`), {
      code: 'CALL_EXCEPTION',
      data: null,
      reason: null,
      info: { error: { code: -32603, message: 'Internal error' } },
    });
    const warnings: string[] = [];
    const err = await go({ warn: (m) => warnings.push(m) }).then(() => { throw new Error('expected a throw'); }, (e: Error & { code?: string }) => e);
    expect(err.code).toBe('rpc');
    expect(err.message).not.toBe('execution reverted');
    expect(err.message).toMatch(/RPC request failed/);
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toMatch(/https?:\/\//);
    expect(signer.raws).toHaveLength(0);
    expect(rpc.broadcasts).toHaveLength(0);
    expect(warnings.join('\n')).not.toContain(secret);
    expect(warnings.join('\n')).not.toMatch(/https?:\/\//);

    const network = harness();
    network.rpc.revert = Object.assign(new Error(`failed to detect network https://rpc.example/${secret}`), { code: 'NETWORK_ERROR' });
    const netErr = await network.go().then(() => { throw new Error('expected a throw'); }, (e: Error & { code?: string }) => e);
    expect(netErr.code).toBe('rpc');
    expect(netErr.message).not.toBe('execution reverted');
    expect(netErr.message).not.toContain(secret);
    expect(network.rpc.broadcasts).toHaveLength(0);
  });

  it('aborts when estimateGas is above the cap', async () => {
    const { rpc, signer, go } = harness();
    rpc.estimate = 400_000n;
    await expect(go({ gasCap: 300_000n, kind: 'bridge' })).rejects.toThrow('gas estimate 400000 for bridge is above the 300000 cap');
    expect(signer.raws).toHaveLength(0);
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_call', 'eth_estimateGas']);
    expect(rpc.reads).toBe(0);
  });

  it('sets gasLimit to min(estimate × 1.2, cap) and prices a 1559 tx as 2×base + a clamped tip', async () => {
    const h = harness();
    h.rpc.estimate = 100_000n;
    const ok = await h.go({ gasCap: 300_000n, gasBudgetWei: 12_000_000n });
    expect(ok.status).toBe('confirmed');
    expect(ok.hash).toBe(hashOf(h.signer));
    expect(h.signer.signed[0].gasLimit).toBe(120_000n);
    expect(h.signer.signed[0].type).toBe(2);
    expect(h.signer.signed[0].maxPriorityFeePerGas).toBe(20n);
    expect(h.signer.signed[0].maxFeePerGas).toBe(100n);
    expect(h.signer.signed[0].maxPriorityFeePerGas).not.toBe(h.signer.signed[0].maxFeePerGas);
    expect(h.signer.signed[0].gasPrice).toBeUndefined();
    const sim = h.rpc.calls.filter((c) => c.method === 'eth_call' || c.method === 'eth_estimateGas');
    expect(sim.every((c) => c.params[1] === 'pending')).toBe(true);
    expect(h.rpc.calls.filter((c) => c.method === 'eth_call')).toHaveLength(2);

    const capped = harness();
    capped.rpc.estimate = 280_000n;
    await capped.go({ gasCap: 300_000n, gasBudgetWei: 300_000n * 100n });
    expect(capped.signer.signed[0].gasLimit).toBe(300_000n);

    const fee = harness();
    fee.rpc.estimate = 100_000n;
    await expect(fee.go({ gasBudgetWei: 12_000_000n - 1n })).rejects.toThrow(/exceeds budget/);
    expect(fee.signer.raws).toHaveLength(0);
    await expect(fee.go({ gasBudgetWei: 12_000_000n, l1FeeWei: 1n })).rejects.toThrow(/exceeds budget/);
    expect(fee.signer.raws).toHaveLength(0);
  });

  it('aborts when the suggested tip is above the chain cap instead of underpaying', async () => {
    const cap = DEFAULT_MAX_PRIORITY_FEE_WEI[1];
    const h = harness();
    h.rpc.baseFee = 30n * GWEI;
    h.rpc.priority = cap + 1n;
    await expect(h.go({
      maxPriorityFeeWei: cap,
      maxGasPriceWei: DEFAULT_MAX_GAS_PRICE_WEI[1],
      gasBudgetWei: DEFAULT_MAX_GAS_PRICE_WEI[1] * 300_000n,
    })).rejects.toMatchObject({ code: 'fee' });
    expect(h.signer.raws).toHaveLength(0);
    expect(h.rpc.broadcasts).toHaveLength(0);
    expect(h.rpc.reads).toBe(0);

    const later = harness();
    later.rpc.baseFee = 30n * GWEI;
    later.rpc.priority = 2n * GWEI;
    let tips = 0;
    const orig = later.rpc.send.bind(later.rpc);
    later.rpc.send = async (method, params) => {
      if (method === 'eth_maxPriorityFeePerGas') {
        tips++;
        if (tips >= 2) return toQuantity(cap + 1n);
      }
      return orig(method, params);
    };
    await expect(later.go({
      maxPriorityFeeWei: cap,
      maxGasPriceWei: DEFAULT_MAX_GAS_PRICE_WEI[1],
      gasBudgetWei: DEFAULT_MAX_GAS_PRICE_WEI[1] * 300_000n,
    })).rejects.toMatchObject({ code: 'fee' });
    expect(tips).toBeGreaterThanOrEqual(2);
    expect(later.rpc.reads).toBe(0);
    expect(later.signer.raws).toHaveLength(0);
  });

  it('pays a PulseChain-sized tip and does not clamp it to 5 gwei', async () => {
    const tip = 33_525n * GWEI;
    const cap = DEFAULT_MAX_PRIORITY_FEE_WEI[369];
    const gasCap = DEFAULT_MAX_GAS_PRICE_WEI[369];
    expect(cap).toBeGreaterThan(tip);
    expect(cap).toBeGreaterThan(5n * GWEI);
    const h = harness();
    h.rpc.baseFee = 80_000n * GWEI;
    h.rpc.priority = tip;
    const ok = await h.go({
      chainId: 369,
      maxPriorityFeeWei: cap,
      maxGasPriceWei: gasCap,
      gasBudgetWei: gasCap * 300_000n,
    });
    expect(ok.status).toBe('confirmed');
    expect(h.signer.signed[0].maxPriorityFeePerGas).toBe(tip);
    expect(h.signer.signed[0].maxFeePerGas).toBe(160_000n * GWEI + tip);
    expect(h.signer.signed[0].maxPriorityFeePerGas).not.toBe(h.signer.signed[0].maxFeePerGas);
    expect(h.signer.signed[0].maxPriorityFeePerGas).toBeGreaterThan(5n * GWEI);

    const zero = harness();
    zero.rpc.baseFee = 10n;
    zero.rpc.priority = 0n;
    await zero.go({ maxPriorityFeeWei: 2n * GWEI });
    expect(zero.signer.signed[0].maxPriorityFeePerGas).toBe(0n);
    expect(zero.signer.signed[0].maxFeePerGas).toBe(20n);

    const missing = harness();
    missing.rpc.priorityError = new Error('the method eth_maxPriorityFeePerGas does not exist');
    missing.rpc.feeHistory = null;
    await expect(missing.go()).rejects.toMatchObject({ code: 'fee', message: 'no priority fee from the chain' });
    expect(missing.rpc.broadcasts).toHaveLength(0);
    expect(missing.rpc.reads).toBe(0);
  });

  it('uses the 10th-percentile feeHistory tip when eth_maxPriorityFeePerGas is missing', async () => {
    const h = harness();
    h.rpc.priorityError = new Error('the method eth_maxPriorityFeePerGas does not exist');
    h.rpc.baseFee = 10n;
    h.rpc.feeHistory = { reward: [['0x5'], ['0x1'], ['0x3'], ['0x9'], ['0x64']] };
    await h.go();
    expect(h.rpc.calls.find((c) => c.method === 'eth_feeHistory')?.params[2]).toEqual([10]);
    // Sorted 1, 3, 5, 9, 100. The 10th percentile is 1; the median is 5.
    expect(h.signer.signed[0].maxPriorityFeePerGas).toBe(1n);
    expect(h.signer.signed[0].maxFeePerGas).toBe(21n);
  });

  it('puts gasPrice on a legacy chain and leaves the 1559 fields empty', async () => {
    const h = harness();
    h.rpc.baseFee = null;
    h.rpc.gasPriceWei = 123n;
    const ok = await h.go({ maxGasPriceWei: 200n, gasBudgetWei: 123n * 120_000n });
    expect(ok.status).toBe('confirmed');
    expect(h.signer.signed[0].type).toBe(0);
    expect(h.signer.signed[0].gasPrice).toBe(123n);
    expect(h.signer.signed[0].maxFeePerGas).toBeUndefined();
    expect(h.signer.signed[0].maxPriorityFeePerGas).toBeUndefined();
  });

  it('aborts when the per-gas price is above the chain cap, including after the gate', async () => {
    const early = harness();
    await expect(early.go({ maxGasPriceWei: 99n })).rejects.toThrow(/gas price 100 wei exceeds the 99 wei cap/);
    expect(early.signer.raws).toHaveLength(0);
    expect(early.rpc.reads).toBe(0);
    expect(early.rpc.broadcasts).toHaveLength(0);

    const later = harness();
    later.rpc.onBlock = () => {
      const n = later.rpc.calls.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[1] === false).length;
      if (n >= 2) later.rpc.baseFee = 1_000n;
    };
    await expect(later.go({ maxGasPriceWei: 150n })).rejects.toThrow(/exceeds the 150 wei cap/);
    expect(later.rpc.reads).toBe(0);
    expect(later.rpc.broadcasts).toHaveLength(0);
    expect(later.signer.raws).toHaveLength(0);
  });

  it('re-runs the simulation inside the gate and aborts when the new estimate exceeds the cap', async () => {
    const h = harness();
    let n = 0;
    h.rpc.onEstimate = () => { n++; if (n >= 2) h.rpc.estimate = 400_000n; };
    await expect(h.go()).rejects.toMatchObject({ code: 'gas_cap' });
    expect(n).toBe(2);
    expect(h.rpc.reads).toBe(0);
    expect(h.rpc.broadcasts).toHaveLength(0);
  });

  it('shares nonce order with a bot send through the same gate', async () => {
    const h = harness();
    h.rpc.pending = 4;
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let mark!: () => void;
    const inside = new Promise<void>((r) => { mark = r; });
    const bot = h.gate.run(async () => {
      const n = await h.nonce.next(() => h.rpc.getTransactionCount(FROM, 'pending'));
      mark();
      await hold;
      await h.signer.sendTransaction({ to: TO, data: '0x', value: 0n, nonce: n, gasLimit: 21_000n });
      return n;
    });
    await inside;
    expect(h.gate.busy).toBe(true);
    const safe = h.go();
    release();
    const [botNonce, result] = await Promise.all([bot, safe]);
    expect(botNonce).toBe(4);
    expect(result.nonce).toBe(5);
    expect(result.status).toBe('confirmed');
    expect(h.signer.sent.map((t) => t.nonce)).toEqual([4]);
    expect(h.signer.signed.map((t) => t.nonce)).toEqual([5]);
    expect(h.signer.signed.map((t) => t.gasLimit)).toEqual([120_000n]);
    expect(h.rpc.reads).toBe(1);
  });

  it('Stop all while the send is queued behind a bot tx aborts before the nonce', async () => {
    const h = harness();
    const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: [1] });
    router.update({ mode: 'live', maxPerMoveUsd: 10, maxPerDayUsd: 20, allowedChains: [1], allowedBridges: ['across'] });
    router.turnOn();
    expect(routerSendHalted(router)()).toBe(false);
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let mark!: () => void;
    const inside = new Promise<void>((r) => { mark = r; });
    const bot = h.gate.run(async () => {
      const n = await h.nonce.next(() => h.rpc.getTransactionCount(FROM, 'pending'));
      mark();
      await hold;
      return n;
    });
    await inside;
    const real = h.gate.run.bind(h.gate);
    let queued!: () => void;
    const queuedP = new Promise<void>((r) => { queued = r; });
    h.gate.run = ((fn: () => Promise<unknown>) => {
      queued();
      return real(fn);
    }) as typeof h.gate.run;
    const safe = h.go({ halted: routerSendHalted(router) });
    await queuedP;
    expect(router.isHalted()).toBe(false);
    router.halt(requestHalt('stop-all', 'POST /api/bot/stop-all', Date.now()));
    expect(router.isHalted()).toBe(true);
    release();
    await expect(safe).rejects.toMatchObject({ code: 'halt' });
    expect(await bot).toBe(4);
    expect(h.rpc.reads).toBe(1);
    expect(h.signer.raws).toHaveLength(0);
    expect(h.rpc.broadcasts).toHaveLength(0);

    const during = harness();
    let halted = false;
    let n = 0;
    during.rpc.onEstimate = () => { n++; if (n >= 2) halted = true; };
    await expect(during.go({ halted: () => halted })).rejects.toMatchObject({ code: 'halt' });
    expect(during.rpc.reads).toBe(0);
    expect(during.signer.raws).toHaveLength(0);
  });

  it('a timeout is pending source_sent with the locally computed hash and is not resent', async () => {
    const h = harness();
    h.rpc.receipt = null;
    const first = await withClock(() => h.go());
    expect(first.status).toBe('pending');
    expect(first.state).toBe('source_sent');
    expect(first.hash).toBe(hashOf(h.signer));
    expect(h.rpc.broadcasts).toHaveLength(1);
    const second = await withClock(() => h.go());
    expect(second.nonce).toBe(first.nonce + 1);
    expect(second.state).toBe('source_sent');
    expect(second.hash).toBe(hashOf(h.signer, 1));
    expect(h.rpc.broadcasts).toHaveLength(2);
    expect(h.rpc.reads).toBe(1);

    const thrown = harness();
    thrown.rpc.receipt = 'throw';
    const pending = await withClock(() => thrown.go());
    expect(pending).toMatchObject({ status: 'pending', state: 'source_sent' });
    expect(pending.hash).toBe(hashOf(thrown.signer));
    expect(thrown.rpc.broadcasts).toHaveLength(1);
  }, 5_000);

  it('already known and a send timeout still return the hash of the signed bytes', async () => {
    const secret = 'SECRETKEYVALUE123';
    const known = harness();
    known.rpc.broadcastError = new Error(`already known https://rpc.example/${secret}`);
    known.rpc.receipt = null;
    const pending = await withClock(() => known.go());
    expect(pending).toMatchObject({ status: 'pending', state: 'source_sent' });
    expect(pending.hash).toBe(hashOf(known.signer));
    expect(known.rpc.broadcasts).toHaveLength(1);

    const mined = harness();
    mined.rpc.broadcastError = new Error('already known');
    const confirmed = await mined.go();
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.hash).toBe(hashOf(mined.signer));
    expect(mined.rpc.broadcasts).toHaveLength(1);

    const timed = harness();
    timed.rpc.broadcastError = Object.assign(new Error(`request timed out https://rpc.example/${secret}`), { code: 'TIMEOUT' });
    timed.rpc.receipt = null;
    const out = await withClock(() => timed.go());
    expect(out).toMatchObject({ status: 'pending', state: 'source_sent' });
    expect(out.hash).toBe(hashOf(timed.signer));
    expect(timed.rpc.broadcasts).toHaveLength(1);
    expect(`${out.status} ${out.state} ${out.hash} ${out.replacementHash ?? ''}`).not.toContain(secret);
  });

  it('does not resend an underpriced replacement or a stale nonce, and strips the endpoint from other broadcast errors', async () => {
    const secret = 'SECRETKEYVALUE123';
    const under = harness();
    under.rpc.broadcastError = Object.assign(
      new Error(`replacement transaction underpriced https://rpc.example/${secret}`),
      { code: 'REPLACEMENT_UNDERPRICED' },
    );
    const warnings: string[] = [];
    await expect(under.go({ warn: (m) => warnings.push(m) })).rejects.toMatchObject({
      code: 'underpriced', message: 'replacement underpriced; not resent',
    });
    expect(under.rpc.broadcasts).toHaveLength(1);
    expect(under.signer.raws).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain(secret);
    expect(warnings.join('\n')).not.toMatch(/https?:\/\//);

    const stale = harness();
    stale.rpc.receipt = null;
    stale.rpc.broadcastError = Object.assign(new Error(`nonce too low https://rpc.example/${secret}`), { code: 'NONCE_EXPIRED' });
    const staleErr = await stale.go().then(() => { throw new Error('expected a throw'); }, (e: Error & { code?: string }) => e);
    expect(staleErr).toMatchObject({ code: 'stale_nonce', message: 'nonce already used; not resent' });
    expect(staleErr.message).not.toContain(secret);
    expect(stale.rpc.broadcasts).toHaveLength(1);
    expect(stale.signer.raws).toHaveLength(1);

    const other = harness();
    other.rpc.broadcastError = new Error(`could not coalesce error https://rpc.example/${secret}`);
    const otherErr = await other.go().then(() => { throw new Error('expected a throw'); }, (e: Error & { code?: string }) => e);
    expect(otherErr.code).toBe('broadcast');
    expect(otherErr.message).not.toContain(secret);
    expect(otherErr.message).not.toMatch(/https?:\/\//);
    expect(otherErr.message).toMatch(/could not coalesce error/);
    expect(other.rpc.broadcasts).toHaveLength(1);
  });

  it('reports replaced or cancelled when the nonce is mined under a different hash', async () => {
    const other = '0x' + 'cd'.repeat(32);
    const replaced = harness();
    replaced.rpc.receipt = null;
    replaced.rpc.pending = 4;
    replaced.rpc.mined = 5;
    replaced.rpc.blockTxs = [{ hash: other, from: FROM, to: TO, nonce: '0x4', value: '0x1', input: '0xabcdef' }];
    const rep = await replaced.go();
    expect(rep.status).toBe('replaced');
    expect(rep.state).toBe('source_replaced');
    expect(rep.hash).toBe(hashOf(replaced.signer));
    expect(rep.hash).not.toBe(other);
    expect(rep.replacementHash).toBe(other);
    expect(rep.status).not.toBe('confirmed');

    const cancel = harness();
    cancel.rpc.receipt = null;
    cancel.rpc.pending = 4;
    cancel.rpc.mined = 5;
    cancel.rpc.blockTxs = [{ hash: other, from: FROM, to: FROM, nonce: '0x4', value: '0x0', input: '0x' }];
    const cancelled = await cancel.go();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.hash).toBe(hashOf(cancel.signer));
    expect(cancelled.hash).not.toBe(other);
    expect(cancelled.replacementHash).toBe(other);

    const foreign = harness();
    foreign.rpc.blockNumber = 16;
    foreign.rpc.receipt = { status: 1, transactionHash: other, blockNumber: 10 };
    const mined = await foreign.go();
    expect(mined.status).toBe('replaced');
    expect(mined.hash).toBe(hashOf(foreign.signer));
    expect(mined.hash).not.toBe(other);
    expect(mined.status).not.toBe('confirmed');

    const unseen = harness();
    unseen.rpc.receipt = null;
    unseen.rpc.pending = 4;
    unseen.rpc.mined = 5;
    unseen.rpc.blockNumber = 20;
    unseen.rpc.blockTxs = [{ hash: other, from: '0x' + '33'.repeat(20), to: TO, nonce: '0x4', value: '0x1', input: '0xab' }];
    const gone = await withClock(() => unseen.go());
    expect(gone.status).toBe('pending');
    expect(gone.state).toBe('source_sent');
    expect(gone.replacementHash).toBeUndefined();
    expect(gone.hash).toBe(hashOf(unseen.signer));
    expect(gone.status).not.toBe('replaced');
    expect(gone.status).not.toBe('confirmed');
    const scans = unseen.rpc.calls.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[1] === true);
    expect(scans.length).toBeGreaterThanOrEqual(8);
    expect(scans.length % 8).toBe(0);

    const unread = harness();
    unread.rpc.receipt = 'throw';
    unread.rpc.mined = 9;
    unread.rpc.blockNumber = 20;
    const orig = unread.rpc.send.bind(unread.rpc);
    unread.rpc.send = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[1] === true) throw new Error('block read failed');
      return orig(method, params);
    };
    const pending = await withClock(() => unread.go());
    expect(pending.status).toBe('pending');
    expect(pending.state).toBe('source_sent');
    expect(pending.hash).toBe(hashOf(unread.signer));
    expect(pending.status).not.toBe('replaced');
    expect(pending.status).not.toBe('confirmed');
  });

  it('wires router.isHalted into the halted check, and blocks off and paper', async () => {
    const router = new Router({ store: new MemoryStore<RouterFile>(), host: true, chainIds: [1] });
    const halted = routerSendHalted(router);
    const src = readFileSync(new URL('../src/server/router/sendSafe.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function routerSendHalted'), src.indexOf('export type SendSafeStatus'));
    expect(body).toMatch(/router\.isHalted\(\)/);
    expect(body).toMatch(/mode !== 'live'/);
    expect(body).toMatch(/s\.on !== true/);
    expect(halted.toString()).toMatch(/\.isHalted\s*\(/);
    expect(router.status()).toMatchObject({ on: false, mode: 'paper' });
    expect(router.isHalted()).toBe(false);
    expect(halted()).toBe(true);
    router.turnOn();
    expect(router.status().mode).toBe('paper');
    expect(halted()).toBe(true);
    router.update({ mode: 'live', maxPerMoveUsd: 10, maxPerDayUsd: 20, allowedChains: [1], allowedBridges: ['across'] });
    router.turnOn();
    expect(router.status()).toMatchObject({ on: true, mode: 'live' });
    expect(halted()).toBe(false);
    const h = harness();
    const ok = await h.go({ halted });
    expect(ok.status).toBe('confirmed');
    router.halt(requestHalt('stop-all', 'POST /api/bot/stop-all', 1));
    expect(router.status().on).toBe(false);
    expect(router.isHalted()).toBe(true);
    expect(halted()).toBe(true);
    await expect(h.go({ halted })).rejects.toMatchObject({ code: 'halt' });
    expect(h.rpc.reads).toBe(1);
  });

  it('does not rotate a broadcast, and a nonce-already-used answer is this tx when the hash is known', async () => {
    const known = new Set<string>();
    const raws: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const counts = { n: 0 };
    const endpoint = (name: 'a' | 'b', onRaw: (raw: string) => never) => ({
      async send(method: string, params: unknown[]) {
        if (method === 'eth_sendRawTransaction') {
          raws[name].push(String(params[0]));
          return onRaw(String(params[0]));
        }
        if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
          const hash = String(params[0]);
          if (!known.has(hash)) return null;
          if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash, gasUsed: '0x1' };
          return { hash };
        }
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        throw new Error(method);
      },
      async getTransactionCount() { counts.n++; return 4; },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
    });
    const a = endpoint('a', (raw) => {
      known.add(keccak256(raw as `0x${string}`));
      throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    });
    const b = endpoint('b', () => {
      throw Object.assign(new Error('nonce already used'), { code: 'NONCE_EXPIRED' });
    });
    const reader = new FallbackReader(
      ['https://rpc.example/a', 'https://rpc.example/b'], 1,
      [a, b] as unknown as ConstructorParameters<typeof FallbackReader>[2],
    );
    const signer = new Signer();
    const gate = new TxGate();
    const nonce = new SharedNonce();
    const tx: ExactTx = { from: FROM, to: TO, data: '0x1234', value: 0n };
    const once = () => sendSafe({
      tx, kind: 'bridge', chainId: 1, reader, signer, gate, nonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      receiptTimeoutMs: 30, halted: () => false,
    });
    const first = await once();
    expect(first.status).toBe('confirmed');
    expect(first.hash).toBe(hashOf(signer));
    expect(raws.a).toHaveLength(1);
    expect(raws.b).toHaveLength(0);
    expect(first.nonce).toBe(4);
    const second = await once();
    expect(second.nonce).toBe(5);
    expect(counts.n).toBe(1);
    expect(raws.b).toHaveLength(0);

    const stuck = new Set<string>();
    let lookups = 0;
    const solo = {
      raw: [] as string[],
      async send(method: string, params: unknown[]) {
        if (method === 'eth_sendRawTransaction') {
          this.raw.push(String(params[0]));
          stuck.add(keccak256(String(params[0]) as `0x${string}`));
          throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
        }
        if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
          lookups++;
          const hash = String(params[0]);
          if (!stuck.has(hash)) return null;
          if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash, gasUsed: '0x1' };
          return { hash };
        }
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        throw new Error(method);
      },
      async getTransactionCount() { return 7; },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
    };
    const soloReader = new FallbackReader(
      ['https://rpc.example/solo'], 1,
      [solo] as unknown as ConstructorParameters<typeof FallbackReader>[2],
    );
    const soloSigner = new Signer();
    const soloNonce = new SharedNonce();
    const accepted = await sendSafe({
      tx, kind: 'bridge', chainId: 1, reader: soloReader, signer: soloSigner, gate: new TxGate(), nonce: soloNonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      receiptTimeoutMs: 30, halted: () => false,
    });
    expect(accepted.status).toBe('confirmed');
    expect(accepted.hash).toBe(hashOf(soloSigner));
    expect(solo.raw).toHaveLength(1);
    expect(lookups).toBeGreaterThan(0);
    const next = await sendSafe({
      tx, kind: 'bridge', chainId: 1, reader: soloReader, signer: soloSigner, gate: new TxGate(), nonce: soloNonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      receiptTimeoutMs: 30, halted: () => false,
    });
    expect(next.nonce).toBe(accepted.nonce + 1);
  });

  it('refuses a send when the tip cap or the halt check is missing', async () => {
    const h = harness();
    await expect(h.go({ maxPriorityFeeWei: 0n })).rejects.toMatchObject({ code: 'fee', message: 'priority fee cap is missing' });
    expect(h.rpc.calls).toHaveLength(0);
    expect(h.rpc.reads).toBe(0);
    await expect(sendSafe({
      tx: h.tx, kind: 'bridge', chainId: 1, reader: h.rpc, signer: h.signer, gate: h.gate, nonce: h.nonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      halted: undefined as unknown as () => boolean,
    })).rejects.toMatchObject({ code: 'halt', message: 'halt check is missing' });
    expect(h.rpc.broadcasts).toHaveLength(0);
  });

  it('does not treat a missing or short hash as a replacement, and waits for one confirmation', async () => {
    const other = '0x' + 'cd'.repeat(32);
    const bad = harness();
    bad.rpc.receipt = null;
    bad.rpc.pending = 4;
    bad.rpc.mined = 5;
    bad.rpc.blockNumber = 20;
    bad.rpc.blockTxs = [
      { from: FROM, to: TO, nonce: '0x4', value: '0x1', input: '0xab' },
      { hash: '0xdead', from: FROM, to: TO, nonce: '0x4', value: '0x1', input: '0xab' },
    ];
    const unseen = await withClock(() => bad.go());
    expect(unseen.status).toBe('pending');
    expect(unseen.state).toBe('source_sent');
    expect(unseen.replacementHash).toBeUndefined();
    expect(unseen.hash).toBe(hashOf(bad.signer));

    const tipOnly = harness();
    tipOnly.rpc.receipt = null;
    tipOnly.rpc.pending = 4;
    tipOnly.rpc.mined = 5;
    tipOnly.rpc.blockNumber = 20;
    tipOnly.rpc.blockTxsAt = (n) => (n === 20
      ? [{ hash: other, from: FROM, to: TO, nonce: '0x4', value: '0x1', input: '0xabcdef' }]
      : []);
    const tip = await withClock(() => tipOnly.go());
    expect(tip.status).toBe('pending');
    expect(tip.replacementHash).toBeUndefined();

    const buried = harness();
    buried.rpc.receipt = null;
    buried.rpc.pending = 4;
    buried.rpc.mined = 5;
    buried.rpc.blockNumber = 20;
    buried.rpc.blockTxsAt = (n) => (n === 19
      ? [{ hash: other, from: FROM, to: TO, nonce: '0x4', value: '0x1', input: '0xabcdef' }]
      : []);
    const rep = await buried.go();
    expect(rep.status).toBe('replaced');
    expect(rep.replacementHash).toBe(other);
    expect(rep.hash).toBe(hashOf(buried.signer));
  });

  it('hasTx finds a hash that only a later endpoint has', async () => {
    const hash = '0x' + 'ab'.repeat(32);
    let first = 0;
    let second = 0;
    const a = {
      async send(method: string) {
        if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') { first++; return null; }
        throw new Error(method);
      },
    };
    const b = {
      async send(method: string, params: unknown[]) {
        if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
          second++;
          return method === 'eth_getTransactionByHash' && params[0] === hash ? { hash } : null;
        }
        throw new Error(method);
      },
    };
    const reader = new FallbackReader(
      ['https://rpc.example/a', 'https://rpc.example/b'], 1,
      [a, b] as unknown as ConstructorParameters<typeof FallbackReader>[2],
    );
    expect(await reader.hasTx(hash)).toBe(true);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  });

  it('rebroadcasts the same bytes after a timeout, and a miss keeps the next nonce on the chain', async () => {
    const tx: ExactTx = { from: FROM, to: TO, data: '0x1234', value: 0n };
    const sendOpts = {
      tx, kind: 'bridge' as const, chainId: 1, gasCap: 300_000n, gasBudgetWei: 10n ** 18n,
      maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n, receiptTimeoutMs: 30, halted: () => false,
    };
    const known = new Set<string>();
    const raws: string[][] = [[], []];
    let counts = 0;
    const ep = (i: 0 | 1, onRaw: (raw: string) => unknown) => ({
      async send(method: string, params: unknown[]) {
        if (method === 'eth_sendRawTransaction') {
          const raw = String(params[0]);
          raws[i].push(raw);
          return onRaw(raw);
        }
        if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
          const hash = String(params[0]);
          if (!known.has(hash)) return null;
          if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash, gasUsed: '0x1' };
          return { hash };
        }
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        throw new Error(method);
      },
      async getTransactionCount() { counts++; return 4; },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
    });
    const reader = new FallbackReader(
      ['https://rpc.example/a', 'https://rpc.example/b'], 1,
      [
        ep(0, () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); }),
        ep(1, (raw) => { known.add(keccak256(raw as `0x${string}`)); return '0x01'; }),
      ] as unknown as ConstructorParameters<typeof FallbackReader>[2],
    );
    const signer = new Signer();
    const nonce = new SharedNonce();
    const first = await sendSafe({ ...sendOpts, reader, signer, gate: new TxGate(), nonce });
    expect(first.status).toBe('confirmed');
    expect(first.hash).toBe(hashOf(signer));
    expect(raws[0]).toHaveLength(1);
    expect(raws[1]).toEqual(raws[0]);
    expect(first.hash).toBe(keccak256(raws[0][0] as `0x${string}`));
    const followed = await sendSafe({ ...sendOpts, reader, signer, gate: new TxGate(), nonce });
    expect(followed.nonce).toBe(first.nonce + 1);
    expect(counts).toBe(1);

    const missed: string[][] = [[], []];
    let pendingReads = 0;
    const chainPending = 8;
    const miss = (i: 0 | 1) => ({
      async send(method: string, params: unknown[]) {
        if (method === 'eth_sendRawTransaction') {
          missed[i].push(String(params[0]));
          throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        }
        if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return null;
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        throw new Error(method);
      },
      async getTransactionCount(_address: string, tag: string) {
        if (tag === 'pending') pendingReads++;
        return chainPending;
      },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
    });
    const missReader = new FallbackReader(
      ['https://rpc.example/a', 'https://rpc.example/b'], 1,
      [miss(0), miss(1)] as unknown as ConstructorParameters<typeof FallbackReader>[2],
    );
    const missSigner = new Signer();
    const missNonce = new SharedNonce();
    const lost = await withClock(() => sendSafe({ ...sendOpts, reader: missReader, signer: missSigner, gate: new TxGate(), nonce: missNonce }));
    expect(lost.status).toBe('pending');
    expect(lost.nonce).toBe(chainPending);
    expect(missed[0]).toHaveLength(1);
    expect(missed[1]).toEqual(missed[0]);
    expect(lost.hash).toBe(keccak256(missed[0][0] as `0x${string}`));
    const retry = await withClock(() => sendSafe({ ...sendOpts, reader: missReader, signer: missSigner, gate: new TxGate(), nonce: missNonce }));
    expect(retry.nonce).toBe(chainPending);
    expect(pendingReads).toBe(2);
  });

  it('keeps the runtime halt check at the door and immediately before the nonce', async () => {
    const src = readFileSync(new URL('../src/server/router/sendSafe.ts', import.meta.url), 'utf8');
    const assertBody = src.slice(src.indexOf('function assertNotHalted'), src.indexOf('type BroadcastKind'));
    expect(assertBody).toContain("typeof o.halted !== 'function'");
    expect(assertBody).toContain('o.halted()');
    const sendAt = src.indexOf('export async function sendSafe');
    const sendHead = src.slice(sendAt, src.indexOf('await assess(o)', sendAt));
    expect(sendHead).toContain("typeof o.halted !== 'function'");
    const gate = src.slice(src.indexOf('return o.gate.run'), src.indexOf('return broadcast'));
    expect(gate).toMatch(/assertNotHalted\(o\);\s*const nonce = await o\.nonce\.next/);

    const h = harness();
    await expect(sendSafe({
      tx: h.tx, kind: 'bridge', chainId: 1, reader: h.rpc, signer: h.signer, gate: h.gate, nonce: h.nonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      halted: undefined as unknown as () => boolean,
    })).rejects.toMatchObject({ code: 'halt', message: 'halt check is missing' });
    expect(h.rpc.calls).toHaveLength(0);
    expect(h.rpc.reads).toBe(0);
  });

  it('does not call a receipt replaced until that block has one confirmation', async () => {
    const other = '0x' + 'cd'.repeat(32);
    const tip = harness();
    tip.rpc.receipt = { status: 1, transactionHash: other, blockNumber: 20 };
    tip.rpc.blockNumber = 20;
    tip.rpc.pending = 4;
    tip.rpc.mined = 4;
    const atTip = await withClock(() => tip.go());
    expect(atTip.status).toBe('pending');
    expect(atTip.state).toBe('source_sent');
    expect(atTip.replacementHash).toBeUndefined();
    expect(atTip.hash).not.toBe(other);

    const missing = harness();
    missing.rpc.receipt = { status: 1, transactionHash: other };
    missing.rpc.blockNumber = 20;
    missing.rpc.pending = 4;
    missing.rpc.mined = 4;
    const bare = await withClock(() => missing.go());
    expect(bare.status).toBe('pending');
    expect(bare.replacementHash).toBeUndefined();

    const buried = harness();
    buried.rpc.receipt = { status: 1, transactionHash: other, blockNumber: 19 };
    buried.rpc.blockNumber = 20;
    buried.rpc.pending = 4;
    buried.rpc.mined = 4;
    const rep = await buried.go();
    expect(rep.status).toBe('replaced');
    expect(rep.replacementHash).toBe(other);
    expect(rep.hash).toBe(hashOf(buried.signer));
    expect(rep.hash).not.toBe(other);
    expect(rep.status).not.toBe('confirmed');
  });

  it('a stale nonce during rebroadcast is not success when the hash is unknown', async () => {
    const tx: ExactTx = { from: FROM, to: TO, data: '0x1234', value: 0n };
    const chainPending = 6;
    let pendingReads = 0;
    let nextSends = 0;
    const reader: SafeReader = {
      async send(method: string) {
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return null;
        throw new Error(method);
      },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
      async getTransactionCount(_address: string, tag: 'pending' | 'latest') {
        if (tag === 'pending') pendingReads++;
        return chainPending;
      },
      async broadcastRaw() { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); },
      async broadcastNext() {
        nextSends++;
        throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
      },
      async hasTx() { return false; },
    };
    const nonce = new SharedNonce();
    const opts = {
      tx, kind: 'bridge' as const, chainId: 1, reader, signer: new Signer(), gate: new TxGate(), nonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      receiptTimeoutMs: 30, halted: () => false,
    };
    await expect(sendSafe(opts)).rejects.toMatchObject({ code: 'stale_nonce', message: 'nonce already used; not resent' });
    expect(nextSends).toBe(1);
    const followed = await withClock(() => sendSafe({
      ...opts,
      reader: {
        ...reader,
        async broadcastRaw() { return '0x01'; },
        async broadcastNext() { throw new Error('should not rebroadcast'); },
      },
      signer: new Signer(),
    }));
    expect(followed.nonce).toBe(chainPending);
    expect(pendingReads).toBe(2);
  });

  it('does not drop the nonce when a rebroadcast was accepted and the receipt is still missing', async () => {
    const tx: ExactTx = { from: FROM, to: TO, data: '0x1234', value: 0n };
    const chainPending = 6;
    let pendingReads = 0;
    const raws: string[] = [];
    const reader: SafeReader = {
      async send(method: string) {
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return null;
        throw new Error(method);
      },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
      async getTransactionCount(_address: string, tag: 'pending' | 'latest') {
        if (tag === 'pending') pendingReads++;
        return chainPending;
      },
      async broadcastRaw(raw: string) {
        raws.push(raw);
        throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      },
      async broadcastNext(raw: string) {
        raws.push(raw);
        return '0x01';
      },
      async hasTx() { return false; },
    };
    const nonce = new SharedNonce();
    const opts = {
      tx, kind: 'bridge' as const, chainId: 1, reader, signer: new Signer(), gate: new TxGate(), nonce,
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      receiptTimeoutMs: 30, halted: () => false,
    };
    const lost = await withClock(() => sendSafe(opts));
    expect(lost.status).toBe('pending');
    expect(lost.nonce).toBe(chainPending);
    expect(raws).toHaveLength(2);
    expect(raws[1]).toBe(raws[0]);
    const retry = await withClock(() => sendSafe({ ...opts, signer: new Signer() }));
    expect(retry.nonce).toBe(chainPending + 1);
    expect(pendingReads).toBe(1);
  });

  it('stops rebroadcasting when every timeout is unknown', async () => {
    let sends = 0;
    const reader: SafeReader = {
      async send(method: string) {
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return toQuantity(100_000n);
        if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
        if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
        if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') return null;
        throw new Error(method);
      },
      async getFeeData() { return { gasPrice: 100n, maxFeePerGas: 100n }; },
      async getTransactionCount() { return 4; },
      async broadcastRaw() { sends++; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); },
      async broadcastNext() { sends++; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); },
      async hasTx() { return false; },
    };
    const out = await withClock(() => sendSafe({
      tx: { from: FROM, to: TO, data: '0x1234', value: 0n }, kind: 'bridge', chainId: 1, reader,
      signer: new Signer(), gate: new TxGate(), nonce: new SharedNonce(),
      gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
      receiptTimeoutMs: 20, halted: () => false,
    }));
    expect(out.status).toBe('pending');
    expect(sends).toBe(9);
  }, 5_000);

  it('broadcastNext does not follow the read cursor or resend a timed-out endpoint', async () => {
    const timeout = () => Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    const reader = (blockFails: number[]) => {
      const hits = [0, 0, 0];
      const providers = [0, 1, 2].map((i) => ({
        async send(method: string) {
          if (method === 'eth_sendRawTransaction') { hits[i]++; return '0x1'; }
          if (method === 'eth_blockNumber') {
            if (blockFails[i] > 0) { blockFails[i]--; throw timeout(); }
            return '0x10';
          }
          throw new Error(method);
        },
      }));
      const r = new FallbackReader(
        ['https://rpc.example/a', 'https://rpc.example/b', 'https://rpc.example/c'], 1,
        providers as unknown as ConstructorParameters<typeof FallbackReader>[2],
      );
      return { r, hits, blockFails };
    };
    const drain = async (r: FallbackReader) => {
      for (;;) {
        try { await r.broadcastNext('0xabc'); }
        catch (e) {
          expect((e as { code?: string }).code).toBe('NO_ENDPOINT');
          return;
        }
      }
    };

    // A read leaves the cursor on C. The broadcast starts there. A later read walks the cursor
    // back to A. The old bound then stops before A and B are tried.
    const back = reader([1, 1, 0]);
    await back.r.send('eth_blockNumber', []);
    expect(back.r.currentUrl).toBe('https://rpc.example/c');
    await back.r.broadcastRaw('0xabc');
    back.blockFails[2] = 1;
    await back.r.send('eth_blockNumber', []);
    expect(back.r.currentUrl).toBe('https://rpc.example/a');
    await drain(back.r);
    expect(back.hits).toEqual([1, 1, 1]);

    // The broadcast starts on A, which times out. A read moves the cursor to B. The old bound
    // then wraps and sends A again.
    const forward = reader([1, 0, 0]);
    await forward.r.broadcastRaw('0xabc');
    await forward.r.send('eth_blockNumber', []);
    expect(forward.r.currentUrl).toBe('https://rpc.example/b');
    await drain(forward.r);
    expect(forward.hits).toEqual([1, 1, 1]);
  });

  it('releases the gate and returns pending when every in-gate RPC hangs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
    try {
      let held = false;
      const inner = new TxGate();
      const gate = {
        get busy() { return inner.busy; },
        run<T>(fn: () => Promise<T>) { return inner.run(() => { held = true; return fn(); }); },
      } as TxGate;
      const hang = () => new Promise(() => undefined);
      const reader: SafeReader = {
        async send(method: string) {
          if (held) return hang();
          if (method === 'eth_call') return '0x';
          if (method === 'eth_estimateGas') return toQuantity(100_000n);
          if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
          if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
          return hang();
        },
        async getFeeData() { return held ? hang() : { gasPrice: 100n, maxFeePerGas: 100n }; },
        async getTransactionCount() { return held ? hang() : 4; },
        async broadcastRaw() { return hang(); },
        async broadcastNext() { return hang(); },
        async hasTx() { return hang(); },
      };
      const opts = {
        tx: { from: FROM, to: TO, data: '0x1234', value: 0n }, kind: 'bridge' as const, chainId: 1, reader,
        signer: new Signer(), gate, nonce: new SharedNonce(),
        gasCap: 300_000n, gasBudgetWei: 10n ** 18n, maxGasPriceWei: 10n ** 12n, maxPriorityFeeWei: 10n ** 12n,
        receiptTimeoutMs: 1_000_000, halted: () => false,
      };
      const budget = RECEIPT_TIMEOUT_CAP_MS + GATE_SLACK_MS;
      let done = false;
      const first = sendSafe(opts).then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(done).toBe(false);
      expect(gate.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      const pending = await first;
      expect(pending.status).toBe('pending');
      expect(pending.state).toBe('source_sent');
      expect(pending.reason).toMatch(/time budget/);
      expect(pending.reason).toMatch(/mempool/);
      expect(gate.busy).toBe(false);

      let started = false;
      held = false;
      const again = sendSafe({
        ...opts,
        signer: new Signer(),
        nonce: new SharedNonce(),
        reader: {
          async send(method: string) {
            started = true;
            if (!held) {
              if (method === 'eth_call') return '0x';
              if (method === 'eth_estimateGas') return toQuantity(100_000n);
              if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: toQuantity(40n) };
              if (method === 'eth_maxPriorityFeePerGas') return toQuantity(20n);
            }
            return hang();
          },
          async getFeeData() { return held ? hang() : { gasPrice: 100n, maxFeePerGas: 100n }; },
          async getTransactionCount() { return held ? hang() : 4; },
          async broadcastRaw() { return hang(); },
          async broadcastNext() { return hang(); },
          async hasTx() { return hang(); },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);
      expect(gate.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(budget);
      const next = await again;
      expect(next.status).toBe('pending');
      expect(gate.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it('no bot calls sendSafe or broadcastNext', () => {
    const root = join(__dirname, '..', 'src');
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    for (const file of walk(root)) {
      if (file.endsWith(`${join('router', 'sendSafe.ts')}`) || file.endsWith(`${join('chains', 'fallback.ts')}`)) continue;
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/\bsendSafe\s*\(/);
      expect(code, file).not.toMatch(/\.broadcastNext\s*\(/);
    }
  });
});
