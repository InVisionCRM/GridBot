/** Pool discovery across every adapter of a chain, ranked by execution quality at a reference size. */
import type { MarketToken, PoolRef } from '../../live/markets';
import { fromUnits, toUnits } from '../../live/swapMath';
import { midPrice } from '../../live/v3Math';
import type { ChainRuntime } from '../chains/runtime';
import { sameAddr } from './types';

export interface DiscoveredPool extends PoolRef {
  dexName: string;
  /** quote per base at the pool mid (no fee) */
  mid: number | null;
  /** Tokens held by the pool, valued in quote units (V2 = reserves; V3 = balances across all ranges) */
  tvlQuote: number | null;
  tvlUsd: number | null;
  /** Base received for the reference quote amount (fee + impact included) */
  refOut: number | null;
  refImpact: number | null;
  /** Raw holdings (human units) */
  balBase?: number;
  balQuote?: number;
  /** Pool mid is > 20 % away from the best pool's price (broken / abandoned pool) */
  offMarket?: boolean;
  error?: string;
}

export async function discoverPools(
  rt: ChainRuntime, base: MarketToken, quote: MarketToken, o: { refQuote: number; quoteUsd: number | null },
): Promise<DiscoveredPool[]> {
  const out: DiscoveredPool[] = [];
  await Promise.all([...rt.adapters.values()].map(async (ad) => {
    let pools: PoolRef[] = [];
    try { pools = await ad.findPools(base.address, quote.address); } catch { return; }
    await Promise.all(pools.map(async (p) => {
      const row: DiscoveredPool = { ...p, dexName: ad.cfg.name, mid: null, tvlQuote: null, tvlUsd: null, refOut: null, refImpact: null };
      try {
        const st = await ad.state(p, base.address, quote.address);
        const baseIs0 = sameAddr(st.token0, base.address);
        if (st.sqrtPriceX96) row.mid = midPrice(st.sqrtPriceX96, baseIs0, base.decimals, quote.decimals);
        else {
          const rb = fromUnits(baseIs0 ? st.reserve0 : st.reserve1, base.decimals), rq = fromUnits(baseIs0 ? st.reserve1 : st.reserve0, quote.decimals);
          row.mid = rb > 0 ? rq / rb : null;
        }
        const [bb, bq] = await Promise.all([rt.tokenBalance(st.pool.address, base.address), rt.tokenBalance(st.pool.address, quote.address)]);
        row.balBase = fromUnits(bb, base.decimals);
        row.balQuote = fromUnits(bq, quote.decimals);
        row.address = st.pool.address;
        const amt = toUnits(o.refQuote.toFixed(Math.min(quote.decimals, 8)), quote.decimals);
        const q = await ad.quote(p, quote.address, base.address, amt);
        row.refOut = fromUnits(q.amountOut, base.decimals);
        row.refImpact = q.impact;
      } catch (e) { row.error = (e as Error).message.slice(0, 120); }
      out.push(row);
    }));
  }));
  return rankPools(valuePools(out, o.quoteUsd));
}

/**
 * Value every pool's holdings at ONE reference price (the best-executing pool's effective price), not at each
 * pool's own mid — a broken pool with an absurd mid would otherwise report astronomical TVL.
 */
export function valuePools(pools: DiscoveredPool[], quoteUsd: number | null): DiscoveredPool[] {
  const best = rankPools(pools.filter((p) => p.refOut != null && p.refOut > 0 && p.mid != null))[0];
  const ref = best?.mid ?? null;
  return pools.map((p) => {
    const r = { ...p };
    if (ref != null && p.balBase != null && p.balQuote != null) {
      r.tvlQuote = p.balQuote + p.balBase * ref;
      r.tvlUsd = quoteUsd ? r.tvlQuote * quoteUsd : null;
      r.offMarket = p.mid != null && Math.abs(p.mid / ref - 1) > 0.2;
    }
    return r;
  });
}

/** Deepest first: most base out for the reference size (captures fee + depth), then TVL. Failed pools last. */
export function rankPools<T extends { refOut: number | null; tvlQuote: number | null }>(pools: T[]): T[] {
  return [...pools].sort((a, b) => (b.refOut ?? -1) - (a.refOut ?? -1) || (b.tvlQuote ?? -1) - (a.tvlQuote ?? -1));
}
