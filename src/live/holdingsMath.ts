/**
 * Pure valuation for the Holdings view. No network.
 *
 * The old wallet card showed ERC-20 balanceOf / native balance only. Coins inside a Uniswap V3 position NFT
 * are not in those balances: the NFT's liquidity converts to token amounts at the pool's current sqrt price,
 * and uncollected fees sit on the position. A V2 LP token is a share of the pair's reserves.
 */
import { feesOwed } from './v3Liquidity';

export const Q96 = 2n ** 96n;
const U256 = 2n ** 256n;
/** Hide a row when its dollar value is under this. Unpriced amounts this small are dust too. */
export const DUST_USD = 0.01;
const MAX_TICK = 887272;

/**
 * √(1.0001^tick) as a Q64.96, the same integer the pool uses. Bit constants are the published TickMath
 * multipliers (1/√(1.0001^(2^i))), so out-of-range amounts match what burn/collect would pay.
 */
const TICK_BITS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
] as const;

export function sqrtPriceX96AtTick(tick: number): bigint {
  const abs = tick < 0 ? -tick : tick;
  if (!Number.isInteger(tick) || abs > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  let ratio = (abs & 1) !== 0 ? TICK_BITS[0] : 0x100000000000000000000000000000000n;
  for (let i = 1; i < TICK_BITS.length; i++) {
    if ((abs & (1 << i)) !== 0) ratio = (ratio * TICK_BITS[i]) >> 128n;
  }
  if (tick > 0) ratio = (U256 - 1n) / ratio;
  const rem = ratio % (1n << 32n);
  return (ratio >> 32n) + (rem > 0n ? 1n : 0n);
}

/** Token0 from L between two sqrt prices (round down, what the pool pays out). */
function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n || liquidity <= 0n) return 0n;
  return ((liquidity << 96n) * (sqrtB - sqrtA) / sqrtB) / sqrtA;
}
function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (liquidity <= 0n) return 0n;
  return liquidity * (sqrtB - sqrtA) / Q96;
}

export type RangeSide = 'below' | 'in' | 'above';

/**
 * Token amounts a V3 position holds at the current price.
 * Below the range the position is entirely token0; above it, entirely token1; inside, both.
 * `tick >= tickUpper` is out of range, matching the pool (in range is tickLower <= tick < tickUpper).
 */
export function v3TokenAmounts(p: {
  liquidity: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  tickLower: number;
  tickUpper: number;
}): { amount0: bigint; amount1: bigint; range: RangeSide } {
  if (p.tickLower >= p.tickUpper) throw new Error('bad position range');
  const range: RangeSide = p.tick < p.tickLower ? 'below' : p.tick >= p.tickUpper ? 'above' : 'in';
  if (p.liquidity <= 0n || p.sqrtPriceX96 <= 0n) return { amount0: 0n, amount1: 0n, range };
  const sa = sqrtPriceX96AtTick(p.tickLower);
  const sb = sqrtPriceX96AtTick(p.tickUpper);
  if (range === 'below') return { amount0: amount0Delta(sa, sb, p.liquidity), amount1: 0n, range };
  if (range === 'above') return { amount0: 0n, amount1: amount1Delta(sa, sb, p.liquidity), range };
  const mid = p.sqrtPriceX96 < sa ? sa : p.sqrtPriceX96 > sb ? sb : p.sqrtPriceX96;
  return { amount0: amount0Delta(mid, sb, p.liquidity), amount1: amount1Delta(sa, mid, p.liquidity), range };
}

/** A wallet's V2 LP tokens as a share of the pair reserves (floor, same as burn). */
export function v2Share(balance: bigint, totalSupply: bigint, reserve0: bigint, reserve1: bigint): { amount0: bigint; amount1: bigint } {
  if (balance <= 0n || totalSupply <= 0n) return { amount0: 0n, amount1: 0n };
  return { amount0: balance * reserve0 / totalSupply, amount1: balance * reserve1 / totalSupply };
}

