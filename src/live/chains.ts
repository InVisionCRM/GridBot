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
  /** L2 fee model: op = add GasPriceOracle.getL1Fee; arbitrum = NodeInterface L1 gas component. */
  stack: 'l1' | 'op' | 'arbitrum';
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
const TIERS_UNI = [100, 500, 3000, 10000];
const TIERS_CAKE = [100, 500, 2500, 10000];
/** Canonical Uniswap V3 addresses shared by Ethereum, Arbitrum, Optimism and Polygon. */
const UNI_V3_CANON = {
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};
const uniV3 = (chainSrc: string, a = UNI_V3_CANON): DexConfig => ({
  id: 'uniswap-v3', name: 'Uniswap V3', kind: 'v3', ...a, feeTiers: TIERS_UNI, source: chainSrc,
});

/**
 * Extra PulseChain mainnet DEXes (verified 2026-10-08, see README "Sources"):
 *  - PulseX V1: separate router/factory from V2 (PulseScan "Official" label, same deployer 0x30e22a…c72539 as V2);
 *    router.factory() == factory on-chain; fee measured from reserves vs getAmountsOut = 29 bps.
 *  - 9mm V2 / V3: github.com/9mm-exchange/deployments pulsechain/v2.json + v3.json. V2 router.factory() == factory,
 *    fee measured 25 bps. V3 is a PancakeSwap-V3 fork: SmartRouter + QuoterV2 report factory/deployer/WPLS on-chain;
 *    enabled tiers via factory.feeAmountTickSpacing: 100, 500, 2500, 10000, 20000 (3000 disabled).
 */
