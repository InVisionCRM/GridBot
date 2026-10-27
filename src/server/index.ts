import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiBot, multiUrgentKey, type MultiState } from './bot/multi';
import { Logger } from './bot/logger';
import { JsonStore } from './bot/store';
import { DurableJsonStore } from './bot/durableStore';
import { ActivityBus } from './bot/activity';
import { createSigners, loadEnv, readCopy, readSettings, takeFriendsSecret, takeHostAuth } from './env';
import { createApp } from './app';
import { CandleStore } from './market/candleStore';
import { GeckoSource } from './market/gecko';
import { CandleSync, geckoBackfill, onchainBackfill } from './market/backfill';
import { VersionCheck } from './system/version';
import { DailyScanner, scanDepsFromHub, type ScanFile } from './market/scanner';
import { PoolHistories } from './lp/poolHistory';
import { LpReplay } from './lp/replay';
import { Converter } from './convert/converter';
import { fetchJson } from './fetchJson';
import { PoolSearch } from './market/poolSearch';
import { TFS } from '../market/candles';
import { buildHub } from './chains/build';
import type { CustomFile } from './chains/hub';
import { FriendsHost } from './friends/host';
import { GeckoRelay, hostScan, relayFetch } from './friends/relay';
import { Autopilot, type AutopilotState, type ScanView } from './bot/autopilot';
import { createTokenTrader, tokenTraderStore } from './market/tokenFeed';

loadEnv();
const friendsSecret = takeFriendsSecret();
const hostAuth = takeHostAuth();
const cfg = readSettings();
const isProd = process.env.NODE_ENV === 'production';
const log = new Logger();
// A friend's copy (started by the host app, friends/copies.ts) shares the host's candles budget and daily scan.
const copy = readCopy();

