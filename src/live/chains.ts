/**
 * Chain + DEX registry (pure data, safe to import from the UI — no secrets, no env access).
 *
 * Every address below was taken from the official source cited in `sources` AND checked on-chain on
 * 2026-10-08 (eth_chainId, code at address, router.factory() / WETH9() / quoter.factory(), a live quote):
 * see `npm run check:onchain`. Do not add addresses that have not been verified the same way.
 *
 * Server-side overrides (read in src/server/chains/runtime.ts): RPC_URL_<envSlug> (comma-separated list,
 * tried in order before the defaults) and an optional per-chain signing key with the same suffix.
 */
import { NETWORKS, type LiveNetwork } from './networks';

export type DexKind = 'v2' | 'v3';

export interface DexConfig {
  id: string;
  name: string;
  kind: DexKind;
  factory: string;
  /** V2: Router02. V3: SwapRouter02-compatible router (exactInputSingle without deadline + multicall(deadline, bytes[])). */
  router: string;
  /** V3 only: QuoterV2 */
  quoter?: string;
  /** V2 only: LP fee in bps (verified against getAmountsOut). */
  feeBps?: number;
  /** V3 only: fee tiers in hundredths of a bip (100 = 0.01 %). */
  feeTiers?: number[];
  source: string;
  note?: string;
  /** GeckoTerminal DEX id on this chain (verified 2026-10-17 against /networks/{slug}/dexes and a known pool) */
  gecko?: string;
  /**
   * V2 only: share of the swap fee that stays with liquidity providers (the rest is minted to the factory's feeTo).
   * Measured 2026-10-17 from on-chain fee mints; absent = not verified, so the LP backtest refuses the DEX.
   */
  lpShare?: number;
  /**
   * V3 only: how slot0().feeProtocol is encoded, so the LP share can be read live per pool.
   * uniswap: low/high 4 bits = N, protocol takes 1/N (0 = off). pancake: low/high 16 bits = protocol share × 10 000.
   */
  protocolFee?: 'uniswap' | 'pancake';
  /**
   * V3 only: NonfungiblePositionManager for liquidity positions (the LP bot). Verified 2026-10-18: factory() and WETH9()
   * match this config on-chain, and fees computed from the pool's counters equal what collect() pays on live positions.
   */
  positionManager?: string;
}

export interface ChainToken {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** stable = treated as ≈1 USD for portfolio maths */
  kind: 'stable' | 'wrapped' | 'token';
  note?: string;
}

export interface ChainConfig {
  id: number;
  /** Stable registry key, used in market keys and URLs */
  key: string;
  /** Suffix for per-chain env vars, e.g. RPC_URL_BASE */
  envSlug: string;
  name: string;
  /** 2–4 letter badge */
  short: string;
  color: string;
  nativeSymbol: string;
  wrappedNative: ChainToken;
  stables: ChainToken[];
  /** Public RPCs in fallback order (env overrides are prepended server-side). */
  rpcs: string[];
  explorer: string;
  /** GeckoTerminal network id (verified against /api/v2/networks on 2026-10-08) */
  geckoSlug: string | null;
  status: 'live' | 'testnet';
  /** Trading unavailable → config still listed, bots cannot start; reason shown in the UI. */
  trading: { enabled: boolean; reason?: string };
  dexes: DexConfig[];
  /** L2 fee model: arbitrum = NodeInterface L1 gas component (Robinhood Chain is an Arbitrum Orbit L2). */
  stack: 'l1' | 'arbitrum';
  /** Gas units used for ESTIMATES (approve, one swap). Probe-measured swap gas was 88–140k on every chain. */
  gasUnits: { approve: number; swap: number };
  /** Warn when the signer's native balance drops below this (native units) */
  lowGasNative: number;
  blockTimeSec: number;
  /** eth_getLogs chunk size for the on-chain candle fallback */
  logChunk: number;
  sources: { label: string; url: string }[];
  note?: string;
}

const UNI_V2_SRC = 'https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments';
/**
 * Uniswap V2 pairs on Ethereum and Robinhood run byte-identical code (keccak of the runtime code matched, 2026-10-17)
 * and both factories have feeTo set, so the canonical _mintFee applies: feeTo gets 1/6 of the fee growth.
 */
const UNI_V2_LP_SHARE = 5 / 6;
const TIERS_UNI = [100, 500, 3000, 10000];
const TIERS_CAKE = [100, 500, 2500, 10000];
/** Canonical Uniswap V3 addresses (Ethereum mainnet). */
const UNI_V3_CANON = {
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
};
const uniV3 = (chainSrc: string, gecko: string, a = UNI_V3_CANON): DexConfig => ({
  id: 'uniswap-v3', name: 'Uniswap V3', kind: 'v3', ...a, feeTiers: TIERS_UNI, source: chainSrc, gecko, protocolFee: 'uniswap',
});

