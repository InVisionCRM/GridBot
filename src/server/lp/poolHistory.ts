/**
 * Trade history of pools for the liquidity and grid replays: each pool's trades folded into minutes. A V3 pool's Swap
 * events carry the tick and the fees (market/lpReplay); a V2 pool's Sync events carry both reserves after every trade,
 * whose ratio is the price, kept on the same tick scale (fractional) with no fees (the grid replay needs the price only).
 * The history is
 * kept for up to MAX_DAYS days in data/pool-history/<chainId>-<pool>.json and topped up when a replay is asked for.
 * The first read covers the window asked for (the page asks for 7 days first); a longer window, when someone picks it,
 * is read backwards a day at a time from where the history starts, saved as it goes, so a long read survives a restart.
 *
 * Requests go through the chain's fallback reader one at a time, so the live bots keep its other slots. RPCs cap the
 * logs one request may return (Robinhood: 10 000; its WETH/USDG 0.01 % pool had ≈210 000 swaps a day in October 2026),
 * so each request asks for about TARGET_LOGS swaps' worth of blocks, sized from the last answer, and halves its span
 * when a request fails. Block times are interpolated inside each request's span, like onchain.ts does for candles.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addSwaps, type PoolMinute, type PoolSwap } from '../../market/lpReplay';
import { QUERY_TOO_WIDE } from '../chains/fallback';
import { PCS_V3_SWAP_TOPIC, SYNC_TOPIC, V3_SWAP_TOPIC, type LogReader } from '../market/onchain';

/** The replay windows, in days; the page opens on DEFAULT_DAYS and reads a longer one only when it is picked */
export const REPLAY_DAYS = [1, 7, 30, 365] as const;
export type ReplayDays = (typeof REPLAY_DAYS)[number];
export const DEFAULT_DAYS: ReplayDays = 7;
/** Days of history kept per pool: the longest window */
export const MAX_DAYS = 365;
const DAY_S = 86_400;
/** History that starts this close after a window's start covers it (the block found for a time is approximate) */
const COVER_SLACK_S = 3600;
const TARGET_LOGS = 5000;
const SAVE_EVERY_MS = 30_000;
/** A public RPC answers 429 to a burst (Robinhood did after ≈2.4 M blocks in 2 minutes): requests keep this gap and a refused one waits 1, 2, 4, 8, 16 s */
const GAP_MS = 250;
const RETRIES = 5;
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
/** An RPC refusing a request because its answer would hold too many logs (or span too many blocks): ask for fewer blocks */

export interface HistoryOpts { now?: () => number; gapMs?: number; sleep?: (ms: number) => Promise<void> }

/** One pool to keep: where, its kind, its fee tier (hundredths of a bip), the LPs' share of fees, the chain's largest log request. */
export interface PoolRef { chainId: number; pool: string; kind: 'v2' | 'v3'; feeTier: number; lpShare: number; logChunk: number }

export interface SyncState {
  syncing: boolean;
  /** Blocks read and to read in the running (or last) sync */
  done: number; total: number;
  error: string | null;
  /** When the last sync ended, done or failed (ms) */
  at: number | null;
  /** A sync has read every swap up to the chain's head (kept in the file): a later sync only tops the minutes up */
  ready: boolean;
  /** Where the history starts (unix s): every swap from here to the last block read is in the minutes */
  from: number | null;
}

type Row = [number, number, number, number, number, number, number, number];
/** version 2 adds where the history starts (fromBlock / fromT); a version 1 file is read again from scratch */
interface PoolFile { version: 2; chainId: number; pool: string; kind: 'v2' | 'v3'; feeTier: number; lpShare: number; fromBlock: number | null; fromT: number; toBlock: number; lastTick: number | null; rows: Row[]; ready: boolean }

const toRow = (m: PoolMinute): Row => [m.t, m.lo, m.hi, m.c, m.f0, m.f1, m.liq, m.n];
const fromRow = (r: Row): PoolMinute => ({ t: r[0], lo: r[1], hi: r[2], c: r[3], f0: r[4], f1: r[5], liq: r[6], n: r[7] });
const word = (data: string, i: number) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const signed = (x: bigint) => (x >= 1n << 255n ? x - (1n << 256n) : x);

/** A V3 Swap event's data: amount0, amount1 (int256), sqrtPriceX96, liquidity, tick (PancakeSwap adds two more words). */
export function decodeSwap(data: string, t: number): PoolSwap {
  return { t, a0: Number(signed(word(data, 0))), a1: Number(signed(word(data, 1))), liq: Number(word(data, 3)), tick: Number(signed(word(data, 4))) };
}