function mod256(x: bigint): bigint {
  const r = x % U256;
  return r < 0n ? r + U256 : r;
}

/**
 * Fee growth inside a tick range, mod 2^256, the same way the pool computes it.
 * `lowerOutside` / `upperOutside` are the ticks' feeGrowthOutside counters.
 */
export function feeGrowthInside(p: {
  tick: number; tickLower: number; tickUpper: number;
  global: bigint; lowerOutside: bigint; upperOutside: bigint;
}): bigint {
  const below = p.tick >= p.tickLower ? p.lowerOutside : mod256(p.global - p.lowerOutside);
  const above = p.tick < p.tickUpper ? p.upperOutside : mod256(p.global - p.upperOutside);
  return mod256(p.global - below - above);
}

/** Uncollected tokens on one side: already-owed plus growth since the position's last snapshot. */
export function uncollectedRaw(tokensOwed: bigint, insideNow: bigint, insideLast: bigint, liquidity: bigint): bigint {
  return tokensOwed + feesOwed(insideNow, insideLast, liquidity);
}

/** raw token1 per raw token0 from a Q64.96 sqrt price. */
export function rawPrice1Per0(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const scale = 10n ** 18n;
  const q = sqrtPriceX96 * sqrtPriceX96 * scale / (Q96 * Q96);
  const n = Number(q);
  return Number.isFinite(n) ? n / 1e18 : Number.POSITIVE_INFINITY;
}

/** num/den as a float, exact to 18 decimal places of the ratio. */
export function bigRatio(num: bigint, den: bigint): number {
  if (den <= 0n || num <= 0n) return 0;
  const q = num * 10n ** 18n / den;
  const n = Number(q);
  return Number.isFinite(n) ? n / 1e18 : Number.POSITIVE_INFINITY;
}

/**
 * Price the other token from a pool mid when one side already has a dollar price.
 * `raw1per0` is raw token1 per raw token0. `known` is which side `usd` belongs to.
 */
export function usdFromOther(usd: number, raw1per0: number, dec0: number, dec1: number, known: 0 | 1): number | null {
  if (!(usd > 0) || !(raw1per0 > 0) || !Number.isFinite(raw1per0)) return null;
  const human1per0 = raw1per0 * 10 ** (dec0 - dec1);
  if (!(human1per0 > 0) || !Number.isFinite(human1per0)) return null;
  const out = known === 0 ? usd / human1per0 : usd * human1per0;
  return Number.isFinite(out) && out > 0 ? out : null;
}

export function feeLabelOf(kind: 'v3' | 'v2', fee: number): string {
  const pct = kind === 'v3' ? fee / 10_000 : fee / 100;
  const s = pct >= 1 ? String(pct) : pct.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `${s}%`;
}

/** A coin amount for the screen. Never scientific notation (9.3e-10 is a broken-looking balance). */
export function formatTokenAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e12) return sign + compact(a / 1e12) + 'T';
  if (a >= 1e9) return sign + compact(a / 1e9) + 'B';
  if (a >= 1e6) return sign + compact(a / 1e6) + 'M';
  if (a >= 1e4) return sign + compact(a / 1e3) + 'K';
  if (a >= 1) return sign + compact(a);
  const digits = a >= 1e-4 ? 6 : 12;
  const s = a.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return sign + (s === '0' ? '< 0.000000000001' : s);
}

function compact(x: number): string {
  const digits = x >= 100 ? 1 : x >= 10 ? 2 : 3;
  return x.toFixed(digits).replace(/\.?0+$/, '');
}

export function formatUsdAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Chip on the header: $84.3k, $1.20M. Still never scientific notation. */
export function formatUsdChip(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e6) return `${sign}$${compact(a / 1e6)}M`;
  if (a >= 1e4) return `${sign}$${compact(a / 1e3)}k`;
  return formatUsdAmount(n);
}