/**
 * Extra PulseChain mainnet DEXes (verified 2026-10-08, see README "Sources"):
 *  - PulseX V1: separate router/factory from V2 (PulseScan "Official" label, same deployer 0x30e22a…c72539 as V2);
 *    router.factory() == factory on-chain; fee measured from reserves vs getAmountsOut = 29 bps.
 *  - 9mm V2 / V3: github.com/9mm-exchange/deployments pulsechain/v2.json + v3.json. V2 router.factory() == factory,
 *    fee measured 25 bps. V3 is a PancakeSwap-V3 fork: SmartRouter + QuoterV2 report factory/deployer/WPLS on-chain;
 *    enabled tiers via factory.feeAmountTickSpacing: 100, 500, 2500, 10000, 20000 (3000 disabled).
 *  LP fee shares (measured 2026-10-17):
 *  - PulseX V1: fee mints to feeTo equal the whole √k growth since kLast (6 mints, ratio 1.000), and one DAI/WPLS LP
 *    token's √k/supply was flat over 30 days (−0.15 % … +0.23 %) while the pool traded ≈1× its size a day → LPs keep ~0.
 *  - PulseX V2: feeTo receives 0.2414 of the √k growth on every mint (6 mints) = 7/29 → LPs keep 22 of the 29 bps.
 *  - 9mm V2: feeTo is set but no fee mint happened in ~35 days (pools hold ≈$1k), so its split is not verified.
 *  - 9mm V3: slot0.feeProtocol 3200/3200 (pancake encoding); Swap events' protocol-fee totals grow by exactly 0.3200 of
 *    the fee on single-hop swaps.
 */
export const PULSECHAIN_EXTRA_DEXES: DexConfig[] = [
  {
    id: 'pulsex-v1', name: 'PulseX V1', kind: 'v2', gecko: 'pulsex', factory: '0x1715a3E4A142d8b698131108995174F37aEBA10D',
    router: '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02', feeBps: 29, lpShare: 0,
    source: 'https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02',
  },
  {
    id: '9mm-v2', name: '9mm V2', kind: 'v2', gecko: '9mm-v2', factory: '0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b',
    router: '0xcC73b59F8D7b7c532703bDfea2808a28a488cF47', feeBps: 25,
    source: 'https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json',
  },
  {
    id: '9mm-v3', name: '9mm V3', kind: 'v3', gecko: '9mm-v3', factory: '0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68',
    router: '0xa9444246d80d6E3496C9242395213B4f22226a59', quoter: '0x500260dD7C27eCE20b89ea0808d05a13CF867279',
    feeTiers: [100, 500, 2500, 10000, 20000], protocolFee: 'pancake', positionManager: '0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2',
    source: 'https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json',
    note: 'PancakeSwap-V3 fork (SmartRouter interface); 0.3% tier not enabled',
  },
];

/** PulseChain is derived from the legacy network config so existing state and tests keep their exact values. */
export function chainFromNetwork(net: LiveNetwork): ChainConfig {
  const wn: ChainToken = { symbol: 'WPLS', name: 'Wrapped Pulse', address: net.pulsex.wpls, decimals: 18, kind: 'wrapped' };
  return {
    id: net.chainId, key: net.isTestnet ? 'pulsechain-testnet' : 'pulsechain', envSlug: net.isTestnet ? 'PULSECHAIN_TESTNET' : 'PULSECHAIN',
    name: net.label, short: 'PLS', color: '#e040fb', nativeSymbol: net.nativeSymbol, wrappedNative: wn,
    stables: net.quotes.filter((q) => q.kind === 'stable').map((q) => ({ symbol: q.symbol, name: q.name, address: q.address, decimals: q.decimals, kind: 'stable' as const })),
    rpcs: net.isTestnet ? [net.rpcUrl] : [net.rpcUrl, 'https://pulsechain-rpc.publicnode.com', 'https://rpc-pulsechain.g4mm4.io'],
    explorer: net.explorer, geckoSlug: net.isTestnet ? null : 'pulsechain', status: net.isTestnet ? 'testnet' : 'live',
    trading: { enabled: true },
    // PulseX V2 stays first (legacy markets + the legacy Quoter constructor use it); mainnet adds PulseX V1 and 9mm.
    dexes: [
      { id: 'pulsex-v2', name: 'PulseX V2', kind: 'v2', gecko: net.isTestnet ? undefined : 'pulsex-v2', factory: net.pulsex.factoryV2, router: net.pulsex.routerV2, feeBps: net.pulsex.feeBps, lpShare: net.isTestnet ? undefined : 22 / 29, source: 'https://scan.pulsechain.com/address/0x165C3410fC91EF562C50559f7d2289fEbed552d9' },
      ...(net.isTestnet ? [] : PULSECHAIN_EXTRA_DEXES),
    ],
    stack: 'l1', gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 50_000, blockTimeSec: 10, logChunk: 5000,
    sources: [
      { label: 'PulseChain docs', url: 'https://docs.pulsechain.com' },
      { label: 'PulseX docs', url: 'https://docs.pulsex.com' },
      ...(net.isTestnet ? [] : [
        { label: 'PulseX V1/V2 router + factory list (community PulseChain docs)', url: 'https://hexikani.github.io/pulsechain-docs/pulsex.html' },
        { label: 'PulseX V1 router on PulseScan (Official label)', url: 'https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02' },
        { label: '9mm deployments (official GitHub): pulsechain/v2.json', url: 'https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json' },
        { label: '9mm deployments (official GitHub): pulsechain/v3.json', url: 'https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json' },
      ]),
      { label: 'PulseScan', url: net.explorer },
    ],
  };
}

