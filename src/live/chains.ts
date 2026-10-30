/**
 * Chain + DEX registry (pure data, safe to import from the UI — no secrets, no env access).
 *
 * Every address below was taken from the official source cited in `sources` AND checked on-chain on
 * 2026-10-08 (eth_chainId, code at address, router.factory() / WETH9() / quoter.factory(), a live quote):
 * see `npm run check:onchain`. Do not add addresses that have not been verified the same way.
 * Base, Arbitrum One, BNB Chain, Polygon PoS and OP Mainnet were re-checked on 2026-10-30: the same calls on every
 * listed RPC plus positionManager.factory() / WETH9(), the eth_call state override the safety check needs, and on three
 * live positions per chain the fees from the pool's counters equal what collect() pays.
 *
 * Server-side overrides (read in src/server/chains/runtime.ts): RPC_URL_<envSlug> (comma-separated list,
 * tried in order before the defaults) and an optional per-chain signing key with the same suffix.
 */
import { NETWORKS, type LiveNetwork } from './networks';

export type DexKind = 'v2' | 'v3' | 'v4';

export interface DexConfig {
  id: string;
  name: string;
  kind: DexKind;
  factory: string;
  /** V2: Router02. V3: SwapRouter02-compatible router (exactInputSingle without deadline + multicall(deadline, bytes[])). V4: Universal Router. */
  router: string;
  /** V3: QuoterV2. V4: the V4 Quoter. */
  quoter?: string;
  /** V4 only: StateView (getSlot0 / getLiquidity). The live LP fee is getSlot0().lpFee. */
  stateView?: string;
  /** V4 only: Permit2. ERC-20 input is approved here, then Permit2 approves the Universal Router. */
  permit2?: string;
  /** V4 only: PoolManager deployment block. Initialize scans start here. */
  v4StartBlock?: number;
  /**
   * V4 only: hook addresses that may trade. Empty / absent rejects every non-zero hook.
   * address(0) (no hook) is always allowed. Listing a hook is an explicit override, including a hook with delta flags.
   */
  hookAllowlist?: string[];
  /** V2 only: LP fee in bps (verified against getAmountsOut). */
  feeBps?: number;
  /** V3 only: fee tiers in hundredths of a bip (100 = 0.01 %). Used to find pools; a pool's own fee() is its fee. */
  feeTiers?: number[];
  /**
   * V3 only: pools can change fee() between blocks (Aerodrome Slipstream style). Quotes read fee() every time instead
   * of using the tier the pool was found at. No DEX configured today sets it (Uniswap/PancakeSwap/9mm fees are fixed).
   */
  dynamicFee?: boolean;
  source: string;
  note?: string;
  /** GeckoTerminal DEX id on this chain (verified 2026-10-17 against /networks/{slug}/dexes and a known pool) */
  gecko?: string;
  /** DexScreener's `dexId:label` for this DEX's pools (pair search). Each was matched to this DEX by a pool's factory() on-chain, 2026-10-22. */
  screener?: string;
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
  /**
   * L2 fee model. op = GasPriceOracle.getL1Fee, charged on top of gasUsed × gasPrice (Base, OP Mainnet).
   * arbitrum = NodeInterface L1 gas component, already inside gasUsed (Arbitrum One; Robinhood Chain is an Arbitrum Orbit L2).
   */
  stack: 'l1' | 'op' | 'arbitrum';
  /** Gas units used for ESTIMATES (approve, one swap). Probe-measured swap gas was 88–140k on every chain. */
  gasUnits: { approve: number; swap: number };
  /** Warn when the signer's native balance drops below this (native units) */
  lowGasNative: number;
  blockTimeSec: number;
  /** eth_getLogs chunk size for the on-chain candle fallback */
  logChunk: number;
  /**
   * Blockscout API (v2) that lists every ERC-20 a wallet holds, for Tools → Convert. Absent: only the coins of this
   * app's markets are listed (Robinhood's explorer answers servers with a Cloudflare challenge page, 2026-10-22).
   */
  tokenApi?: string;
  /** DexScreener chain id: the pair pickers search its pools (absent: no search on this chain) */
  screener?: string;
  sources: { label: string; url: string }[];
  note?: string;
}

const UNI_V2_SRC = 'https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments';
/**
 * Uniswap V2 pairs on Ethereum and Robinhood run byte-identical code (keccak of the runtime code matched, 2026-10-17)
 * and both factories have feeTo set, so the canonical _mintFee applies: feeTo gets 1/6 of the fee growth. The same
 * held on 2026-10-30 for Uniswap V2 on Base and Arbitrum and QuickSwap V2 on Polygon (pair code keccak 0x5b83bd…9ce5,
 * feeTo set on every factory).
 */
