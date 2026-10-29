/**
 * Audit a041: a sent tx with no receipt is not waited on forever. After TX_DROP_MS the wallet's nonces say what became
 * of it: dropped (never ran: sent again), used by another tx (a wallet-app speed-up or cancel: not sent again, the
 * bot stops naming it), still pending past TX_STUCK_MS (stuck: named once).
 */
import { describe, expect, it } from 'vitest';
import { LiveExecutor, TX_DROP_MS, TX_STUCK_MS, type Quoter, type TxSender } from '../src/server/bot/chain';

function exec(latest: number, pending: number) {
  const quoter = {
    reader: { getTransactionCount: async (_a: string, tag: 'pending' | 'latest') => (tag === 'latest' ? latest : pending) },
  } as unknown as Quoter;
  const signer = { getAddress: async () => '0x' + '11'.repeat(20) } as unknown as TxSender;
  return new LiveExecutor(quoter, signer, { approval: 'exact', receiptTimeoutMs: 1000 });
}
const T0 = 1_800_000_000_000;

describe('txFate: what became of a sent tx with no receipt', () => {
  it('waits while it is young', async () => {
    expect(await exec(0, 0).txFate(5, T0, T0 + TX_DROP_MS - 1)).toBe('wait');
  });
  it('dropped: the node does not have it and its nonce is unused', async () => {
    expect(await exec(5, 5).txFate(5, T0, T0 + TX_DROP_MS)).toBe('dropped');
  });
  it('used: another tx from this wallet took its nonce', async () => {
    expect(await exec(6, 6).txFate(5, T0, T0 + TX_DROP_MS)).toBe('used');
  });
  it('still pending: waits, then stuck after an hour', async () => {
    expect(await exec(5, 6).txFate(5, T0, T0 + TX_DROP_MS)).toBe('wait');
    expect(await exec(5, 6).txFate(5, T0, T0 + TX_STUCK_MS)).toBe('stuck');
  });
  it('a record without its nonce: stuck after an hour, never guessed dropped', async () => {
    expect(await exec(9, 9).txFate(undefined, T0, T0 + TX_DROP_MS)).toBe('wait');
    expect(await exec(9, 9).txFate(undefined, T0, T0 + TX_STUCK_MS)).toBe('stuck');
  });
});