export function isDustAmount(usd: number | null, amount: number): boolean {
  if (usd != null && Number.isFinite(usd)) return Math.abs(usd) < DUST_USD;
  return !(Math.abs(amount) >= 1e-6);
}

export type BotKind = 'grid' | 'trend' | 'lp';
export interface BotRef { id: string; kind: BotKind; name: string; status: string; mode: 'live' | 'paper' }

export interface RawCoin {
  chainId: number;
  address: string | null;
  symbol: string;
  decimals: number;
  amount: number;
  usdEach: number | null;
}
export interface CoinView extends RawCoin { usd: number | null }

export interface WalletRow {
  coin: CoinView;
  dust: boolean;
  /** Live bots using this coin. Grid and trend amounts sit in the wallet; liquidity-bot amounts are idle beside a position. */
  bots: { bot: BotRef; amount: number }[];
}
export interface PositionRow {
  chainId: number;
  kind: 'v3' | 'v2';
  dexName: string;
  pool: string;
  feeLabel: string;
  tokenId: string | null;
  range: RangeSide | null;
  token0: CoinView;
  token1: CoinView;
  usd: number | null;
  partial: boolean;
  dust: boolean;
  bot: BotRef | null;
  stranded: boolean;
  idleNote: string | null;
}
export interface FeeRow {
  chainId: number;
  dexName: string;
  pool: string;
  feeLabel: string;
  tokenId: string | null;
  token0: CoinView;
  token1: CoinView;
  usd: number | null;
  partial: boolean;
  dust: boolean;
  bot: BotRef | null;
  stranded: boolean;
  /** No liquidity left: these tokens are still owed by a position that was not fully collected. */
  leftover: boolean;
}
export interface BotBag {
  bot: BotRef;
  chainId: number;
  coins: CoinView[];
  usd: number | null;
  dust: boolean;
}
export interface ChainRollup {
  chainId: number;
  name: string;
  short: string;
  color: string;
  address: string | null;
  usd: number;
  walletUsd: number;
  botsUsd: number;
  lpUsd: number;
  feesUsd: number;
}
export interface HoldingsSnapshot {
  address: string | null;
  at: number;
  hasSigner: boolean;
  netWorthUsd: number | null;
  netWorthExDustUsd: number | null;
  unpriced: number;
  walletUsd: number;
  freeUsd: number;
  botsUsd: number;
  lpUsd: number;
  feesUsd: number;
  /** Bot books add up to more than the wallet holds. */
  overdrawn: boolean;
  chains: ChainRollup[];
  wallet: WalletRow[];
  positions: PositionRow[];
  fees: FeeRow[];
  bots: BotBag[];
  errors: { chainId: number | null; message: string }[];
  how: string[];
}

export interface RawPosition {
  chainId: number;
  kind: 'v3' | 'v2';
  dexName: string;
  pool: string;
  feeLabel: string;
  tokenId: string | null;
  range: RangeSide | null;
  token0: RawCoin;
  token1: RawCoin;
  fee0: RawCoin;
  fee1: RawCoin;
  bot: BotRef | null;
  stranded: boolean;
  idleNote: string | null;
  /** Liquidity is zero, so fee0/fee1 are leftover tokens rather than trading fees. */
  leftover: boolean;
}

export const HOW_HOLDINGS = [
  'Wallet is the coins sitting at your address: the chain’s own coin, plus each token’s balance.',
  'Liquidity positions are Uniswap-style V3 NFTs and V2 LP tokens (PulseX, 9mm, Uniswap). Those coins are in the pool, so a normal balance does not see them. A V3 amount comes from the position’s liquidity and the pool’s current price; a V2 amount is your share of the pair’s reserves.',
  'Uncollected fees are what a V3 position would pay if you collected. That read does not send a transaction. A position with no liquidity left can still owe tokens — those show up here too, including a closed bot that did not finish collecting.',
  'Bot grids are coins your live grid and trend bots are using. Those coins are already in the wallet, so they are split out of the wallet total and not added again.',
];