// Every configured chain gets a fallback RPC reader; signers come from PRIVATE_KEY / PRIVATE_KEY_<SLUG> (env.ts only).
const dataDir = path.dirname(cfg.stateFile);
log.attach(path.join(dataDir, 'server.log'));
const { hub, readers } = buildHub({
  net: cfg.net, env: process.env, signerFactory: createSigners,
  custom: new JsonStore<CustomFile>(path.join(dataDir, 'custom.json')),
});
const legacyReader = readers.get(cfg.net.chainId)!;
const activity = new ActivityBus(400, Date.now, path.join(dataDir, 'activity.log'));
const candles = new CandleStore(path.join(dataDir, 'candles'), 5000);
const bot = new MultiBot({
  net: cfg.net, reader: legacyReader, signer: hub.rt(cfg.net.chainId).signer, store: new DurableJsonStore<MultiState>(cfg.stateFile, { urgentKey: multiUrgentKey, onError: (e) => log.warn(`state.json: ${e.message}`) }), log,
  approval: cfg.approval, maxRetries: cfg.maxRetries, retryDelayMs: cfg.retryDelayMs, candles, activity, hub,
  copy: copy && { friend: copy.friend, host: copy.host },
});
const gecko = new GeckoSource(copy ? relayFetch(copy.hostUrl) : undefined);
const sync: CandleSync = new CandleSync(gecko, () => hub.candleSources(), candles, {
  onEvent: (msg, level) => activity.emitEvent({ type: 'candles', kind: 'system', level, msg }),
  active: () => bot.activeCandleKeys(),
  paused: (): boolean => dailyScan?.status().running ?? false,
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

// Daily pair scan shares the GeckoTerminal client (one rate limit) and is off with it (CANDLES_GECKO=off). A friend's
// copy shows the host's scan instead of running one.
const dailyScan: DailyScanner | undefined = !copy && sync.enabled ? new DailyScanner(scanDepsFromHub(hub, candles, {
  gecko, store: new JsonStore<ScanFile>(path.join(dataDir, 'picks.json')), approval: cfg.approval, emit: activity.emitEvent,
})) : undefined;
const scanner = copy ? hostScan(copy.hostUrl, copy.host) : dailyScan;

const version = copy ? null : await VersionCheck.start(process.cwd(), process.env.NODE_ENV !== 'production');
const entry = fileURLToPath(import.meta.url);
const clientDir = path.join(path.dirname(entry), '../client');
// Friends' copies (host only): FRIENDS_SECRET seals their keys; each copy runs the built server this process runs.
const hostAddresses: string[] = [];
const friends = copy ? undefined
  : !friendsSecret ? { off: 'Run npm run friends:setup once, then restart the app.' }
    : !isProd ? { off: 'Friends\' copies run from the built app: npm run build, then npm start.' }
      : new FriendsHost({
        secret: friendsSecret, dataDir, entry, hostEnv: { ...process.env }, hostPort: cfg.port, port: Number(process.env.FRIENDS_PORT || 3850),
        publicDir: clientDir, hostAddresses: () => hostAddresses,
        hostAuth, gatewayHost: process.env.GATEWAY_HOST?.trim() || null,
        say: (msg, level) => activity.emitEvent({ type: 'info', kind: 'system', level, msg }),
      });
const lpReplay = new LpReplay(hub, new PoolHistories(path.join(dataDir, 'pool-history'), (id) => readers.get(id)!), cfg.approval);
const convert = new Converter({ hub, allocations: () => bot.allocations().rows, approval: cfg.approval, emit: activity.emitEvent, fetchJson });
// The smart trader: budgets per chain, run as grid and liquidity bots picked from the opportunity scan.
const autopilot = new Autopilot({
  bot, store: new JsonStore<AutopilotState>(path.join(dataDir, 'autopilot.json')), emit: activity.emitEvent,
  scan: async () => (scanner ? (await scanner.status()) as ScanView : null),
});
const tokenTrader = copy ? undefined : createTokenTrader({
  hub, gecko, store: tokenTraderStore(path.join(dataDir, 'token-trader.json')), emit: activity.emitEvent,
  approval: cfg.approval, receiptTimeoutMs: 120_000,
});
const app = createApp({
  bot, net: cfg.net, backfill, scanner, viewCandles: (pair) => sync.view(pair), system: { version, pollMs: cfg.pollMs },
  lpReplay: (q) => lpReplay.replay(q), convert, poolSearch: new PoolSearch(hub, fetchJson),
  relay: copy ? undefined : new GeckoRelay(gecko, { busy: () => dailyScan?.status().running ?? false }),
  friends, autopilot, tokenTrader, copy: !!copy,
});
if (isProd) {
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
  dailyScan?.start();
  autopilotTimer = setInterval(() => void autopilot.tick(), 60_000);
  tokenTimer = setInterval(() => void tokenTrader?.tick(), 20_000);
  if (friends instanceof FriendsHost) {
    for (const rt of hub.runtimes()) if (rt.signer) hostAddresses.push(await rt.signer.getAddress());
    await friends.start().catch((e: Error) => { log.error(e.message); process.exit(1); });
    const phone = hostAuth ? `owner login on (${hostAuth.login})` : 'owner login off (npm run host:password)';
    log.info(`Friends' gateway on http://127.0.0.1:${friends.view().port} · ${phone} · ${friends.friends.list().length} friend copies`);
  } else if (hostAuth && !copy) {
    log.warn('Owner phone password is set, but the gateway is off. Run npm run friends:setup, npm run build, then npm start.');
  }
});
server.on('error', (err: NodeJS.ErrnoException) => {
  log.error(err.code === 'EADDRINUSE' ? `Port ${cfg.port} in use. Set PORT=…` : err.message);
  process.exit(1);
});
let autopilotTimer: ReturnType<typeof setInterval> | null = null;
let tokenTimer: ReturnType<typeof setInterval> | null = null;
const shutdown = () => {
  if (autopilotTimer) clearInterval(autopilotTimer);
  if (tokenTimer) clearInterval(tokenTimer);
  bot.stopLoop(); sync.stop(); dailyScan?.stop(); candles.flush(); server.close();
  try { bot.flush(); } catch { /* logged by the store */ }
  if (friends instanceof FriendsHost) friends.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// A copy runs only while its host does: the IPC channel closes when the host stops, however it stops.
if (copy) {
  if (!process.send) throw new Error('A friend\'s copy is started by the host app.');
  process.on('disconnect', shutdown);
}
