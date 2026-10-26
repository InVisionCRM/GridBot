/**
 * Real-time new-pool watcher. No webhooks: where the chain's reader can subscribe, it does; every chain also
 * polls eth_getLogs so a dropped socket is caught up. Factory addresses come from the chain config and are
 * checked on chain (code present, and router or quoter factory() matches) before any subscription.
 *
 * A pool is empty at creation. It is remembered and evaluated when liquidity is added (V2 Mint/Sync, V3 Mint,
 * V4 ModifyLiquidity). Only pairs with the chain's native coin or a stablecoin are kept. V4 is reported and
 * skipped: this app does not swap it. The age setting of the scan does not apply here.
 */
import {
  backfillRanges, liquidityArrived, parseCreation, parseLiquidity, poolKey, TOPIC, V4_POOL_MANAGER,
  type CreatedPool, type RawLog,
} from '../../market/poolEvents';

export interface SniperDex { id: string; kind: 'v2' | 'v3'; factory: string; router: string; quoter?: string }
export interface SniperChain {
  id: number;
  name: string;
  /** Native wrapper, zero address, 0xeeee…, and stablecoins, lowercase */
  spendable: string[];
  dexes: SniperDex[];
  logChunk: number;
}

export interface LogSource {
  head(chainId: number): Promise<number>;
  getLogs(chainId: number, from: number, to: number, address: string, topics: string[]): Promise<RawLog[]>;
  getCode(chainId: number, address: string): Promise<string>;
  /** factory() on the router or quoter. null when the call fails. */
  factoryOf(chainId: number, address: string): Promise<string | null>;
  /** Optional websocket. Return an unsubscribe. Throw to signal the socket is down; polling still runs. */
  subscribe?(chainId: number, address: string, topic: string, onLog: (log: RawLog) => void): () => void;
  nowBlock?(chainId: number): Promise<number>;
}

export interface SnipeHit {
  chainId: number;
  dex: string;
  kind: 'v2' | 'v3' | 'v4';
  pool: string;
  token0: string;
  token1: string;
  fee: number | null;
  blockNumber: number;
  at: number;
  /** Set when the pool is seen but must not be bought */
  skip: string | null;
}

export interface SniperNote { level: 'info' | 'warn'; msg: string }

const LOOKBACK = 80;
const lc = (a: string) => a.toLowerCase();

interface Waiting {
  created: CreatedPool;
  dex: string;
  chainId: number;
  liqBlock: number | null;
  liqAt: number | null;
}

/**
 * One pass over the factories. `cursors` is the last block read per `chainId:factory` (0 = not yet).
 * `delayBlocks` / `delaySec` hold a pool after liquidity arrives (launch-tax and anti-bot windows).
 */
export class PoolSniper {
  private waiting = new Map<string, Waiting>();
  private seen = new Set<string>();
  private verified = new Map<string, string | null>();
  private unsub: (() => void)[] = [];
  private v4 = new Map<number, boolean>();

  constructor(private readonly d: {
    chains: SniperChain[];
    source: LogSource;
    now?: () => number;
    delayBlocks?: number;
    delaySec?: number;
    lookback?: number;
  }) {}

  private now() { return (this.d.now ?? Date.now)(); }

  /** Drop socket subscriptions (a reconnect subscribes again on the next tick). */
  stop() {
    for (const u of this.unsub) { try { u(); } catch { /* already closed */ } }
    this.unsub = [];
  }

  /** Forget a pool so a test can see it twice only when it really is new. */
  has(chainId: number, pool: string) { return this.seen.has(poolKey(chainId, pool)); }

