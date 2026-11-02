/** Global one-tx-at-a-time gate shared by every grid. */
export class TxGate {
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  private closed = false;
  get busy() { return this.depth > 0; }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      if (this.closed) throw new Error('the app is shutting down: nothing new is sent');
      this.depth++;
      try { return await fn(); } finally { this.depth--; }
    });
    // Keep the chain alive even if fn rejects
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Shutdown: nothing waiting its turn is sent, and this resolves once the transaction being sent now is done (its
   * hash saved by its caller). Exiting mid-send loses a hash the network already has: on 2026-11-02 a liquidity
   * increase was mined after the app was stopped mid-send, the bot sent it again on restart, and its saved liquidity
   * fell short of the position's, so every exit reverted "Not cleared".
   */
  close(): Promise<void> {
    this.closed = true;
    return this.chain;
  }
}

/** Shared pending-nonce counter for one hot wallet used by many LiveExecutors. */
export class SharedNonce {
  private n: number | null = null;

  async next(getPending: () => Promise<number>): Promise<number> {
    if (this.n == null) this.n = await getPending();
    const cur = this.n;
    this.n = cur + 1;
    return cur;
  }

  /** Drop local counter so the next send re-reads pending from chain. */
  invalidate() { this.n = null; }
}
