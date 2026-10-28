/**
 * Replay the bots saved in the app state and print net token units per day.
 * Reads data/state.json (or --state). Does not load the process environment and does not sign anything.
 *
 *   npm run backtest:harness
 *   npm run backtest:harness -- --state data/state.json --md out.md --json out.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CHAINS } from '../src/live/chains';
import { invertCandles, loadCandles, readGasPrice, readV3Pool, type FetchLike } from '../src/backtest/adapters';
import { discoverPool } from '../src/backtest/pools';
import { aggregateModel, fittedModel, recordedSource, renderMarkdown, sourceLabel, summaryJson, type RunWindow } from '../src/backtest/report';
import { runBot, type BotConfig, type HarnessData } from '../src/backtest/run';
import { blockReason, calibrateBot, calibrationMarkdown, loadAppState, pairLabel, recordedPerDay, replayExit, splitByMode, whatIfMarkdown, type BotMode, ZERO_REPLAY_WARNING } from '../src/backtest/state';

const DAY = 86_400;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fetchFn: FetchLike = async (url, init) => {
  const r = await fetch(url, {
    method: init?.method,
    body: init?.body,
    headers: { 'user-agent': 'pulsechain-grid-bot', accept: 'application/json', ...(init?.headers ?? {}) },
  });
  return { ok: r.ok, status: r.status, json: () => r.json() };
};

function rpcFor(chain: BotConfig['chain']): string {
  const c = CHAINS.find((x) => x.key === chain);
  if (!c?.rpcs.length) throw new Error(`no public node for ${chain}`);
  return c.rpcs[0];
}

async function resolvePool(cfg: BotConfig, cacheDir: string): Promise<BotConfig> {
  if (!blockReason(cfg)) return cfg;
  const found = await discoverPool(cfg, rpcFor(cfg.chain), cacheDir, fetchFn);
  if (!found) return cfg;
  return { ...cfg, ...found };
}

async function loadMarket(cfg: BotConfig, from: number, to: number, cacheDir: string): Promise<{ data: HarnessData; cfg: BotConfig }> {
  if (!cfg.pool) throw new Error('no pool address on this bot');
  const base = cfg.base.address;
  if (!base) throw new Error('no base token on this bot');
  const source = (arg('--source') as 'gecko' | 'dexscreener' | 'auto' | undefined) ?? 'auto';
  // A couple of days of hourly closes step out of a ±1% band more often than the live bot moved. Fifteen-minute
  // bars cover that window in one page; longer windows stay hourly.
  const barMinutes = to - from <= 14 * 86_400 ? 15 : 60;
  const candleArgs = { chain: cfg.chain, pool: cfg.pool, from, to, source, cacheDir, fetchFn, barMinutes };
  let candles;
  try {
    candles = (await loadCandles({ ...candleArgs, baseToken: base })).candles;
  } catch (e) {
    // A flipped pair is quoted the other way by the candle source. Invert that series into this bot's prices.
    if (!cfg.quote.address) throw e;
    candles = invertCandles((await loadCandles({ ...candleArgs, baseToken: cfg.quote.address })).candles);
  }
  const rpc = rpcFor(cfg.chain);
  const pool = await readV3Pool(cfg.pool, rpc, cacheDir, fetchFn).catch(() => null);
  const gas = await readGasPrice(rpc, cacheDir, fetchFn).catch(() => 0);
  if (cfg.kind === 'lp' && !(pool && Number(pool.liquidity) > 0)) throw new Error('pool liquidity was not read');
  const liq = pool ? Number(pool.liquidity) : 0;
  const price = candles.length ? candles[candles.length - 1].c : 0;
  const quotePerNative = cfg.gasToken === 'quote' ? 1 : (cfg.quotePerNative ?? (price > 0 ? price : 1));
  const onChain: HarnessData['onChain'] = [];
  if (pool) {
    onChain.push(
      { label: 'Pool fee tier', value: pool.fee, source: 'onchain' },
      { label: 'Active liquidity', value: liq, source: 'onchain' },
    );
  }
  if (gas > 0) onChain.push({ label: 'Current gas price', value: gas, unit: 'native per gas', source: 'onchain' });
  const data: HarnessData = { candles, poolLiquidity: liq > 0 ? liq : undefined, onChain };
  const next: BotConfig = {
    ...cfg,
    feeTier: cfg.feeTier ?? pool?.fee,
    feeBps: cfg.feeBps || (pool ? pool.fee / 100 : cfg.feeBps),
    gasPriceNative: cfg.gasPriceNative ?? gas,
    quotePerNative,
    spacing: cfg.spacing ?? pool?.tickSpacing,
    baseIs0: pool && cfg.base.address ? pool.token0.toLowerCase() === cfg.base.address.toLowerCase() : cfg.baseIs0,
  };
  return { data, cfg: next };
}

interface OutRow {
  id: string;
  mode: BotMode;
  pair: string;
  unit: string;
  recordedSource: ReturnType<typeof recordedSource>;
  recordedLabel: string;
  replaySource: 'modeled';
  replayLabel: 'fitted model';
  recordedPerDay: number | null;
  replayedPerDay: number | null;
  netError: number | null;
  movesError: number | null;
  calibrated: boolean;
  model: ReturnType<typeof fittedModel>;
  skip?: string;
  summary?: unknown;
  calibration?: unknown;
  lines: string[];
}

async function main() {
  const statePath = resolve(arg('--state') ?? 'data/state.json');
  const cacheDir = resolve(arg('--cache') ?? 'data/backtest-cache');
  const loaded = loadAppState(statePath);
  const now = Math.floor(Date.now() / 1000);
  const fromArg = arg('--from');
  const toArg = arg('--to');
  const rows: OutRow[] = [];
  let replayed = 0;

  const shell = (bot: (typeof loaded.bots)[number], model: ReturnType<typeof fittedModel>, lines: string[], extra?: Partial<OutRow>): OutRow => ({
    id: bot.id,
    mode: bot.mode,
    pair: pairLabel(bot.config),
    unit: bot.config.quote.symbol,
    recordedSource: recordedSource(bot.mode),
    recordedLabel: sourceLabel(recordedSource(bot.mode)),
    replaySource: 'modeled',
    replayLabel: 'fitted model',
    recordedPerDay: recordedPerDay(bot),
    replayedPerDay: null,
    netError: null,
    movesError: null,
    calibrated: false,
    model,
    lines,
    ...extra,
  });

  for (const bot of loaded.bots) {
    const span = bot.window
      ?? (bot.fills.length
        ? { from: Math.min(...bot.fills.map((f) => f.t)), to: Math.max(...bot.fills.map((f) => f.t)) + 3600 }
        : { from: now - 30 * DAY, to: now });
    const from = fromArg ? Number(fromArg) : span.from;
    const to = toArg ? Number(toArg) : span.to;
    let cfg = bot.config;
    let data: HarnessData | null = null;
    try {
      cfg = await resolvePool(cfg, cacheDir);
      const why = blockReason(cfg);
      if (why) {
        rows.push(shell(bot, fittedModel(false, null, false), [`${pairLabel(bot.config)} ${bot.id} (${bot.mode}): not replayed (${why}) (fitted model).`], { skip: why }));
        continue;
      }
      const market = await loadMarket(cfg, from, to, cacheDir);
      data = market.data;
      cfg = market.cfg;
      if (bot.depth) data.poolDepth = bot.depth;
    } catch (e) {
      const reason = `replay did not run (${(e as Error).message})`;
      rows.push(shell(bot, fittedModel(false, null, false), [`${pairLabel(bot.config)} ${bot.id} (${bot.mode}): not replayed (${reason}) (fitted model).`], { skip: reason }));
      continue;
    }
    replayed++;
    const cal = calibrateBot({ ...bot, config: cfg }, data);
    const summary = runBot(cal.config, data);
    const model = fittedModel(cal.fitted, cal.netError, cal.calibrated);
    const w: RunWindow = { from, to, inSample: cal.fitted };
    rows.push(shell(bot, model, [renderMarkdown([summary], w).trimEnd(), calibrationMarkdown(cal)], {
      recordedPerDay: cal.recordedPerDay,
      replayedPerDay: cal.replayedPerDay,
      netError: cal.netError,
      movesError: cal.movesError,
      calibrated: cal.calibrated,
      summary: summaryJson([summary], w, model).bots[0],
      calibration: {
        botId: cal.botId, fitted: cal.fitted, feeK: cal.feeK, slippageBps: cal.slippageBps,
        dwellMs: cal.config.dwellMs ?? 0,
        recordedPerDay: cal.recordedPerDay, replayedPerDay: cal.replayedPerDay,
        netError: cal.netError, movesError: cal.movesError, calibrated: cal.calibrated,
        error: cal.error, note: cal.note,
      },
    }));
  }

  const { live, paper } = splitByMode(rows);
  const ordered = [...live, ...paper];
  const blocks: string[] = [loaded.note, ''];
  const writeSection = (title: string, list: OutRow[]) => {
    blocks.push(`# ${title}`, '');
    if (!list.length) {
      blocks.push('None in this file (fitted model).', '');
      return;
    }
    for (const row of list) blocks.push(...row.lines, '');
  };
  writeSection('Live bots', live);
  writeSection('Paper bots', paper);
  blocks.push(whatIfMarkdown(ordered.map((b) => ({
    id: b.id, pair: b.pair, unit: b.unit, mode: b.mode, replayedPerDay: b.replayedPerDay, calibrated: b.mode === 'live' && b.calibrated,
  }))));
  blocks.push('');

  const failed = replayExit(loaded.source, loaded.bots.length, replayed);
  if (failed) {
    blocks.unshift(ZERO_REPLAY_WARNING, '');
    process.stderr.write(`${ZERO_REPLAY_WARNING}\n`);
  }
  const text = blocks.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  process.stdout.write(text);
  const md = arg('--md');
  const js = arg('--json');
  if (md) { mkdirSync(dirname(resolve(md)), { recursive: true }); writeFileSync(md, text); }
  if (js) {
    mkdirSync(dirname(resolve(js)), { recursive: true });
    const publish = (row: OutRow) => {
      const { lines: _lines, ...rest } = row;
      return rest;
    };
    const liveOut = live.map(publish);
    const paperOut = paper.map(publish);
    const bots = [...liveOut, ...paperOut];
    const model = aggregateModel(bots.map((b) => ({ mode: b.mode, model: b.model })));
    const whatIf = liveOut.filter((b) => b.calibrated).map((b) => ({
      id: b.id, mode: b.mode, pair: b.pair, unit: b.unit,
      recordedPerDay: b.recordedPerDay, replayedPerDay: b.replayedPerDay, netError: b.netError,
      model: b.model,
    }));
    writeFileSync(js, JSON.stringify({
      source: loaded.source, note: loaded.note, replayed, inSample: model.fitted, model, whatIf, live: liveOut, paper: paperOut, bots,
    }, null, 2));
  }
  if (failed) process.exit(failed);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
