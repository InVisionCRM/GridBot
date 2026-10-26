/**
 * Self-test: is everything that has to work for the bots to trade actually working, right now?
 *   App          the running code vs the build, the checkout and GitHub
 *   Chains       RPC answers (timed), signing key, gas, wallet balances
 *   Bots         ticking, errors, levels that can never trade, stuck transactions, range, pool readable, next trade
 *   Market data  GeckoTerminal rate limits (counted on this machine), the opportunity scan
 * Every finding says what it means and, when something is wrong, the one fix.
 */
import type { VersionReport } from './version';
import { nextLevels, type LiveInterval } from '../../live/liveGrid';
import { hostFix } from '../words';

export type CheckState = 'pass' | 'warn' | 'fail';
export type CheckGroup = 'App' | 'Chains' | 'Bots' | 'Market data';
export interface Check { id: string; group: CheckGroup; name: string; state: CheckState; detail: string; fix?: string }
export interface CheckReport { at: number; checks: Check[]; counts: Record<CheckState, number> }

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CheckDeps {
  /** null in a friend's copy: the host keeps it up to date */
  version: (() => Promise<VersionReport>) | null;
  /** MultiBot.status() after a fresh wallet read */
  status: () => Promise<AnyObj>;
  /** Time one RPC request on a chain (throws when the RPC doesn't answer) */
  probeChain: (chainId: number) => Promise<number>;
  /** Read a market's pool the way a trade would (throws when it can't) */
  probeMarket: (key: string) => Promise<void>;
  /** The opportunity scan (a friend's copy asks the host for it) */
  scan: (() => AnyObj | Promise<AnyObj>) | null;
  pollMs: number;
  now?: () => number;
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
const px = (x: number) => (x >= 1 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x.toPrecision(5));
/** A running bot reads a price every poll; three missed polls (at least 45 s) means it has stopped ticking. */
export const staleAfter = (pollMs: number) => Math.max(45_000, 3 * pollMs);
const RESTART_IN_PLACE = 'Open the grid → Stop → Change range (same or new prices) → Start. It keeps the coins it holds.';

export function versionCheck(v: VersionReport): Check {
  const state: CheckState = v.state === 'current' ? (v.notes.length ? 'warn' : 'pass') : v.state === 'update-available' ? 'warn' : 'fail';
  return { id: 'app:version', group: 'App', name: v.title, state, detail: [v.detail, ...v.notes].join(' '), ...(v.steps.length ? { fix: v.steps.join(' → ') } : {}) };
}

/** Checks that need only the bot's status (pure). */
export function botChecks(b: AnyObj, kind: 'grid' | 'trend' | 'lp', now: number, pollMs: number): Check[] {
  const name = kind === 'grid' ? `Grid ${b.label}` : kind === 'lp' ? `Liquidity ${b.label}` : b.name;
  const id = `bot:${b.id}`;
  const out: Check[] = [];
  const add = (sub: string, state: CheckState, detail: string, fix?: string) => out.push({ id: `${id}:${sub}`, group: 'Bots', name, state, detail, ...(fix ? { fix } : {}) });
  if (b.available === false) { add('available', 'fail', "Its chain or token isn't loaded on this server, so it can't trade.", hostFix('Turn the chain back on in .env, or remove the bot.')); return out; }
  if (b.status === 'closed') return out;
  if (b.status !== 'running') add('status', 'warn', `${kind === 'lp' ? 'Paused' : 'Stopped'}: it isn't trading.`, 'Press Resume on the bot.');
  if (b.status === 'running') {
    const age = b.priceAt ? now - b.priceAt : Infinity;
    if (age > staleAfter(pollMs)) add('ticking', 'fail', b.priceAt ? `No price read for ${Math.round(age / 1000)} s, so it can't react to the market.` : 'No price read yet.', 'Check this chain\'s RPC below. If the chain is fine, restart the server.');
  }
  if (b.lastError) add('error', 'fail', `Last attempt failed: ${b.lastError}`);
  if (kind === 'grid') gridChecks(b, now, add);
  if (kind === 'lp') {
    if (b.step?.hash && b.step.sentAt && now - b.step.sentAt > 10 * 60_000) add('tx', 'warn', `A transaction has waited ${mins(now - b.step.sentAt)} to confirm.`, 'Check it on the explorer; the bot settles it by hash when it lands.');
    if (b.status === 'running' && b.position && b.inRange === false && !b.config?.rerange) add('range', 'warn', "The price is outside the range and moving the range is off, so it isn't earning.", 'Turn on Auto-move or move it to the price on the bot\'s page, or close the position.');
  }
  if (!out.length) add('ok', 'pass', kind === 'lp' ? (b.position ? (b.inRange ? 'In range and earning.' : 'Out of range; the range moves if it stays out.') : 'Opening…') : 'Running and reading prices.');
  return out;
}

function gridChecks(g: AnyObj, now: number, add: (sub: string, s: CheckState, d: string, f?: string) => void) {
  const ivs: AnyObj[] = g.intervals ?? [];
  const price: number | null = g.price;
  const dead = ivs.filter((i) => i.status === 'inactive');
  if (dead.length) add('legacy', 'warn', `${dead.length} of ${ivs.length} levels can never trade: they were set up by an older version that left the levels above the start price empty.`, RESTART_IN_PLACE);
  const lost = price == null ? [] : ivs.filter((i) => i.status === 'waitingBuy' && i.needsRearm && i.buyPrice >= price);
  if (lost.length) add('seed', 'warn', `${lost.length} levels above the price have no coins to sell: their start-up buy didn't happen (stopped before it ran, or skipped). They only trade after the price dips back through them.`, RESTART_IN_PLACE);
  if (g.inFlight?.job?.createdAt && now - g.inFlight.job.createdAt > 10 * 60_000) add('tx', 'warn', `A swap has waited ${mins(now - g.inFlight.job.createdAt)} to confirm.`, 'Check it on the explorer; the bot settles it by hash when it lands.');
  const oldJob = (g.queue ?? []).find((q: AnyObj) => now - q.createdAt > 5 * 60_000);
  if (oldJob) add('queue', 'warn', `A ${oldJob.side} has been waiting ${mins(now - oldJob.createdAt)} to be sent.`, 'Check the chain checks below (gas, RPC) and the bot\'s log.');
  if (g.status === 'running' && price != null && g.config) {
    if (price < g.config.lowerPrice) add('range', 'warn', `The price ${px(price)} is below the range (${px(g.config.lowerPrice)}–${px(g.config.upperPrice)}): every level has bought, so it waits for the price to come back.`, RESTART_IN_PLACE);
    else if (price > g.config.upperPrice) add('range', 'warn', `The price ${px(price)} is above the range: everything is sold, so it waits${g.recenter?.enabled ? ' (Follow the price up will move the range)' : ''}.`, g.recenter?.enabled ? undefined : RESTART_IN_PLACE);
    else {
      const next = nextLevels(ivs as LiveInterval[], price);
      const parts = [next.buy != null ? `next buy ${px(next.buy)} (${pct(1 - next.buy / price)} below)` : null, next.sell != null ? `next sell ${px(next.sell)} (${pct(next.sell / price - 1)} above)` : null].filter(Boolean);
      add('next', 'pass', parts.length ? `In range. ${parts.join(', ')}. It trades when the price reaches one of them.` : 'In range.');
    }
  }
}


export function chainChecks(c: AnyObj, rpcMs: number | Error, liveBots: number): Check[] {
  const id = `chain:${c.id}`, name = c.name as string;
  const out: Check[] = [];
  out.push(rpcMs instanceof Error
    ? { id: `${id}:rpc`, group: 'Chains', name, state: 'fail', detail: `RPC ${c.rpc ?? ''} didn't answer: ${rpcMs.message}`, fix: hostFix('Set another RPC for this chain in .env (RPC_URL_…) and restart.') }
    : { id: `${id}:rpc`, group: 'Chains', name, state: rpcMs > 3000 ? 'warn' : 'pass', detail: `RPC answered in ${rpcMs} ms${rpcMs > 3000 ? ' (slow: trades may be late)' : ''}.` });
  if (!c.hasSigner) out.push({ id: `${id}:key`, group: 'Chains', name, state: liveBots ? 'fail' : 'pass', detail: liveBots ? 'No signing key for this chain, but live bots use it.' : 'No signing key: paper only here.' });
  else if (c.walletError) out.push({ id: `${id}:wallet`, group: 'Chains', name, state: 'fail', detail: `Couldn't read the wallet: ${c.walletError}`, fix: 'Usually the RPC; check it above.' });
  else if (c.lowGas) out.push({ id: `${id}:gas`, group: 'Chains', name, state: liveBots ? 'fail' : 'warn', detail: `Gas is low: ${Number(c.gasNative).toPrecision(4)} ${c.nativeSymbol} (warning level ${c.lowGasNative}). Trades are skipped when it runs out.`, fix: `Send some ${c.nativeSymbol} to ${c.address}.` });
  else out.push({ id: `${id}:gas`, group: 'Chains', name, state: 'pass', detail: `Wallet readable; ${Number(c.gasNative).toPrecision(4)} ${c.nativeSymbol} for gas.` });
  return out;
}

export function dataChecks(sync: AnyObj | null, scan: AnyObj | null, now: number): Check[] {
  const out: Check[] = [];
  if (sync) {
    const n = sync.limited1h as number;
    out.push({
      id: 'data:gecko', group: 'Market data', name: 'GeckoTerminal (charts, opportunity scan)', state: n > 0 ? 'warn' : 'pass',
      detail: n > 0
        ? `${n} rate limit${n === 1 ? '' : 's'} (HTTP 429) in the last hour. The app slows down by itself (now one request every ${(sync.paceMs / 1000).toFixed(1)} s). Trading doesn't use GeckoTerminal, only charts and the scan do.`
        : `No rate limits in the last hour (${sync.calls} requests since start, one every ${(sync.paceMs / 1000).toFixed(1)} s at most). Trading doesn't use GeckoTerminal.`,
      ...(n > 5 ? { fix: 'Something else on this network may be using GeckoTerminal too (another copy of the app, a browser tab with its site).' } : {}),
    });
  }
  if (scan) {
    const age = scan.at == null ? null : now - scan.at;
    out.push({
      id: 'data:scan', group: 'Market data', name: 'Opportunity scan', state: scan.running ? 'pass' : age == null || age > 26 * 3600_000 ? 'warn' : 'pass',
      detail: scan.running ? 'Scanning now.' : age == null ? 'Not run yet.' : `Last scan ${Math.round(age / 3600_000)} h ago.`,
    });
  }
  return out;
}

export async function runChecks(d: CheckDeps): Promise<CheckReport> {
  const now = (d.now ?? Date.now)();
  const [version, s, scan] = await Promise.all([d.version?.() ?? null, d.status(), d.scan?.() ?? null]);
  const chains: AnyObj[] = s.chains ?? [];
  const bots = [
    ...(s.grids ?? []).map((b: AnyObj) => ({ b, kind: 'grid' as const, market: b.stable })),
    ...(s.trends ?? []).map((b: AnyObj) => ({ b, kind: 'trend' as const, market: b.quote })),
    ...(s.lps ?? []).map((b: AnyObj) => ({ b, kind: 'lp' as const, market: b.market })),
  ];
  const rpc = await Promise.all(chains.map((c) => d.probeChain(c.id).catch((e: Error) => e)));
  const live = (cid: number) => bots.filter(({ b }) => b.mode === 'live' && b.status !== 'closed' && (b.chainId ?? s.legacyChainId) === cid).length;
  // One pool read per market a running bot trades
  const markets = [...new Set(bots.filter(({ b }) => b.status === 'running' && b.available !== false).map(({ market }) => market as string))];
  const probes = new Map(await Promise.all(markets.map(async (k) => [k, await d.probeMarket(k).then(() => null, (e: Error) => e.message)] as const)));
  const checks: Check[] = [
    ...(version ? [versionCheck(version)] : []),
    ...chains.flatMap((c, i) => chainChecks(c, rpc[i], live(c.id))),
    ...bots.flatMap(({ b, kind, market }) => {
      const err = probes.get(market);
      const pool: Check[] = err ? [{ id: `bot:${b.id}:pool`, group: 'Bots', name: kind === 'trend' ? b.name : `${kind === 'lp' ? 'Liquidity' : 'Grid'} ${b.label}`, state: 'fail', detail: `Can't read its pool: ${err}` }] : [];
      return [...pool, ...botChecks(b, kind, now, d.pollMs)];
    }),
    ...dataChecks(s.candleSync, scan, now),
  ];
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.state]++;
  return { at: now, checks, counts };
}
