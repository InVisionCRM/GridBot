/**
 * Swap history of V3 pools for the liquidity replay (market/lpReplay): each pool's Swap events folded into minutes,
 * kept for the last KEEP_DAYS days in data/pool-history/<chainId>-<pool>.json and topped up when a replay is asked for.
 *
 * Requests go through the chain's fallback reader one at a time, so the live bots keep its other slots. RPCs cap the
 * logs one request may return (Robinhood: 10 000; its WETH/USDG 0.01 % pool had ≈210 000 swaps a day in October 2026),
 * so each request asks for about TARGET_LOGS swaps' worth of blocks, sized from the last answer, and halves its span
 * when a request fails. Block times are interpolated inside each request's span, like onchain.ts does for candles.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addSwaps, type PoolMinute, type PoolSwap } from '../../market/lpReplay';
import { PCS_V3_SWAP_TOPIC, V3_SWAP_TOPIC, type LogReader } from '../market/onchain';

/** Days of history kept per pool: the replay's window */
export const KEEP_DAYS = 7;
const DAY_S = 86_400;
const TARGET_LOGS = 5000;
const SAVE_EVERY_MS = 30_000;
/** A public RPC answers 429 to a burst (Robinhood did after ≈2.4 M blocks in 2 minutes): requests keep this gap and a refused one waits 1, 2, 4, 8, 16 s */
const GAP_MS = 250;
const RETRIES = 5;
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
/** An RPC refusing a request because its answer would hold too many logs (or span too many blocks): ask for fewer blocks */
const TOO_MANY_LOGS = /exceeds limit|more than \d+ results|response size|block range|range (is )?too (large|wide)/i;

export interface HistoryOpts { now?: () => number; gapMs?: number; sleep?: (ms: number) => Promise<void> }

/** One pool to keep: where, its fee tier (hundredths of a bip), the LPs' share of fees, the chain's largest log request. */
export interface PoolRef { chainId: number; pool: string; feeTier: number; lpShare: number; logChunk: number }

export interface SyncState {
  syncing: boolean;
  /** Blocks read and to read in the running (or last) sync */
  done: number; total: number;
  error: string | null;
  /** When the last sync ended, done or failed (ms) */
  at: number | null;
}

type Row = [number, number, number, number, number, number, number, number];
interface PoolFile { version: 1; chainId: number; pool: string; feeTier: number; lpShare: number; toBlock: number; lastTick: number | null; rows: Row[] }

const toRow = (m: PoolMinute): Row => [m.t, m.lo, m.hi, m.c, m.f0, m.f1, m.liq, m.n];
const fromRow = (r: Row): PoolMinute => ({ t: r[0], lo: r[1], hi: r[2], c: r[3], f0: r[4], f1: r[5], liq: r[6], n: r[7] });
const word = (data: string, i: number) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const signed = (x: bigint) => (x >= 1n << 255n ? x - (1n << 256n) : x);

/** A V3 Swap event's data: amount0, amount1 (int256), sqrtPriceX96, liquidity, tick (PancakeSwap adds two more words). */
export function decodeSwap(data: string, t: number): PoolSwap {
  return { t, a0: Number(signed(word(data, 0))), a1: Number(signed(word(data, 1))), liq: Number(word(data, 3)), tick: Number(signed(word(data, 4))) };
}

export class PoolHistory {
  minutes: PoolMinute[] = [];
  readonly state: SyncState = { syncing: false, done: 0, total: 0, error: null, at: null };
  private toBlock: number | null = null;
  private lastTick: number | null = null;
  private span: number;
  private running: Promise<void> | null = null;
  private lastAsk = 0;
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(readonly ref: PoolRef, private readonly file: string | null, private readonly reader: LogReader, o: HistoryOpts = {}) {
    this.now = o.now ?? Date.now;
    this.gapMs = o.gapMs ?? GAP_MS;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.span = ref.logChunk;
    this.load();
  }

