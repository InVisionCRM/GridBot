/**
 * Backfill candles into data/candles/. Stop the server first (it holds the same files in memory).
 *   npm run candles:backfill -- --pair DAI --days 60 --source onchain
 *   npm run candles:backfill -- --pair ethereum:ETH/USDC --source gecko
 * --pair is any market key (legacy PulseChain quote symbol, chain default, or a custom market from data/custom.json).
 */
import { dirname, resolve } from 'node:path';
import { loadEnv, readSettings } from '../src/server/env';
import { CandleStore } from '../src/server/market/candleStore';
import { GeckoSource } from '../src/server/market/gecko';
import { geckoBackfill, onchainBackfill } from '../src/server/market/backfill';
import { TFS } from '../src/market/candles';
import { buildHub } from '../src/server/chains/build';
import { JsonStore } from '../src/server/bot/store';
import type { CustomFile } from '../src/server/chains/hub';

loadEnv();
const cfg = readSettings();
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const pair = arg('pair', 'DAI'), days = Number(arg('days', '30')), source = arg('source', 'onchain');
const { hub, readers } = buildHub({ net: cfg.net, env: process.env, custom: new JsonStore<CustomFile>(resolve(dirname(cfg.stateFile), 'custom.json')) });
const src = hub.candleSource(pair);
const store = new CandleStore(resolve(process.env.CANDLE_DIR || 'data/candles'), 1000);
const t0 = Date.now();
if (source === 'gecko') {
  const g = new GeckoSource();
  for (const tf of TFS) console.log(tf, await geckoBackfill(g, src, store, tf));
} else {
  const r = await onchainBackfill(readers.get(hub.def(pair).chainId)!, src, store, days, (p, m) => console.log(`${(p * 100).toFixed(1)}% ${m} (${((Date.now() - t0) / 1000).toFixed(0)}s)`));
  console.log('done', r, `${new Date(r.fromSec * 1000).toISOString()} → ${new Date(r.toSec * 1000).toISOString()}`);
}
store.flush();
for (const s of store.summary([pair])[0].series) console.log(s.tf, s.count, s.from && new Date(s.from * 1000).toISOString(), '→', s.to && new Date(s.to * 1000).toISOString(), s.source);
process.exit(0);
