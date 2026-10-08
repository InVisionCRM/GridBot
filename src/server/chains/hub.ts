/**
 * Hub: every configured chain runtime + every market (legacy PulseChain, per-chain defaults, custom), quoters,
 * the USD / native-coin oracle and the custom-token flow (inspect → discover pools → safety → add).
 * Engines resolve their market key through the hub; nothing here sends transactions.
 */
import type { LiveNetwork } from '../../live/networks';
import { chainFromNetwork, type ChainConfig } from '../../live/chains';
import { flipMarket, isFlipKey, isLegacyKey, legacyMarkets, marketKey, marketLabel, unflipKey, type MarketDef, type MarketToken, type SafetyReport } from '../../live/markets';
import { Quoter, type ChainReader, type TxSender } from '../bot/chain';
import type { Store } from '../bot/store';
import type { SharedNonce, TxGate } from '../bot/txGate';
import { ChainRuntime } from './runtime';
import { discoverPools, type DiscoveredPool } from '../dex/discovery';
import { readTokenMeta, type TokenMeta } from '../dex/tokens';
import { classify, depthAt, hopFor, simulateRoundTrip, type ProbeResult } from '../dex/safety';
import { sameAddr } from '../dex/types';
import { toUnits } from '../../live/swapMath';
import { readDecimals } from '../../live/decimals';
import { NO_TAX, taxesOf, type Taxes } from '../../live/tax';
import type { CandleSource } from '../market/backfill';

/** pools = trading-pool overrides for built-in markets (custom markets persist their pool in markets[]) */
export interface CustomFile { version: 1; tokens: TokenMeta[]; markets: MarketDef[]; pools?: Record<string, { pool: MarketDef['pool']; mode: 'auto' | 'manual'; candleKind?: 'v2' | 'v3' }> }

export interface PoolChoice { key: string; current: MarketDef['pool']; mode: string; refQuote: number; quoteUsd: number | null; pools: DiscoveredPool[]; best: DiscoveredPool | null }

export interface InspectRequest { chainId: number; address: string; quote?: string; pool?: string }
export interface InspectResult {
  chainId: number;
  token: TokenMeta;
  quoteOptions: { symbol: string; address: string; kind: MarketDef['quoteKind'] }[];
  quote: MarketToken & { kind: MarketDef['quoteKind'] };
  pools: DiscoveredPool[];
  chosen: DiscoveredPool | null;
  draft: MarketDef | null;
  safety: SafetyReport | null;
  probe: (Omit<ProbeResult, 'quoteIn' | 'expectedBuy' | 'gotBuy' | 'transferSent' | 'transferGot' | 'sellIn' | 'expectedSell' | 'gotSell' | 'gasBuy' | 'gasSell'> & Record<string, string | number>) | null;
  existing: string | null;
}

export class Hub {
  readonly spots: Record<string, number> = {};
  readonly spotAt: Record<string, number> = {};
  private readonly rts = new Map<number, ChainRuntime>();
  private readonly defs = new Map<string, MarketDef>();
  private readonly quoters = new Map<string, Quoter>();
  private custom: CustomFile = { version: 1, tokens: [], markets: [] };
  private tvlCache = new Map<string, { at: number; v: number | null }>();

  constructor(private readonly o: { runtimes: ChainRuntime[]; markets: MarketDef[]; legacyNet: LiveNetwork; custom?: Store<CustomFile>; now?: () => number }) {
    for (const r of o.runtimes) this.rts.set(r.cfg.id, r);
    // Shallow copies: the hub owns its defs (pool switches replace d.pool in place so live Quoters follow).
    for (const m of o.markets) if (this.rts.has(m.chainId)) this.defs.set(m.key, { ...m });
    const saved = o.custom?.load();
    if (saved && saved.version === 1) {
      this.custom = { version: 1, tokens: saved.tokens ?? [], markets: saved.markets ?? [], pools: saved.pools ?? {} };
      for (const m of this.custom.markets) if (this.rts.has(m.chainId) && !this.defs.has(m.key)) this.defs.set(m.key, { ...m, custom: true });
      for (const [k, ov] of Object.entries(this.custom.pools ?? {})) {
        const d = this.defs.get(k);
        if (!d || d.custom || !this.rts.get(d.chainId)?.adapters.has(ov.pool.dex)) continue;
        d.pool = { ...ov.pool }; d.poolMode = ov.mode; d.candleKind = ov.candleKind ?? d.candleKind;
      }
    }
  }

