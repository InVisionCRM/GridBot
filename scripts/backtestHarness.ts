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
import { renderMarkdown, summaryJson, type RunWindow } from '../src/backtest/report';
import { runBot, type BotConfig, type HarnessData } from '../src/backtest/run';
import { blockReason, calibrateBot, calibrationMarkdown, loadAppState, pairLabel, recordedPerDay, replayExit, whatIfMarkdown, ZERO_REPLAY_WARNING } from '../src/backtest/state';

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
      { label: 'Pool fee tier', value: pool.fee, source: 'on-chain actual' },
      { label: 'Active liquidity', value: liq, source: 'on-chain actual' },
    );
  }
  if (gas > 0) onChain.push({ label: 'Current gas price', value: gas, unit: 'native per gas', source: 'on-chain actual' });
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

async function main() {
  const statePath = resolve(arg('--state') ?? 'data/state.json');
  const cacheDir = resolve(arg('--cache') ?? 'data/backtest-cache');
  const loaded = loadAppState(statePath);
  const now = Math.floor(Date.now() / 1000);
  const fromArg = arg('--from');
  const toArg = arg('--to');
  const blocks: string[] = [loaded.note, ''];
  const jsonBots: Record<string, unknown>[] = [];
  let replayed = 0;

  const skippedRow = (bot: (typeof loaded.bots)[number], reason: string) => {
    const row = {
      id: bot.id,
      pair: pairLabel(bot.config),
      unit: bot.config.quote.symbol,
      recordedPerDay: recordedPerDay(bot),
      replayedPerDay: null as number | null,
      netError: null as number | null,
      movesError: null as number | null,
      calibrated: false,
      skip: reason,
    };
    jsonBots.push(row);
    blocks.push(`${row.pair} ${bot.id}: not replayed (${reason}) (modeled).`);
    blocks.push('');
  };

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
        skippedRow(bot, why);
        continue;
      }
      const market = await loadMarket(cfg, from, to, cacheDir);
      data = market.data;
      cfg = market.cfg;
      if (bot.depth) data.poolDepth = bot.depth;
    } catch (e) {
      skippedRow(bot, `replay did not run (${(e as Error).message})`);
      continue;
    }
    replayed++;
    const cal = calibrateBot({ ...bot, config: cfg }, data);
    const summary = runBot(cal.config, data);
    const w: RunWindow = { from, to, inSample: cal.fitted };
    blocks.push(renderMarkdown([summary], w).trimEnd());
    blocks.push(calibrationMarkdown(cal));
    blocks.push('');
    jsonBots.push({
      id: bot.id,
      pair: pairLabel(cal.config),
      unit: cal.config.quote.symbol,
      recordedPerDay: cal.recordedPerDay,
      replayedPerDay: cal.replayedPerDay,
      netError: cal.netError,
      movesError: cal.movesError,
      calibrated: cal.calibrated,
      summary: summaryJson([summary], w).bots[0],
      calibration: {
        botId: cal.botId, fitted: cal.fitted, feeK: cal.feeK, slippageBps: cal.slippageBps,
        dwellMs: cal.config.dwellMs ?? 0,
        recordedPerDay: cal.recordedPerDay, replayedPerDay: cal.replayedPerDay,
        netError: cal.netError, movesError: cal.movesError, calibrated: cal.calibrated,
        error: cal.error, note: cal.note,
      },
    });
  }

  blocks.push(whatIfMarkdown(jsonBots.map((b) => ({
    id: String(b.id),
    pair: String(b.pair),
    unit: String(b.unit),
    replayedPerDay: b.replayedPerDay as number | null,
    calibrated: b.calibrated === true,
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
    const whatIf = jsonBots.filter((b) => b.calibrated === true).map((b) => ({
      id: b.id, pair: b.pair, unit: b.unit, recordedPerDay: b.recordedPerDay, replayedPerDay: b.replayedPerDay, netError: b.netError,
    }));
    writeFileSync(js, JSON.stringify({ source: loaded.source, note: loaded.note, replayed, whatIf, bots: jsonBots }, null, 2));
  }
  if (failed) process.exit(failed);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