  /** One RPC request, GAP_MS after the last; a failure other than "too many logs" is retried after a growing wait. */
  private async ask<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      const wait = this.lastAsk + this.gapMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAsk = Date.now();
      try { return await fn(); } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (i >= RETRIES || (!RATE_LIMITED.test(msg) && TOO_MANY_LOGS.test(msg))) throw e;
        await this.sleep(1000 * 2 ** i);
      }
    }
  }

  private load() {
    if (!this.file || !existsSync(this.file)) return;
    const f = JSON.parse(readFileSync(this.file, 'utf8')) as PoolFile;
    // a different fee tier or LP share would make the saved fees wrong: start over
    if (f.version !== 1 || f.feeTier !== this.ref.feeTier || f.lpShare !== this.ref.lpShare) return;
    this.minutes = f.rows.map(fromRow);
    this.toBlock = f.toBlock;
    this.lastTick = f.lastTick;
  }

  private save() {
    if (!this.file || this.toBlock == null) return;
    const f: PoolFile = { version: 1, chainId: this.ref.chainId, pool: this.ref.pool, feeTier: this.ref.feeTier, lpShare: this.ref.lpShare, toBlock: this.toBlock, lastTick: this.lastTick, rows: this.minutes.map(toRow) };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(f));
    renameSync(tmp, this.file);
  }

  /** Read every swap since the last sync (the first one reaches back KEEP_DAYS days). One sync at a time per pool. */
  sync(): Promise<void> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run() {
    Object.assign(this.state, { syncing: true, error: null, done: 0, total: 0 });
    try {
      const latest = await this.ask(() => this.reader.getBlockNumber());
      let from = this.toBlock != null ? this.toBlock + 1 : await this.blockAt(this.now() / 1000 - KEEP_DAYS * DAY_S, latest);
      this.state.total = Math.max(0, latest - from + 1);
      let saved = this.now();
      // block times: the end of the last request anchors the next one, so each request reads one block
      let anchor = { n: from, t: await this.time(from) };
      // the smallest span refused in this sync: an RPC whose cap is under TARGET_LOGS would refuse every other request
      let refused = Infinity;
      while (from <= latest) {
        const to = Math.min(latest, from + this.span - 1);
        let logs: Awaited<ReturnType<LogReader['getLogs']>>;
        try {
          logs = await this.ask(() => this.reader.getLogs({ address: this.ref.pool, topics: [[V3_SWAP_TOPIC, PCS_V3_SWAP_TOPIC]], fromBlock: from, toBlock: to }));
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (to === from || RATE_LIMITED.test(msg) || !TOO_MANY_LOGS.test(msg)) throw e;
          refused = Math.min(refused, to - from + 1);
          this.span = Math.max(1, Math.floor((to - from + 1) / 2));
          continue;
        }
        const end = { n: to, t: await this.time(to) }, a = anchor;
        const ts = (bn: number) => (end.n === a.n ? a.t : a.t + ((bn - a.n) * (end.t - a.t)) / (end.n - a.n));
        const swaps = [...logs]
          .sort((x, y) => x.blockNumber - y.blockNumber || (x.index ?? x.logIndex ?? 0) - (y.index ?? y.logIndex ?? 0))
          .map((l) => decodeSwap(l.data, ts(l.blockNumber)));
        this.lastTick = addSwaps(this.minutes, swaps, { feeTier: this.ref.feeTier, lpShare: this.ref.lpShare, lastTick: this.lastTick });
        this.toBlock = to;
        this.state.done += to - from + 1;
        // next span: about TARGET_LOGS swaps at this request's rate, growing at most 4× at a time, under a refused span
        const got = to - from + 1;
        this.span = Math.max(1, Math.min(this.ref.logChunk, 4 * got, Math.floor(refused * 0.8), Math.round((got * TARGET_LOGS) / Math.max(logs.length, 1))));
        anchor = end;
        from = to + 1;
        if (this.now() - saved >= SAVE_EVERY_MS) { this.trim(); this.save(); saved = this.now(); }
      }
      this.trim();
      this.save();
    } catch (e) {
      this.state.error = (e as Error).message.slice(0, 200);
      this.save();
      throw e;
    } finally {
      this.state.syncing = false;
      this.state.at = this.now();
    }
  }

  /** Keep KEEP_DAYS back from the newest minute (not from now: a sync's data ends where it started reading). */
  private trim() {
    const last = this.minutes[this.minutes.length - 1];
    if (!last) return;
    const i = this.minutes.findIndex((m) => m.t > last.t - KEEP_DAYS * DAY_S);
    if (i > 0) this.minutes.splice(0, i);
  }

  private async time(n: number): Promise<number> {
    const b = await this.ask(() => this.reader.getBlock(n));
    if (!b) throw new Error(`block ${n} not found`);
    return b.timestamp;
  }

  /** About the first block at `sec` (unix s): from the chain's block rate near the top, corrected once. */
  private async blockAt(sec: number, latest: number): Promise<number> {
    const probe = Math.max(0, latest - 100_000), tTop = await this.time(latest), tProbe = await this.time(probe);
    const rate = (latest - probe) / Math.max(1, tTop - tProbe);
    const guess = Math.max(0, Math.round(latest - (tTop - sec) * rate));
    return Math.max(0, Math.min(latest, Math.round(guess + (sec - (await this.time(guess))) * rate)));
  }
}

/** The pool histories on disk, one PoolHistory per pool. */
export class PoolHistories {
  private pools = new Map<string, PoolHistory>();
  constructor(private readonly dir: string | null, private readonly reader: (chainId: number) => LogReader, private readonly o: HistoryOpts = {}) {
    if (dir) mkdirSync(dir, { recursive: true });
  }
  get(ref: PoolRef): PoolHistory {
    const key = `${ref.chainId}-${ref.pool.toLowerCase()}`;
    let h = this.pools.get(key);
    if (!h || h.ref.feeTier !== ref.feeTier || h.ref.lpShare !== ref.lpShare) {
      h = new PoolHistory(ref, this.dir ? join(this.dir, `${key}.json`) : null, this.reader(ref.chainId), this.o);
      this.pools.set(key, h);
    }
    return h;
  }
}