  /** Single-chain hub for the legacy PulseChain wiring (tests, MultiBot/GridEngine without a hub). */
  static single(net: LiveNetwork, reader: ChainReader, signer: TxSender | null, o: { gate?: TxGate; nonce?: SharedNonce } = {}): Hub {
    const rt = new ChainRuntime(chainFromNetwork(net), reader, signer, o);
    return new Hub({ runtimes: [rt], markets: legacyMarkets(net), legacyNet: net });
  }

  private now() { return (this.o.now ?? Date.now)(); }
  get legacyNet() { return this.o.legacyNet; }
  get legacyChainId() { return this.o.legacyNet.chainId; }
  get defaultKey() { return this.o.legacyNet.defaultQuote; }
  runtimes(): ChainRuntime[] { return [...this.rts.values()]; }
  rt(chainId: number): ChainRuntime {
    const r = this.rts.get(Number(chainId));
    if (!r) throw new Error(`Chain ${chainId} is not configured`);
    return r;
  }
  chain(chainId: number): ChainConfig { return this.rt(chainId).cfg; }

  /** Flipped views ('K~'), created on first use; they read pool / safety live from the original def. */
  private flips = new Map<string, MarketDef>();
  private get(key: string): MarketDef | undefined {
    if (!isFlipKey(key)) return this.defs.get(key);
    const orig = this.defs.get(unflipKey(key));
    if (!orig) return undefined;
    let f = this.flips.get(key);
    if (!f) { f = flipMarket(orig, () => this.spots[orig.key] ?? null); this.flips.set(key, f); }
    return f;
  }
  /** Either orientation of any configured market: 'HEX' (PLS/HEX) or 'HEX~' (HEX/PLS). */
  has(key: string) { return !!this.get(key); }
  def(key: string): MarketDef {
    const d = this.get(key);
    if (!d) throw new Error(`Unknown quote ${key}`);
    return d;
  }
  /** Original (as configured) orientation of every market; flipped views are reached via def('K~'). */
  list(): MarketDef[] { return [...this.defs.values()]; }
  /** Both orientations of every market (UI market list). */
  listBoth(): MarketDef[] { return this.list().flatMap((d) => [d, this.def(d.key + '~')]); }
  byChain(chainId: number) { return this.list().filter((m) => m.chainId === chainId); }
  chainOf(key: string): ChainRuntime { return this.rt(this.def(key).chainId); }

  /** 'PLS/DAI' for legacy markets (unchanged messages); 'ETH/USDC·BASE' elsewhere. */
  label(key: string): string {
    const d = this.get(key);
    if (!d) return key;
    return d.legacy ? marketLabel(d) : `${marketLabel(d)}·${this.rts.get(d.chainId)?.cfg.short ?? d.chainId}`;
  }

  quoter(key: string): Quoter {
    const cached = this.quoters.get(key);
    if (cached) return cached;
    const d = this.def(key);
    const rt = this.rt(d.chainId);
    if (!rt.tradable) throw new Error(`${rt.cfg.name}: trading unavailable — ${rt.cfg.trading.reason ?? 'no DEX configured'}`);
    const q = new Quoter(rt.reader, d, {
      chain: rt.cfg, adapter: rt.adapter(d.pool.dex), resolve: (id) => rt.adapter(id),
      basePerNative: () => this.basePerNativeAsync(key),
      l1Fee: rt.cfg.stack !== 'l1' ? (to, data, gp) => rt.l1Fee(to, data, gp) : undefined,
      tvl: () => this.poolTvl(key),
      verifyDecimals: () => this.verifyDecimals(key),
      taxOf: (addr) => this.taxOf(d.chainId, addr),
    });
    this.quoters.set(key, q);
    return q;
  }

