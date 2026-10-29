/**
 * Read-only picture of what a signing wallet holds.
 *
 * The wallet card (MultiBot.walletView) is only the native balance plus ERC-20 balanceOf for tokens this app's
 * markets already know. That misses coins inside a V3 position NFT, the reserve share behind a V2 LP token
 * (PulseX V1/V2, 9mm, Uniswap V2), and V3 fees that have not been collected. A closed liquidity bot can still
 * own an NFT with liquidity or unpaid tokens; those are listed too. Nothing here signs or sends a transaction.
 */
import { decodeBytes32String } from 'ethers';
import { fromUnits } from '../../live/swapMath';
import { readDecimals } from '../../live/decimals';
import {
  assemblePortfolio, bigRatio, feeGrowthInside, feeLabelOf, formatTokenAmount, rawPrice1Per0, uncollectedRaw, usdFromOther, v2Share, v3TokenAmounts,
  type BotRef, type HoldingsSnapshot, type RangeSide, type RawCoin, type RawPosition,
} from '../../live/holdingsMath';
import type { ChainConfig } from '../../live/chains';
import type { DexConfig } from '../../live/chains';
import type { MarketDef } from '../../live/markets';
import { ERC20, ERC20_B32, ERC721_ENUM, FACTORY, PAIR, V3_FACTORY, V3_NPM, V3_POOL, V3_POOL_LP } from '../dex/abis';
import { isZero, readCall, sameAddr } from '../dex/types';
import { collectAllData } from '../lp/npmCalls';
import { holdings as readListed, type Holding } from '../convert/holdings';
import type { FetchJson } from '../fetchJson';
import type { MultiBot } from '../bot/multi';
import type { ChainRuntime } from '../chains/runtime';
import { PRICE_TTL_MS, type Hub } from '../chains/hub';

const NFT_CAP = 48;
const CHAIN_MS = 90_000;
const TTL_MS = 45_000;

type Err = { chainId: number | null; message: string };
type Side = { address: string; raw: bigint };
interface Found {
  kind: 'v3' | 'v2';
  dexName: string;
  pool: string;
  fee: number;
  tokenId: string | null;
  range: RangeSide | null;
  token0: Side;
  token1: Side;
  fee0: Side;
  fee1: Side;
  raw1per0: number;
  leftover: boolean;
}
interface BotLink {
  tokenIds: Map<string, BotRef>;
  byPool: Map<string, BotRef>;
  idle: Map<string, string>;
  names: Map<string, BotRef>;
}

const clip = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 180);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} took too long to answer`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function readSymbol(reader: ChainRuntime['reader'], token: string): Promise<string | null> {
  try {
    const raw = await reader.call({ to: token, data: ERC20.encodeFunctionData('symbol') });
    try { return String(ERC20.decodeFunctionResult('symbol', raw)[0]); } catch { /* bytes32 below */ }
    return decodeBytes32String(ERC20_B32.decodeFunctionResult('symbol', raw)[0] as string);
  } catch { return null; }
}

class TokenMeta {
  private cache = new Map<string, { symbol: string; decimals: number }>();
  constructor(private readonly reader: ChainRuntime['reader'], private readonly chainId: number, private readonly known: Map<string, { symbol: string; decimals: number }>) {}
  async get(address: string): Promise<{ symbol: string; decimals: number }> {
    const k = address.toLowerCase();
    const hit = this.cache.get(k);
    if (hit) return hit;
    const reg = this.known.get(k);
    let decimals: number | null = null;
    try { decimals = await readDecimals(this.reader, this.chainId, address); } catch { decimals = reg?.decimals ?? null; }
    if (decimals == null) throw new Error(`Couldn't read decimals for ${address}`);
    let symbol = reg?.symbol ?? null;
    if (!symbol) symbol = await readSymbol(this.reader, address);
    const meta = { symbol: symbol && symbol.length > 0 && symbol.length < 24 ? symbol : `${address.slice(0, 6)}…${address.slice(-4)}`, decimals };
    this.cache.set(k, meta);
    return meta;
  }
}

