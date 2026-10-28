import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiBot, multiUrgentKey, type MultiState } from './bot/multi';
import { Logger } from './bot/logger';
import { JsonStore } from './bot/store';
import { DurableJsonStore } from './bot/durableStore';
import { ActivityBus } from './bot/activity';
import { createSigners, loadEnv, readCopy, readSettings, receiveFriendKey, shortQuoteKeyWarnings, takeBridgeKeys, takeFriendsSecret, takeHostAuth } from './env';
import { Router, type RouterFile } from './router/router';
import { createApp } from './app';
import { CandleStore } from './market/candleStore';
import { GeckoSource } from './market/gecko';
import { CandleSync, geckoBackfill, onchainBackfill } from './market/backfill';
import { VersionCheck } from './system/version';
import { DailyScanner, localScan, scanDepsFromHub, type ScanFile } from './market/scanner';
import { PoolHistories } from './lp/poolHistory';
import { LpReplay } from './lp/replay';
import { Converter } from './convert/converter';
import { swapForHost } from './swap/wire';
import { fetchJson } from './fetchJson';
import { PoolSearch } from './market/poolSearch';
import { TFS } from '../market/candles';
import { buildHub } from './chains/build';
import type { CustomFile } from './chains/hub';
import { FriendsHost } from './friends/host';
import { GeckoRelay, hostScan, relayFetch } from './friends/relay';
import { Autopilot, type AutopilotState, type ScanView } from './bot/autopilot';
import { createTokenTrader, tokenTraderStore } from './market/tokenFeed';
import { tryStartPush } from './push/service';
import { lpSnapsFromStatus } from './push/lpWatch';
import { dailySummary } from './push/summary';
import { chainBootLine, registerRpcUrls } from './chains/rpcUrl';

loadEnv();
// RPC URLs can hold an API key: register them before anything can log one (logs and the API show the host only).
registerRpcUrls(process.env);
const friendsSecret = takeFriendsSecret();
const hostAuth = takeHostAuth();
// Before anything copies process.env (a friend's copy must not inherit quote keys).
const bridgeKeyStatus = takeBridgeKeys();
const cfg = readSettings();
const isProd = process.env.NODE_ENV === 'production';
const log = new Logger();
for (const msg of shortQuoteKeyWarnings()) log.warn(msg);
// A friend's copy (started by the host app, friends/copies.ts) shares the host's candles budget and daily scan.
const copy = readCopy();