  /** Measured taxes of a token on a chain: from the safety report of the custom market whose BASE is that token. */
  taxOf(chainId: number, address: string): Taxes {
    let best: SafetyReport | undefined;
    for (const m of this.byChain(chainId)) {
      if (m.custom && m.safety && sameAddr(m.base.address, address) && (!best || m.safety.at > best.at)) best = m.safety;
    }
    return best ? taxesOf(best) : NO_TAX;
  }

  /** Something looks off on a custom market (swap reverted, fill short of the post-tax quote) → tax watcher re-checks now. */
  onSuspect: ((key: string, why: string) => void) | null = null;
  suspect(key: string, why: string) { key = unflipKey(key); if (this.has(key) && this.def(key).custom) this.onSuspect?.(key, why); }

  /** V3 pool TVL in quote units from the pool's token balances (cached 5 min). */
  async poolTvl(key: string): Promise<number | null> {
    const c = this.tvlCache.get(key);
    if (c && this.now() - c.at < 300_000) return c.v;
    const d = this.def(key), rt = this.rt(d.chainId);
    if (d.pool.kind !== 'v3' || !d.pool.address) return null;
    let v: number | null = null;
    try {
      const spot = this.spots[key] ?? await this.ensureSpot(key);
      const [bb, bq] = await Promise.all([rt.tokenBalance(d.pool.address, d.base.address), rt.tokenBalance(d.pool.address, d.quote.address)]);
      v = Number(bq) / 10 ** d.quote.decimals + (Number(bb) / 10 ** d.base.decimals) * spot;
    } catch { v = null; }
    this.tvlCache.set(key, { at: this.now(), v });
    return v;
  }

  // ── USD / native oracle ───────────────────────────────────────────────
  setSpot(key: string, p: number) { if (p > 0 && Number.isFinite(p)) { this.spots[key] = p; this.spotAt[key] = this.now(); } }

  async ensureSpot(key: string, maxAgeMs = 120_000): Promise<number> {
    const p = this.spots[key];
    if (p > 0 && this.now() - (this.spotAt[key] ?? 0) < maxAgeMs) return p;
    const v = await this.quoter(key).getPrice();
    this.setSpot(key, v);
    return v;
  }

  isStable(chainId: number, addr: string): boolean {
    const c = this.rts.get(chainId)?.cfg;
    if (c?.stables.some((s) => sameAddr(s.address, addr))) return true;
    return this.byChain(chainId).some((m) => m.quoteKind === 'stable' && sameAddr(m.quote.address, addr));
  }

  /** Market used to price the native coin in USD: base = native, quote = stable (PulseChain: DAI). */
  usdRefKey(chainId: number): string | null {
    const ms = this.byChain(chainId).filter((m) => m.base.native && m.quoteKind === 'stable');
    return (ms.find((m) => !m.custom) ?? ms[0])?.key ?? null;
  }

  nativeUsd(chainId: number): number | null {
    const k = this.usdRefKey(chainId);
    return k && this.spots[k] > 0 ? this.spots[k] : null;
  }

  /** USD per token from cached spots (sync; null when no route is priced yet). */
  tokenUsd(chainId: number, addr: string, depth = 0): number | null {
    if (this.isStable(chainId, addr)) return 1;
    const c = this.rts.get(chainId)?.cfg;
    if (c && sameAddr(c.wrappedNative.address, addr)) return this.nativeUsd(chainId);
    if (depth > 2) return null;
    for (const m of this.byChain(chainId)) {
      const s = this.spots[m.key];
      if (!(s > 0)) continue;
      if (sameAddr(m.base.address, addr) && !sameAddr(m.quote.address, addr)) {
        const q = this.tokenUsd(chainId, m.quote.address, depth + 1);
        if (q != null) return s * q;
      }
      if (sameAddr(m.quote.address, addr) && !sameAddr(m.base.address, addr)) {
        const b = this.tokenUsd(chainId, m.base.address, depth + 1);
        if (b != null) return b / s;
      }
    }
    return null;
  }

