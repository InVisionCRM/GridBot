import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiBot, type MultiState } from './bot/multi';
import { Logger } from './bot/logger';
import { JsonStore } from './bot/store';
import { ActivityBus } from './bot/activity';
import { createSigners, loadEnv, readSettings } from './env';
import { createApp } from './app';
import { CandleStore } from './market/candleStore';
import { GeckoSource } from './market/gecko';
import { CandleSync, geckoBackfill, onchainBackfill } from './market/backfill';
import { TFS } from '../market/candles';
import { buildHub } from './chains/build';
import type { CustomFile } from './chains/hub';

loadEnv();
const cfg = readSettings();
const isProd = process.env.NODE_ENV === 'production';
const log = new Logger();

// Every configured chain gets a fallback RPC reader; signers come from PRIVATE_KEY / PRIVATE_KEY_<SLUG> (env.ts only).
const dataDir = path.dirname(cfg.stateFile);
const { hub, readers } = buildHub({
  net: cfg.net, env: process.env, signerFactory: createSigners,
  custom: new JsonStore<CustomFile>(path.join(dataDir, 'custom.json')),
});
const legacyReader = readers.get(cfg.net.chainId)!;
const activity = new ActivityBus();
const candles = new CandleStore(path.join(dataDir, 'candles'), 5000);
const bot = new MultiBot({
  net: cfg.net, reader: legacyReader, signer: hub.rt(cfg.net.chainId).signer, store: new JsonStore<MultiState>(cfg.stateFile), log,
  approval: cfg.approval, maxRetries: cfg.maxRetries, retryDelayMs: cfg.retryDelayMs, candles, activity, hub,
});
const gecko = new GeckoSource();
const sync = new CandleSync(gecko, () => hub.candleSources(), candles, {
  onEvent: (msg, level) => activity.emitEvent({ type: 'candles', kind: 'system', level, msg }),
});
sync.enabled = process.env.CANDLES_GECKO !== 'off';
bot.candleSyncStatus = () => sync.status();

let backfilling = false;
const backfill = async (pair: string, source: 'gecko' | 'onchain', days: number) => {
  if (backfilling) throw new Error('a backfill is already running');
  const src = hub.candleSource(pair);
  const reader = readers.get(hub.def(pair).chainId)!;
  backfilling = true;
  const chainId = hub.def(pair).chainId;
  const say = (msg: string, level: 'info' | 'warn' | 'success' = 'info') => activity.emitEvent({ type: 'candles', kind: 'system', pair, chainId, level, msg });
  try {
    say(`Backfill ${src.label} from ${source} started (${source === 'onchain' ? `${days} days` : 'all timeframes'})`);
    if (source === 'onchain') {
      const r = await onchainBackfill(reader, src, candles, days, (p, m) => say(`${(p * 100).toFixed(0)}% — ${m}`));
      say(`Backfill ${src.label} on-chain done: ${r.candles1m} 1m candles`, 'success');
    } else {
      for (const tf of TFS) say(`${src.label} ${tf}: ${await geckoBackfill(gecko, src, candles, tf)} candles from GeckoTerminal`);
      say(`Backfill ${src.label} from GeckoTerminal done`, 'success');
    }
  } catch (e) {
    say(`Backfill ${src.label} failed: ${(e as Error).message}`, 'warn');
  } finally {
    backfilling = false;
    candles.flush();
  }
};

const app = createApp({ bot, net: cfg.net, backfill });
if (isProd) {
  const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../client');
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

const server = app.listen(cfg.port, '127.0.0.1', async () => {
  log.info(`API on http://127.0.0.1:${cfg.port} · legacy chain ${cfg.net.label} (${cfg.net.chainId})`);
  for (const rt of hub.runtimes()) {
    const addr = rt.signer ? await rt.signer.getAddress().catch(() => null) : null;
    log.info(`  ${rt.cfg.name} (${rt.cfg.id})${rt.cfg.status === 'testnet' ? ' TESTNET' : ''} · ${rt.tradable ? rt.cfg.dexes.map((d) => d.name).join(', ') : `trading unavailable — ${rt.cfg.trading.reason ?? 'no DEX'}`} · RPC ${rt.reader.currentUrl ?? '?'} · ${addr ? `signer ${addr}` : 'paper only'}`);
  }
  bot.address = hub.rt(cfg.net.chainId).signer ? await hub.rt(cfg.net.chainId).signer!.getAddress() : null;
  log.info(`State file ${cfg.stateFile} · poll ${cfg.pollMs}ms · approvals ${cfg.approval} · ${hub.list().length} markets (${hub.customMarkets().length} custom)`);
  bot.startLoop(cfg.pollMs);
  sync.start();
});
server.on('error', (err: NodeJS.ErrnoException) => {
  log.error(err.code === 'EADDRINUSE' ? `Port ${cfg.port} in use. Set PORT=…` : err.message);
  process.exit(1);
});
const shutdown = () => { bot.stopLoop(); sync.stop(); candles.flush(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
