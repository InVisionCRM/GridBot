/**
 * Coins a swap must not spend.
 *
 * Two layers:
 *  - Standing reservations (live bots, token-trader positions and the coin they spent, a converter job,
 *    a router transaction already in flight). Callers pass these in; each source that is not wired yet
 *    simply contributes nothing.
 *  - Quote-to-execute holds. A paper quote does not take one. A result that includes live calldata does,
 *    so two quotes cannot both spend the same balance. The hold is released when the quote fails, when
 *    the caller calls release, or when it expires (TTL, aligned with the swap deadline).
 */
import { NATIVE } from '../../live/swapMath';

export type ReservationSource = 'allocation' | 'token-trader' | 'converter' | 'in-flight';

/** Human units of one coin already committed somewhere else. */
export interface ReservedBalance {
  chainId: number;
  address: string;
  native: boolean;
  amount: number;
  source: ReservationSource;
}

export interface SpendHold {
  id: string;
  chainId: number;
  /** Token address, or 'native'. */
  token: string;
  native: boolean;
  /** Raw units. */
  amount: bigint;
  expiresAt: number;
}

export const DEFAULT_HOLD_TTL_MS = 3 * 60_000;

export class SpendHolds {
  private readonly holds = new Map<string, SpendHold>();
  private seq = 0;

  constructor(private readonly o: { now?: () => number; ttlMs?: number } = {}) {}

  now() { return this.o.now?.() ?? Date.now(); }
  private ttl() { return this.o.ttlMs ?? DEFAULT_HOLD_TTL_MS; }

  sweep(now = this.now()) {
    for (const [id, h] of this.holds) if (h.expiresAt <= now) this.holds.delete(id);
  }

  held(chainId: number, token: string, native: boolean, now = this.now()): bigint {
    this.sweep(now);
    const want = native ? NATIVE : token.toLowerCase();
    let n = 0n;
    for (const h of this.holds.values()) {
      if (h.chainId !== chainId || h.native !== native) continue;
      const id = h.native ? NATIVE : h.token.toLowerCase();
      if (id === want) n += h.amount;
    }
    return n;
  }

  place(p: { chainId: number; token: string; native: boolean; amount: bigint; expiresAt?: number }): string {
    this.sweep();
    const id = `hold-${++this.seq}`;
    this.holds.set(id, {
      id, chainId: p.chainId, token: p.native ? NATIVE : p.token, native: p.native, amount: p.amount,
      expiresAt: p.expiresAt ?? this.now() + this.ttl(),
    });
    return id;
  }

  release(id: string) { this.holds.delete(id); }

  list(): SpendHold[] { this.sweep(); return [...this.holds.values()]; }
}