  usdPerQuote(key: string): number | null {
    const d = this.get(key);
    if (!d) return null;
    return this.tokenUsd(d.chainId, d.quote.address) ?? (d.quoteKind === 'stable' ? 1 : null);
  }
  baseUsd(key: string): number | null {
    const k = this.usdPerQuote(key), s = this.spots[key];
    return k != null && s > 0 ? s * k : null;
  }

  async nativeUsdAsync(chainId: number): Promise<number | null> {
    const k = this.usdRefKey(chainId);
    if (!k) return null;
    try { return await this.ensureSpot(k); } catch { return this.nativeUsd(chainId); }
  }

  /** Base units per 1 native coin (gas conversion). 1 when the base is the native coin. */
  async basePerNativeAsync(key: string): Promise<number> {
    const d = this.def(key);
    if (d.base.native) return 1;
    const rt = this.rt(d.chainId);
    if (sameAddr(d.base.address, rt.cfg.wrappedNative.address)) return 1;
    // Quote is the native coin (flipped HEX/PLS, custom/WPLS): base per native = 1 / spot, exact, no USD route needed.
    if (d.quote.native || sameAddr(d.quote.address, rt.cfg.wrappedNative.address)) {
      const s = await this.ensureSpot(key);
      if (s > 0) return 1 / s;
    }
    const [nat] = await Promise.all([this.nativeUsdAsync(d.chainId), this.ensureSpot(key).catch(() => 0)]);
    if (!sameAddr(d.quote.address, rt.cfg.wrappedNative.address) && !this.isStable(d.chainId, d.quote.address)) {
      for (const m of this.byChain(d.chainId)) if (sameAddr(m.base.address, d.quote.address)) await this.ensureSpot(m.key).catch(() => 0);
    }
    const b = this.baseUsd(key);
    if (nat && b) return nat / b;
    if (sameAddr(d.quote.address, rt.cfg.wrappedNative.address) && this.spots[key] > 0) return 1 / this.spots[key];
    throw new Error(`No native price route for ${this.label(key)}`);
  }

  // ── Custom tokens / markets ───────────────────────────────────────────
  customTokens(chainId?: number) { return this.custom.tokens.filter((t) => chainId == null || t.chainId === chainId); }
  customMarkets() { return this.list().filter((m) => m.custom); }
  private persist() {
    this.custom.markets = this.customMarkets();
    this.o.custom?.save(this.custom);
  }

  quoteOptions(chainId: number, exclude?: string) {
    const c = this.chain(chainId);
    const opts: InspectResult['quoteOptions'] = [
      { symbol: c.wrappedNative.symbol, address: c.wrappedNative.address, kind: 'wrapped' },
      ...c.stables.map((s) => ({ symbol: s.symbol, address: s.address, kind: 'stable' as const })),
    ];
    for (const m of this.byChain(chainId)) {
      if (m.custom && !opts.some((o) => sameAddr(o.address, m.base.address))) opts.push({ symbol: m.base.symbol, address: m.base.address, kind: 'token' });
      if (m.legacy && !opts.some((o) => sameAddr(o.address, m.quote.address))) opts.push({ symbol: m.quote.symbol, address: m.quote.address, kind: m.quoteKind });
    }
    return opts.filter((o) => !exclude || !sameAddr(o.address, exclude));
  }