  async tick(cursors: Record<string, number>, opts?: { delayBlocks?: number; delaySec?: number }): Promise<{ cursors: Record<string, number>; hits: SnipeHit[]; notes: SniperNote[] }> {
    const next = { ...cursors };
    const hits: SnipeHit[] = [];
    const notes: SniperNote[] = [];
    const delayBlocks = opts?.delayBlocks ?? this.d.delayBlocks ?? 2;
    const delaySec = opts?.delaySec ?? this.d.delaySec ?? 15;
    for (const c of this.d.chains) {
      let head = 0;
      try { head = await this.d.source.head(c.id); } catch (e) { notes.push({ level: 'warn', msg: `${c.name}: no block height (${(e as Error).message})` }); continue; }
      await this.watchV4(c, head, next, hits, notes);
      for (const dex of c.dexes) {
        const why = await this.checkFactory(c, dex);
        const key = `${c.id}:${lc(dex.factory)}`;
        if (why) { notes.push({ level: 'warn', msg: `${c.name} ${dex.id}: not watching — ${why}` }); continue; }
        this.listen(c, dex, notes);
        const ranges = backfillRanges(next[key] ?? 0, head, Math.max(1, c.logChunk), this.d.lookback ?? LOOKBACK);
        let failed = false;
        for (const r of ranges) {
          try {
            const logs = await this.d.source.getLogs(c.id, r.from, r.to, dex.factory, [dex.kind === 'v2' ? TOPIC.pairCreated : TOPIC.poolCreated]);
            for (const log of logs) this.onLog(c, dex.id, log);
            next[key] = r.to;
          } catch (e) {
            notes.push({ level: 'warn', msg: `${c.name} ${dex.id}: logs ${r.from}-${r.to} failed (${(e as Error).message}); will retry` });
            failed = true;
            break;
          }
        }
        if (failed) continue;
        if (ranges.length) next[key] = ranges[ranges.length - 1].to;
      }
      await this.collectLiquidity(c, notes);
      hits.push(...this.ready(c, head, delayBlocks, delaySec * 1000));
    }
    return { cursors: next, hits, notes };
  }

  /** A log that arrived on a socket, or a fixture in a test. */
  ingest(chainId: number, dex: string, log: RawLog) {
    const c = this.d.chains.find((x) => x.id === chainId);
    if (!c) return;
    this.onLog(c, dex, log);
  }

  private async checkFactory(c: SniperChain, dex: SniperDex): Promise<string | null> {
    const key = `${c.id}:${lc(dex.factory)}`;
    const cached = this.verified.get(key);
    if (cached !== undefined) return cached;
    let why: string | null = null;
    try {
      const code = await this.d.source.getCode(c.id, dex.factory);
      if (!code || code === '0x' || code === '0x0') why = `no contract code at ${dex.factory}`;
      else {
        const probe = dex.quoter || dex.router;
        const got = await this.d.source.factoryOf(c.id, probe);
        if (!got) why = `factory() on ${probe} did not answer`;
        else if (lc(got) !== lc(dex.factory)) why = `factory() is ${got}, config says ${dex.factory}`;
      }
    } catch (e) { why = (e as Error).message; }
    this.verified.set(key, why);
    return why;
  }

  private listen(c: SniperChain, dex: SniperDex, notes: SniperNote[]) {
    if (!this.d.source.subscribe) return;
    const topic = dex.kind === 'v2' ? TOPIC.pairCreated : TOPIC.poolCreated;
    const id = `${c.id}:${lc(dex.factory)}:${topic}`;
    if (this.unsub.some((u) => (u as { id?: string }).id === id)) return;
    try {
      const stop = this.d.source.subscribe(c.id, dex.factory, topic, (log) => this.onLog(c, dex.id, log));
      (stop as { id?: string }).id = id;
      this.unsub.push(stop);
    } catch (e) {
      notes.push({ level: 'warn', msg: `${c.name} ${dex.id}: subscription failed (${(e as Error).message}); polling instead` });
    }
  }

