/**
 * Express app factory (no listening, no env access): REST API + SSE stream. index.ts wires env, signer,
 * provider and the poll loop; tests build an app around a MultiBot on a mock chain.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { MultiBot } from './bot/multi';
import type { Mode, ProfitMode } from './bot/engine';
import type { ActivityEvent } from './bot/activity';
import { analyzeSpacing, DENSE_PRESETS, MAX_GRID_COUNT } from '../live/spacing';
import { listPresets } from '../live/presets';
import { DEFAULT_TREND, STRATEGIES } from '../market/strategy';
import { SWEEP_AXES } from '../market/backtest';
import { checkTestUsd } from '../market/scan';
import { TFS, isTF } from '../market/candles';
import type { LiveNetwork } from '../live/networks';
import { fmtFeeTier } from '../live/chains';
import type { VersionCheck } from './system/version';
import { runChecks } from './system/checks';
import type { Converter } from './convert/converter';
import type { SwapService } from './swap/service';
import { viaFunnel } from './friends/publicHost';
import type { PoolSearch } from './market/poolSearch';
import type { FriendsHost } from './friends/host';
import type { GeckoRelay } from './friends/relay';
import type { Autopilot, AutoOptions, Budget } from './bot/autopilot';
import type { TokenTrader, TraderOptions } from './bot/tokenTrader';
import type { Router } from './router/router';
import { noKey } from './words';
import { fetchJson } from './fetchJson';
import { StatusFeed } from './statusFeed';
import { holdingsSnapshot } from './holdings/read';
import { requestStore, type HaltOrigin } from './bot/audit';

export interface AppOpts {
  bot: MultiBot;
  net: LiveNetwork;
  /** Background candle backfill (server only) */
  backfill?: (pair: string, source: 'gecko' | 'onchain', days: number) => Promise<unknown>;
  /** Daily pair scan (server only; a friend's copy shows the host's) */
  scanner?: { status(): unknown; run(testUsd?: number): Promise<unknown> };
  /** The host's GeckoTerminal relay for friends' copies (host only) */
  relay?: GeckoRelay;
  /** Friends' copies (host only): on, or why they are off */
  friends?: FriendsHost | { off: string };
  /** The smart trader (server only) */
  autopilot?: Autopilot;
  /** New-token trader and sniper (server only) */
  tokenTrader?: TokenTrader;
  /** Capital router settings (host only). Absent in tests that don't construct one. */
  router?: Router;
  /** A chart was opened: the candle sync keeps every timeframe of that market for a while (server only) */
  viewCandles?: (pair: string) => void;
  /** Liquidity replay over a pool's real trades (server only: reads the chain) */
  lpReplay?: (q: { market: string; capital?: number; maxImpact?: number }) => Promise<unknown>;
  /** Tools → Convert: a chain's holdings into one coin (server only: reads the explorer, signs swaps) */
  convert?: Converter;
  /** Same-chain swap quotes. Builds calldata in live mode and never broadcasts it. */
  swap?: SwapService;
  /** Pair search in the pair pickers (server only: asks DexScreener) */
  poolSearch?: PoolSearch;
  heartbeatMs?: number;
  statusThrottleMs?: number;
  /** Version check + self-test (server only: needs the git checkout and the build stamp; a friend's copy has no version check) */
  system?: { version: VersionCheck | null; pollMs: number };
  /** This process is a friend's copy. Its requests are labeled as such even if a via header says otherwise. */
  copy?: boolean;
}