  private async quoteTokenUsd(chainId: number, q: { address: string; kind: MarketDef['quoteKind'] }): Promise<number | null> {
    if (q.kind === 'stable') return 1;
    if (q.kind === 'wrapped') return this.nativeUsdAsync(chainId);
    for (const m of this.byChain(chainId)) if (sameAddr(m.base.address, q.address) || sameAddr(m.quote.address, q.address)) await this.ensureSpot(m.key).catch(() => 0);
    return this.tokenUsd(chainId, q.address);
  }

  /**
   * Read token metadata, discover pools against the chosen (or best) quote, and run the safety checks.
   * Pure read: nothing is persisted until add().
   */
  async inspect(req: InspectRequest): Promise<InspectResult> {
    const rt = this.rt(req.chainId);
    if (!rt.tradable) throw new Error(`${rt.cfg.name}: trading unavailable — ${rt.cfg.trading.reason ?? 'no DEX'}`);
    const token = await readTokenMeta(rt.reader, rt.cfg.id, req.address);
    if (sameAddr(token.address, rt.cfg.wrappedNative.address)) throw new Error(`${token.symbol} is the chain's wrapped native coin — use the built-in ${rt.cfg.nativeSymbol} market.`);
    const quoteOptions = this.quoteOptions(rt.cfg.id, token.address);
    const existing = this.list().find((m) => m.chainId === rt.cfg.id && sameAddr(m.base.address, token.address))?.key ?? null;
    const pick = req.quote ? quoteOptions.find((o) => sameAddr(o.address, req.quote!) || o.symbol.toLowerCase() === req.quote!.toLowerCase()) : null;
    if (req.quote && !pick) throw new Error(`Quote ${req.quote} is not available on ${rt.cfg.name} (choose ${quoteOptions.map((o) => o.symbol).join(', ')})`);
    const base: MarketToken = { address: token.address, symbol: token.symbol, name: token.name, decimals: token.decimals };
    const candidates = pick ? [pick] : quoteOptions.filter((o) => o.kind !== 'token');
    let best: { q: (typeof quoteOptions)[number]; pools: DiscoveredPool[]; usd: number | null } | null = null;
    for (const q of candidates) {
      const usd = await this.quoteTokenUsd(rt.cfg.id, q);
      const pools = await discoverPools(rt, base, { address: q.address, symbol: q.symbol, decimals: await this.decimalsOf(rt, q.address) }, { refQuote: usd ? 1000 / usd : 1000, quoteUsd: usd });
      const top = pools[0]?.tvlUsd ?? pools[0]?.tvlQuote ?? -1;
      const cur = best ? best.pools[0]?.tvlUsd ?? best.pools[0]?.tvlQuote ?? -1 : -2;
      if (!best || (pools.length && top > cur)) best = { q, pools, usd };
    }
    const q = best!.q;
    const quote = { address: q.address, symbol: q.symbol, decimals: await this.decimalsOf(rt, q.address), kind: q.kind, name: q.symbol };
    const pools = best!.pools;
    const chosen = (req.pool ? pools.find((p) => sameAddr(p.address, req.pool!)) : pools.find((p) => p.refOut != null)) ?? null;
    if (req.pool && !chosen) throw new Error(`Pool ${req.pool} not found for ${token.symbol}/${q.symbol}`);
    const result: InspectResult = { chainId: rt.cfg.id, token, quoteOptions, quote, pools, chosen, draft: null, safety: null, probe: null, existing };
    if (!chosen || chosen.mid == null) return result;

    const quoteUsd = best!.usd;
    const baseUsd = quoteUsd != null ? chosen.mid * quoteUsd : null;
    const probe = baseUsd ? +(25 / baseUsd).toPrecision(3) : 1;
    const draft: MarketDef = {
      key: marketKey(rt.cfg, token.symbol, q.symbol, (k) => this.defs.has(k)), chainId: rt.cfg.id,
      base, quote: { address: quote.address, symbol: quote.symbol, decimals: quote.decimals, name: quote.name },
      pool: { dex: chosen.dex, kind: chosen.kind, address: chosen.address, feeBps: chosen.feeBps, ...(chosen.feeTier != null ? { feeTier: chosen.feeTier } : {}) },
      probe, quoteKind: q.kind, custom: true, candlePool: chosen.address, addedAt: this.now(),
    };
    result.draft = draft;
    const { report, probe: pr } = await this.safety(rt, draft, token, quoteUsd, baseUsd, chosen.tvlUsd);
    result.safety = report;
    result.probe = pr ? { stage: pr.stage, err: pr.err, quoteIn: pr.quoteIn.toString(), expectedBuy: pr.expectedBuy.toString(), gotBuy: pr.gotBuy.toString(), transferSent: pr.transferSent.toString(), transferGot: pr.transferGot.toString(), sellIn: pr.sellIn.toString(), expectedSell: pr.expectedSell.toString(), gotSell: pr.gotSell.toString(), gasBuy: Number(pr.gasBuy), gasSell: Number(pr.gasSell) } : null;
    draft.safety = report;
    return result;
  }