// Every configured chain gets a fallback RPC reader; signers come from PRIVATE_KEY / PRIVATE_KEY_<SLUG> (env.ts only).
const dataDir = path.dirname(cfg.stateFile);
log.attach(path.join(dataDir, 'server.log'));
// A friend's copy gets its key from the host over IPC (never through its environment).
const friendKey = copy ? await receiveFriendKey() : undefined;
const { hub, readers } = buildHub({
  net: cfg.net, env: process.env, signerFactory: (chains) => (copy ? createSigners(chains, { friendKey }) : createSigners(chains)),
  custom: new JsonStore<CustomFile>(path.join(dataDir, 'custom.json')),
});
registerRpcUrls(process.env, readers.values());
const legacyReader = readers.get(cfg.net.chainId)!;
const activity = new ActivityBus(400, Date.now, path.join(dataDir, 'activity.log'));
const candles = new CandleStore(path.join(dataDir, 'candles'), 5000);
const bot = new MultiBot({
  net: cfg.net, reader: legacyReader, signer: hub.rt(cfg.net.chainId).signer, store: new DurableJsonStore<MultiState>(cfg.stateFile, { urgentKey: multiUrgentKey, onError: (e) => log.warn(`state.json: ${e.message}`) }), log,
  approval: cfg.approval, maxRetries: cfg.maxRetries, retryDelayMs: cfg.retryDelayMs, candles, activity, hub,
  copy: copy && { friend: copy.friend, host: copy.host },
  rpcAlertAfterMs: Number(process.env.RPC_ALERT_MINUTES) > 0 ? Number(process.env.RPC_ALERT_MINUTES) * 60_000 : undefined,
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
const scanSource = copy ? hostScan(copy.hostUrl, copy.host) : dailyScan;
const scanner = scanSource ? localScan(hub, scanSource) : undefined;

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
  approval: cfg.approval, receiptTimeoutMs: 120_000, dataDir,
});
// Stop all / STOP chain: the token trader and sniper make no new buys there; exits of positions it holds keep running.
if (tokenTrader) bot.stopHooks.push((chainId, halt) => tokenTrader.stopEntries(chainId, halt));
const push = tryStartPush({
  dir: dataDir,
  subject: cfg.vapidSubject,
  log: (level, msg) => log[level](msg),
  positions: () => { try { return lpSnapsFromStatus(bot.status()); } catch { return []; } },
  summary: () => { try { return dailySummary(bot.status()); } catch { return { title: 'GridBot · daily summary', body: 'No generated profit to report.' }; } },
});
if (push) activity.on('activity', (ev) => { void push.onActivity(ev).catch(() => log.warn('push: event was not sent')); });
// ROUTER HOOK: host only (a friend's copy has readCopy() set). Stop all calls router.halt.
const router = new Router({
  store: new JsonStore<RouterFile>(path.join(dataDir, 'router.json')),
  host: copy == null,
  configured: bridgeKeyStatus,
  chainIds: hub.runtimes().map((r) => r.cfg.id),
  emit: activity.emitEvent,
  log,
});
bot.routerHalt = (halt) => router.halt(halt);
// Quotes and, in live mode, calldata only. A friend's copy does not construct this. Nothing here broadcasts.
const swap = swapForHost(!!copy, {
  hub,
  allocations: () => bot.allocations().rows,
  reservations: () => [
    ...(tokenTrader?.reservations() ?? []),
    ...convert.reservations(),
    ...bot.routerReservations(),
  ],
});
const app = createApp({
  bot, net: cfg.net, backfill, scanner, viewCandles: (pair) => sync.view(pair), system: { version, pollMs: cfg.pollMs },
  lpReplay: (q) => lpReplay.replay(q), convert, swap, poolSearch: new PoolSearch(hub, fetchJson),
  relay: copy ? undefined : new GeckoRelay(gecko, { busy: () => dailyScan?.status().running ?? false }),
  friends, autopilot, tokenTrader, router, copy: !!copy, ...(push ? { push } : {}),
});
if (isProd) {
  app.get('/sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('js');
    res.sendFile(path.join(clientDir, 'sw.js'));
  });
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

const server = app.listen(cfg.port, '127.0.0.1', async () => {
  log.info(`API on http://127.0.0.1:${cfg.port} · legacy chain ${cfg.net.label} (${cfg.net.chainId})`);
  for (const rt of hub.runtimes()) {
    const addr = rt.signer ? await rt.signer.getAddress().catch(() => null) : null;
    log.info(chainBootLine(rt, addr));
  }
  bot.address = hub.rt(cfg.net.chainId).signer ? await hub.rt(cfg.net.chainId).signer!.getAddress() : null;
  log.info(`State file ${cfg.stateFile} · poll ${cfg.pollMs}ms · approvals ${cfg.approval} · ${hub.list().length} markets (${hub.customMarkets().length} custom)`);
  bot.startLoop(cfg.pollMs);
  sync.start();
  dailyScan?.start();
  // A first check at once: its prices and unconfirmed swaps are read now, not a minute after a restart
  void autopilot.tick();
  autopilotTimer = setInterval(() => void autopilot.tick(), 60_000);
  tokenTimer = setInterval(() => void tokenTrader?.tick(), 20_000);
  if (push) {
    pushTimer = setInterval(() => { void push.tick().catch(() => log.warn('push: tick failed')); }, 15_000);
    log.info('Web push ready');
  }
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
let pushTimer: ReturnType<typeof setInterval> | null = null;
const shutdown = () => {
  if (autopilotTimer) clearInterval(autopilotTimer);
  if (tokenTimer) clearInterval(tokenTimer);
  if (pushTimer) clearInterval(pushTimer);
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
