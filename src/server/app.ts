/**
 * Express app factory (no listening, no env access): REST API + SSE stream. index.ts wires env, signer,
 * provider and the poll loop; tests build an app around a MultiBot on a mock chain.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { MultiBot } from './bot/multi';
import type { ActivityEvent } from './bot/activity';
import { analyzeSpacing, DENSE_PRESETS, MAX_GRID_COUNT } from '../live/spacing';
import { listPresets } from '../live/presets';
import { DEFAULT_TREND, STRATEGIES } from '../market/strategy';
import { SWEEP_AXES } from '../market/backtest';
import { TFS, isTF } from '../market/candles';
import type { LiveNetwork } from '../live/networks';
import { fmtFeeTier } from '../live/chains';

export interface AppOpts {
  bot: MultiBot;
  net: LiveNetwork;
  /** Background candle backfill (server only) */
  backfill?: (pair: string, source: 'gecko' | 'onchain', days: number) => Promise<unknown>;
  heartbeatMs?: number;
  statusThrottleMs?: number;
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
    next();
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
      // Paper-only override; live starts are hard-blocked by the engine's economics gate regardless.
      allowTightSpacing: mode === 'paper' && !!b.allowTightSpacing,
    };
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
    quote: req.query.quote as string | undefined, capitalUsd: num(req.query.capitalUsd),
  })));
  app.post('/api/bot/presets/:id/start', wrap(async (req) => {
    const b = req.body ?? {};
    const mode = b.mode === 'live' ? 'live' as const : 'paper' as const;
    if (mode === 'live' && !bot.hasSigner) throw new Error('Live mode needs PRIVATE_KEY in .env');
    const out = await bot.startPreset(req.params.id, { mode, quote: b.quote, capitalUsd: num(b.capitalUsd), allowTightSpacing: mode === 'paper' && !!b.allowTightSpacing, limits: b.limits });
    void bot.tickAll();
    return { ok: true, ...out };
  }));
  app.post('/api/bot/grids', wrap(async (req) => { const id = await bot.add(startBody(req.body ?? {})); void bot.tickAll(); return { ok: true, id }; }));
  app.post('/api/bot/grids/:id/start', wrap(async (req) => { await bot.start(req.params.id, startBody(req.body ?? {})); void bot.tickAll(); }));
  app.post('/api/bot/grids/:id/resume', wrap((req) => { bot.resume(req.params.id); void bot.tickAll(); }));
  app.post('/api/bot/grids/:id/stop', wrap((req) => bot.stop(req.params.id)));
  app.put('/api/bot/grids/:id/limits', wrap((req) => bot.setLimits(req.params.id, limitsBody(req.body ?? {}))));
  app.delete('/api/bot/grids/:id', wrap((req) => bot.remove(req.params.id)));
  app.post('/api/bot/stop-all', wrap(() => bot.stopAll()));

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
  app.post('/api/tokens/inspect', wrap(async (req) => plain(await bot.hub.inspect(marketReq(req.body ?? {})))));
  app.get('/api/markets', wrap(() => ({ markets: bot.marketList() })));
  app.post('/api/markets', wrap(async (req) => { const d = await bot.addMarket(marketReq(req.body ?? {})); void bot.tickAll(); return plain({ ok: true, market: d }); }));
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
  app.post('/api/bot/stop', wrap(() => bot.stopAll()));
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
    let capital = num(b.capital);
    if (!(capital! > 0) && num(b.capitalUsd)) {
      const k = bot.usdPerQuote(quote);
      if (!k) throw new Error(`No USD rate for ${quote} yet — pass capital in ${quote}`);
      capital = num(b.capitalUsd)! / k;
    }
    const id = await bot.addTrend({ mode, quote, tf: String(b.tf ?? '1h') as never, cfg: b.cfg ?? {}, capital: capital ?? 0, name: b.name, limits: b.limits });
    void bot.tickAll();
    return { ok: true, id };
  }));
  app.post('/api/bot/trends/:id/resume', wrap((req) => { bot.resumeTrend(req.params.id); void bot.tickAll(); }));
  app.post('/api/bot/trends/:id/stop', wrap((req) => bot.stopTrend(req.params.id)));
  app.post('/api/bot/trends/:id/close', wrap((req) => { bot.closeTrend(req.params.id); void bot.tickAll(); }));
  app.put('/api/bot/trends/:id/limits', wrap((req) => bot.setTrendLimits(req.params.id, limitsBody(req.body ?? {}))));
  app.delete('/api/bot/trends/:id', wrap((req) => bot.removeTrend(req.params.id)));

  // ── Candles / market ─────────────────────────────────────────────────
  app.get('/api/market/candles', wrap((req) => {
    const pair = String(req.query.pair ?? net.defaultQuote), tf = String(req.query.tf ?? '1h');
    if (!isTF(tf)) throw new Error('unknown timeframe');
    const candles = bot.candleSeries(pair, tf, num(req.query.from), num(req.query.to), Math.min(5000, num(req.query.limit) ?? 1500));
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
  app.get('/api/analytics/overview', wrap(() => bot.overview()));
  const jFilter = (q: Request['query']) => ({
    botId: q.botId as string | undefined, kind: q.kind as string | undefined, pair: q.pair as string | undefined,
    side: q.side as string | undefined, mode: q.mode as string | undefined, from: num(q.from), to: num(q.to),
  });
  app.get('/api/analytics/journal', wrap((req) => {
    const rows = bot.journal(jFilter(req.query));
    return { total: rows.length, rows: rows.slice(0, Math.min(2000, num(req.query.limit) ?? 500)) };
  }));
  app.get('/api/analytics/journal.csv', (req, res) => {
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="journal-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(MultiBot.journalCsv(bot.journal(jFilter(req.query))));
  });
  app.get('/api/alerts', wrap(() => ({ alerts: bot.listAlerts() })));
  app.post('/api/alerts', wrap((req) => bot.addAlert(req.body ?? {})));
  app.put('/api/alerts/:id', wrap((req) => bot.updateAlert(req.params.id, req.body ?? {})));
  app.delete('/api/alerts/:id', wrap((req) => bot.removeAlert(req.params.id)));
  app.get('/api/activity', wrap((req) => ({ events: bot.activity.recent(Math.min(400, num(req.query.n) ?? 100), num(req.query.since) ?? 0) })));

  // ── SSE: activity + ticks + status pushes ────────────────────────────
  app.get('/api/bot/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const since = Number(req.headers['last-event-id'] ?? req.query.since ?? 0) || 0;
    send('hello', { t: Date.now(), network: net.key, recent: bot.activity.recent(100, since) });
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStatus = 0;
    const pushStatus = () => {
      if (statusTimer) return;
      const wait = Math.max(0, (o.statusThrottleMs ?? 1000) - (Date.now() - lastStatus));
      statusTimer = setTimeout(() => {
        statusTimer = null; lastStatus = Date.now();
        try { send('status', bot.status()); } catch { /* ignore */ }
      }, wait);
    };
    const onAct = (e: ActivityEvent) => { res.write(`id: ${e.id}\n`); send('activity', e); if (e.type !== 'tick' && e.type !== 'candles') pushStatus(); };
    const onTicks = (t: unknown) => send('ticks', t);
    bot.activity.on('activity', onAct);
    bot.activity.on('ticks', onTicks);
    bot.activity.on('status', pushStatus);
    const hb = setInterval(() => res.write(`: hb ${Date.now()}\n\n`), o.heartbeatMs ?? 15_000);
    req.on('close', () => {
      clearInterval(hb);
      if (statusTimer) clearTimeout(statusTimer);
      bot.activity.off('activity', onAct);
      bot.activity.off('ticks', onTicks);
      bot.activity.off('status', pushStatus);
    });
  });

  return app;
}