function knownTokens(cfg: ChainConfig, markets: MarketDef[]): Map<string, { symbol: string; decimals: number }> {
  const m = new Map<string, { symbol: string; decimals: number }>();
  const put = (address: string, symbol: string, decimals: number) => m.set(address.toLowerCase(), { symbol, decimals });
  put(cfg.wrappedNative.address, cfg.wrappedNative.symbol, cfg.wrappedNative.decimals);
  for (const s of cfg.stables) put(s.address, s.symbol, s.decimals);
  for (const d of markets) {
    if (!d.base.native) put(d.base.address, d.base.symbol, d.base.decimals);
    if (!d.quote.native) put(d.quote.address, d.quote.symbol, d.quote.decimals);
  }
  return m;
}

function ercAddr(t: { address: string; native?: boolean }, wrapped: string) {
  return t.native ? wrapped : t.address;
}

function botLinks(bot: MultiBot): BotLink {
  const st = bot.status();
  const tokenIds = new Map<string, BotRef>();
  const byPool = new Map<string, BotRef>();
  const idle = new Map<string, string>();
  for (const lp of st.lps) {
    if (lp.mode !== 'live') continue;
    const ref: BotRef = { id: lp.id, kind: 'lp', name: `Liquidity ${lp.label}`, status: lp.archivedAt ? 'closed' : lp.status, mode: 'live' };
    const id = lp.position?.id;
    if (id && /^\d+$/.test(id)) tokenIds.set(`${lp.chainId}:${id}`, ref);
    const pool = bot.hub.has(lp.market) ? bot.hub.def(lp.market).pool.address : '';
    if (pool) byPool.set(`${lp.chainId}:${pool.toLowerCase()}`, ref);
    const idleBase = lp.idle?.base ?? 0, idleQuote = lp.idle?.quote ?? 0;
    if (idleBase > 1e-12 || idleQuote > 1e-12) {
      idle.set(lp.id, `Also in the wallet, not in the pool: ${formatTokenAmount(idleBase)} ${lp.base} and ${formatTokenAmount(idleQuote)} ${lp.quote}.`);
    }
  }
  const names = new Map<string, BotRef>();
  for (const g of st.grids) names.set(g.id, { id: g.id, kind: 'grid', name: `Grid ${g.label}`, status: g.archivedAt ? 'closed' : g.status, mode: g.mode });
  for (const t of st.trends) names.set(t.id, { id: t.id, kind: 'trend', name: t.name, status: t.archivedAt ? 'closed' : t.status, mode: t.mode });
  for (const lp of st.lps) names.set(lp.id, { id: lp.id, kind: 'lp', name: `Liquidity ${lp.label}`, status: lp.archivedAt ? 'closed' : lp.status, mode: lp.mode });
  return { tokenIds, byPool, idle, names };
}

async function enumerateNfts(reader: ChainRuntime['reader'], npm: string, owner: string, dexName: string, chainId: number, errors: Err[]): Promise<string[]> {
  const ids: string[] = [];
  let count = 0;
  try {
    const [bal] = await readCall<[bigint]>(reader, npm, ERC721_ENUM, 'balanceOf', [owner]);
    if (bal > BigInt(NFT_CAP)) errors.push({ chainId, message: `${dexName}: this wallet has ${bal} positions. The first ${NFT_CAP} are shown.` });
    count = Number(bal > BigInt(NFT_CAP) ? BigInt(NFT_CAP) : bal);
  } catch (e) {
    errors.push({ chainId, message: `${dexName} positions couldn't be listed (${clip(e)}). Positions this app already tracks are still checked.` });
    return ids;
  }
  const n = count;
  for (let i = 0; i < n; i++) {
    try {
      const [id] = await readCall<[bigint]>(reader, npm, ERC721_ENUM, 'tokenOfOwnerByIndex', [owner, i]);
      ids.push(id.toString());
    } catch (e) {
      errors.push({ chainId, message: `${dexName} stopped listing positions at ${i} of ${count} (${clip(e)}).` });
      break;
    }
  }
  return ids;
}

