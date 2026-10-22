/**
 * The coins a wallet holds on one chain, for Tools → Convert: the chain's own coin, the coins of this app's markets
 * there, and every other ERC-20 the chain's Blockscout API lists (ChainConfig.tokenApi). An explorer only says which
 * tokens to look at; every balance and decimals() is read on-chain, since an explorer can lag or be wrong.
 */
import { readDecimals } from '../../live/decimals';
import { fromUnits, NATIVE } from '../../live/swapMath';
import type { CoinId } from '../../market/convertRoute';
import type { Hub } from '../chains/hub';
import type { FetchJson } from '../fetchJson';

export interface Coin {
  id: CoinId;
  /** Token address; null for the chain's own coin */
  address: string | null;
  symbol: string;
  name: string;
  decimals: number;
  /** In one of this app's markets (else found through the explorer) */
  tracked: boolean;
}
export interface Holding extends Coin { balance: number }
/** A coin the explorer lists for the wallet */
export interface Listed { address: string; symbol: string; name: string }
/** A listed coin whose balanceOf() or decimals() the chain wouldn't answer: never converted */
export interface Unreadable extends Listed { why: string }

interface ExplorerPage {
  items?: { token?: { address?: string; address_hash?: string; symbol?: string | null; name?: string | null; type?: string } }[];
  next_page_params?: Record<string, string | number> | null;
}

/** Every ERC-20 the explorer lists for `owner` (all pages). */
async function explorerTokens(api: string, owner: string, fetchJson: FetchJson): Promise<Listed[]> {
  const out: Listed[] = [];
  let params: Record<string, string | number> | null = { type: 'ERC-20' };
  for (let page = 0; params && page < 20; page++) {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const j = (await fetchJson(`${api}/addresses/${owner}/tokens?${q}`)) as ExplorerPage;
    if (!Array.isArray(j?.items)) throw new Error(`token list: unexpected answer from ${new URL(api).host}`);
    for (const it of j.items) {
      const t = it.token, address = t?.address ?? t?.address_hash;
      if (!t || !address || (t.type && t.type !== 'ERC-20')) continue;
      out.push({ address, symbol: t.symbol ?? '?', name: t.name ?? t.symbol ?? '?' });
    }
    params = j.next_page_params ? { type: 'ERC-20', ...j.next_page_params } : null;
  }
  return out;
}

/**
 * The coins `owner` holds on `chainId` with a balance above 0, the chain's own coin first, and the listed coins the chain
 * wouldn't answer for (one junk airdrop must not stop the rest).
 */
export async function holdings(hub: Hub, chainId: number, owner: string, fetchJson: FetchJson): Promise<{ held: Holding[]; unreadable: Unreadable[] }> {
  const rt = hub.rt(chainId), cfg = rt.cfg;
  const coins = new Map<CoinId, Coin>();
  coins.set(NATIVE, { id: NATIVE, address: null, symbol: cfg.nativeSymbol, name: cfg.nativeSymbol, decimals: 18, tracked: true });
  const w = cfg.wrappedNative;
  coins.set(w.address.toLowerCase(), { id: w.address.toLowerCase(), address: w.address, symbol: w.symbol, name: w.name, decimals: w.decimals, tracked: true });
  for (const m of hub.byChain(chainId)) {
    for (const t of [m.base, m.quote]) {
      if (t.native || coins.has(t.address.toLowerCase())) continue;
      coins.set(t.address.toLowerCase(), { id: t.address.toLowerCase(), address: t.address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals, tracked: true });
    }
  }
  const held: Holding[] = [];
  for (const c of coins.values()) {
    const raw = c.address ? await rt.tokenBalance(owner, c.address) : await rt.reader.getBalance(owner);
    const balance = fromUnits(raw, c.decimals);
    if (balance > 0) held.push({ ...c, balance });
  }
  const unreadable: Unreadable[] = [];
  if (cfg.tokenApi) {
    const seen = new Set(coins.keys());
    for (const t of await explorerTokens(cfg.tokenApi, owner, fetchJson)) {
      const id = t.address.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const raw = await rt.tokenBalance(owner, t.address);
        if (raw === 0n) continue;
        const decimals = await readDecimals(rt.reader, chainId, t.address);
        held.push({ id, ...t, decimals, tracked: false, balance: fromUnits(raw, decimals) });
      } catch (e) {
        unreadable.push({ ...t, why: `Couldn't read it on-chain: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
      }
    }
  }
  return { held, unreadable };
}
