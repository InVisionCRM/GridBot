/**
 * Market model (pure, UI-safe). A market = base/quote on one pool of one DEX on one chain.
 * Prices are always QUOTE per BASE, sell-side after the LP fee (what selling `probe` base returns).
 *
 * Legacy PulseChain markets keep their old keys ('DAI', 'HEX', …) so saved grids, trend bots, alerts and
 * candle files load unchanged; every other market is keyed '<chainKey>:<BASE>/<QUOTE>[#n]'.
 */
import type { LiveNetwork } from './networks';
import { CHAINS, chainFromNetwork, type ChainConfig, type DexKind } from './chains';

export interface MarketToken {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  /** The chain's wrapped native, traded as the native coin (no approval, wraps/unwraps in the router). Either side:
   *  base in the classic orientation (PLS/HEX), quote in the flipped one (HEX/PLS). */
  native?: boolean;
}

export interface PoolRef {
  dex: string;
  kind: DexKind;
  /** Pool / pair address ('' = resolve through the factory) */
  address: string;
  /** LP fee in bps (V2: DEX fee; V3: tier / 100; V4: lpFee / 100, re-read at quote time when the pool is dynamic) */
  feeBps: number;
  /** V3 fee tier in hundredths of a bip */
  feeTier?: number;
  /**
   * V4 PoolKey. `address` on this ref is the pool id (bytes32). currency 0x0 is native ETH; swaps and the
   * safety probe use this key, not the wrapped-native address the rest of the app shows.
   */
  v4?: {
    currency0: string;
    currency1: string;
    /** Static fee, or DYNAMIC_FEE_FLAG (0x800000) when the live fee comes from StateView. */
    fee: number;
    tickSpacing: number;
    hooks: string;
    poolId: string;
    dynamicFee: boolean;
  };
}

export interface SafetyReport {
  at: number;
  risk: 'low' | 'medium' | 'high' | 'blocked' | 'unknown';
  liveAllowed: boolean;
  reasons: string[];
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  transferTaxPct: number | null;
  honeypot: boolean | null;
  proxy: { kind: string; implementation?: string } | null;
  depth: { usd: number; buyImpactPct: number | null; sellImpactPct: number | null }[];
  liquidityUsd: number | null;
  simulated: boolean;
  note?: string;
  /** How taxes are traded: none · V2 fee-on-transfer methods · V3 or V4 proven by simulation · blocked */
  taxMode?: 'none' | 'v2-fot' | 'v3-proven' | 'v4-proven' | 'blocked';
  /** Pool kind the report was measured on (taxes are pool-specific for V3 and V4) */
  poolKind?: 'v2' | 'v3' | 'v4';
  /** Live cap per side (fraction) at the time of the check */
  taxCapPct?: number;
  /** Token limits in human units (maxTxAmount / maxWallet views); trades above them are skipped */
  maxTxTokens?: number | null;
  maxWalletTokens?: number | null;
  /** Owner can blacklist wallets (signature of the view found) */
  blacklist?: string | null;
  /** paused() true / tradingEnabled() false */
  paused?: boolean | null;
  /** Token decimals read on-chain at check time */
  decimals?: number;
  /**
   * Set when the last re-check failed or measured nothing: the values above are the last known ones, kept for display
   * and for the taxes the quotes use, but not re-confirmed since `since`. Cleared by the next re-check that measures.
   * Being stale never pauses or stops a bot; `liveAllowed` keeps its last known value.
   */
  stale?: SafetyStale;
}

export interface SafetyStale {
  /** First failed re-check in this run of failures */
  since: number;
  /** Most recent failed re-check */
  lastTry: number;
  why: string;
}

export interface MarketDef {
  key: string;
  chainId: number;
  base: MarketToken;
  quote: MarketToken;
  pool: PoolRef;
  /** Base amount used for the spot probe (human units) */
  probe: number;
  /** quote kind for USD maths */
  quoteKind: 'stable' | 'wrapped' | 'token';
  legacy?: boolean;
  custom?: boolean;
  /** Pool address used for GeckoTerminal / on-chain candles */
  candlePool?: string;
  /** Pool kind of candlePool (frozen when the trading pool is switched, so the series never mixes pools) */
  candleKind?: 'v2' | 'v3';
  /** How the trading pool was chosen: default registry pool, best-quote auto pick, or manual override */
  poolMode?: 'default' | 'auto' | 'manual';
  safety?: SafetyReport;
  addedAt?: number;
  /** Flipped orientation of the market `flipOf` (base ↔ quote swapped, same pool). Derived, never persisted. */
  flipped?: boolean;
  flipOf?: string;
  /** Flipped markets size the spot probe in QUOTE units (the original's base probe) when no spot is cached yet. */
  probeQuote?: number;
}