async function quoteFees(
  reader: ChainRuntime['reader'], npm: string, owner: string, tokenId: bigint, pool: string,
  tick: number, tickLower: number, tickUpper: number, liquidity: bigint, owed0: bigint, owed1: bigint, last0: bigint, last1: bigint,
): Promise<{ fee0: bigint; fee1: bigint }> {
  try {
    const raw = await reader.call({ to: npm, from: owner, data: collectAllData(tokenId, owner) });
    const [fee0, fee1] = V3_NPM.decodeFunctionResult('collect', raw) as unknown as [bigint, bigint];
    return { fee0, fee1 };
  } catch {
    const [[g0], [g1], lower, upper] = await Promise.all([
      readCall<[bigint]>(reader, pool, V3_POOL_LP, 'feeGrowthGlobal0X128'),
      readCall<[bigint]>(reader, pool, V3_POOL_LP, 'feeGrowthGlobal1X128'),
      readCall<[bigint, bigint, bigint, bigint]>(reader, pool, V3_POOL_LP, 'ticks', [tickLower]),
      readCall<[bigint, bigint, bigint, bigint]>(reader, pool, V3_POOL_LP, 'ticks', [tickUpper]),
    ]);
    const inside0 = feeGrowthInside({ tick, tickLower, tickUpper, global: g0, lowerOutside: lower[2], upperOutside: upper[2] });
    const inside1 = feeGrowthInside({ tick, tickLower, tickUpper, global: g1, lowerOutside: lower[3], upperOutside: upper[3] });
    return { fee0: uncollectedRaw(owed0, inside0, last0, liquidity), fee1: uncollectedRaw(owed1, inside1, last1, liquidity) };
  }
}