export const CHAINS: ChainConfig[] = [
  chainFromNetwork(NETWORKS.mainnet),
  {
    id: 4663, key: 'robinhood', envSlug: 'ROBINHOOD', name: 'Robinhood Chain', short: 'HOOD', color: '#ccff00', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18, kind: 'wrapped' },
    stables: [{ symbol: 'USDG', name: 'Global Dollar (Paxos)', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, kind: 'stable', note: 'Upgradeable proxy (Paxos-issued stablecoin)' }],
    rpcs: ['https://rpc.mainnet.chain.robinhood.com'],
    explorer: 'https://robinhoodchain.blockscout.com', geckoSlug: 'robinhood', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments', 'uniswap-v3-robinhood', {
        factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', router: '0xCaf681a66D020601342297493863E78C959E5cb2', quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
        positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
      }),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', gecko: 'uniswap-v2-robinhood', factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f', router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: 'https://github.com/Uniswap/contracts/blob/main/deployments/4663.md' },
      { id: 'pancakeswap-v3', name: 'PancakeSwap V3', kind: 'v3', gecko: 'pancakeswap-v3-robinhood', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', quoter: '0x8553AA1615549A86882151784b329B017aA7c832', feeTiers: TIERS_CAKE, protocolFee: 'pancake', source: 'https://developer.pancakeswap.finance/contracts/v3/addresses', note: 'Thin liquidity on WETH/USDG (Oct 2026); auto-pick prefers Uniswap.' },
    ],
    stack: 'arbitrum', gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 0.0005, blockTimeSec: 0.25, logChunk: 20_000,
    sources: [
      { label: 'Robinhood Chain — connecting (chain ID, RPC, explorer)', url: 'https://docs.robinhood.com/chain/connecting' },
      { label: 'Robinhood Chain — contracts (WETH, USDG)', url: 'https://docs.robinhood.com/chain/contracts' },
      { label: 'Uniswap v3 Robinhood deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments' },
      { label: 'Uniswap/contracts deployments/4663.md (v2 + v3)', url: 'https://github.com/Uniswap/contracts/blob/main/deployments/4663.md' },
      { label: 'PancakeSwap v3 addresses (Robinhood column)', url: 'https://developer.pancakeswap.finance/contracts/v3/addresses' },
    ],
    note: 'Arbitrum Orbit L2, mainnet since 2026-07-01, ETH gas. An Alchemy endpoint (needs your API key) can be added via RPC_URL_ROBINHOOD.',
  },
  {
    id: 1, key: 'ethereum', envSlug: 'ETHEREUM', name: 'Ethereum', short: 'ETH', color: '#8c9eff', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDC', name: 'USD Coin', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, kind: 'stable' },
      { symbol: 'USDT', name: 'Tether USD', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, kind: 'stable' },
      { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, kind: 'stable' },
    ],
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'],
    explorer: 'https://etherscan.io', geckoSlug: 'eth', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments', 'uniswap_v3'),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', gecko: 'uniswap_v2', factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: UNI_V2_SRC },
    ],
    stack: 'l1', gasUnits: { approve: 60_000, swap: 180_000 }, lowGasNative: 0.01, blockTimeSec: 12, logChunk: 2000,
    sources: [
      { label: 'Uniswap v3 Ethereum deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments' },
      { label: 'Uniswap v2 deployments', url: UNI_V2_SRC },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
      { label: 'Tether supported protocols', url: 'https://tether.to/en/supported-protocols' },
    ],
    note: 'L1 gas makes small grids uneconomic — the start gate will usually block them.',
  },
];

export const LEGACY_CHAIN_ID = 369;

export function chainById(id: number, list: ChainConfig[] = CHAINS): ChainConfig | null {
  return list.find((c) => c.id === Number(id)) ?? null;
}
export function chainByKey(key: string, list: ChainConfig[] = CHAINS): ChainConfig | null {
  return list.find((c) => c.key === key) ?? null;
}
export function explorerTx(c: Pick<ChainConfig, 'explorer'>, hash: string) { return `${c.explorer}/tx/${hash}`; }
export function explorerAddress(c: Pick<ChainConfig, 'explorer'>, addr: string) { return `${c.explorer}/address/${addr}`; }
export function v3FeeBps(tier: number) { return tier / 100; }
export function fmtFeeTier(tier: number) { return `${+(tier / 10_000).toFixed(2)}%`; }
