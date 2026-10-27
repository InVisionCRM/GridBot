/**
 * sendSafe: eth_call at pending, gas cap, explicit gasLimit, one send through the shared gate and nonce.
 * A timeout is pending / source_sent. No second broadcast. No real RPC.
 */
import { Interface, toQuantity } from 'ethers';
import { describe, expect, it } from 'vitest';
import type { SentTx } from '../src/server/bot/chain';
import { SharedNonce, TxGate } from '../src/server/bot/txGate';
import { sendSafe, type ExactTx, type GasSender, type SafeReader } from '../src/server/router/sendSafe';

const FROM = '0x1234567890123456789012345678901234567890';
const TO = '0x2222222222222222222222222222222222222222';
const ERR = new Interface(['error Error(string)']);

class Rpc implements SafeReader {
  calls: { method: string; params: unknown[] }[] = [];
  estimate = 100_000n;
  revert: unknown = null;
  fee = 100n;
  pending = 4;
  reads = 0;
  async send(method: string, params: unknown[]) {
    this.calls.push({ method, params });
    if (method === 'eth_call') {
      if (this.revert) throw this.revert;
      return '0x';
    }
    if (method === 'eth_estimateGas') return toQuantity(this.estimate);
    throw new Error(method);
  }
  async getFeeData() { return { gasPrice: this.fee, maxFeePerGas: this.fee }; }
  async getTransactionCount(_address: string, blockTag: 'pending') {
    if (blockTag !== 'pending') throw new Error(`block tag ${blockTag}`);
    this.reads++;
    return this.pending;
  }
}

class Signer implements GasSender {
  sent: { nonce: number; gasLimit: bigint; maxFeePerGas?: bigint; to: string; data: string; value: bigint }[] = [];
  /** null receipt, a thrown timeout, or a mined success. */
  outcome: 'ok' | 'timeout' | 'throw' = 'ok';
  async getAddress() { return FROM; }
  async sendTransaction(tx: { to: string; data: string; value: bigint; nonce: number; gasLimit: bigint; maxFeePerGas?: bigint }): Promise<SentTx> {
    this.sent.push(tx);
    const outcome = this.outcome;
    return {
      hash: `0x${tx.nonce.toString(16).padStart(64, '0')}`,
      async wait() {
        if (outcome === 'timeout') return null;
        if (outcome === 'throw') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        return { status: 1, gasUsed: tx.gasLimit, logs: [] };
      },
    };
  }
}

function harness(rpc = new Rpc(), signer = new Signer()) {
  const gate = new TxGate();
  const nonce = new SharedNonce();
  const tx: ExactTx = { from: FROM, to: TO, data: '0x1234', value: 0n };
  const go = (over: { gasCap?: bigint; gasBudgetWei?: bigint; l1FeeWei?: bigint; kind?: 'bridge' | 'claim' | 'swap' | 'approve'; warn?: (m: string) => void } = {}) => sendSafe({
    tx, kind: over.kind ?? 'bridge', reader: rpc, signer, gate, nonce,
    gasCap: over.gasCap ?? 300_000n,
    gasBudgetWei: over.gasBudgetWei ?? 10n ** 18n,
    l1FeeWei: over.l1FeeWei,
    receiptTimeoutMs: 20,
    warn: over.warn,
  });
  return { rpc, signer, gate, nonce, tx, go };
}

