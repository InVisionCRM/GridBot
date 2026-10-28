/**
 * Cross-chain route table (pure data). No network calls, no signing.
 *
 * Same-chain swaps live in src/server/swap. This table only says which bridge may later carry a token
 * between two chains, and which contracts are the same asset (or the dollar the desk trades) on each chain.
 *
 * Auto-selection never returns a canonical slow route (Robinhood's Arbitrum bridge waits ~7 days to withdraw)
 * or a discovery-only aggregator. Across is the fast primary where it is deployed; Relay is the fallback;
 * Li.Fi is listed so a later search can ask it, and is never chosen by itself. Ethereum ↔ PulseChain uses
 * the official PulseChain OmniBridge (bridge.pulsechain.com) — Across does not list chain 369.
 *
 * Addresses below are the ones already pinned in this repo, or copied from the publisher cited on the row.
 * PulseChain bridged WETH is not in the trading registry (the fork-copy of Ethereum WETH is a different coin).
 */
import { chainById, type ChainToken } from '../live/chains';
import { NETWORKS } from '../live/networks';

const ETH = chainById(1)!;
const RH = chainById(4663)!;
const ETH_USDC = ETH.stables.find((s) => s.symbol === 'USDC')!;
const ETH_WETH = ETH.wrappedNative;
const RH_USDG = RH.stables.find((s) => s.symbol === 'USDG')!;
const RH_WETH = RH.wrappedNative;
const PLS_USDC = NETWORKS.mainnet.quotes.find((q) => q.symbol === 'USDC')!;

/**
 * Wrapped Ether from Ethereum on PulseChain (OmniBridge token, PulseScan "Official").
 * Not the fork copy at Ethereum's WETH address.
 * https://scan.pulsechain.com/address/0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C
 * https://go.pulsechain.wiki/getting-started/getting-started
 */
export const PULSE_BRIDGED_WETH = '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C';

/** Across SpokePool. Ethereum: docs.across.to deployments. Robinhood: across-protocol/contracts deployed-addresses.md (chain 4663). */
export const ACROSS_SPOKE = {
  1: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  4663: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
} as const;

/**
 * Robinhood's canonical Arbitrum bridge on Ethereum. Deposits ~10 min; withdrawals wait the 7-day challenge
 * period. https://docs.robinhood.com/chain/bridging/ and https://docs.robinhood.com/chain/protocol-contracts/
 */
export const RH_CANONICAL = {
  delayedInbox: '0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D',
  bridge: '0xDf8755334ce7A73cCF6b581C02eA649AE3E864b3',
  outbox: '0xf0ce991ea4A0d2400A4AB49b20ae333f6Dce3DE9',
} as const;

export type BridgeProtocol = 'across' | 'relay' | 'lifi' | 'pulse-omnibridge' | 'canonical';
export type BridgeRole = 'primary' | 'fallback' | 'discovery' | 'canonical';
export type RouteSpeed = 'fast' | 'standard' | 'slow';

export interface BridgeRoute {
  id: string;
  protocol: BridgeProtocol;
  fromChainId: number;
  toChainId: number;
  /** Source token, or '*' for every token. */
  tokenIn: string;
  /** Destination token, or '*' when the other chain's address is not fixed here. */
  tokenOut: string;
  role: BridgeRole;
  speed: RouteSpeed;
  /** Published intent. autoRoutes() also refuses slow and canonical rows even when this is true. */
  autoSelect: boolean;
  /** Contract on the source chain, when the publisher lists one. API-only routes omit it. */
  address?: string;
  note: string;
  source: string;
}

export interface TokenLeg {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  /** bridged = OmniBridge representation; canonical = the contract that chain itself issues. */
  kind: 'canonical' | 'bridged';
  source: string;
}

export interface TokenMapping {
  id: string;
  /** same-asset = one coin on two chains. dollar = the dollar this desk trades (USDC and USDG are different issuers). */
  relation: 'same-asset' | 'dollar';
  note: string;
  legs: TokenLeg[];
}