  /** decimals() read on-chain (cached per chain + address) and cross-checked against the registry / stored market. */
  private async decimalsOf(rt: ChainRuntime, addr: string): Promise<number> {
    const c = rt.cfg;
    const onchain = await readDecimals(rt.reader, c.id, addr);
    const m = this.byChain(c.id).find((x) => sameAddr(x.base.address, addr) || sameAddr(x.quote.address, addr));
    const known = sameAddr(addr, c.wrappedNative.address) ? c.wrappedNative.decimals
      : c.stables.find((x) => sameAddr(x.address, addr))?.decimals
      ?? (m ? (sameAddr(m.base.address, addr) ? m.base.decimals : m.quote.decimals) : undefined);
    if (known != null && known !== onchain) throw new Error(`${addr} on ${c.name}: decimals() = ${onchain} on-chain but ${known} in the registry/market — refusing`);
    return onchain;
  }

  /**
   * Verify a market's stored decimals against decimals() on-chain (cached). Throws on mismatch so no quote, gate or
   * transaction ever runs with wrong scaling. Called by every Quoter before its first quote.
   */
  async verifyDecimals(key: string): Promise<void> {
    const d = this.def(key), rt = this.rt(d.chainId);
    for (const t of [d.base, d.quote]) {
      const onchain = await readDecimals(rt.reader, d.chainId, t.address);
      if (onchain !== t.decimals) throw new Error(`${this.label(key)}: ${t.symbol} decimals() = ${onchain} on-chain but the market stores ${t.decimals} — refusing to quote or trade (re-add the market)`);
    }
  }

  private async safety(rt: ChainRuntime, d: MarketDef, token: TokenMeta, quoteUsd: number | null, baseUsd: number | null, liquidityUsd: number | null) {
    const ad = rt.adapter(d.pool.dex);
    const depth = quoteUsd && baseUsd ? await depthAt(ad, d, quoteUsd, baseUsd) : [];
    let probe: ProbeResult | null = null, simError: string | null = null;
    try {
      const wn = rt.cfg.wrappedNative.address;
      const nat = await this.nativeUsdAsync(rt.cfg.id);
      const wethIn = toUnits(((nat ? 20 / nat : 0.01)).toFixed(12), 18);
      let prep = null;
      if (!sameAddr(d.quote.address, wn)) {
        const pools = await discoverPools(rt, { address: wn, symbol: 'W', decimals: 18 }, d.quote, { refQuote: nat ? 20 / (quoteUsd ?? 1) : 1, quoteUsd });
        const p = pools.find((x) => x.refOut != null);
        if (!p) throw new Error(`no ${rt.cfg.wrappedNative.symbol}/${d.quote.symbol} pool to fund the simulation`);
        prep = hopFor(rt.adapter(p.dex), p, wn, d.quote.address);
      }
      probe = await simulateRoundTrip(rt, { weth: wn, wethIn, prep, buy: hopFor(ad, d.pool, d.quote.address, d.base.address), sell: hopFor(ad, d.pool, d.base.address, d.quote.address) });
    } catch (e) {
      simError = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
      simError = simError.slice(0, 140);
    }
    return {
      report: classify({ probe, simError, proxy: token.proxy, depth, liquidityUsd, now: this.now(), poolKind: d.pool.kind, flags: token.flags ?? null, decimals: token.decimals }),
      probe,
    };
  }