describe('sendSafe', () => {
  it('aborts a revert with the decoded reason and does not send', async () => {
    const { rpc, signer, go } = harness();
    const secret = 'SECRETKEYVALUE123';
    rpc.revert = Object.assign(new Error(`https://rpc.example/${secret} execution reverted: ignored`), {
      data: ERR.encodeErrorResult('Error', ['bridge paused']),
    });
    const warnings: string[] = [];
    await expect(go({ warn: (m) => warnings.push(m) })).rejects.toThrow('bridge paused');
    expect(signer.sent).toHaveLength(0);
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_call']);
    expect(rpc.calls[0].params[1]).toBe('pending');
    expect(rpc.calls[0].params[0]).toMatchObject({ from: FROM, to: TO, data: '0x1234', value: '0x0' });
    expect(warnings.join('\n')).toContain('bridge paused');
    expect(warnings.join('\n')).not.toContain(secret);
    expect(rpc.reads).toBe(0);
  });

  it('aborts when estimateGas is above the cap', async () => {
    const { rpc, signer, go } = harness();
    rpc.estimate = 400_000n;
    await expect(go({ gasCap: 300_000n, kind: 'bridge' })).rejects.toThrow('gas estimate 400000 for bridge is above the 300000 cap');
    expect(signer.sent).toHaveLength(0);
    expect(rpc.calls.map((c) => c.method)).toEqual(['eth_call', 'eth_estimateGas']);
    expect(rpc.reads).toBe(0);
  });

  it('sets gasLimit to min(estimate × 1.2, cap) and aborts when the fee exceeds the budget', async () => {
    const h = harness();
    h.rpc.estimate = 100_000n;
    const ok = await h.go({ gasCap: 300_000n, gasBudgetWei: 12_000_000n });
    expect(ok.status).toBe('confirmed');
    expect(h.signer.sent[0].gasLimit).toBe(120_000n);
    expect(h.signer.sent[0].maxFeePerGas).toBe(100n);
    expect(h.rpc.calls.every((c) => c.params[1] === 'pending')).toBe(true);

    const capped = harness();
    capped.rpc.estimate = 280_000n;
    await capped.go({ gasCap: 300_000n, gasBudgetWei: 300_000n * 100n });
    expect(capped.signer.sent[0].gasLimit).toBe(300_000n);

    const fee = harness();
    fee.rpc.estimate = 100_000n;
    await expect(fee.go({ gasBudgetWei: 12_000_000n - 1n })).rejects.toThrow(/exceeds budget/);
    expect(fee.signer.sent).toHaveLength(0);
    await expect(fee.go({ gasBudgetWei: 12_000_000n, l1FeeWei: 1n })).rejects.toThrow(/exceeds budget/);
    expect(fee.signer.sent).toHaveLength(0);
  });

  it('shares nonce order with a bot send through the same gate', async () => {
    const h = harness();
    h.rpc.pending = 4;
    const order: number[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let mark!: () => void;
    const inside = new Promise<void>((r) => { mark = r; });
    const bot = h.gate.run(async () => {
      const n = await h.nonce.next(() => h.rpc.getTransactionCount(FROM, 'pending'));
      mark();
      await hold;
      await h.signer.sendTransaction({ to: TO, data: '0x', value: 0n, nonce: n, gasLimit: 21_000n });
      order.push(n);
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
    expect(order).toEqual([4]);
    expect(h.signer.sent.map((t) => t.nonce)).toEqual([4, 5]);
    expect(h.signer.sent.map((t) => t.gasLimit)).toEqual([21_000n, 120_000n]);
    expect(h.rpc.reads).toBe(1);
  });

  it('a timeout is pending source_sent and is not resent', async () => {
    const h = harness();
    h.signer.outcome = 'timeout';
    const first = await h.go();
    expect(first.status).toBe('pending');
    expect(first.state).toBe('source_sent');
    expect(first.hash).toBe(h.signer.sent[0] && `0x${h.signer.sent[0].nonce.toString(16).padStart(64, '0')}`);
    expect(h.signer.sent).toHaveLength(1);
    const second = await h.go();
    expect(second.nonce).toBe(first.nonce + 1);
    expect(second.state).toBe('source_sent');
    expect(h.signer.sent).toHaveLength(2);
    expect(h.rpc.reads).toBe(1);

    const thrown = harness();
    thrown.signer.outcome = 'throw';
    const pending = await thrown.go();
    expect(pending).toMatchObject({ status: 'pending', state: 'source_sent' });
    expect(thrown.signer.sent).toHaveLength(1);
  });
});