const leg = (t: Pick<ChainToken, 'address' | 'symbol' | 'decimals'>, chainId: number, kind: TokenLeg['kind'], source: string): TokenLeg => ({
  chainId, address: t.address, symbol: t.symbol, decimals: t.decimals, kind, source,
});

export const TOKEN_MAPPINGS: TokenMapping[] = [
  {
    id: 'dollar-usdc-usdg',
    relation: 'dollar',
    note: 'Ethereum USDC (Circle) and Robinhood USDG (Paxos Global Dollar) are the dollar leg on each chain. They are not the same contract.',
    legs: [
      leg(ETH_USDC, 1, 'canonical', 'https://developers.circle.com/stablecoins/usdc-contract-addresses'),
      leg(RH_USDG, 4663, 'canonical', 'https://docs.robinhood.com/chain/contracts/'),
    ],
  },
  {
    id: 'usdc-ethereum-pulse',
    relation: 'same-asset',
    note: 'PulseChain USDC is the OmniBridge representation of Ethereum USDC, not the fork copy.',
    legs: [
      leg(ETH_USDC, 1, 'canonical', 'https://developers.circle.com/stablecoins/usdc-contract-addresses'),
      leg(PLS_USDC, 369, 'bridged', 'https://scan.pulsechain.com/address/0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07'),
    ],
  },
  {
    id: 'weth',
    relation: 'same-asset',
    note: 'Ethereum WETH, its OmniBridge form on PulseChain, and Robinhood Chain\'s own WETH (gas on 4663 is ETH).',
    legs: [
      leg(ETH_WETH, 1, 'canonical', 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments'),
      { chainId: 369, address: PULSE_BRIDGED_WETH, symbol: 'WETH', decimals: 18, kind: 'bridged', source: 'https://go.pulsechain.wiki/getting-started/getting-started' },
      leg(RH_WETH, 4663, 'canonical', 'https://docs.robinhood.com/chain/contracts/'),
    ],
  },
];

const SRC_ACROSS = 'https://docs.across.to/chains-and-contracts';
const SRC_RELAY = 'https://docs.relay.link/references/api/api_guides/bridging-integration-guide';
const SRC_LIFI = 'https://docs.li.fi';
const SRC_RH = 'https://docs.robinhood.com/chain/bridging/';
const SRC_PULSE = 'https://bridge.pulsechain.com/';

function pair(a: TokenLeg, b: TokenLeg): [TokenLeg, TokenLeg][] {
  return [[a, b], [b, a]];
}

function fast(protocol: BridgeProtocol, role: BridgeRole, speed: RouteSpeed, autoSelect: boolean, from: TokenLeg, to: TokenLeg, address: string | undefined, note: string, source: string): BridgeRoute {
  return {
    id: `${protocol}:${from.chainId}-${to.chainId}:${from.symbol}`,
    protocol, fromChainId: from.chainId, toChainId: to.chainId,
    tokenIn: from.address, tokenOut: to.address, role, speed, autoSelect, note, source,
    ...(address ? { address } : {}),
  };
}

const dollar = TOKEN_MAPPINGS[0].legs;
const usdcPulse = TOKEN_MAPPINGS[1].legs;
const weth = TOKEN_MAPPINGS[2].legs;
const [usdcEth, usdgRh] = dollar;
const [usdcEth2, usdcPls] = usdcPulse;
const wethEth = weth.find((l) => l.chainId === 1)!;
const wethPls = weth.find((l) => l.chainId === 369)!;
const wethRh = weth.find((l) => l.chainId === 4663)!;

const across = (from: TokenLeg, to: TokenLeg): BridgeRoute[] => pair(from, to).map(([a, b]) => fast(
  'across', 'primary', 'fast', true, a, b,
  ACROSS_SPOKE[a.chainId as 1 | 4663],
  'Across SpokePool. Primary fast route.',
  SRC_ACROSS,
));
const relay = (from: TokenLeg, to: TokenLeg): BridgeRoute[] => pair(from, to).map(([a, b]) => fast(
  'relay', 'fallback', 'fast', true, a, b, undefined,
  'Relay intents bridge. Used when Across is not the route that gets built.',
  `${SRC_RELAY} ${SRC_RH}`,
));
const lifi = (from: TokenLeg, to: TokenLeg): BridgeRoute[] => pair(from, to).map(([a, b]) => fast(
  'lifi', 'discovery', 'fast', false, a, b, undefined,
  'Li.Fi is discovery-only: a later search may ask it. It is never auto-selected.',
  `${SRC_LIFI} ${SRC_RH}`,
));

function canonical(fromChainId: number, toChainId: number, address: string, note: string): BridgeRoute {
  return {
    id: `canonical:${fromChainId}-${toChainId}`,
    protocol: 'canonical', fromChainId, toChainId, tokenIn: '*', tokenOut: '*',
    role: 'canonical', speed: 'slow', autoSelect: false, address, note, source: SRC_RH,
  };
}

function omnibridge(from: TokenLeg, to: TokenLeg): BridgeRoute[] {
  return pair(from, to).map(([a, b]) => fast(
    'pulse-omnibridge', 'primary', 'standard', true, a, b, undefined,
    'Official PulseChain OmniBridge (bridge.pulsechain.com). The route for Ethereum ↔ PulseChain; Across does not list chain 369.',
    SRC_PULSE,
  ));
}

export const BRIDGE_ROUTES: BridgeRoute[] = [
  ...across(wethEth, wethRh),
  ...relay(wethEth, wethRh),
  ...lifi(wethEth, wethRh),
  ...across(usdcEth, usdgRh),
  ...relay(usdcEth, usdgRh),
  ...lifi(usdcEth, usdgRh),
  canonical(1, 4663, RH_CANONICAL.delayedInbox, 'Arbitrum canonical deposit (Delayed Inbox). Withdrawals the other way wait ~7 days and are never auto-selected.'),
  canonical(4663, 1, RH_CANONICAL.outbox, 'Arbitrum canonical withdrawal: ~7 day challenge period, then a claim on Ethereum. Never auto-selected.'),
  ...omnibridge(wethEth, wethPls),
  ...omnibridge(usdcEth2, usdcPls),
];

const lc = (a: string) => a.toLowerCase();
const sameToken = (routeToken: string, query: string) => routeToken === '*' || lc(routeToken) === lc(query);

/** Every published candidate for this chain pair and source token, including routes that must not be auto-selected. */
export function bridgeRoutes(fromChainId: number, toChainId: number, token: string): BridgeRoute[] {
  return BRIDGE_ROUTES.filter((r) => r.fromChainId === fromChainId && r.toChainId === toChainId && sameToken(r.tokenIn, token));
}

/**
 * True when a route may be chosen without a person picking it.
 * Slow and canonical rows are refused here even if autoSelect was set, so a data edit cannot turn the 7-day bridge on.
 */
export function isAutoRoute(r: BridgeRoute): boolean {
  if (r.speed === 'slow') return false;
  if (r.protocol === 'canonical' || r.role === 'canonical') return false;
  if (r.role === 'discovery' || r.protocol === 'lifi') return false;
  return r.autoSelect;
}

const ROLE_ORDER: Record<BridgeRole, number> = { primary: 0, fallback: 1, discovery: 2, canonical: 3 };

/** Candidates a later bridge step may build. Canonical slow routes and Li.Fi are absent. */
export function autoRoutes(fromChainId: number, toChainId: number, token: string): BridgeRoute[] {
  return bridgeRoutes(fromChainId, toChainId, token)
    .filter(isAutoRoute)
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
}

export function mappingsFor(chainId: number, address: string): TokenMapping[] {
  return TOKEN_MAPPINGS.filter((m) => m.legs.some((l) => l.chainId === chainId && lc(l.address) === lc(address)));
}

/** The other chain's leg of the first mapping that has both, or null. */
export function counterpart(chainId: number, address: string, otherChainId: number): TokenLeg | null {
  for (const m of mappingsFor(chainId, address)) {
    const legOn = m.legs.find((l) => l.chainId === otherChainId);
    if (legOn) return legOn;
  }
  return null;
}
