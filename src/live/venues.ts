/**
 * Token launch venues the token trader buys on, beyond each chain's own DEX list (pure data, safe for the UI).
 *
 * GeckoTerminal labels pools by the launcher that made them, not by the contract that trades them. Each venue below
 * was traced on Robinhood Chain on 2026-10-30 (pools from GeckoTerminal's new, trending and top-volume lists):
 *  - Pons V1 (`pons-dot-family`): plain Uniswap V3 pools; factory() is the Uniswap V3 factory 0x1f7d…2EfA.
 *  - Uniswap V4 and Pools.trade: V4 pools with no hook (14 + 3 sampled, Initialize read on the PoolManager).
 *  - Pons V2 Dex, Long.xyz, Bankr, Frontier.fun: V4 pools on the same PoolManager with a hook. Each hook's source is
 *    verified on the explorer and it is not a proxy: PonsV2MemeHook (part of the verified PonsV2LaunchFactory),
 *    DopplerHookInitializer (Long.xyz and Bankr share it), FactoryHook (Frontier.fun). All three can take a cut of a
 *    swap (AFTER_SWAP_RETURNS_DELTA); the safety simulation buys and sells through the hook, so that cut is measured
 *    like a token tax.
 *  - Pons V2 (`pons-v2`): a bonding curve per launch (PonsV2BondingCurve, verified source), not a pool. A curve counts
 *    only when PonsV2LaunchFactory.getLaunchedToken(token).curve is that curve. Fee 1 % plus a creator tax (≤ 20 %
 *    combined), a 99 % snipe tax in the first 3 s, and at graduation the token moves to a Pons V2 Dex pool.
 * The token trader has an on/off switch per venue (TraderOptions.venues); all are on by default.
 */
export const ZERO_HOOK = '0x0000000000000000000000000000000000000000';

export type VenueVia =
  /** Pools of one of the chain's DEXes (chains.ts). V4: only with exactly this hook (ZERO_HOOK = none). */
  | { dex: string; hook?: string }
  /** A Pons V2 bonding curve, vouched for by this factory */
  | { curve: 'pons-v2'; factory: string };

export interface LaunchVenue {
  id: string;
  name: string;
  chainId: number;
  /** GeckoTerminal DEX ids whose pools belong to this venue */
  gecko: string[];
  via: VenueVia;
}

const HOOD = 4663;
export const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const PONS_V2_HOOK = '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044';
export const DOPPLER_HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
export const FRONTIER_HOOK = '0xee588bCF2bd3e658f5160489f4199d1851BBf0Cc';

export const VENUES: LaunchVenue[] = [
  { id: 'uniswap-v4', name: 'Uniswap V4', chainId: HOOD, gecko: ['uniswap-v4-robinhood', 'uniswap-pools-trade'], via: { dex: 'uniswap-v4', hook: ZERO_HOOK } },
  { id: 'pons-v1', name: 'Pons V1', chainId: HOOD, gecko: ['pons-dot-family'], via: { dex: 'uniswap-v3' } },
  { id: 'pons-v2', name: 'Pons V2', chainId: HOOD, gecko: ['pons-v2'], via: { curve: 'pons-v2', factory: PONS_V2_FACTORY } },
  { id: 'pons-v2-dex', name: 'Pons V2 Dex', chainId: HOOD, gecko: ['pons-v2-dex'], via: { dex: 'uniswap-v4', hook: PONS_V2_HOOK } },
  { id: 'long-xyz', name: 'Long.xyz', chainId: HOOD, gecko: ['long-xyz'], via: { dex: 'uniswap-v4', hook: DOPPLER_HOOK } },
  { id: 'bankr', name: 'Bankr', chainId: HOOD, gecko: ['bankr-robinhood'], via: { dex: 'uniswap-v4', hook: DOPPLER_HOOK } },
  { id: 'frontier', name: 'Frontier.fun', chainId: HOOD, gecko: ['frontier-fun'], via: { dex: 'uniswap-v4', hook: FRONTIER_HOOK } },
];

/** The venue a GeckoTerminal pool row belongs to on this chain, or null. */
export function venueOf(chainId: number, geckoDex: string): LaunchVenue | null {
  return VENUES.find((v) => v.chainId === chainId && v.gecko.includes(geckoDex)) ?? null;
}

/** Hooks a venue may trade through on this chain: the V4 DEX's allowlist (chains.ts) is built from these. */
export function venueHooks(chainId: number): string[] {
  return [...new Set(VENUES.filter((v) => v.chainId === chainId && 'dex' in v.via && v.via.hook && v.via.hook !== ZERO_HOOK)
    .map((v) => (v.via as { hook: string }).hook))];
}