async function readOneV3(reader: ChainRuntime['reader'], dex: DexConfig, npm: string, owner: string, tokenId: bigint, chainId: number, errors: Err[]): Promise<Found | null> {
  let pos: [bigint, string, string, string, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  try {
    pos = await readCall<typeof pos>(reader, npm, V3_NPM, 'positions', [tokenId]);
  } catch (e) {
    errors.push({ chainId, message: `${dex.name} position ${tokenId} couldn't be read (${clip(e)}).` });
    return null;
  }
  const token0 = pos[2], token1 = pos[3], fee = Number(pos[4]);
  const tickLower = Number(pos[5]), tickUpper = Number(pos[6]), liquidity = pos[7];
  const last0 = pos[8], last1 = pos[9], owed0 = pos[10], owed1 = pos[11];
  let pool: string;
  try {
    const [p] = await readCall<[string]>(reader, dex.factory, V3_FACTORY, 'getPool', [token0, token1, fee]);
    pool = p;
  } catch (e) {
    errors.push({ chainId, message: `${dex.name} position ${tokenId}: pool lookup failed (${clip(e)}).` });
    return null;
  }
  if (isZero(pool)) {
    errors.push({ chainId, message: `${dex.name} position ${tokenId} has no pool.` });
    return null;
  }
  let sqrt = 0n, tick = 0;
  try {
    const [s, t] = await readCall<[bigint, bigint]>(reader, pool, V3_POOL, 'slot0');
    sqrt = s; tick = Number(t);
  } catch (e) {
    errors.push({ chainId, message: `${dex.name} position ${tokenId}: the pool price couldn't be read (${clip(e)}).` });
    return null;
  }
  const amounts = v3TokenAmounts({ liquidity, sqrtPriceX96: sqrt, tick, tickLower, tickUpper });
  let fee0 = 0n, fee1 = 0n;
  try {
    const q = await quoteFees(reader, npm, owner, tokenId, pool, tick, tickLower, tickUpper, liquidity, owed0, owed1, last0, last1);
    fee0 = q.fee0; fee1 = q.fee1;
  } catch (e) {
    errors.push({ chainId, message: `${dex.name} position ${tokenId}: uncollected fees couldn't be quoted (${clip(e)}). The liquidity is still shown.` });
  }
  if (amounts.amount0 === 0n && amounts.amount1 === 0n && fee0 === 0n && fee1 === 0n) return null;
  const leftover = liquidity === 0n;
  return {
    kind: 'v3', dexName: dex.name, pool, fee, tokenId: tokenId.toString(), range: amounts.range,
    token0: { address: token0, raw: leftover ? 0n : amounts.amount0 },
    token1: { address: token1, raw: leftover ? 0n : amounts.amount1 },
    fee0: { address: token0, raw: leftover ? amounts.amount0 + fee0 : fee0 },
    fee1: { address: token1, raw: leftover ? amounts.amount1 + fee1 : fee1 },
    raw1per0: rawPrice1Per0(sqrt), leftover,
  };
}

async function readV3(rt: ChainRuntime, owner: string, knownIds: bigint[], errors: Err[]): Promise<Found[]> {
  const out: Found[] = [];
  for (const dex of rt.cfg.dexes) {
    if (dex.kind !== 'v3' || !dex.positionManager) continue;
    const npm = dex.positionManager;
    const ids = new Set(await enumerateNfts(rt.reader, npm, owner, dex.name, rt.cfg.id, errors));
    for (const id of knownIds) {
      if (ids.has(id.toString())) continue;
      try {
        const [who] = await readCall<[string]>(rt.reader, npm, V3_NPM, 'ownerOf', [id]);
        if (sameAddr(who, owner)) ids.add(id.toString());
      } catch { /* burned, or it lives on a different position manager */ }
    }
    const found = await Promise.all([...ids].map((id) => readOneV3(rt.reader, dex, npm, owner, BigInt(id), rt.cfg.id, errors)));
    for (const f of found) if (f) out.push(f);
  }
  return out;
}

async function v2Pairs(rt: ChainRuntime, markets: MarketDef[], errors: Err[]): Promise<{ dexName: string; feeBps: number; address: string }[]> {
  const seen = new Set<string>();
  const out: { dexName: string; feeBps: number; address: string }[] = [];
  const add = (dexName: string, feeBps: number, address: string) => {
    if (!address || isZero(address)) return;
    const k = address.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ dexName, feeBps, address });
  };
  for (const m of markets) {
    if (m.pool.kind === 'v2' && m.pool.address) {
      const dex = rt.cfg.dexes.find((d) => d.id === m.pool.dex);
      add(dex?.name ?? m.pool.dex, m.pool.feeBps, m.pool.address);
    }
  }
  const wrapped = rt.cfg.wrappedNative.address;
  for (const dex of rt.cfg.dexes) {
    if (dex.kind !== 'v2') continue;
    const adapter = rt.adapters.get(dex.id);
    for (const m of markets) {
      const a = ercAddr(m.base, wrapped), b = ercAddr(m.quote, wrapped);
      if (sameAddr(a, b)) continue;
      try {
        if (adapter) {
          for (const p of await adapter.findPools(a, b)) add(dex.name, dex.feeBps ?? p.feeBps, p.address);
        } else {
          const [pair] = await readCall<[string]>(rt.reader, dex.factory, FACTORY, 'getPair', [a, b]);
          add(dex.name, dex.feeBps ?? 30, pair);
        }
      } catch (e) {
        errors.push({ chainId: rt.cfg.id, message: `${dex.name} pair ${m.base.symbol}/${m.quote.symbol} couldn't be looked up (${clip(e)}).` });
      }
    }
  }
  return out;
}

async function readV2(rt: ChainRuntime, owner: string, markets: MarketDef[], errors: Err[]): Promise<{ found: Found[]; lpTokens: Set<string> }> {
  const lpTokens = new Set<string>();
  const found: Found[] = [];
  const pairs = await v2Pairs(rt, markets, errors);
  await Promise.all(pairs.map(async (pair) => {
    try {
      const [bal] = await readCall<[bigint]>(rt.reader, pair.address, ERC20, 'balanceOf', [owner]);
      if (bal === 0n) return;
      const [[supply], [r0, r1], [t0], [t1]] = await Promise.all([
        readCall<[bigint]>(rt.reader, pair.address, ERC20, 'totalSupply'),
        readCall<[bigint, bigint]>(rt.reader, pair.address, PAIR, 'getReserves'),
        readCall<[string]>(rt.reader, pair.address, PAIR, 'token0'),
        readCall<[string]>(rt.reader, pair.address, PAIR, 'token1'),
      ]);
      const share = v2Share(bal, supply, r0, r1);
      if (share.amount0 === 0n && share.amount1 === 0n) return;
      lpTokens.add(pair.address.toLowerCase());
      found.push({
        kind: 'v2', dexName: pair.dexName, pool: pair.address, fee: pair.feeBps, tokenId: null, range: null,
        token0: { address: t0, raw: share.amount0 }, token1: { address: t1, raw: share.amount1 },
        fee0: { address: t0, raw: 0n }, fee1: { address: t1, raw: 0n },
        raw1per0: bigRatio(r1, r0), leftover: false,
      });
    } catch (e) {
      errors.push({ chainId: rt.cfg.id, message: `${pair.dexName} LP ${pair.address.slice(0, 8)}… couldn't be valued (${clip(e)}). If the wallet holds that LP token, it is listed as the token itself.` });
    }
  }));
  return { found, lpTokens };
}

