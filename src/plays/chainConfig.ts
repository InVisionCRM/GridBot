/**
 * Which chains Plays will accept. Pure data: addresses are read from the chain registry, not copied.
 * Robinhood Chain (4663) is the default. PancakeSwap V3 is left out; the registry notes that book is thin.
 * Uniswap V4 is not listed: this app does not swap V4.
 */
import { chainById } from '../live/chains';

export interface PlaysChainConfig {
  chainId: number;
  /** Ids from CHAINS[].dexes. */
  dexIds: string[];
  /** Symbols on that chain's wrapped native and stables. */
  quoteTokens: string[];
}

export const DEFAULT_PLAYS_CHAIN = 4663;

export const PLAYS_CHAINS: Record<number, PlaysChainConfig> = {
  4663: { chainId: 4663, dexIds: ['uniswap-v3', 'uniswap-v2'], quoteTokens: ['WETH', 'USDG'] },
};

export function playsChain(chainId: number): PlaysChainConfig | null {
  return PLAYS_CHAINS[chainId] ?? null;
}

export interface ResolvedQuote {
  symbol: string;
  address: string;
  decimals: number;
}

/** Quote tokens for a plays chain, resolved through the registry. Null when the chain or a symbol is unknown. */
export function quoteTokens(chainId: number): ResolvedQuote[] | null {
  const cfg = playsChain(chainId);
  const chain = chainById(chainId);
  if (!cfg || !chain) return null;
  const book = [chain.wrappedNative, ...chain.stables];
  const out: ResolvedQuote[] = [];
  for (const symbol of cfg.quoteTokens) {
    const token = book.find((t) => t.symbol === symbol);
    if (!token) return null;
    out.push({ symbol: token.symbol, address: token.address, decimals: token.decimals });
  }
  return out;
}
