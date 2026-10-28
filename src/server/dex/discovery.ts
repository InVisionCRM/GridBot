/** Pool discovery across every adapter of a chain, ranked by execution quality at a reference size. */
import type { MarketToken, PoolRef } from '../../live/markets';
import { fromUnits, NATIVE, toUnits } from '../../live/swapMath';
import { midPrice } from '../../live/v3Math';
import type { ChainRuntime } from '../chains/runtime';
import { V4_CURRENCY_MISMATCH, V4ScanError, v4PoolMatches } from './v4';
import { sameAddr, ZERO } from './types';

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
  /** Set when a V4 Initialize scan stopped early. Pools already found are still listed. */
  partial?: string;
}

export async function discoverPools(
  rt: ChainRuntime, base: MarketToken, quote: MarketToken,
  o: { refQuote: number; quoteUsd: number | null; onlyKind?: 'v4' },
): Promise<DiscoveredPool[]> {
  const out: DiscoveredPool[] = [];
  await Promise.all([...rt.adapters.values()].map(async (ad) => {
    if (o.onlyKind && ad.kind !== o.onlyKind) return;
    let pools: PoolRef[] = [];
    let scanError: string | null = null;
    try {
      // V4 native markets search address(0). V2/V3 keep the wrapped address: their routers wrap.
      pools = await ad.findPools(
        ad.kind === 'v4' && base.native ? ZERO : base.address,
        ad.kind === 'v4' && quote.native ? ZERO : quote.address,
      );
    } catch (e) {
      if (ad.kind === 'v4' && e instanceof V4ScanError) { pools = e.pools; scanError = e.message; }
      else return;
    }
    if (scanError && pools.length === 0) {
      out.push({
        dex: ad.cfg.id, kind: ad.kind, address: '', feeBps: 0, dexName: ad.cfg.name,
        mid: null, tvlQuote: null, tvlUsd: null, refOut: null, refImpact: null, error: scanError, partial: scanError,
      });
      return;
    }
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
        const amt = toUnits(o.refQuote.toFixed(Math.min(quote.decimals, 8)), quote.decimals);
        if (p.kind === 'v4') {
          // V4 balances sit in the PoolManager, not at the pool id. Virtual reserves of the active range are the depth.
          row.balBase = fromUnits(baseIs0 ? st.reserve0 : st.reserve1, base.decimals);
          row.balQuote = fromUnits(baseIs0 ? st.reserve1 : st.reserve0, quote.decimals);
          row.address = st.pool.address;
          if (scanError) row.partial = scanError;
          // A WETH market must not quote an address(0) pool, and a native market must not quote a WETH pool.
          if (!v4PoolMatches(p, base, quote)) row.error = V4_CURRENCY_MISMATCH;
          else {
            const qIn = quote.native ? NATIVE : quote.address;
            const qOut = base.native ? NATIVE : base.address;
            const q = await ad.quote(p, qIn, qOut, amt);
            if (q.lpFee != null) row.feeBps = q.lpFee / 100;
            if (q.hook && !q.hook.allowed) row.error = q.hook.reason ?? 'V4 hook rejected';
            else {
              row.refOut = fromUnits(q.amountOut, base.decimals);
              row.refImpact = q.impact;
            }
          }
        } else {
          const [bb, bq] = await Promise.all([rt.tokenBalance(st.pool.address, base.address), rt.tokenBalance(st.pool.address, quote.address)]);
          row.balBase = fromUnits(bb, base.decimals);
          row.balQuote = fromUnits(bq, quote.decimals);
          row.address = st.pool.address;
          const q = await ad.quote(p, quote.address, base.address, amt);
          row.refOut = fromUnits(q.amountOut, base.decimals);
          row.refImpact = q.impact;
        }
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