async function listedCoins(hub: Hub, rt: ChainRuntime, owner: string, fetchJson: FetchJson, errors: Err[]): Promise<Holding[]> {
  try {
    const { held, unreadable } = await readListed(hub, rt.cfg.id, owner, fetchJson);
    for (const u of unreadable) errors.push({ chainId: rt.cfg.id, message: `${u.symbol} is on the explorer but couldn't be read on chain (${u.why}). It is left out rather than shown as zero.` });
    return held;
  } catch (e) {
    errors.push({ chainId: rt.cfg.id, message: `The token list failed (${clip(e)}). Showing the chain's own coin and this app's markets only.` });
    const held: Holding[] = [];
    try {
      const raw = await rt.reader.getBalance(owner);
      const amount = fromUnits(raw, 18);
      if (amount > 0) held.push({ id: 'native', address: null, symbol: rt.cfg.nativeSymbol, name: rt.cfg.nativeSymbol, decimals: 18, tracked: true, balance: amount });
    } catch (err) {
      errors.push({ chainId: rt.cfg.id, message: `${rt.cfg.nativeSymbol} balance couldn't be read (${clip(err)}).` });
    }
    const seen = new Set<string>();
    for (const m of hub.byChain(rt.cfg.id)) {
      for (const t of [m.base, m.quote]) {
        if (t.native || seen.has(t.address.toLowerCase())) continue;
        seen.add(t.address.toLowerCase());
        try {
          const raw = await rt.tokenBalance(owner, t.address);
          if (raw === 0n) continue;
          held.push({ id: t.address.toLowerCase(), address: t.address, symbol: t.symbol, name: t.name ?? t.symbol, decimals: t.decimals, tracked: true, balance: fromUnits(raw, t.decimals) });
        } catch (err) {
          errors.push({ chainId: rt.cfg.id, message: `${t.symbol} balance couldn't be read (${clip(err)}).` });
        }
      }
    }
    return held;
  }
}

interface ChainPiece {
  chain: { id: number; name: string; short: string; color: string; address: string | null };
  wallet: (RawCoin & { bots: { bot: BotRef; amount: number }[] })[];
  positions: RawPosition[];
  errors: Err[];
  note: string | null;
}

function priceOf(hub: Hub, chainId: number, address: string | null, wrapped: string): number | null {
  if (address == null || sameAddr(address, wrapped)) return hub.nativeUsd(chainId) ?? (address ? hub.tokenUsd(chainId, address) : null);
  return hub.tokenUsd(chainId, address);
}

async function warmPrices(hub: Hub, chainId: number, addrs: string[]) {
  await hub.nativeUsdAsync(chainId).catch(() => null);
  const want = new Set(addrs.map((a) => a.toLowerCase()));
  const markets = hub.byChain(chainId).filter((m) => want.has(m.base.address.toLowerCase()) || want.has(m.quote.address.toLowerCase()));
  // a price that exists can be hours old (a stopped bot's market is not polled): read again any spot older than the
  // TTL; a fresh one costs no chain read
  for (const m of markets.slice(0, 16)) await hub.ensureSpot(m.key, PRICE_TTL_MS).catch(() => 0);
}