// ── Orientation (base/quote flip) ─────────────────────────────────────────
/**
 * Every market can be traded in either orientation. The flipped market of key K is 'K~': base and quote swapped
 * on the SAME pool (pool switches follow the original), prices = new quote per new base (= 1 / original price,
 * modulo the LP fee on the sell side). '~' never appears in an original key (marketKey strips it).
 */
export const FLIP = '~';
export const isFlipKey = (k: string) => k.endsWith(FLIP);
export const unflipKey = (k: string) => (isFlipKey(k) ? k.slice(0, -FLIP.length) : k);
export const flipKey = (k: string) => (isFlipKey(k) ? unflipKey(k) : k + FLIP);
export const orientedKey = (k: string, flipped: boolean) => (flipped ? unflipKey(k) + FLIP : unflipKey(k));

/**
 * The flipped view of a market. Static fields are swapped; pool / safety / candle settings are live getters on the
 * original object so a pool switch or safety re-check applies to both orientations at once.
 * `spot` = cached original price (quote per base) used to size the probe in the new base; null → Quoter sizes it.
 */
export function flipMarket(m: MarketDef, spot: () => number | null = () => null): MarketDef {
  if (m.flipped) throw new Error(`${m.key} is already flipped`);
  // Tokens swap sides with their native flags (PLS/HEX → HEX/PLS: PLS stays the native coin, now as the quote).
  const base: MarketToken = { ...m.quote };
  const quote: MarketToken = { ...m.base };
  const f = {
    key: flipKey(m.key), chainId: m.chainId, base, quote,
    quoteKind: (m.base.native ? 'wrapped' : 'token') as MarketDef['quoteKind'],
    flipped: true, flipOf: m.key, probeQuote: m.probe,
    ...(m.legacy ? { legacy: true } : {}), ...(m.custom ? { custom: true } : {}),
  } as MarketDef;
  const live = (k: keyof MarketDef) => Object.defineProperty(f, k, { enumerable: true, configurable: true, get: () => m[k] });
  for (const k of ['pool', 'safety', 'candlePool', 'candleKind', 'poolMode', 'addedAt'] as const) live(k);
  Object.defineProperty(f, 'probe', {
    enumerable: true, configurable: true,
    get: () => { const s = spot(); return s && s > 0 && Number.isFinite(s) ? +(m.probe * s).toPrecision(3) : 0; },
  });
  return f;
}

/** "HEX/PLS" with what the grid spends and stacks: buys spend the quote, sells give the base back for quote. */
export function orientation(m: Pick<MarketDef, 'base' | 'quote' | 'flipped'>) {
  return { label: `${m.base.symbol}/${m.quote.symbol}`, spends: m.quote.symbol, stacks: m.base.symbol, flipped: !!m.flipped };
}

export const isLegacyKey = (k: string) => !k.includes(':');

/** Base first: 'PLS/HEX' (classic) or 'HEX/PLS' (flipped). */
export function marketLabel(m: Pick<MarketDef, 'base' | 'quote'>) {
  return `${m.base.symbol}/${m.quote.symbol}`;
}

/** File-system safe candle series name ('ethereum:ETH/USDC' → 'ethereum_ETH-USDC'); legacy keys unchanged. */
export function seriesFile(key: string) {
  return key.replace(/:/g, '_').replace(/\//g, '-').replace(/[^A-Za-z0-9._#-]/g, '_').replace(/#/g, '_');
}

export function marketKey(chain: Pick<ChainConfig, 'key'>, base: string, quote: string, taken: (k: string) => boolean = () => false) {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9.$₮]/g, '').slice(0, 16) || 'TKN';
  const k0 = `${chain.key}:${clean(base)}/${clean(quote)}`;
  if (!taken(k0)) return k0;
  for (let i = 2; ; i++) if (!taken(`${k0}#${i}`)) return `${k0}#${i}`;
}

