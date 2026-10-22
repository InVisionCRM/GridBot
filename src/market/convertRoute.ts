/**
 * Tools → Convert, the pure part: which swaps take one coin to another over the markets a chain has, and which coins
 * are never touched. A coin is 'native' (the chain's own coin) or its token address in lower case; the wrapped native
 * token is a token like any other here (it is unwrapped before routing, see server/convert).
 */

import { NATIVE } from '../live/swapMath';

export type CoinId = string;

/** A market as routing sees it: its key and the coins on each side. */
export interface RouteMarket { key: string; base: CoinId; quote: CoinId }

/** One swap: through market `key`, selling its base (`sell`, from = base) or spending its quote on base (`buy`). */
export interface Hop { key: string; side: 'buy' | 'sell'; from: CoinId; to: CoinId }

function hop(m: RouteMarket, from: CoinId): Hop {
  return m.base === from ? { key: m.key, side: 'sell', from, to: m.quote } : { key: m.key, side: 'buy', from, to: m.base };
}
const joins = (m: RouteMarket, a: CoinId, b: CoinId) => (m.base === a && m.quote === b) || (m.base === b && m.quote === a);

/**
 * The swaps from `from` to `to`: one market joining them, else two through a coin both trade against (the native
 * coin first, then the markets' order). null when no route of at most two swaps exists.
 */
export function findRoute(from: CoinId, to: CoinId, markets: RouteMarket[]): Hop[] | null {
  if (from === to) return [];
  const direct = markets.find((m) => joins(m, from, to));
  if (direct) return [hop(direct, from)];
  const mids = [...new Set(markets.flatMap((m) => [m.base, m.quote]))].filter((c) => c !== from && c !== to);
  mids.sort((a, b) => (a === NATIVE ? -1 : b === NATIVE ? 1 : 0));
  for (const mid of mids) {
    const a = markets.find((m) => joins(m, from, mid)), b = markets.find((m) => joins(m, mid, to));
    if (a && b) return [hop(a, from), hop(b, mid)];
  }
  return null;
}

/**
 * Scam airdrops are named like a website ("https://pcock.page.gd", "www.claim-….com") to lure you to a site that
 * drains wallets; approving or swapping one can be the trap itself. Such coins are listed but never touched.
 */
export function namedLikeSite(...names: string[]): boolean {
  return names.some((n) => /https?:|www\.|\.(com|net|org|io|xyz|gd|app|site|page|top|info|live|link|click|vip|cc|pro|fun)\b/i.test(n));
}