async function readChain(bot: MultiBot, rt: ChainRuntime, owner: string, links: BotLink, fetchJson: FetchJson): Promise<ChainPiece> {
  const cfg = rt.cfg;
  const errors: Err[] = [];
  const markets = bot.hub.byChain(cfg.id);
  const meta = new TokenMeta(rt.reader, cfg.id, knownTokens(cfg, markets));
  const knownIds = [...links.tokenIds.keys()].filter((k) => k.startsWith(`${cfg.id}:`)).map((k) => BigInt(k.slice(k.indexOf(':') + 1)));
  const [v3, v2, listed] = await Promise.all([
    readV3(rt, owner, knownIds, errors),
    readV2(rt, owner, markets, errors),
    listedCoins(bot.hub, rt, owner, fetchJson, errors),
  ]);
  const found = [...v3, ...v2.found];
  const addrs = new Set<string>();
  for (const f of found) { addrs.add(f.token0.address); addrs.add(f.token1.address); }
  for (const h of listed) if (h.address) addrs.add(h.address);
  await warmPrices(bot.hub, cfg.id, [...addrs]);

  const prices = new Map<string, number | null>();
  const putPrice = (address: string | null, usd: number | null) => {
    const k = address ? address.toLowerCase() : 'native';
    if (usd == null || prices.get(k) != null) return;
    prices.set(k, usd);
  };
  putPrice(null, priceOf(bot.hub, cfg.id, null, cfg.wrappedNative.address));
  for (const a of addrs) putPrice(a, priceOf(bot.hub, cfg.id, a, cfg.wrappedNative.address));

  const resolved = new Map<string, { symbol: string; decimals: number }>();
  const metaOf = async (address: string) => {
    const k = address.toLowerCase();
    const hit = resolved.get(k);
    if (hit) return hit;
    const m = await meta.get(address);
    resolved.set(k, m);
    return m;
  };
  for (const a of addrs) {
    try { await metaOf(a); } catch (e) { errors.push({ chainId: cfg.id, message: clip(e) }); }
  }
  for (const f of found) {
    const d0 = resolved.get(f.token0.address.toLowerCase()), d1 = resolved.get(f.token1.address.toLowerCase());
    if (!d0 || !d1) continue;
    const k0 = f.token0.address.toLowerCase(), k1 = f.token1.address.toLowerCase();
    if (prices.get(k0) == null && prices.get(k1) != null) putPrice(f.token0.address, usdFromOther(prices.get(k1)!, f.raw1per0, d0.decimals, d1.decimals, 1));
    if (prices.get(k1) == null && prices.get(k0) != null) putPrice(f.token1.address, usdFromOther(prices.get(k0)!, f.raw1per0, d0.decimals, d1.decimals, 0));
  }

  const coin = (address: string | null, symbol: string, decimals: number, amount: number): RawCoin => ({
    chainId: cfg.id, address, symbol, decimals, amount, usdEach: address ? prices.get(address.toLowerCase()) ?? null : prices.get('native') ?? null,
  });
  const side = async (s: Side): Promise<RawCoin> => {
    const m = resolved.get(s.address.toLowerCase()) ?? await metaOf(s.address);
    return coin(s.address, m.symbol, m.decimals, fromUnits(s.raw, m.decimals));
  };

  const positions: RawPosition[] = [];
  for (const f of found) {
    try {
      const [token0, token1, fee0, fee1] = await Promise.all([side(f.token0), side(f.token1), side(f.fee0), side(f.fee1)]);
      const botRef = f.tokenId ? links.tokenIds.get(`${cfg.id}:${f.tokenId}`) ?? null : links.byPool.get(`${cfg.id}:${f.pool.toLowerCase()}`) ?? null;
      const stranded = !botRef || botRef.status === 'closed';
      positions.push({
        chainId: cfg.id, kind: f.kind, dexName: f.dexName, pool: f.pool, feeLabel: feeLabelOf(f.kind, f.fee), tokenId: f.tokenId, range: f.range,
        token0, token1, fee0, fee1, bot: botRef, stranded, idleNote: botRef ? links.idle.get(botRef.id) ?? null : null, leftover: f.leftover,
      });
    } catch (e) {
      errors.push({ chainId: cfg.id, message: `${f.dexName} position couldn't be priced (${clip(e)}).` });
    }
  }

  const alloc = bot.allocations().rows.filter((r) => r.chainId === cfg.id);
  const botsFor = (address: string | null, native: boolean) => {
    const row = alloc.find((r) => native ? r.native : !r.native && sameAddr(r.address, address ?? ''));
    if (!row) return [];
    return row.bots.flatMap((b) => {
      const ref = links.names.get(b.id);
      return ref ? [{ bot: ref, amount: b.amount }] : [];
    });
  };
  for (const row of alloc) {
    if (row.ok === false) errors.push({ chainId: cfg.id, message: `Live bots are booked for ${formatTokenAmount(row.allocated)} ${row.token}, and the wallet has ${row.wallet == null ? 'an unknown amount' : formatTokenAmount(row.wallet)}.` });
  }

  const wallet: ChainPiece['wallet'] = [];
  for (const h of listed) {
    if (h.address && v2.lpTokens.has(h.address.toLowerCase())) continue;
    let decimals = h.decimals, symbol = h.symbol;
    if (h.address) {
      try {
        const m = await metaOf(h.address);
        decimals = m.decimals; symbol = m.symbol || symbol;
      } catch { /* keep the explorer / market figures */ }
    }
    // holdings() already converted raw units with the decimals it knew. If the contract disagrees, rescale.
    const scaled = decimals === h.decimals ? h.balance : h.balance * 10 ** (h.decimals - decimals);
    wallet.push({ ...coin(h.address, symbol, decimals, scaled), bots: botsFor(h.address, h.address == null) });
  }

  return {
    chain: { id: cfg.id, name: cfg.name, short: cfg.short, color: cfg.color, address: owner },
    wallet, positions, errors,
    note: cfg.tokenApi ? null : `${cfg.name}'s explorer blocks a server from listing every token, so the wallet there shows coins this app tracks plus anything inside liquidity positions.`,
  };
}