/**
 * The six verified PulseX markets, keyed by quote symbol exactly as before. Base = native PLS. The pair is resolved via
 * the DEX's factory.getPair (address ''); stables trade on PulseX V1, the rest on V2 (networks.ts). Both charge 29 bps.
 */
export function legacyMarkets(net: LiveNetwork): MarketDef[] {
  const wpls = net.pulsex.wpls;
  return net.quotes.map((q) => ({
    key: q.symbol, chainId: net.chainId, legacy: true,
    base: { address: wpls, symbol: net.nativeSymbol, name: net.isTestnet ? 'Test Pulse' : 'Pulse', decimals: 18, native: true },
    quote: { address: q.address, symbol: q.symbol, name: q.name, decimals: q.decimals },
    pool: { dex: q.dex ?? 'pulsex-v2', kind: 'v2' as const, address: '', feeBps: net.pulsex.feeBps },
    probe: 1000, quoteKind: q.kind === 'stable' ? 'stable' as const : 'token' as const, candlePool: q.pool,
  }));
}

/** Safety report of a built-in market on the day it was verified (re-run before every live start and while bots run). */
const VERIFIED_AT = Date.parse('2026-10-17T10:00:00Z');
function verified(risk: SafetyReport['risk'], reason: string, proxy: string | null, liquidityUsd: number): SafetyReport {
  return {
    at: VERIFIED_AT, risk, liveAllowed: true, reasons: [reason], buyTaxPct: 0, sellTaxPct: 0, transferTaxPct: 0, honeypot: false,
    proxy: proxy ? { kind: proxy } : null, depth: [], liquidityUsd, simulated: true, taxMode: 'none', paused: false,
  };
}
const CLEAN = 'Simulated buy, transfer and sell matched quotes exactly; no proxy; adequate depth.';
const STOCK = 'Upgradeable proxy (EIP-1967 beacon) — the issuer (Robinhood) can change the token logic.';

type BuiltInToken = { symbol: string; name: string; address: string; decimals: number };
/**
 * Built-in markets outside PulseChain. `base`/`quote` 'native' = the chain's native coin (traded through the wrapper);
 * a quote string is a stablecoin symbol of the chain. Native/stable pairs come first (the first is the chain's USD
 * reference). Token pairs were verified 2026-10-17 with hub.inspect on live RPCs: deepest pool for a ≈$1,000 trade,
 * decimals read on-chain, and the eth_call buy → transfer → sell simulation (no tax, no honeypot, not paused).
 */
