/**
 * Stopping the app waits for a transaction being sent (2026-11-02, ETH/USDG on Robinhood): the app was stopped while a
 * liquidity increase was being sent. The network mined it, the bot never saved its hash, sent it again on restart, and
 * its saved liquidity fell short of the position's, so every range move after that reverted "Not cleared".
 */
import { describe, expect, it } from 'vitest';
import { TxGate } from '../src/server/bot/txGate';

describe('TxGate.close: the send in progress finishes; nothing waiting is sent', () => {
  it('close resolves only after the transaction being sent has come back', async () => {
    const g = new TxGate();
    let release!: () => void;
    const saved: string[] = [];
    const sending = g.run(async () => { await new Promise<void>((r) => { release = r; }); saved.push('0xhash'); });
    await Promise.resolve();
    let closed = false;
    const done = g.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(false); // still sending
    release();
    await sending;
    await done;
    expect(saved).toEqual(['0xhash']);
    expect(closed).toBe(true);
  });

  it('a send queued behind it, or asked after close, is not sent', async () => {
    const g = new TxGate();
    let release!: () => void;
    const sent: string[] = [];
    const first = g.run(async () => { await new Promise<void>((r) => { release = r; }); sent.push('first'); });
    const queued = g.run(async () => { sent.push('queued'); });
    await Promise.resolve(); // the first send has started
    const done = g.close();
    const late = g.run(async () => { sent.push('late'); });
    release();
    await first;
    await expect(queued).rejects.toThrow(/shutting down/);
    await expect(late).rejects.toThrow(/shutting down/);
    await done;
    expect(sent).toEqual(['first']);
  });
});