function coinOf(c: RawCoin): CoinView {
  const usd = c.usdEach == null || !Number.isFinite(c.amount) ? null : c.amount * c.usdEach;
  return { ...c, usd: usd != null && Number.isFinite(usd) ? usd : null };
}

function pairUsd(a: CoinView, b: CoinView): { usd: number | null; partial: boolean } {
  const parts = [a, b].filter((c) => c.amount !== 0 || (c.usd ?? 0) !== 0);
  const known = parts.map((c) => c.usd).filter((u): u is number => u != null);
  const missing = parts.some((c) => c.usd == null && !isDustAmount(null, c.amount));
  if (!known.length) return { usd: missing ? null : 0, partial: missing };
  return { usd: known.reduce((s, x) => s + x, 0), partial: missing };
}

function addNum(sum: number, x: number | null): number {
  return x != null && Number.isFinite(x) ? sum + x : sum;
}

/**
 * Turn raw reads into the screen model.
 * Net worth = wallet balances + liquidity principal + uncollected fees.
 * Bot-grid dollars are a slice of the wallet, capped so they cannot exceed it.
 */
export function assemblePortfolio(p: {
  address: string | null;
  at: number;
  hasSigner: boolean;
  chains: { id: number; name: string; short: string; color: string; address: string | null }[];
  wallet: (RawCoin & { bots: { bot: BotRef; amount: number }[] })[];
  positions: RawPosition[];
  errors: { chainId: number | null; message: string }[];
}): HoldingsSnapshot {
  const wallet: WalletRow[] = p.wallet.map((w) => {
    const coin = coinOf(w);
    return { coin, dust: isDustAmount(coin.usd, coin.amount), bots: w.bots.filter((b) => b.amount > 0) };
  }).sort((a, b) => (b.coin.usd ?? -1) - (a.coin.usd ?? -1));

  const bags = new Map<string, BotBag>();
  let botsClaim = 0;
  let accounted = 0;
  let walletUsd = 0;
  for (const row of wallet) {
    walletUsd = addNum(walletUsd, row.coin.usd);
    if (row.coin.usdEach == null) continue;
    let room = row.coin.amount;
    for (const b of row.bots) {
      if (b.bot.kind === 'lp' || b.bot.mode !== 'live') continue;
      const take = Math.min(Math.max(0, b.amount), Math.max(0, room));
      room -= take;
      botsClaim += take * row.coin.usdEach;
      accounted += Math.max(0, b.amount) * row.coin.usdEach;
      const bag = bags.get(b.bot.id) ?? { bot: b.bot, chainId: row.coin.chainId, coins: [], usd: 0, dust: false };
      bag.coins.push({ ...row.coin, amount: b.amount, usd: b.amount * row.coin.usdEach });
      bag.usd = (bag.usd ?? 0) + b.amount * row.coin.usdEach;
      bags.set(b.bot.id, bag);
    }
  }
  const bots = [...bags.values()].map((b) => ({ ...b, dust: isDustAmount(b.usd, 1) })).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  // Books can run ahead of the wallet (a read raced a trade). The tile never counts more than the wallet holds.
  const overdrawn = accounted > walletUsd + 1e-6;
  const botsUsd = Math.min(botsClaim, walletUsd);
  const freeUsd = walletUsd - botsUsd;

  const positions: PositionRow[] = [];
  const fees: FeeRow[] = [];
  for (const raw of p.positions) {
    const token0 = coinOf(raw.token0), token1 = coinOf(raw.token1);
    const pr = pairUsd(token0, token1);
    const principalDust = isDustAmount(pr.usd, token0.amount) && isDustAmount(pr.usd, token1.amount) && isDustAmount(token0.usd, token0.amount) && isDustAmount(token1.usd, token1.amount);
    if (!raw.leftover && (token0.amount > 0 || token1.amount > 0)) {
      positions.push({
        chainId: raw.chainId, kind: raw.kind, dexName: raw.dexName, pool: raw.pool, feeLabel: raw.feeLabel, tokenId: raw.tokenId,
        range: raw.range, token0, token1, usd: pr.usd, partial: pr.partial, dust: principalDust, bot: raw.bot, stranded: raw.stranded, idleNote: raw.idleNote,
      });
    }
    const fee0 = coinOf(raw.fee0), fee1 = coinOf(raw.fee1);
    if (fee0.amount > 0 || fee1.amount > 0) {
      const fr = pairUsd(fee0, fee1);
      fees.push({
        chainId: raw.chainId, dexName: raw.dexName, pool: raw.pool, feeLabel: raw.feeLabel, tokenId: raw.tokenId,
        token0: fee0, token1: fee1, usd: fr.usd, partial: fr.partial,
        dust: isDustAmount(fr.usd, fee0.amount) && isDustAmount(fr.usd, fee1.amount) && isDustAmount(fee0.usd, fee0.amount) && isDustAmount(fee1.usd, fee1.amount),
        bot: raw.bot, stranded: raw.stranded, leftover: raw.leftover,
      });
    }
  }
  positions.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  fees.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  const lpUsd = positions.reduce((s, r) => addNum(s, r.usd), 0);
  const feesUsd = fees.reduce((s, r) => addNum(s, r.usd), 0);
  const priced = wallet.some((w) => w.coin.usd != null) || positions.some((r) => r.usd != null) || fees.some((r) => r.usd != null);
  const netWorthUsd = priced ? walletUsd + lpUsd + feesUsd : null;

  const ex = (rows: { usd: number | null; dust: boolean }[]) => rows.filter((r) => !r.dust).reduce((s, r) => addNum(s, r.usd), 0);
  const netWorthExDustUsd = priced ? ex(wallet.map((w) => ({ usd: w.coin.usd, dust: w.dust }))) + ex(positions) + ex(fees) : null;

  let unpriced = 0;
  const countMissing = (c: CoinView) => { if (c.usd == null && !isDustAmount(null, c.amount)) unpriced++; };
  for (const w of wallet) countMissing(w.coin);
  for (const r of positions) { countMissing(r.token0); countMissing(r.token1); }
  for (const r of fees) { countMissing(r.token0); countMissing(r.token1); }

  const chains: ChainRollup[] = p.chains.map((c) => {
    const on = (id: number) => id === c.id;
    const wUsd = wallet.filter((r) => on(r.coin.chainId)).reduce((s, r) => addNum(s, r.coin.usd), 0);
    let claim = 0;
    for (const row of wallet.filter((r) => on(r.coin.chainId))) {
      if (row.coin.usdEach == null) continue;
      let room = row.coin.amount;
      for (const b of row.bots) {
        if (b.bot.kind === 'lp' || b.bot.mode !== 'live') continue;
        const take = Math.min(Math.max(0, b.amount), Math.max(0, room));
        room -= take;
        claim += take * row.coin.usdEach;
      }
    }
    const bUsd = Math.min(claim, wUsd);
    const lUsd = positions.filter((r) => on(r.chainId)).reduce((s, r) => addNum(s, r.usd), 0);
    const fUsd = fees.filter((r) => on(r.chainId)).reduce((s, r) => addNum(s, r.usd), 0);
    return { chainId: c.id, name: c.name, short: c.short, color: c.color, address: c.address, usd: wUsd + lUsd + fUsd, walletUsd: wUsd - bUsd, botsUsd: bUsd, lpUsd: lUsd, feesUsd: fUsd };
  }).sort((a, b) => b.usd - a.usd);

  return {
    address: p.address, at: p.at, hasSigner: p.hasSigner,
    netWorthUsd, netWorthExDustUsd, unpriced,
    walletUsd, freeUsd, botsUsd, lpUsd, feesUsd, overdrawn,
    chains, wallet, positions, fees, bots,
    errors: p.errors, how: HOW_HOLDINGS,
  };
}