export const PULSECHAIN_EXTRA_DEXES: DexConfig[] = [
  {
    id: 'pulsex-v1', name: 'PulseX V1', kind: 'v2', factory: '0x1715a3E4A142d8b698131108995174F37aEBA10D',
    router: '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02', feeBps: 29,
    source: 'https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02',
  },
  {
    id: '9mm-v2', name: '9mm V2', kind: 'v2', factory: '0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b',
    router: '0xcC73b59F8D7b7c532703bDfea2808a28a488cF47', feeBps: 25,
    source: 'https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json',
  },
  {
    id: '9mm-v3', name: '9mm V3', kind: 'v3', factory: '0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68',
    router: '0xa9444246d80d6E3496C9242395213B4f22226a59', quoter: '0x500260dD7C27eCE20b89ea0808d05a13CF867279',
    feeTiers: [100, 500, 2500, 10000, 20000],
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
      { id: 'pulsex-v2', name: 'PulseX V2', kind: 'v2', factory: net.pulsex.factoryV2, router: net.pulsex.routerV2, feeBps: net.pulsex.feeBps, source: 'https://scan.pulsechain.com/address/0x165C3410fC91EF562C50559f7d2289fEbed552d9' },
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
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments', {
        factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', router: '0xCaf681a66D020601342297493863E78C959E5cb2', quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
      }),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f', router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba', feeBps: 30, source: 'https://github.com/Uniswap/contracts/blob/main/deployments/4663.md' },
      { id: 'pancakeswap-v3', name: 'PancakeSwap V3', kind: 'v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', quoter: '0x8553AA1615549A86882151784b329B017aA7c832', feeTiers: TIERS_CAKE, source: 'https://developer.pancakeswap.finance/contracts/v3/addresses', note: 'Thin liquidity on WETH/USDG (Oct 2026); auto-pick prefers Uniswap.' },
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
    id: 46630, key: 'robinhood-testnet', envSlug: 'ROBINHOOD_TESTNET', name: 'Robinhood Chain Testnet', short: 'tHOOD', color: '#8a9a3a', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x7943e237c7F95DA44E0301572D358911207852Fa', decimals: 18, kind: 'wrapped' },
    stables: [{ symbol: 'USDG', name: 'Global Dollar (testnet)', address: '0x7E955252E15c84f5768B83c41a71F9eba181802F', decimals: 6, kind: 'stable' }],
    rpcs: ['https://rpc.testnet.chain.robinhood.com'],
    explorer: 'https://explorer.testnet.chain.robinhood.com', geckoSlug: null, status: 'testnet',
    trading: { enabled: false, reason: 'TESTNET — no official DEX deployment found: the mainnet Uniswap/PancakeSwap addresses have no code on 46630 and no testnet router/quoter is published (checked 2026-10-08).' },
    dexes: [], stack: 'arbitrum', gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 0.0005, blockTimeSec: 0.25, logChunk: 20_000,
    sources: [
      { label: 'Robinhood Chain — connecting', url: 'https://docs.robinhood.com/chain/connecting' },
      { label: 'Robinhood Chain — contracts', url: 'https://docs.robinhood.com/chain/contracts' },
    ],
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
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments'),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', feeBps: 30, source: UNI_V2_SRC },
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
  {
    id: 8453, key: 'base', envSlug: 'BASE', name: 'Base', short: 'BASE', color: '#2f6bff', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18, kind: 'wrapped' },
    stables: [{ symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, kind: 'stable' }],
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'],
    explorer: 'https://basescan.org', geckoSlug: 'base', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments', {
        factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', router: '0x2626664c2603336E57B271c5C0b26F421741e481', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      }),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', feeBps: 30, source: UNI_V2_SRC },
    ],
    stack: 'op', gasUnits: { approve: 60_000, swap: 180_000 }, lowGasNative: 0.0005, blockTimeSec: 2, logChunk: 10_000,
    sources: [
      { label: 'Base docs — network information', url: 'https://docs.base.org/base-chain/quickstart/connecting-to-base' },
      { label: 'Uniswap v3 Base deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments' },
      { label: 'Uniswap v2 deployments', url: UNI_V2_SRC },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
  },
  {
    id: 42161, key: 'arbitrum', envSlug: 'ARBITRUM', name: 'Arbitrum One', short: 'ARB', color: '#28a0f0', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDC', name: 'USD Coin (native)', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, kind: 'stable' },
      { symbol: 'USDT', name: 'USD₮0', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, kind: 'stable', note: 'on-chain symbol "USD₮0"' },
    ],
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    explorer: 'https://arbiscan.io', geckoSlug: 'arbitrum', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments'),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', feeBps: 30, source: UNI_V2_SRC, note: 'Shallow; V3 holds the liquidity.' },
    ],
    stack: 'arbitrum', gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 0.0005, blockTimeSec: 0.25, logChunk: 20_000,
    sources: [
      { label: 'Arbitrum docs — RPC endpoints', url: 'https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers' },
      { label: 'Uniswap v3 Arbitrum deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments' },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
  },
  {
    id: 56, key: 'bsc', envSlug: 'BSC', name: 'BNB Chain', short: 'BNB', color: '#f0b90b', nativeSymbol: 'BNB',
    wrappedNative: { symbol: 'WBNB', name: 'Wrapped BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDT', name: 'Tether USD (BSC-USD)', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, kind: 'stable', note: '18 decimals on BNB Chain' },
      { symbol: 'USDC', name: 'USD Coin (Binance-Peg)', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, kind: 'stable', note: '18 decimals on BNB Chain' },
    ],
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io', 'https://bsc.drpc.org'],
    explorer: 'https://bscscan.com', geckoSlug: 'bsc', status: 'live', trading: { enabled: true },
    dexes: [
      { id: 'pancakeswap-v3', name: 'PancakeSwap V3', kind: 'v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', feeTiers: TIERS_CAKE, source: 'https://developer.pancakeswap.finance/contracts/v3/addresses' },
      { id: 'pancakeswap-v2', name: 'PancakeSwap V2', kind: 'v2', factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E', feeBps: 25, source: 'https://developer.pancakeswap.finance/contracts/v2/addresses' },
    ],
    stack: 'l1', gasUnits: { approve: 60_000, swap: 200_000 }, lowGasNative: 0.005, blockTimeSec: 0.75, logChunk: 5000,
    sources: [
      { label: 'BNB Chain docs — RPC', url: 'https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/' },
      { label: 'PancakeSwap v3 addresses', url: 'https://developer.pancakeswap.finance/contracts/v3/addresses' },
      { label: 'PancakeSwap v2 addresses', url: 'https://developer.pancakeswap.finance/contracts/v2/addresses' },
    ],
  },
  {
    id: 137, key: 'polygon', envSlug: 'POLYGON', name: 'Polygon PoS', short: 'POL', color: '#8247e5', nativeSymbol: 'POL',
    wrappedNative: { symbol: 'WPOL', name: 'Wrapped POL', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDC', name: 'USD Coin (native)', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, kind: 'stable' },
      { symbol: 'USDT', name: 'USDT0', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, kind: 'stable', note: 'on-chain symbol "USDT0"' },
    ],
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    explorer: 'https://polygonscan.com', geckoSlug: 'polygon_pos', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-polygon-deployments'),
      { id: 'quickswap-v2', name: 'QuickSwap V2', kind: 'v2', factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', feeBps: 30, source: 'https://docs.quickswap.exchange/overview/contracts-and-addresses' },
    ],
    stack: 'l1', gasUnits: { approve: 60_000, swap: 200_000 }, lowGasNative: 1, blockTimeSec: 2, logChunk: 3000,
    sources: [
      { label: 'Polygon docs — RPC endpoints', url: 'https://docs.polygon.technology/pos/reference/rpc-endpoints/' },
      { label: 'Uniswap v3 Polygon deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-polygon-deployments' },
      { label: 'QuickSwap contracts', url: 'https://docs.quickswap.exchange/overview/contracts-and-addresses' },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
    note: 'polygon-rpc.com now returns 401 without a key; publicnode/drpc are used.',
  },
  {
    id: 10, key: 'optimism', envSlug: 'OPTIMISM', name: 'OP Mainnet', short: 'OP', color: '#ff0420', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDC', name: 'USD Coin (native)', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, kind: 'stable' },
      { symbol: 'USDT', name: 'Tether USD', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, kind: 'stable' },
    ],
    rpcs: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
    explorer: 'https://optimistic.etherscan.io', geckoSlug: 'optimism', status: 'live', trading: { enabled: true },
    dexes: [uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-optimism-deployments')],
    stack: 'op', gasUnits: { approve: 60_000, swap: 180_000 }, lowGasNative: 0.0005, blockTimeSec: 2, logChunk: 10_000,
    sources: [
      { label: 'Optimism docs — networks', url: 'https://docs.optimism.io/superchain/networks' },
      { label: 'Uniswap v3 Optimism deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-optimism-deployments' },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
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
