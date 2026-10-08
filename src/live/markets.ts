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
  /** LP fee in bps (V2: DEX fee; V3: tier / 100) */
  feeBps: number;
  /** V3 fee tier in hundredths of a bip */
  feeTier?: number;
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
  /** How taxes are traded: none · V2 fee-on-transfer methods · V3 proven by simulation · blocked */
  taxMode?: 'none' | 'v2-fot' | 'v3-proven' | 'blocked';
  /** Pool kind the report was measured on (taxes are pool-specific for V3) */
  poolKind?: 'v2' | 'v3';
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

/** File-system safe candle series name ('base:ETH/USDC' → 'base_ETH-USDC'); legacy keys unchanged. */
export function seriesFile(key: string) {
  return key.replace(/:/g, '_').replace(/\//g, '-').replace(/[^A-Za-z0-9._#-]/g, '_').replace(/#/g, '_');
}

export function marketKey(chain: Pick<ChainConfig, 'key'>, base: string, quote: string, taken: (k: string) => boolean = () => false) {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9.$₮]/g, '').slice(0, 16) || 'TKN';
  const k0 = `${chain.key}:${clean(base)}/${clean(quote)}`;
  if (!taken(k0)) return k0;
  for (let i = 2; ; i++) if (!taken(`${k0}#${i}`)) return `${k0}#${i}`;
}

/** The six verified PulseX V2 markets, keyed by quote symbol exactly as before. Base = native PLS. */
export function legacyMarkets(net: LiveNetwork): MarketDef[] {
  const wpls = net.pulsex.wpls;
  return net.quotes.map((q) => ({
    key: q.symbol, chainId: net.chainId, legacy: true,
    base: { address: wpls, symbol: net.nativeSymbol, name: net.isTestnet ? 'Test Pulse' : 'Pulse', decimals: 18, native: true },
    quote: { address: q.address, symbol: q.symbol, name: q.name, decimals: q.decimals },
    pool: { dex: 'pulsex-v2', kind: 'v2' as const, address: '', feeBps: net.pulsex.feeBps },
    probe: 1000, quoteKind: q.kind === 'stable' ? 'stable' as const : 'token' as const, candlePool: q.pool,
  }));
}

/**
 * One verified default market per non-PulseChain chain (wrapped native vs its deepest stable pool,
 * picked by on-chain quote at 2026-10-08). Pools are re-discoverable from the UI.
 */
const DEFAULTS: { chain: string; quote: string; dex: string; tier: number; pool: string; probe: number }[] = [
  { chain: 'robinhood', quote: 'USDG', dex: 'uniswap-v3', tier: 100, pool: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca', probe: 0.01 },
  { chain: 'ethereum', quote: 'USDC', dex: 'uniswap-v3', tier: 500, pool: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', probe: 0.01 },
  { chain: 'base', quote: 'USDC', dex: 'uniswap-v3', tier: 500, pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', probe: 0.01 },
  { chain: 'arbitrum', quote: 'USDC', dex: 'uniswap-v3', tier: 500, pool: '0xC6962004f452bE9203591991D15f6b388e09E8D0', probe: 0.01 },
  { chain: 'bsc', quote: 'USDT', dex: 'pancakeswap-v3', tier: 100, pool: '0x172fcD41E0913e95784454622d1c3724f546f849', probe: 0.05 },
  { chain: 'polygon', quote: 'USDC', dex: 'uniswap-v3', tier: 500, pool: '0xB6e57ed85c4c9dbfEF2a68711e9d6f36c56e0FcB', probe: 100 },
  { chain: 'optimism', quote: 'USDC', dex: 'uniswap-v3', tier: 3000, pool: '0xc1738D90E2E26C35784A0d3E3d8A9f795074bcA4', probe: 0.01 },
];

export function defaultMarkets(chains: ChainConfig[] = CHAINS): MarketDef[] {
  const out: MarketDef[] = [];
  for (const d of DEFAULTS) {
    const c = chains.find((x) => x.key === d.chain);
    if (!c || !c.trading.enabled) continue;
    const st = c.stables.find((s) => s.symbol === d.quote)!;
    const wn = c.wrappedNative;
    out.push({
      key: `${c.key}:${c.nativeSymbol}/${st.symbol}`, chainId: c.id,
      base: { address: wn.address, symbol: c.nativeSymbol, name: c.nativeSymbol, decimals: 18, native: true },
      quote: { address: st.address, symbol: st.symbol, name: st.name, decimals: st.decimals },
      pool: { dex: d.dex, kind: 'v3', address: d.pool, feeBps: d.tier / 100, feeTier: d.tier },
      probe: d.probe, quoteKind: 'stable', candlePool: d.pool,
    });
  }
  return out;
}

export function allChains(net: LiveNetwork): ChainConfig[] {
  // NETWORK=testnet swaps PulseChain mainnet for the v4 testnet; every other chain is unchanged.
  return net.chainId === 369 ? CHAINS : [chainFromNetwork(net), ...CHAINS.filter((c) => c.id !== 369)];
}
