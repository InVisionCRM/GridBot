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
import { loadCandles, readGasPrice, readV3Pool, type FetchLike } from '../src/backtest/adapters';
import { renderMarkdown, summaryJson, type RunWindow } from '../src/backtest/report';
import { runBot, type BotConfig, type HarnessData } from '../src/backtest/run';
import { calibrateBot, calibrationMarkdown, loadAppState } from '../src/backtest/state';

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

async function loadMarket(cfg: BotConfig, from: number, to: number, cacheDir: string): Promise<{ data: HarnessData; cfg: BotConfig }> {
  if (!cfg.pool) throw new Error('no pool address on this bot');
  const base = cfg.base.address;
  if (!base) throw new Error('no base token on this bot');
  const source = (arg('--source') as 'gecko' | 'dexscreener' | 'auto' | undefined) ?? 'auto';
  const { candles } = await loadCandles({
    chain: cfg.chain, pool: cfg.pool, baseToken: base, from, to, source, cacheDir, fetchFn,
  });
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
  if (gas > 0) onChain.push({ label: 'Gas price', value: gas, unit: 'native per gas', source: 'on-chain actual' });
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
  const jsonBots: unknown[] = [];
  const calibrations = [];

  for (const bot of loaded.bots) {
    const span = bot.fills.length
      ? { from: Math.min(...bot.fills.map((f) => f.t)), to: Math.max(...bot.fills.map((f) => f.t)) + 3600 }
      : { from: now - 30 * DAY, to: now };
    const from = fromArg ? Number(fromArg) : span.from;
    const to = toArg ? Number(toArg) : span.to;
    let cfg = bot.config;
    let data: HarnessData | null = null;
    try {
      if (cfg.kind === 'lp' || cfg.pool) {
        const market = await loadMarket(cfg, from, to, cacheDir);
        data = market.data;
        cfg = market.cfg;
      }
    } catch (e) {
      blocks.push(`${bot.id}: replay did not run (${(e as Error).message}).`);
      blocks.push('');
      continue;
    }
    if (!data) {
      blocks.push(`${bot.id}: no pool address in the app state, so this bot was not replayed.`);
      blocks.push('');
      continue;
    }
    const cal = calibrateBot({ ...bot, config: cfg }, data);
    calibrations.push({ botId: cal.botId, fitted: cal.fitted, feeK: cal.feeK, slippageBps: cal.slippageBps, error: cal.error, note: cal.note });
    const summary = runBot(cal.config, data);
    const w: RunWindow = { from, to };
    blocks.push(renderMarkdown([summary], w).trimEnd());
    blocks.push(calibrationMarkdown(cal));
    blocks.push('');
    jsonBots.push({ id: bot.id, summary: summaryJson([summary], w).bots[0], calibration: calibrations[calibrations.length - 1] });
  }

  const text = blocks.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  process.stdout.write(text);
  const md = arg('--md');
  const js = arg('--json');
  if (md) { mkdirSync(dirname(resolve(md)), { recursive: true }); writeFileSync(md, text); }
  if (js) {
    mkdirSync(dirname(resolve(js)), { recursive: true });
    writeFileSync(js, JSON.stringify({ source: loaded.source, note: loaded.note, bots: jsonBots }, null, 2));
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