const UNI_V2_LP_SHARE = 5 / 6;
const TIERS_UNI = [100, 500, 3000, 10000];
const TIERS_CAKE = [100, 500, 2500, 10000];
/**
 * PancakeSwap V2 on BNB Chain (pair code differs from Uniswap's): router getAmountsOut equals the 25 bps formula to the
 * wei, and fee mints to feeTo on WBNB/USDT measured 0.3200 of the √k growth (2026-10-30, mints with no earlier pair event
 * in their block) → LPs keep 17 of the 25 bps.
 */
const CAKE_V2_LP_SHARE = 17 / 25;
/** Canonical Uniswap V3 addresses (Ethereum mainnet). */
const UNI_V3_CANON = {
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
};
/** `screener`: DexScreener leaves Uniswap V3 pools unlabeled on Arbitrum, Polygon and OP Mainnet ('uniswap:'; checked by factory() 2026-10-30). */
const uniV3 = (chainSrc: string, gecko: string, a = UNI_V3_CANON, screener = 'uniswap:v3'): DexConfig => ({
  id: 'uniswap-v3', name: 'Uniswap V3', kind: 'v3', ...a, feeTiers: TIERS_UNI, source: chainSrc, gecko, screener, protocolFee: 'uniswap',
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
    id: 'pulsex-v1', name: 'PulseX V1', kind: 'v2', gecko: 'pulsex', screener: 'pulsex:v1', factory: '0x1715a3E4A142d8b698131108995174F37aEBA10D',
    router: '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02', feeBps: 29, lpShare: 0,
    source: 'https://scan.pulsechain.com/address/0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02',
  },
  {
    id: '9mm-v2', name: '9mm V2', kind: 'v2', gecko: '9mm-v2', screener: '9mm:v2', factory: '0x3a0Fa7884dD93f3cd234bBE2A0958Ef04b05E13b',
    router: '0xcC73b59F8D7b7c532703bDfea2808a28a488cF47', feeBps: 25,
    source: 'https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v2.json',
  },
  {
    id: '9mm-v3', name: '9mm V3', kind: 'v3', gecko: '9mm-v3', screener: '9mm:v3', factory: '0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68',
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
    // lists a wallet's ERC-20s with balances (checked 2026-10-22)
    ...(net.isTestnet ? {} : { tokenApi: 'https://api.scan.pulsechain.com/api/v2', screener: 'pulsechain' }),
    trading: { enabled: true },
    // PulseX V2 stays first (legacy markets + the legacy Quoter constructor use it); mainnet adds PulseX V1 and 9mm.
    dexes: [
      { id: 'pulsex-v2', name: 'PulseX V2', kind: 'v2', gecko: net.isTestnet ? undefined : 'pulsex-v2', screener: 'pulsex:v2', factory: net.pulsex.factoryV2, router: net.pulsex.routerV2, feeBps: net.pulsex.feeBps, lpShare: net.isTestnet ? undefined : 22 / 29, source: 'https://scan.pulsechain.com/address/0x165C3410fC91EF562C50559f7d2289fEbed552d9' },
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
    explorer: 'https://robinhoodchain.blockscout.com', geckoSlug: 'robinhood', screener: 'robinhood', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments', 'uniswap-v3-robinhood', {
        factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', router: '0xCaf681a66D020601342297493863E78C959E5cb2', quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
        positionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
      }),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', gecko: 'uniswap-v2-robinhood', screener: 'uniswap:v2', factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f', router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: 'https://github.com/Uniswap/contracts/blob/main/deployments/4663.md' },
      { id: 'pancakeswap-v3', name: 'PancakeSwap V3', kind: 'v3', gecko: 'pancakeswap-v3-robinhood', screener: 'pancakeswap:v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', quoter: '0x8553AA1615549A86882151784b329B017aA7c832', feeTiers: TIERS_CAKE, protocolFee: 'pancake', source: 'https://developer.pancakeswap.finance/contracts/v3/addresses', note: 'Thin liquidity on WETH/USDG (Oct 2026); auto-pick prefers Uniswap.' },
      {
        id: 'uniswap-v4', name: 'Uniswap V4', kind: 'v4', gecko: 'uniswap-v4-robinhood',
        // No factory: this is the PoolManager. Pools are Initialize logs from v4StartBlock, keyed by PoolKey.
        factory: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
        // Universal Router 2.1.2 (current "Universal Router" in deployments/4663.md). 2.1.1 shares this calldata.
        router: '0x204FAca1764B154221e35c0d20aBb3c525710498',
        quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
        stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
        permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
        v4StartBlock: 9070,
        source: 'https://developers.uniswap.org/docs/protocols/v4/deployments',
        note: 'Singleton PoolManager. Swaps use Universal Router 2.1.2 and Permit2. The previous router 0x8876789976dEcBfCbBbe364623C63652db8C0904 accepts the same calldata. A non-zero hook is rejected unless it is listed in hookAllowlist; none are listed.',
      },
    ],
    stack: 'arbitrum', gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 0.0005, blockTimeSec: 0.25, logChunk: 20_000,
    sources: [
      { label: 'Robinhood Chain — connecting (chain ID, RPC, explorer)', url: 'https://docs.robinhood.com/chain/connecting' },
      { label: 'Robinhood Chain — contracts (WETH, USDG)', url: 'https://docs.robinhood.com/chain/contracts' },
      { label: 'Uniswap v3 Robinhood deployments', url: 'https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-deployments' },
      { label: 'Uniswap/contracts deployments/4663.md (v2, v3, v4)', url: 'https://github.com/Uniswap/contracts/blob/main/deployments/4663.md' },
      { label: 'Uniswap v4 deployments (Robinhood Chain 4663)', url: 'https://developers.uniswap.org/docs/protocols/v4/deployments' },
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
    // cloudflare-eth.com was dropped 2026-10-27: it answers eth_call / eth_getBalance / eth_blockNumber with JSON-RPC
    // errors (-32603 "Internal error", -32046 "Cannot fulfill request"); only eth_chainId still works.
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth-mainnet.public.blastapi.io'],
    explorer: 'https://etherscan.io', geckoSlug: 'eth', screener: 'ethereum', status: 'live', trading: { enabled: true },
    // lists a wallet's ERC-20s; an empty list for a wallet holding none (checked 2026-10-22)
    tokenApi: 'https://eth.blockscout.com/api/v2',
    dexes: [
      uniV3('https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments', 'uniswap_v3'),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', gecko: 'uniswap_v2', screener: 'uniswap:v2', factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: UNI_V2_SRC },
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
    // publicnode first: it serves 20,000-block eth_getLogs; base.drpc.org (free plan) refuses spans over ~100 blocks (2026-10-30)
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
    explorer: 'https://basescan.org', geckoSlug: 'base', screener: 'base', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://github.com/Uniswap/contracts/blob/main/deployments/8453.md', 'uniswap-v3-base', {
        factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', router: '0x2626664c2603336E57B271c5C0b26F421741e481', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      }),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', gecko: 'uniswap-v2-base', screener: 'uniswap:v2', factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: 'https://github.com/Uniswap/contracts/blob/main/deployments/8453.md' },
    ],
    stack: 'op', gasUnits: { approve: 60_000, swap: 180_000 }, lowGasNative: 0.0005, blockTimeSec: 2, logChunk: 10_000,
    sources: [
      { label: 'Base docs — network information', url: 'https://docs.base.org/base-chain/quickstart/connecting-to-base' },
      { label: 'Uniswap/contracts deployments/8453.md (v2, v3)', url: 'https://github.com/Uniswap/contracts/blob/main/deployments/8453.md' },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
    note: 'OP-stack L2, ETH gas. Aerodrome (the largest Base DEX) is not supported: its pools are not Uniswap-compatible.',
  },
  {
    id: 42161, key: 'arbitrum', envSlug: 'ARBITRUM', name: 'Arbitrum One', short: 'ARB', color: '#28a0f0', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDC', name: 'USD Coin (native)', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, kind: 'stable' },
      { symbol: 'USDT', name: 'USD₮0', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, kind: 'stable', note: 'on-chain symbol "USD₮0"' },
    ],
    // arb1 first: the only one of the three serving eth_getLogs over 100 blocks (publicnode asks for a token, drpc free plan refuses; 2026-10-30)
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    explorer: 'https://arbiscan.io', geckoSlug: 'arbitrum', screener: 'arbitrum', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://github.com/Uniswap/contracts/blob/main/deployments/42161.md', 'uniswap_v3_arbitrum', UNI_V3_CANON, 'uniswap:'),
      { id: 'uniswap-v2', name: 'Uniswap V2', kind: 'v2', gecko: 'uniswap-v2-arbitrum', screener: 'uniswap:v2', factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: 'https://github.com/Uniswap/contracts/blob/main/deployments/42161.md', note: 'Shallow; V3 holds the liquidity.' },
    ],
    stack: 'arbitrum', gasUnits: { approve: 60_000, swap: 220_000 }, lowGasNative: 0.0005, blockTimeSec: 0.25, logChunk: 20_000,
    sources: [
      { label: 'Arbitrum docs — RPC endpoints', url: 'https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers' },
      { label: 'Uniswap/contracts deployments/42161.md (v2, v3)', url: 'https://github.com/Uniswap/contracts/blob/main/deployments/42161.md' },
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
    // publicnode first: the bnbchain/defibit dataseeds answer every eth_getLogs with "limit exceeded" (2026-10-30)
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.drpc.org'],
    explorer: 'https://bscscan.com', geckoSlug: 'bsc', screener: 'bsc', status: 'live', trading: { enabled: true },
    dexes: [
      {
        id: 'pancakeswap-v3', name: 'PancakeSwap V3', kind: 'v3', gecko: 'pancakeswap-v3-bsc', screener: 'pancakeswap:v3', factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
        router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', feeTiers: TIERS_CAKE, protocolFee: 'pancake',
        positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', source: 'https://developer.pancakeswap.finance/contracts/v3/addresses',
      },
      { id: 'pancakeswap-v2', name: 'PancakeSwap V2', kind: 'v2', gecko: 'pancakeswap_v2', screener: 'pancakeswap:v2', factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E', feeBps: 25, lpShare: CAKE_V2_LP_SHARE, source: 'https://developer.pancakeswap.finance/contracts/v2/addresses' },
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
    // publicnode serves up to 10,000 blocks per eth_getLogs; polygon.drpc.org (free plan) about 100 (2026-10-30)
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    explorer: 'https://polygonscan.com', geckoSlug: 'polygon_pos', screener: 'polygon', status: 'live', trading: { enabled: true },
    dexes: [
      uniV3('https://github.com/Uniswap/contracts/blob/main/deployments/137.md', 'uniswap_v3_polygon_pos', UNI_V3_CANON, 'uniswap:'),
      { id: 'quickswap-v2', name: 'QuickSwap V2', kind: 'v2', gecko: 'quickswap', screener: 'quickswap:v2', factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', feeBps: 30, lpShare: UNI_V2_LP_SHARE, source: 'https://docs.quickswap.exchange/overview/contracts-and-addresses' },
    ],
    stack: 'l1', gasUnits: { approve: 60_000, swap: 200_000 }, lowGasNative: 1, blockTimeSec: 2, logChunk: 3000,
    sources: [
      { label: 'Polygon docs — RPC endpoints', url: 'https://docs.polygon.technology/pos/reference/rpc-endpoints/' },
      { label: 'Uniswap/contracts deployments/137.md (v3)', url: 'https://github.com/Uniswap/contracts/blob/main/deployments/137.md' },
      { label: 'QuickSwap contracts', url: 'https://docs.quickswap.exchange/overview/contracts-and-addresses' },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
    note: 'polygon-rpc.com returns 401 without a key; publicnode/drpc are used.',
  },
  {
    id: 10, key: 'optimism', envSlug: 'OPTIMISM', name: 'OP Mainnet', short: 'OP', color: '#ff0420', nativeSymbol: 'ETH',
    wrappedNative: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18, kind: 'wrapped' },
    stables: [
      { symbol: 'USDC', name: 'USD Coin (native)', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, kind: 'stable' },
      { symbol: 'USDT', name: 'Tether USD', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6, kind: 'stable' },
    ],
    // mainnet.optimism.io serves 10,000-block eth_getLogs, old ranges included; publicnode only recent ones (2026-10-30)
    rpcs: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
    explorer: 'https://optimistic.etherscan.io', geckoSlug: 'optimism', screener: 'optimism', status: 'live', trading: { enabled: true },
    // Blockscout's OP Mainnet instance; lists a wallet's ERC-20s (checked 2026-10-30)
    tokenApi: 'https://explorer.optimism.io/api/v2',
    dexes: [uniV3('https://github.com/Uniswap/contracts/blob/main/deployments/10.md', 'uniswap_v3_optimism', UNI_V3_CANON, 'uniswap:')],
    stack: 'op', gasUnits: { approve: 60_000, swap: 180_000 }, lowGasNative: 0.0005, blockTimeSec: 2, logChunk: 10_000,
    sources: [
      { label: 'Optimism docs — networks', url: 'https://docs.optimism.io/superchain/networks' },
      { label: 'Uniswap/contracts deployments/10.md (v3)', url: 'https://github.com/Uniswap/contracts/blob/main/deployments/10.md' },
      { label: 'Circle USDC addresses', url: 'https://developers.circle.com/stablecoins/usdc-contract-addresses' },
    ],
    note: 'OP-stack L2, ETH gas.',
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
