/**
 * Network + contract config for live PulseX trading.
 *
 * Verified on-chain (RPC) — do not invent addresses:
 *   - Stables (2026-10-05): DAI/USDC/USDT bridged from Ethereum; deepest WPLS pairs.
 *   - HEX / eHEX / PLSX (2026-10-07): WPLS pairs preferred (orders of magnitude deeper than token/DAI).
 * Sources: PulseChain FAQ, PulseX docs, scan.pulsechain.com + factory.getPair + symbol()/decimals()/getAmountsOut.
 */

export type NetworkKey = 'testnet' | 'mainnet';

/** Quote side of a PLS/<quote> grid (stablecoin or other ERC-20). */
export interface QuoteToken {
  /** UI / config symbol (may differ from on-chain symbol, e.g. eHEX). */
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /** On-chain ERC-20 symbol() when it differs from `symbol` (eHEX → HEX). */
  onChainSymbol?: string;
  /** Verified PulseX V2 WPLS/<quote> pair (factory.getPair), used for candles/depth */
  pool?: string;
  kind: 'stable' | 'token';
}

/** @deprecated alias */
export type StableToken = QuoteToken;

export interface LiveNetwork {
  key: NetworkKey;
  label: string;
  chainId: number;
  chainIdHex: string;
  rpcUrl: string;
  explorer: string;
  nativeSymbol: string;
  faucet?: string;
  isTestnet: boolean;
  pulsex: {
    routerV2: string;
    factoryV2: string;
    wpls: string;
    /** LP fee in basis points (PulseX V2 = 29 bps; verified against getAmountsOut). */
    feeBps: number;
  };
  quotes: QuoteToken[];
  defaultQuote: string;
  /** Alias of quotes (legacy name). */
  stables: QuoteToken[];
  /** Alias of defaultQuote (legacy name). */
  defaultStable: string;
}

const MAINNET_QUOTES: QuoteToken[] = [
  { symbol: 'DAI', name: 'Dai Stablecoin from Ethereum', address: '0xefD766cCb38EaF1dfd701853BFCe31359239F305', decimals: 18, pool: '0x146E1f1e060e5b5016Db0D118D2C5a11A240ae32', kind: 'stable' },
  { symbol: 'USDC', name: 'USD Coin from Ethereum', address: '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07', decimals: 6, pool: '0x8eBe62D5e9D26b637673d91f56900233d6A4910d', kind: 'stable' },
  { symbol: 'USDT', name: 'Tether USD from Ethereum', address: '0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f', decimals: 6, pool: '0x21e4d9dfB30B097316De38ea49c68776C9735329', kind: 'stable' },
  // Native PulseChain HEX (same address as Ethereum HEX). WPLS pair 0x19BB…a98 ~143M HEX + ~35B WPLS (2026-10-07). DAI pool ~$243 — not used.
  { symbol: 'HEX', name: 'HEX', address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', decimals: 8, pool: '0x19BB45a7270177e303DEe6eAA6F5Ad700812bA98', kind: 'token' },
  // Bridged Ethereum HEX ("eHEX"). On-chain symbol() is "HEX". WPLS pair 0xF0eA…D3F ~157M + ~14.5B WPLS. DAI ~$34 — not used.
  { symbol: 'eHEX', name: 'HEX from Ethereum', address: '0x57fde0a71132198BBeC939B98976993d8D89D225', decimals: 8, onChainSymbol: 'HEX', pool: '0xF0eA3efE42C11c8819948Ec2D3179F4084863D3F', kind: 'token' },
  // PulseX token. WPLS pair 0x149B…f9F ~52.7B PLSX + ~41B WPLS. DAI ~$18k — WPLS preferred.
  { symbol: 'PLSX', name: 'PulseX', address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab', decimals: 18, pool: '0x149B2C629e652f2E89E11cd57e5d4D77ee166f9F', kind: 'token' },
];

const TESTNET_QUOTES: QuoteToken[] = [
  { symbol: 'DAI', name: 'Dai Stablecoin (testnet fork copy)', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, kind: 'stable' },
  { symbol: 'USDC', name: 'USD Coin (testnet fork copy)', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, kind: 'stable' },
];

export const NETWORKS: Record<NetworkKey, LiveNetwork> = {
  mainnet: {
    key: 'mainnet',
    label: 'PulseChain Mainnet',
    chainId: 369,
    chainIdHex: '0x171',
    rpcUrl: 'https://rpc.pulsechain.com',
    explorer: 'https://scan.pulsechain.com',
    nativeSymbol: 'PLS',
    isTestnet: false,
    pulsex: {
      routerV2: '0x165C3410fC91EF562C50559f7d2289fEbed552d9',
      factoryV2: '0x29eA7545DEf87022BAdc76323F373EA1e707C523',
      wpls: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
      feeBps: 29,
    },
    quotes: MAINNET_QUOTES,
    defaultQuote: 'DAI',
    stables: MAINNET_QUOTES,
    defaultStable: 'DAI',
  },
  testnet: {
    key: 'testnet',
    label: 'PulseChain Testnet v4',
    chainId: 943,
    chainIdHex: '0x3af',
    rpcUrl: 'https://rpc.v4.testnet.pulsechain.com',
    explorer: 'https://scan.v4.testnet.pulsechain.com',
    nativeSymbol: 'tPLS',
    faucet: 'https://faucet.v4.testnet.pulsechain.com/',
    isTestnet: true,
    pulsex: {
      routerV2: '0x636f6407B90661b73b1C0F7e24F4C79f624d0738',
      factoryV2: '0x3B53e9270d0210214B9c242eb16C252474c5be01',
      wpls: '0x70499adEBB11Efd915E3b69E700c331778628707',
      feeBps: 29,
    },
    quotes: TESTNET_QUOTES,
    defaultQuote: 'DAI',
    stables: TESTNET_QUOTES,
    defaultStable: 'DAI',
  },
};

export function getNetwork(key: NetworkKey): LiveNetwork {
  return NETWORKS[key];
}

export function networkByChainId(chainId: number | bigint | null | undefined): LiveNetwork | null {
  if (chainId == null) return null;
  const id = Number(chainId);
  return Object.values(NETWORKS).find((n) => n.chainId === id) ?? null;
}

export function getQuote(net: LiveNetwork, symbol: string): QuoteToken {
  const s = net.quotes.find((t) => t.symbol === symbol);
  if (!s) throw new Error(`Unknown quote ${symbol} on ${net.label}`);
  return s;
}

/** @deprecated use getQuote */
export function getStable(net: LiveNetwork, symbol: string): QuoteToken {
  return getQuote(net, symbol);
}

export function txUrl(net: LiveNetwork, hash: string): string {
  return `${net.explorer}/tx/${hash}`;
}

export function addressUrl(net: LiveNetwork, addr: string): string {
  return `${net.explorer}/address/${addr}`;
}

export function addChainParams(net: LiveNetwork) {
  return {
    chainId: net.chainIdHex,
    chainName: net.label,
    nativeCurrency: { name: net.isTestnet ? 'Test Pulse' : 'Pulse', symbol: net.nativeSymbol, decimals: 18 },
    rpcUrls: [net.rpcUrl],
    blockExplorerUrls: [net.explorer],
  };
}