  private onLog(c: SniperChain, dex: string, log: RawLog) {
    const created = parseCreation(log);
    if (!created || created.kind === 'v4') return;
    const spend = new Set(c.spendable.map(lc));
    if (!spend.has(created.token0) && !spend.has(created.token1)) return;
    if (spend.has(created.token0) && spend.has(created.token1)) return;
    const key = poolKey(c.id, created.pool);
    if (this.seen.has(key) || this.waiting.has(key)) return;
    this.waiting.set(key, { created, dex, chainId: c.id, liqBlock: null, liqAt: null });
  }

  private async watchV4(c: SniperChain, head: number, cursors: Record<string, number>, hits: SnipeHit[], notes: SniperNote[]) {
    if (c.id !== 1) return;
    const key = `${c.id}:v4`;
    if (this.v4.get(c.id) == null) {
      try {
        const code = await this.d.source.getCode(c.id, V4_POOL_MANAGER);
        this.v4.set(c.id, !!code && code !== '0x' && code !== '0x0');
      } catch { this.v4.set(c.id, false); return; }
    }
    if (!this.v4.get(c.id)) return;
    const ranges = backfillRanges(cursors[key] ?? 0, head, Math.max(1, c.logChunk), this.d.lookback ?? LOOKBACK);
    for (const r of ranges) {
      try {
        const logs = await this.d.source.getLogs(c.id, r.from, r.to, V4_POOL_MANAGER, [TOPIC.v4Init]);
        for (const log of logs) {
          const created = parseCreation(log);
          if (!created?.v4 || this.seen.has(poolKey(c.id, created.pool))) continue;
          this.seen.add(poolKey(c.id, created.pool));
          hits.push({ chainId: c.id, dex: 'uniswap-v4', kind: 'v4', pool: created.pool, token0: created.token0, token1: created.token1, fee: created.fee, blockNumber: created.blockNumber, at: this.now(), skip: "this app doesn't swap V4" });
        }
        cursors[key] = r.to;
      } catch (e) {
        notes.push({ level: 'warn', msg: `Ethereum V4: logs failed (${(e as Error).message})` });
        break;
      }
    }
  }

  /** Read Mint/Sync on pools still waiting. One getLogs per pool per tick; a 429 stops the rest. */
  private async collectLiquidity(c: SniperChain, notes: SniperNote[]) {
    const pending = [...this.waiting.values()].filter((w) => w.chainId === c.id && w.liqBlock == null);
    for (const w of pending.slice(0, 20)) {
      const topic = w.created.kind === 'v2' ? TOPIC.v2Mint : TOPIC.v3Mint;
      const from = w.created.blockNumber;
      let head = from;
      try { head = await this.d.source.head(c.id); } catch { continue; }
      try {
        const logs = await this.d.source.getLogs(c.id, from, head, w.created.pool, [topic]);
        const extra = w.created.kind === 'v2' ? await this.d.source.getLogs(c.id, from, head, w.created.pool, [TOPIC.v2Sync]) : [];
        for (const log of [...logs, ...extra]) {
          const add = parseLiquidity(log);
          if (add && liquidityArrived(add)) { w.liqBlock = add.blockNumber; w.liqAt = this.now(); break; }
        }
      } catch (e) {
        notes.push({ level: 'warn', msg: `${c.name}: liquidity read failed (${(e as Error).message})` });
        break;
      }
    }
  }

  private ready(c: SniperChain, head: number, delayBlocks: number, delayMs: number): SnipeHit[] {
    const out: SnipeHit[] = [];
    const now = this.now();
    for (const [key, w] of this.waiting) {
      if (w.chainId !== c.id || w.liqBlock == null || w.liqAt == null) continue;
      if (head - w.liqBlock < delayBlocks || now - w.liqAt < delayMs) continue;
      this.waiting.delete(key);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      out.push({
        chainId: c.id, dex: w.dex, kind: w.created.kind === 'v4' ? 'v4' : w.created.kind,
        pool: w.created.pool, token0: w.created.token0, token1: w.created.token1, fee: w.created.fee,
        blockNumber: w.liqBlock, at: now, skip: null,
      });
    }
    return out;
  }
}