  /** Persist a custom market (re-inspects server-side; the client's data is never trusted). */
  async addMarket(req: InspectRequest): Promise<MarketDef> {
    const r = await this.inspect(req);
    if (!r.draft) throw new Error(`No usable pool for ${r.token.symbol}/${r.quote.symbol} on ${this.chain(req.chainId).name}`);
    if (r.existing && this.def(r.existing).pool.address.toLowerCase() === r.draft.pool.address.toLowerCase()) throw new Error(`Already added as ${r.existing}`);
    this.defs.set(r.draft.key, r.draft);
    if (!this.custom.tokens.some((t) => t.chainId === r.token.chainId && sameAddr(t.address, r.token.address))) this.custom.tokens.push(r.token);
    this.persist();
    return r.draft;
  }

  async recheck(key: string): Promise<SafetyReport> {
    key = unflipKey(key);
    const d = this.def(key);
    if (!d.custom) throw new Error('Safety checks apply to custom markets');
    const r = await this.inspect({ chainId: d.chainId, address: d.base.address, quote: d.quote.address, pool: d.pool.address });
    d.safety = r.safety ?? d.safety;
    this.persist();
    return d.safety!;
  }

  // ── Pool selection (PulseChain: PulseX V1 / PulseX V2 / 9mm V2 / 9mm V3; elsewhere every configured DEX) ──
  /**
   * Every pool for the market's base/quote across all DEXes on its chain, ranked by the quote for a reference
   * buy (≈ $250 of the quote token by default) — the best execution at a realistic size, which favours deep pools.
   */
  async poolOptions(key: string, refUsd = 250): Promise<PoolChoice> {
    key = unflipKey(key); // one pool serves both orientations
    const d = this.def(key), rt = this.rt(d.chainId);
    const quoteUsd = this.usdPerQuote(key) ?? (await this.ensureSpot(key).then(() => this.usdPerQuote(key)).catch(() => null));
    const refQuote = quoteUsd ? refUsd / quoteUsd : (d.quoteKind === 'stable' ? refUsd : 1);
    const pools = await discoverPools(rt, d.base, d.quote, { refQuote: +refQuote.toPrecision(6), quoteUsd });
    const best = pools.find((p) => p.refOut != null && p.refOut > 0 && p.mid != null) ?? null;
    return { key, current: d.pool, mode: d.poolMode ?? (d.custom ? 'manual' : 'default'), refQuote, quoteUsd, pools, best };
  }