function headerOne(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : null;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp(o: AppOpts) {
  const { bot, net } = o;
  const app = express();
  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return res.status(403).json({ error: 'forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !LOCAL_ORIGIN.test(origin)) return res.status(403).json({ error: 'forbidden origin' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON body required' });
    }
    const via = headerOne(req.headers['x-gridbot-via']);
    const fromRaw = headerOne(req.headers['x-gridbot-from']);
    const origin: HaltOrigin = o.copy ? 'friend-copy' : via === 'owner' ? 'gateway-owner' : 'localhost';
    requestStore.run({
      origin,
      endpoint: `${req.method} ${req.path}`,
      ua: headerOne(req.headers['user-agent'])?.slice(0, 180) ?? null,
      from: fromRaw && /^[a-z0-9-]{1,40}$/.test(fromRaw) ? fromRaw : null,
    }, () => next());
  });
  app.use(express.json({ limit: '64kb' }));

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: (e as Error).message });
    }
  };
  const num = (v: unknown) => (v == null || v === '' ? undefined : Number(v));
  /** Per-leg preset amounts in spend-coin units: { "HEX~": 10000000 } (object body, or JSON in a query string). */
  const amountsParam = (v: unknown): Record<string, number> => {
    const o = typeof v === 'string' ? JSON.parse(v) as unknown : v ?? {};
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error('amounts must be an object of market key → amount');
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, Number(x)]).filter(([, x]) => Number.isFinite(x as number) && (x as number) > 0));
  };
  /** JSON-safe (bigint → string) */
  const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const marketReq = (b: Record<string, unknown>) => {
    const chainId = Number(b.chainId), address = String(b.address ?? '').trim();
    if (!Number.isInteger(chainId)) throw new Error('chainId required');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('address must be a 0x… 20-byte hex address');
    const opt = (v: unknown) => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim()) ? v.trim() : undefined);
    return { chainId, address, quote: opt(b.quote), pool: opt(b.pool) };
  };

  function startBody(b: Record<string, unknown>) {
    const mode = b.mode === 'live' ? 'live' as const : 'paper' as const;
    return {
      mode, stable: b.stable as string | undefined,
      lowerPrice: Number(b.lowerPrice), upperPrice: Number(b.upperPrice), gridCount: Number(b.gridCount), totalCapitalUsd: Number(b.totalCapitalUsd),
      limits: b.limits as never,
      recenter: typeof b.recenter === 'boolean' ? b.recenter : undefined,
      profits: profitsBody(b.profits),
    };
  }
  /** { mode: 'reinvest' } | { mode: 'send', to } — checked by the grid (checkProfitMode); omitted = keep. */
  function profitsBody(v: unknown): ProfitMode | undefined {
    if (v == null) return undefined;
    const o = v as { mode?: unknown; to?: unknown };
    return o.mode === 'send' ? { mode: 'send', to: String(o.to ?? '').trim() } : o.mode === 'reinvest' ? { mode: 'reinvest' } : (() => { throw new Error('profits must be { mode: "reinvest" } or { mode: "send", to }'); })();
  }
  const limitsBody = (b: Record<string, unknown>) => ({
    ...(b.maxPriceImpact != null && { maxPriceImpact: Number(b.maxPriceImpact) }),
    ...(b.slippageBps != null && { slippageBps: Number(b.slippageBps) }),
    ...(b.deadlineMinutes != null && { deadlineMinutes: Number(b.deadlineMinutes) }),
    // Gas reserve for native-spending markets (flipped HEX/PLS …): share of capital and/or a fixed native amount.
    ...(b.gasReservePct != null && { gasReservePct: Number(b.gasReservePct) }),
    ...(b.gasReserveNative != null && { gasReserveNative: Number(b.gasReserveNative) }),
  });

  // ── Meta / grids (unchanged API) ─────────────────────────────────────
  app.get('/api/health', (_req, res) => res.json({ ok: true, chainId: net.chainId, chains: bot.hub.runtimes().map((r) => r.cfg.id) }));
  app.get('/api/holdings', wrap(async (req) => holdingsSnapshot(bot, fetchJson, req.query.refresh === '1')));
  app.get('/api/bot/meta', (_req, res) => res.json({
    maxGridCount: MAX_GRID_COUNT, densePresets: DENSE_PRESETS, feeBps: net.pulsex.feeBps, presets: listPresets(),
    strategies: STRATEGIES, trendDefaults: DEFAULT_TREND, timeframes: TFS, sweepAxes: SWEEP_AXES,
  }));
  app.get('/api/bot/spacing', (req, res) => {
    const lower = Number(req.query.lower), upper = Number(req.query.upper), n = Number(req.query.grids);
    if (!(lower > 0) || !(upper > lower) || !(n >= 2)) return res.status(400).json({ error: 'need lower, upper, grids' });
    res.json(analyzeSpacing(lower, upper, n));
  });
  app.get('/api/bot/econ', wrap(async (req) => {
    const lower = Number(req.query.lower), upper = Number(req.query.upper), n = Number(req.query.grids), cap = Number(req.query.capital);
    if (!(lower > 0) || !(upper > lower) || !(n >= 2) || !(cap > 0)) throw new Error('need lower, upper, grids, capital');
    return bot.economics(String(req.query.quote ?? net.defaultQuote), { lowerPrice: lower, upperPrice: upper, gridCount: n, totalCapitalUsd: cap });
  }));
  app.get('/api/bot/status', wrap(async () => bot.status()));
  app.get('/api/bot/prices', wrap(async () => ({ prices: await bot.prices() })));
  app.get('/api/bot/presets', (_req, res) => res.json({ presets: listPresets() }));
  app.get('/api/bot/presets/:id/preview', wrap(async (req) => bot.previewPreset(req.params.id, {
    quote: req.query.quote as string | undefined, amounts: amountsParam(req.query.amounts),
  })));
  app.post('/api/bot/presets/:id/start', wrap(async (req) => {
    const b = req.body ?? {};
    const mode = b.mode === 'live' ? 'live' as const : 'paper' as const;
    if (mode === 'live' && !bot.hasSigner) throw new Error(noKey());
    const out = await bot.startPreset(req.params.id, { mode, quote: b.quote, amounts: amountsParam(b.amounts), limits: b.limits, recenter: typeof b.recenter === 'boolean' ? b.recenter : undefined, profits: profitsBody(b.profits) });
    void bot.tickAll();
    return { ok: true, ...out };
  }));
  app.post('/api/bot/grids', wrap(async (req) => { const id = await bot.add(startBody(req.body ?? {})); void bot.tickAll(); return { ok: true, id }; }));
  app.post('/api/bot/grids/:id/start', wrap(async (req) => { await bot.start(req.params.id, startBody(req.body ?? {})); void bot.tickAll(); }));
  app.post('/api/bot/grids/:id/resume', wrap((req) => { bot.resume(req.params.id); void bot.tickAll(); }));
  app.post('/api/bot/grids/:id/stop', wrap((req) => bot.stop(req.params.id)));
  app.post('/api/bot/grids/:id/close', wrap((req) => bot.closeGrid(req.params.id)));
  app.put('/api/bot/grids/:id/limits', wrap((req) => bot.setLimits(req.params.id, limitsBody(req.body ?? {}))));
  app.put('/api/bot/grids/:id/recenter', wrap((req) => bot.setRecenter(req.params.id, req.body?.enabled === true)));
  app.put('/api/bot/grids/:id/profits', wrap((req) => bot.setProfits(req.params.id, profitsBody(req.body) ?? (() => { throw new Error('profits required'); })())));
  app.delete('/api/bot/grids/:id', wrap((req) => bot.remove(req.params.id)));
  app.post('/api/bot/stop-all', wrap(() => bot.stopAll()));
  app.post('/api/bot/close-all', wrap((req) => {
    const raw = req.body?.chainId;
    return bot.closeAll(raw == null || raw === '' ? undefined : Number(raw));
  }));
  app.post('/api/bot/archive-closed', wrap((req) => {
    const raw = req.body?.chainId;
    return bot.archiveClosed(raw == null || raw === '' ? undefined : Number(raw));
  }));

  // ── Chains / custom markets ──────────────────────────────────────────
  app.get('/api/chains', wrap(() => ({
    chains: bot.chainsStatus().map((c) => {
      const cfg = bot.hub.chain(c.id);
      return {
        ...c, stables: cfg.stables, wrappedNative: cfg.wrappedNative, sources: cfg.sources, note: cfg.note ?? null, blockTimeSec: cfg.blockTimeSec,
        dexes: cfg.dexes.map((d) => ({ ...d, tiers: d.kind === 'v3' ? (d.feeTiers ?? []).map(fmtFeeTier) : null })),
      };
    }),
  })));
  app.post('/api/chains/:id/stop', wrap((req) => ({ ok: true, stopped: bot.stopChain(Number(req.params.id)) })));
  app.post('/api/chains/:id/close', wrap((req) => bot.closeAll(Number(req.params.id))));
  app.post('/api/tokens/inspect', wrap(async (req) => plain(await bot.hub.inspect(marketReq(req.body ?? {})))));
  app.get('/api/markets', wrap(() => ({ markets: bot.marketList() })));

  // ── Opportunities (daily scan) ───────────────────────────────────────
  const scanner = () => { if (!o.scanner) throw new Error('The daily scan is off (CANDLES_GECKO=off).'); return o.scanner; };
  app.get('/api/opportunities', wrap(() => scanner().status()));
  // { testUsd } = test size in USD (checked here so a bad value is an error, not a silently failed background scan).
  app.post('/api/opportunities/scan', wrap((req) => {
    const sc = scanner();
    const usd = req.body?.testUsd == null ? undefined : checkTestUsd(req.body.testUsd);
    void sc.run(usd).catch(() => undefined);
    return { ok: true };
  }));
  app.post('/api/opportunities/use', wrap(async (req) => {
    const b = req.body ?? {};
    const key = await bot.addOpportunityMarket({ chainId: Number(b.chainId), address: String(b.address ?? ''), quote: String(b.quote ?? ''), pool: String(b.pool ?? '') });
    void bot.tickAll();
    return { ok: true, key };
  }));
  app.post('/api/markets', wrap(async (req) => { const d = await bot.addMarket(marketReq(req.body ?? {})); void bot.tickAll(); return plain({ ok: true, market: d }); }));
  // Pair search: pools on the app's DEXes for what was typed (chain = a chain id, or all); picking one adds it once it passes the safety check
  app.get('/api/pools/search', wrap(async (req) => {
    if (!o.poolSearch) throw new Error('pair search is not available');
    const chain = String(req.query.chain ?? 'all');
    const ids = chain === 'all' ? bot.hub.runtimes().map((r) => r.cfg.id) : [Number(chain)];
    return plain({ pools: await o.poolSearch.search(String(req.query.q ?? ''), ids) });
  }));
  app.post('/api/markets/pool', wrap(async (req) => {
    const b = req.body ?? {};
    const key = await bot.addPoolMarket({ chainId: Number(b.chainId), pool: String(b.pool ?? ''), base: String(b.base ?? ''), quote: String(b.quote ?? '') });
    void bot.tickAll();
    return { ok: true, key };
  }));
  app.post('/api/markets/:key/recheck', wrap(async (req) => plain({ ok: true, safety: await bot.recheckMarket(req.params.key) })));
  app.delete('/api/markets/:key', wrap((req) => { bot.removeMarket(req.params.key); return { ok: true }; }));
  // Pool selection: every pool for the pair across the chain's DEXes (PulseChain: PulseX V1/V2 + 9mm V2/V3), ranked by quote
  app.get('/api/markets/:key/pools', wrap(async (req) => plain(await bot.poolOptions(req.params.key))));
  app.put('/api/markets/:key/pool', wrap(async (req) => {
    const b = (req.body ?? {}) as { pool?: unknown; auto?: unknown; reset?: unknown };
    const sel = { pool: typeof b.pool === 'string' ? b.pool : undefined, auto: b.auto === true, reset: b.reset === true };
    if ([!!sel.pool, sel.auto, sel.reset].filter(Boolean).length !== 1) throw new Error('Send exactly one of { pool: "0x…" }, { auto: true }, { reset: true }');
    if (sel.pool && !/^0x[0-9a-fA-F]{40}$/.test(sel.pool)) throw new Error('pool must be a 0x address');
    return plain({ ok: true, market: await bot.setMarketPool(req.params.key, sel) });
  }));
  // Back-compat aliases (single-grid era)
  app.post('/api/bot/start', wrap(async (req) => { const id = await bot.add(startBody(req.body ?? {})); void bot.tickAll(); return { ok: true, id }; }));
  // Single-grid era alias. It used to stop every bot with an empty body; now it stops one bot ({ id }) and stops all
  // only with an explicit { all: true }. Like every host route it answers loopback only (phones: owner login).
  app.post('/api/bot/stop', wrap((req) => {
    const b = (req.body ?? {}) as { id?: unknown; all?: unknown };
    if (b.all === true) { bot.stopAll(); return { ok: true, stopped: 'all' }; }
    if (typeof b.id === 'string' && b.id) return { ok: true, stopped: bot.stopById(b.id) };
    throw new Error('Send { "id": "<bot id>" } to stop one bot, or { "all": true } to stop every bot.');
  }));
  app.post('/api/bot/resume', wrap(() => {
    const g = bot.status().grids.find((x) => x.config && x.status !== 'running');
    if (!g) throw new Error('No stopped grid to resume');
    bot.resume(g.id);
    void bot.tickAll();
  }));

  // ── Trend bots ───────────────────────────────────────────────────────
  app.post('/api/bot/trends', wrap(async (req) => {
    const b = req.body ?? {};
    const mode = b.mode === 'live' ? 'live' as const : 'paper' as const;
    const quote = String(b.quote ?? net.defaultQuote);
    const id = await bot.addTrend({ mode, quote, tf: String(b.tf ?? '1h') as never, cfg: b.cfg ?? {}, capital: num(b.capital) ?? 0, name: b.name, limits: b.limits });
    void bot.tickAll();
    return { ok: true, id };
  }));
  app.post('/api/bot/trends/:id/resume', wrap((req) => { bot.resumeTrend(req.params.id); void bot.tickAll(); }));
  app.post('/api/bot/trends/:id/stop', wrap((req) => bot.stopTrend(req.params.id)));
  app.post('/api/bot/trends/:id/sell', wrap((req) => bot.sellTrend(req.params.id)));
  app.post('/api/bot/trends/:id/close', wrap((req) => bot.closeTrend(req.params.id)));
  app.put('/api/bot/trends/:id/limits', wrap((req) => bot.setTrendLimits(req.params.id, limitsBody(req.body ?? {}))));
  app.put('/api/bot/trends/:id/lines', wrap((req) => bot.setTrendLines(req.params.id, req.body?.lines)));
  app.delete('/api/bot/trends/:id', wrap((req) => bot.removeTrend(req.params.id)));

  // ── Liquidity bots (V3 positions) ────────────────────────────────────
  app.post('/api/bot/lps', wrap(async (req) => {
    const b = req.body ?? {};
    const id = await bot.addLp({
      mode: b.mode === 'live' ? 'live' : 'paper', market: String(b.market ?? ''), bandPct: Number(b.bandPct), capital: Number(b.capital ?? 0),
      baseAmount: b.baseAmount == null ? undefined : Number(b.baseAmount),
      rerange: typeof b.rerange === 'boolean' ? b.rerange : undefined, profits: profitsBody(b.profits), limits: b.limits ? limitsBody(b.limits) : undefined,
    });
    void bot.tickAll();
    return { ok: true, id };
  }));
  app.post('/api/bot/lps/:id/resume', wrap((req) => { bot.resumeLp(req.params.id); void bot.tickAll(); }));
  app.post('/api/bot/lps/:id/stop', wrap((req) => bot.stopLp(req.params.id)));
  app.post('/api/bot/lps/:id/close', wrap((req) => bot.closeLp(req.params.id)));
  app.put('/api/bot/lps/:id/rerange', wrap((req) => bot.setLpRerange(req.params.id, req.body?.enabled === true)));
  // { bandPct? }: move the range to the price now (a new width, or the same one)
  app.post('/api/bot/lps/:id/move', wrap(async (req) => {
    const b = req.body?.bandPct;
    await bot.moveLp(req.params.id, b == null ? undefined : Number(b));
    void bot.tickAll();
    return { ok: true };
  }));
  app.put('/api/bot/lps/:id/profits', wrap((req) => bot.setLpProfits(req.params.id, profitsBody(req.body) ?? (() => { throw new Error('profits required'); })())));
  app.delete('/api/bot/lps/:id', wrap((req) => bot.removeLp(req.params.id)));
  app.get('/api/lp/replay', wrap((req) => {
    if (!o.lpReplay) throw new Error('replay not available');
    const capital = num(req.query.capital), maxImpact = num(req.query.maxImpact);
    if (capital != null && !(capital > 0)) throw new Error('capital must be > 0');
    if (maxImpact != null && !(maxImpact > 0 && maxImpact < 1)) throw new Error('maxImpact must be between 0 and 1');
    return o.lpReplay({ market: String(req.query.market ?? ''), capital: capital ?? undefined, maxImpact: maxImpact ?? undefined });
  }));

  // ── Convert: a chain's holdings into one coin ─────────────────────────
  const cv = () => { if (!o.convert) throw new Error('converting is not available'); return o.convert; };
  app.get('/api/convert/targets', wrap((req) => ({ targets: cv().targets(Number(req.query.chainId)) })));
  app.post('/api/convert/plan', wrap((req) => {
    const b = req.body ?? {};
    return cv().plan({ chainId: Number(b.chainId), target: String(b.target ?? ''), keepNative: num(b.keepNative), maxImpact: num(b.maxImpact) });
  }));
  app.post('/api/convert/run', wrap((req) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.coins)) throw new Error('coins required');
    return { job: cv().run(String(b.planId ?? ''), b.coins.map(String)) };
  }));
  app.get('/api/convert/job', wrap(() => ({ job: cv().job() })));
  app.post('/api/convert/stop', wrap(() => { cv().stop(); return { ok: true }; }));

  // Host only. A friend's copy and a request that arrived through Tailscale Funnel never quote.
  // Live mode returns calldata; this route never broadcasts it.
  app.post('/api/swap/quote', wrap(async (req) => {
    if (o.copy || !o.swap || viaFunnel(req.headers, req.socket.remoteAddress)) throw new Error('swap quoting is host-only');
    const b = req.body ?? {};
    if (typeof b.amountIn !== 'string' || !/^\d+$/.test(b.amountIn)) throw new Error('amountIn must be a decimal string of raw units');
    return plain(await o.swap.quote({
      chainId: Number(b.chainId), tokenIn: String(b.tokenIn ?? ''), tokenOut: String(b.tokenOut ?? ''),
      amountIn: BigInt(b.amountIn), owner: String(b.owner ?? ''),
      recipient: typeof b.recipient === 'string' ? b.recipient : undefined,
      mode: b.mode === 'live' ? 'live' : 'paper',
      slippageBps: num(b.slippageBps), deadlineMinutes: num(b.deadlineMinutes), maxPriceImpact: num(b.maxPriceImpact),
    }));
  }));

  // ── Smart trader ────────────────────────────────────────────────────
  const ap = () => { if (!o.autopilot) throw new Error('The smart trader is not available.'); return o.autopilot; };
  app.get('/api/autopilot', wrap(() => plain(ap().status())));
  // { mode, options, budgets: [{ chainId, coin, amount }] } (while it is off)
  app.put('/api/autopilot', wrap((req) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.budgets)) throw new Error('budgets required');
    ap().configure({ mode: b.mode, options: (b.options ?? {}) as Partial<AutoOptions>, budgets: b.budgets as Budget[] });
    return plain(ap().status());
  }));
  app.put('/api/autopilot/options', wrap((req) => { ap().setOptions(req.body ?? {}); return plain(ap().status()); }));
  app.post('/api/autopilot/on', wrap(async () => { await ap().turnOn(); void bot.tickAll(); return plain(ap().status()); }));
  // { chainId }: that budget sends again after KILL ALL / STOP chain
  app.post('/api/autopilot/carry-on', wrap((req) => { ap().carryOn(Number(req.body?.chainId)); void ap().tick(); return plain(ap().status()); }));
  // { sell: true } closes every bot it runs to cash; false leaves them running unmanaged
  app.post('/api/autopilot/off', wrap((req) => { ap().turnOff(req.body?.sell === true); void ap().tick(); return plain(ap().status()); }));
  // { chainId }: that budget opens and swaps again after Stop all / STOP chain
  app.post('/api/autopilot/review', wrap(async () => { await ap().review(true); void bot.tickAll(); return plain(ap().status()); }));

  const tt = () => { if (!o.tokenTrader) throw new Error('The token trader is not available.'); return o.tokenTrader; };
  app.get('/api/token-trader', wrap(() => plain(tt().status())));
  app.put('/api/token-trader', wrap((req) => {
    const b = req.body ?? {};
    const patch: Partial<TraderOptions> = {};
    if (b.mode === 'paper' || b.mode === 'live') patch.mode = b.mode;
    for (const k of ['perTradeUsd', 'totalUsd', 'minPoolAgeSec', 'maxImpact', 'maxPoolShare', 'sizeImpactCap'] as const) if (b[k] != null) patch[k] = Number(b[k]);
    if (typeof b.enforceSizeImpact === 'boolean') patch.enforceSizeImpact = b.enforceSizeImpact;
    if (b.risk === 'safe' || b.risk === 'medium' || b.risk === 'any') patch.risk = b.risk;
    if (Array.isArray(b.chains)) patch.chains = b.chains.map(Number);
    if (b.sniper && typeof b.sniper === 'object') patch.sniper = b.sniper;
    tt().configure(patch);
    return plain(tt().status());
  }));
  app.post('/api/token-trader/on', wrap(() => { tt().turnOn(); void tt().tick(); return plain(tt().status()); }));
  app.post('/api/token-trader/off', wrap(() => { tt().turnOff(); return plain(tt().status()); }));

  // ── Capital router (settings only; this does not move funds) ──
  const router = () => { if (!o.router) throw new Error('The capital router is not available.'); return o.router; };
  app.get('/api/router', wrap(() => router().status()));
  app.put('/api/router', wrap((req) => router().update(req.body ?? {})));
  app.post('/api/router/on', wrap(() => router().turnOn()));
  app.post('/api/router/off', wrap(() => router().turnOff()));
  // After Stop all / STOP chain: new buys and snipes may happen again
  app.post('/api/token-trader/resume-entries', wrap(() => { tt().resumeEntries(); return plain(tt().status()); }));

  // ── Friends' copies: the host's Tools → Friends, and the relay the copies fetch candles through ─────
  app.get('/api/host/gecko', wrap(async (req, res) => {
    if (!o.relay) throw new Error('Only the host app relays GeckoTerminal.');
    const a = await o.relay.get(String(req.query.url ?? ''));
    if (a.status === 200) return a.body;
    res.status(a.status).json(a.status === 429 ? { error: 'GeckoTerminal is busy; try again later.', retryAt: a.retryAt } : { error: a.error });
  }));
  const fh = (): FriendsHost => {
    if (!o.friends) throw new Error('Friends\' copies are run by the host app.');
    if ('off' in o.friends) throw new Error(o.friends.off);
    return o.friends;
  };
  app.get('/api/friends', wrap(() => (o.friends && 'off' in o.friends ? { on: false, off: o.friends.off } : { on: true, ...fh().view() })));
  app.put('/api/friends/host', wrap((req) => {
    const b = req.body ?? {};
    fh().setHost({ name: b.name == null ? undefined : String(b.name), address: b.address == null ? undefined : String(b.address) });
  }));
  app.post('/api/friends/invites', wrap((req) => fh().invite(String(req.body?.name ?? ''))));
  app.delete('/api/friends/invites/:id', wrap((req) => fh().cancelInvite(req.params.id)));
  app.post('/api/friends/:id/reset', wrap((req) => fh().resetLink(req.params.id)));
  app.post('/api/friends/:id/start', wrap((req) => fh().startCopy(req.params.id)));
  app.post('/api/friends/:id/stop', wrap((req) => fh().stopCopy(req.params.id)));
  app.post('/api/friends/:id/restart', wrap((req) => fh().restartCopy(req.params.id)));
  app.delete('/api/friends/:id', wrap((req) => fh().remove(req.params.id)));

  // ── System: version + self-test ───────────────────────────────────────
  if (o.system) {
    const { version, pollMs } = o.system;
    app.get('/api/system/version', wrap((req) => {
      if (!version) throw new Error('This copy is kept up to date by the app that runs it.');
      return version.report(req.query.refresh === '1');
    }));
    app.get('/api/system/check', wrap(() => runChecks({
      version: version ? () => version.report(true) : null,
      status: async () => { await bot.refreshWallet(true); return plain(bot.status()); },
      probeChain: async (id) => { const t0 = Date.now(); await bot.hub.rt(id).reader.getFeeData(); return Date.now() - t0; },
      probeMarket: async (k) => { await bot.hub.quoter(k).market(); },
      scan: o.scanner ? async () => (await o.scanner!.status()) as Record<string, unknown> : null,
      pollMs,
    })));
  }

  // ── Candles / market ─────────────────────────────────────────────────
  app.get('/api/market/candles', wrap((req) => {
    const pair = String(req.query.pair ?? net.defaultQuote), tf = String(req.query.tf ?? '1h');
    if (!isTF(tf)) throw new Error('unknown timeframe');
    const candles = bot.candleSeries(pair, tf, num(req.query.from), num(req.query.to), Math.min(5000, num(req.query.limit) ?? 1500));
    o.viewCandles?.(pair);
    return { pair, tf, candles, meta: bot.candles.getMeta(pair, tf) };
  }));
  app.get('/api/market/summary', wrap(() => ({ series: bot.candles.summary(bot.watchedKeys(true)), sync: bot.status().candleSync })));
  app.get('/api/market/panels', wrap(async (req) => ({ panels: plain(await bot.markets(num(req.query.chainId))) })));
  app.get('/api/market/panel', wrap(async (req) => plain(await bot.marketPanel(String(req.query.pair ?? net.defaultQuote)))));
  app.get('/api/market/panel/:pair', wrap(async (req) => plain(await bot.marketPanel(req.params.pair))));
  app.post('/api/market/backfill', wrap(async (req) => {
    if (!o.backfill) throw new Error('backfill not available');
    const b = req.body ?? {};
    const source = b.source === 'onchain' ? 'onchain' : 'gecko';
    const days = Math.min(180, Math.max(1, Number(b.days ?? 30)));
    void o.backfill(String(b.pair ?? net.defaultQuote), source, days).catch(() => undefined);
    return { ok: true, started: true };
  }));

  // ── Backtests ────────────────────────────────────────────────────────
  app.post('/api/backtest/trend', wrap(async (req) => bot.backtest(req.body ?? {})));
  app.post('/api/backtest/grid', wrap(async (req) => {
    const b = req.body ?? {};
    return bot.backtestGrid({ ...b, lowerPrice: Number(b.lowerPrice), upperPrice: Number(b.upperPrice), gridCount: Number(b.gridCount) });
  }));
  app.post('/api/backtest/sweep', wrap(async (req) => bot.sweep(req.body ?? {})));

  // ── Analytics / alerts ───────────────────────────────────────────────
  // Analytics are for one mode at a time: live is real money, paper is simulated, and they are never added together.
  const modeOf = (q: Request['query']): Mode => {
    if (q.mode !== 'live' && q.mode !== 'paper') throw new Error('mode must be live or paper');
    return q.mode;
  };
  app.get('/api/analytics/overview', wrap((req) => bot.overview(modeOf(req.query))));
  const jFilter = (q: Request['query']) => ({
    mode: modeOf(q), botId: q.botId as string | undefined, kind: q.kind as string | undefined, pair: q.pair as string | undefined,
    side: q.side as string | undefined, from: num(q.from), to: num(q.to),
  });
  app.get('/api/analytics/journal', wrap((req) => {
    const rows = bot.journal(jFilter(req.query));
    return { total: rows.length, rows: rows.slice(0, Math.min(2000, num(req.query.limit) ?? 500)) };
  }));
  app.get('/api/analytics/journal.csv', (req, res) => {
    let rows;
    try { rows = bot.journal(jFilter(req.query)); } catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="journal-${req.query.mode}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(MultiBot.journalCsv(rows));
  });
  app.get('/api/alerts', wrap(() => ({ alerts: bot.listAlerts() })));
  app.post('/api/alerts', wrap((req) => bot.addAlert(req.body ?? {})));
  app.put('/api/alerts/:id', wrap((req) => bot.updateAlert(req.params.id, req.body ?? {})));
  app.delete('/api/alerts/:id', wrap((req) => bot.removeAlert(req.params.id)));
  app.get('/api/activity', wrap((req) => ({ events: bot.activity.recent(Math.min(400, num(req.query.n) ?? 100), num(req.query.since) ?? 0) })));

  // ── SSE: activity + ticks + status pushes ────────────────────────────
  // The status is computed once per push for all clients (StatusFeed). v1 (no ?v): the whole status, as before.
  // v2 (?v=2): a snapshot in hello, then only what changed (docs/stream-v2.md), plus an hb event the UI watches.
  const feed = new StatusFeed(() => bot.status(), o.statusThrottleMs ?? 1000);
  const poke = () => feed.poke();
  const pokeAct = (e: ActivityEvent) => { if (e.type !== 'tick' && e.type !== 'candles') poke(); };
  let clients = 0;
  // The feed listens only while a client is connected.
  const join = () => { if (clients++ === 0) { bot.activity.on('status', poke); bot.activity.on('activity', pokeAct); } };
  const leave = () => { if (--clients === 0) { bot.activity.off('status', poke); bot.activity.off('activity', pokeAct); feed.stop(); } };
  app.get('/api/bot/stream', (req, res) => {
    const v2 = String(req.query.v ?? '') === '2';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const since = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;
    const hbMs = o.heartbeatMs ?? (v2 ? 5_000 : 15_000);
    if (v2) {
      const { seq, status } = feed.snapshot();
      send('hello', { v: 2, t: Date.now(), network: net.key, recent: bot.activity.recent(100, since), epoch: feed.epoch, seq, status, hbMs });
    } else send('hello', { t: Date.now(), network: net.key, recent: bot.activity.recent(100, since) });
    join();
    const off = v2
      ? feed.onPatch((p) => send('patch', p))
      : feed.onFull((s) => { try { send('status', s); } catch { /* ignore */ } });
    const onAct = (e: ActivityEvent) => { res.write(`id: ${e.id}\n`); send('activity', e); };
    const onTicks = (t: unknown) => send('ticks', t);
    bot.activity.on('activity', onAct);
    bot.activity.on('ticks', onTicks);
    const hb = setInterval(() => (v2 ? send('hb', { t: Date.now(), seq: feed.seq, epoch: feed.epoch }) : res.write(`: hb ${Date.now()}\n\n`)), hbMs);
    req.on('close', () => {
      clearInterval(hb);
      off();
      leave();
      bot.activity.off('activity', onAct);
      bot.activity.off('ticks', onTicks);
    });
  });

  return app;
}
