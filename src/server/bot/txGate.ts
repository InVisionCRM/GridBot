/** Global one-tx-at-a-time gate shared by every grid. */
export class TxGate {
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  get busy() { return this.depth > 0; }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      this.depth++;
      try { return await fn(); } finally { this.depth--; }
    });
    // Keep the chain alive even if fn rejects
    this.chain = run.then(() => undefined, () => undefined);
    return run;
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