let cache: { at: number; data: HoldingsSnapshot } | null = null;
let flight: Promise<HoldingsSnapshot> | null = null;

async function compute(bot: MultiBot, fetchJson: FetchJson): Promise<HoldingsSnapshot> {
  if (!bot.hasSigner) {
    return assemblePortfolio({ address: null, at: Date.now(), hasSigner: false, chains: [], wallet: [], positions: [], errors: [] });
  }
  const links = botLinks(bot);
  const pieces = await Promise.all(bot.hub.runtimes().filter((rt) => rt.signer).map(async (rt) => {
    try {
      const owner = rt.gas.address ?? await rt.signer!.getAddress();
      return await withTimeout(readChain(bot, rt, owner, links, fetchJson), CHAIN_MS, rt.cfg.name);
    } catch (e) {
      return {
        chain: { id: rt.cfg.id, name: rt.cfg.name, short: rt.cfg.short, color: rt.cfg.color, address: rt.gas.address },
        wallet: [], positions: [], errors: [{ chainId: rt.cfg.id, message: clip(e) }], note: null,
      } satisfies ChainPiece;
    }
  }));
  const snap = assemblePortfolio({
    address: bot.address ?? pieces.find((p) => p.chain.address)?.chain.address ?? null,
    at: Date.now(), hasSigner: true,
    chains: pieces.map((p) => p.chain),
    wallet: pieces.flatMap((p) => p.wallet),
    positions: pieces.flatMap((p) => p.positions),
    errors: pieces.flatMap((p) => p.errors),
  });
  const notes = pieces.flatMap((p) => p.note ? [p.note] : []);
  if (notes.length) snap.how = [...snap.how, ...notes];
  return snap;
}

/** Cached for 45s. `force` reads the chains again. Concurrent callers share one read. */
export function holdingsSnapshot(bot: MultiBot, fetchJson: FetchJson, force = false): Promise<HoldingsSnapshot> {
  const now = Date.now();
  if (!force && cache && now - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (!force && flight) return flight;
  const run = compute(bot, fetchJson).then((data) => { cache = { at: Date.now(), data }; return data; });
  if (!force) flight = run.finally(() => { flight = null; });
  return force ? run : flight!;
}