/**
 * A V2 Sync event's data: reserve0, reserve1 (uint112) after a trade. The price (raw token1 per raw token0) on the V3
 * tick scale, fractional; no amounts or liquidity, so no fees. Null for an empty side (a pool being drained or seeded).
 */
export function decodeSync(data: string, t: number): PoolSwap | null {
  const r0 = Number(word(data, 0)), r1 = Number(word(data, 1));
  if (!(r0 > 0 && r1 > 0)) return null;
  return { t, a0: 0, a1: 0, liq: 0, tick: Math.log(r1 / r0) / Math.log(1.0001) };
}

export class PoolHistory {
  minutes: PoolMinute[] = [];
  readonly state: SyncState = { syncing: false, done: 0, total: 0, error: null, at: null, ready: false, from: null };
  private toBlock: number | null = null;
  /** The first block read; null once trimming moved the start past it (a backward read then looks the block up) */
  private fromBlock: number | null = null;
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
        if (i >= RETRIES || (!RATE_LIMITED.test(msg) && QUERY_TOO_WIDE.test(msg))) throw e;
        await this.sleep(1000 * 2 ** i);
      }
    }
  }

  private load() {
    if (!this.file || !existsSync(this.file)) return;
    const f = JSON.parse(readFileSync(this.file, 'utf8')) as PoolFile;
    // a different fee tier or LP share would make the saved fees wrong, and a version 1 file doesn't say where it starts: start over
    if (f.version !== 2 || f.kind !== this.ref.kind || f.feeTier !== this.ref.feeTier || f.lpShare !== this.ref.lpShare) return;
    this.minutes = f.rows.map(fromRow);
    this.toBlock = f.toBlock;
    this.fromBlock = f.fromBlock;
    this.lastTick = f.lastTick;
    this.state.from = f.fromT;
    // a first read stopped half way (saved every SAVE_EVERY_MS) has not reached the head yet
    this.state.ready = f.ready;
  }

  private save() {
    if (!this.file || this.toBlock == null || this.state.from == null) return;
    const f: PoolFile = { version: 2, chainId: this.ref.chainId, pool: this.ref.pool, kind: this.ref.kind, feeTier: this.ref.feeTier, lpShare: this.ref.lpShare, fromBlock: this.fromBlock, fromT: this.state.from, toBlock: this.toBlock, lastTick: this.lastTick, rows: this.minutes.map(toRow), ready: this.state.ready };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(f));
    renameSync(tmp, this.file);
  }

  /** The minutes cover the last `days` days up to the last block read (the head, after a full read). */
  covers(days: number, nowSec = this.now() / 1000): boolean {
    return this.state.ready && this.state.from != null && this.state.from <= nowSec - days * DAY_S + COVER_SLACK_S;
  }

  /**
   * Read every swap since the last sync, and, when the history starts later than `days` ago, the days before it. The
   * first sync reaches back `days` days. One sync at a time per pool: asked again while one runs, it returns that one.
   */
  sync(days: number = DEFAULT_DAYS): Promise<void> {
    if (!(days > 0 && days <= MAX_DAYS)) throw new Error(`a pool history keeps 1 to ${MAX_DAYS} days, not ${days}`);
    this.running ??= this.run(days).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(days: number) {
    Object.assign(this.state, { syncing: true, error: null, done: 0, total: 0 });
    try {
      const latest = await this.ask(() => this.reader.getBlockNumber());
      const target = this.now() / 1000 - days * DAY_S;
      let saved = this.now();
      const saveNow = () => { if (this.now() - saved >= SAVE_EVERY_MS) { this.trim(); this.save(); saved = this.now(); } };
      if (this.toBlock == null) {
        const start = await this.blockAt(target, latest);
        this.fromBlock = start;
        this.state.from = await this.time(start);
        this.state.total = latest - start + 1;
        this.lastTick = await this.read(start, latest, this.minutes, this.lastTick, (to) => { this.toBlock = to; saveNow(); });
      } else {
        // the week already read first: its new blocks are a few requests; then the older days, if this window needs them
        const back = this.state.from! > target + COVER_SLACK_S ? await this.blockAt(target, latest) : null;
        const fromBlock = this.fromBlock ?? (back == null ? null : await this.blockAt(this.state.from!, latest));
        this.state.total = Math.max(0, latest - this.toBlock) + (back != null && fromBlock != null ? Math.max(0, fromBlock - back) : 0);
        if (this.toBlock < latest) this.lastTick = await this.read(this.toBlock + 1, latest, this.minutes, this.lastTick, (to) => { this.toBlock = to; saveNow(); });
        if (back != null) await this.readBack(back, fromBlock!, target, latest, saveNow);
      }
      this.trim();
      this.state.ready = true;
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

  /**
   * The days before the history's start, newest first, a day per pass: each day's swaps are read oldest first into
   * minutes of their own, put in front, and the start moves back, so what has been read is kept if the read stops.
   */
  private async readBack(back: number, fromBlock: number, target: number, latest: number, saveNow: () => void) {
    let start = fromBlock;
    while (start > back) {
      const dayT = Math.max(target, this.state.from! - DAY_S);
      const lo = Math.max(back, Math.min(start - 1, dayT <= target ? back : await this.blockAt(dayT, latest)));
      const older: PoolMinute[] = [];
      await this.read(lo, start - 1, older, null, () => {});
      this.prepend(older);
      start = lo;
      this.fromBlock = lo;
      this.state.from = await this.time(lo);
      saveNow();
    }
  }

  /** Older minutes in front of the history; a minute both hold (the boundary) becomes one. */
  private prepend(older: PoolMinute[]) {
    const a = older[older.length - 1], b = this.minutes[0];
    if (a && b && a.t === b.t) {
      // the older part is first in the minute; the newer part ends it
      this.minutes[0] = { t: b.t, lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi), c: b.c, f0: a.f0 + b.f0, f1: a.f1 + b.f1, liq: (a.liq * a.n + b.liq * b.n) / (a.n + b.n), n: a.n + b.n };
      older.pop();
    }
    if (older.length) this.minutes.unshift(...older);
  }

  /**
   * Every swap in blocks [from, to] into `into` (oldest first, after what it holds), starting from `lastTick`; calls
   * `done(block)` after each request. Returns where the price is after the last swap.
   */
  private async read(from: number, to: number, into: PoolMinute[], lastTick: number | null, done: (block: number) => void): Promise<number | null> {
    // block times: the end of the last request anchors the next one, so each request reads one block
    let anchor = { n: from, t: await this.time(from) };
    // the smallest span refused in this read: an RPC whose cap is under TARGET_LOGS would refuse every other request
    let refused = Infinity;
    while (from <= to) {
      const end = Math.min(to, from + this.span - 1);
      let logs: Awaited<ReturnType<LogReader['getLogs']>>;
      try {
        logs = await this.ask(() => this.reader.getLogs({ address: this.ref.pool, topics: [this.ref.kind === 'v3' ? [V3_SWAP_TOPIC, PCS_V3_SWAP_TOPIC] : [SYNC_TOPIC]], fromBlock: from, toBlock: end }));
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (end === from || RATE_LIMITED.test(msg) || !QUERY_TOO_WIDE.test(msg)) throw e;
        refused = Math.min(refused, end - from + 1);
        this.span = Math.max(1, Math.floor((end - from + 1) / 2));
        continue;
      }
      const e = { n: end, t: await this.time(end) }, a = anchor;
      const ts = (bn: number) => (e.n === a.n ? a.t : a.t + ((bn - a.n) * (e.t - a.t)) / (e.n - a.n));
      const swaps = [...logs]
        .sort((x, y) => x.blockNumber - y.blockNumber || (x.index ?? x.logIndex ?? 0) - (y.index ?? y.logIndex ?? 0))
        .flatMap((l) => {
          if (this.ref.kind === 'v3') return [decodeSwap(l.data, ts(l.blockNumber))];
          const sync = decodeSync(l.data, ts(l.blockNumber));
          return sync ? [sync] : [];
        });
      lastTick = addSwaps(into, swaps, { feeTier: this.ref.feeTier, lpShare: this.ref.lpShare, lastTick });
      this.state.done += end - from + 1;
      // next span: about TARGET_LOGS swaps at this request's rate, growing at most 4× at a time, under a refused span
      const got = end - from + 1;
      this.span = Math.max(1, Math.min(this.ref.logChunk, 4 * got, Math.floor(refused * 0.8), Math.round((got * TARGET_LOGS) / Math.max(logs.length, 1))));
      anchor = e;
      from = end + 1;
      done(end);
    }
    return lastTick;
  }

  /** Keep MAX_DAYS back from the newest minute (not from now: a sync's data ends where it started reading). */
  private trim() {
    const last = this.minutes[this.minutes.length - 1];
    if (!last) return;
    const cut = last.t - MAX_DAYS * DAY_S;
    if (this.state.from == null || this.state.from >= cut) return;
    const i = this.minutes.findIndex((m) => m.t > cut);
    if (i > 0) this.minutes.splice(0, i);
    this.state.from = cut;
    this.fromBlock = null;
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
    if (!h || h.ref.kind !== ref.kind || h.ref.feeTier !== ref.feeTier || h.ref.lpShare !== ref.lpShare) {
      h = new PoolHistory(ref, this.dir ? join(this.dir, `${key}.json`) : null, this.reader(ref.chainId), this.o);
      this.pools.set(key, h);
    }
    return h;
  }
}