  /**
   * Switch the trading pool: `{ pool }` = manual override (must be one of poolOptions), `{ auto: true }` = best quote,
   * `{ reset: true }` = registry default (built-in markets). Candles stay on the original pool. Caller makes sure no
   * transaction is in flight.
   */
  async setPool(key: string, req: { pool?: string; auto?: boolean; reset?: boolean }): Promise<{ def: MarketDef; choice: PoolChoice | null }> {
    key = unflipKey(key);
    this.tvlCache.delete(key + '~');
    const d = this.def(key);
    if (!d.candleKind) d.candleKind = d.pool.kind;
    if (req.reset) {
      if (d.custom) throw new Error('Custom markets have no registry default; pick a pool');
      const orig = this.o.markets.find((m) => m.key === key);
      if (!orig) throw new Error(`No default pool for ${key}`);
      d.pool = { ...orig.pool }; d.poolMode = 'default';
      delete this.custom.pools?.[key];
      this.tvlCache.delete(key);
      this.persist();
      return { def: d, choice: null };
    }
    const choice = await this.poolOptions(key);
    const pick = req.auto ? choice.best : choice.pools.find((p) => req.pool && sameAddr(p.address, req.pool));
    if (!pick) throw new Error(req.auto ? `No quotable pool for ${this.label(key)}` : `Pool ${req.pool} is not a ${d.base.symbol}/${d.quote.symbol} pool on ${this.chain(d.chainId).name}`);
    if (pick.refOut == null || pick.mid == null) throw new Error(`${pick.dexName} pool ${pick.address} cannot be quoted${pick.error ? `: ${pick.error}` : ''}`);
    d.pool = { dex: pick.dex, kind: pick.kind, address: pick.address, feeBps: pick.feeBps, ...(pick.feeTier != null ? { feeTier: pick.feeTier } : {}) };
    d.poolMode = req.auto ? 'auto' : 'manual';
    if (!d.custom) (this.custom.pools ??= {})[key] = { pool: { ...d.pool }, mode: d.poolMode, candleKind: d.candleKind };
    this.tvlCache.delete(key);
    this.persist();
    return { def: d, choice };
  }

  dexName(chainId: number, dexId: string): string {
    return this.rts.get(chainId)?.cfg.dexes.find((x) => x.id === dexId)?.name ?? dexId;
  }

  removeMarket(key: string) {
    key = unflipKey(key);
    const d = this.def(key);
    if (!d.custom) throw new Error('Only custom markets can be removed');
    this.defs.delete(key);
    this.quoters.delete(key);
    this.quoters.delete(key + '~');
    this.flips.delete(key + '~');
    if (!this.list().some((m) => m.chainId === d.chainId && sameAddr(m.base.address, d.base.address))) {
      this.custom.tokens = this.custom.tokens.filter((t) => !(t.chainId === d.chainId && sameAddr(t.address, d.base.address)));
    }
    this.persist();
  }

  /** Candle source per market: GeckoTerminal slug + pool + base token; on-chain fallback by pool kind. */
  candleSource(key: string): CandleSource {
    key = unflipKey(key); // flipped series are derived (inverted) from the original's candles
    const d = this.def(key), c = this.chain(d.chainId);
    return {
      key, label: this.label(key), network: c.geckoSlug, pool: d.candlePool || d.pool.address, kind: d.candlePool ? (d.candleKind ?? d.pool.kind) : d.pool.kind,
      base: { address: d.base.address, decimals: d.base.decimals }, quote: { address: d.quote.address, decimals: d.quote.decimals },
      feeBps: d.pool.feeBps, logChunk: c.logChunk,
    };
  }
  candleSources(): CandleSource[] {
    return this.list().filter((d) => this.rt(d.chainId).tradable).map((d) => this.candleSource(d.key)).filter((s) => !!s.pool);
  }

  isLegacy(key: string) { return isLegacyKey(key) && !isFlipKey(key) && this.defs.get(key)?.legacy === true; }

  /**
   * Quoter for a market on another pool of the same pair (preset preview on the best pool) — not cached, never
   * changes the market. `pool` must come from poolOptions().
   */
  quoterOnPool(key: string, pool: MarketDef['pool']): Quoter {
    const d = this.def(key), rt = this.rt(d.chainId);
    const view = Object.create(d, { pool: { value: { ...pool }, enumerable: true } }) as MarketDef;
    return new Quoter(rt.reader, view, {
      chain: rt.cfg, adapter: rt.adapter(pool.dex), resolve: (id) => rt.adapter(id),
      basePerNative: () => this.basePerNativeAsync(key),
      l1Fee: rt.cfg.stack !== 'l1' ? (to, data, gp) => rt.l1Fee(to, data, gp) : undefined,
      verifyDecimals: () => this.verifyDecimals(key),
      taxOf: (addr) => this.taxOf(d.chainId, addr),
    });
  }
}