const DEFAULTS: { chain: string; base: 'native' | BuiltInToken; quote: 'native' | string; pool: PoolRef; probe: number; safety?: SafetyReport }[] = [
  { chain: 'robinhood', base: 'native', quote: 'USDG', pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', feeBps: 1, feeTier: 100 }, probe: 0.01 },
  { chain: 'robinhood', base: { symbol: 'NVDA', name: 'NVIDIA • Robinhood Token', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 }, quote: 'USDG',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3', feeBps: 5, feeTier: 500 }, probe: 0.1, safety: verified('medium', STOCK, 'EIP-1967 beacon', 3_064_160) },
  { chain: 'robinhood', base: { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust • Robinhood Token', address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 }, quote: 'USDG',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0xa7Bb1AC63BBaB0C44316E6c8C455213441689167', feeBps: 5, feeTier: 500 }, probe: 0.03, safety: verified('medium', STOCK, 'EIP-1967 beacon', 245_642) },
  { chain: 'robinhood', base: { symbol: 'GOOGL', name: 'Alphabet Class A • Robinhood Token', address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 }, quote: 'USDG',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7', feeBps: 5, feeTier: 500 }, probe: 0.07, safety: verified('medium', STOCK, 'EIP-1967 beacon', 812_153) },
  { chain: 'robinhood', base: { symbol: 'SPCX', name: 'Space Exploration Technologies Corp. Class A Common Stock • Robinhood Token', address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18 }, quote: 'USDG',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0xc61284332117c3FB23A2A56cceFFD07F7aF60029', feeBps: 5, feeTier: 500 }, probe: 0.2, safety: verified('medium', STOCK, 'EIP-1967 beacon', 1_351_331) },
  { chain: 'robinhood', base: { symbol: 'CRCL', name: 'Circle Internet Group • Robinhood Token', address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5', decimals: 18 }, quote: 'USDG',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x654E4143e82a5824445Ade0824351C2A9ACD95a8', feeBps: 30, feeTier: 3000 }, probe: 0.3, safety: verified('medium', STOCK, 'EIP-1967 beacon', 2_512_336) },
  { chain: 'robinhood', base: { symbol: 'USO', name: 'United States Oil Fund • Robinhood Token', address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344', decimals: 18 }, quote: 'USDG',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x02175608F1b5E6b5ed221cCFdC7Be197D111D915', feeBps: 30, feeTier: 3000 }, probe: 0.15, safety: verified('medium', STOCK, 'EIP-1967 beacon', 2_198_092) },
  { chain: 'ethereum', base: 'native', quote: 'USDC', pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', feeBps: 5, feeTier: 500 }, probe: 0.01 },
  { chain: 'ethereum', base: { symbol: 'WBTC', name: 'Wrapped BTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 }, quote: 'USDT',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x56534741CD8B152df6d48AdF7ac51f75169A83b2', feeBps: 5, feeTier: 500 }, probe: 0.0003, safety: verified('low', CLEAN, null, 32_489_594) },
  { chain: 'ethereum', base: { symbol: 'WBTC', name: 'Wrapped BTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 }, quote: 'native',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0xe6ff8b9A37B0fab776134636D9981Aa778c4e718', feeBps: 1, feeTier: 100 }, probe: 0.0003, safety: verified('low', CLEAN, null, 778_754) },
  { chain: 'ethereum', base: { symbol: 'LINK', name: 'ChainLink Token', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 }, quote: 'native',
    pool: { dex: 'uniswap-v3', kind: 'v3', address: '0x5d4F3C6fA16908609BAC31Ff148Bd002AA6b8c83', feeBps: 5, feeTier: 500 }, probe: 2, safety: verified('low', CLEAN, null, 439_110) },
  { chain: 'ethereum', base: { symbol: 'PEPE', name: 'Pepe', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 }, quote: 'native',
    pool: { dex: 'uniswap-v2', kind: 'v2', address: '0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f', feeBps: 30 }, probe: 6_000_000, safety: verified('low', CLEAN, null, 28_930_325) },
  { chain: 'ethereum', base: { symbol: 'HEX', name: 'HEX', address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', decimals: 8 }, quote: 'native',
    pool: { dex: 'uniswap-v2', kind: 'v2', address: '0x55D5c232D921B9eAA6b37b5845E439aCD04b4DBa', feeBps: 30 }, probe: 40_000, safety: verified('low', CLEAN, null, 350_951) },
];

export function defaultMarkets(chains: ChainConfig[] = CHAINS): MarketDef[] {
  const out: MarketDef[] = [];
  for (const d of DEFAULTS) {
    const c = chains.find((x) => x.key === d.chain);
    if (!c || !c.trading.enabled) continue;
    const wn = c.wrappedNative;
    const native: MarketToken = { address: wn.address, symbol: c.nativeSymbol, name: c.nativeSymbol, decimals: 18, native: true };
    const base: MarketToken = d.base === 'native' ? native : { ...d.base };
    const st = d.quote === 'native' ? null : c.stables.find((x) => x.symbol === d.quote);
    if (d.quote !== 'native' && !st) throw new Error(`built-in market: ${d.quote} is not a stablecoin of ${c.name}`);
    const quote: MarketToken = st ? { address: st.address, symbol: st.symbol, name: st.name, decimals: st.decimals } : native;
    out.push({
      key: `${c.key}:${base.symbol}/${quote.symbol}`, chainId: c.id, base, quote, pool: { ...d.pool },
      probe: d.probe, quoteKind: st ? 'stable' : 'wrapped', candlePool: d.pool.address, ...(d.safety ? { safety: { ...d.safety } } : {}),
    });
  }
  return out;
}

export function allChains(net: LiveNetwork): ChainConfig[] {
  // NETWORK=testnet swaps PulseChain mainnet for the v4 testnet; every other chain is unchanged.
  return net.chainId === 369 ? CHAINS : [chainFromNetwork(net), ...CHAINS.filter((c) => c.id !== 369)];
}
