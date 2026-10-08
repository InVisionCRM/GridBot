/**
 * Candle storage: one JSON file per market under data/candles/ (legacy PulseChain keys keep their file names,
 * e.g. DAI.json; multi-chain keys are sanitized: base:ETH/USDC → base_ETH-USDC.json), compact rows, debounced atomic writes.
 * Flipped markets ('HEX~' = HEX/PLS) have no file of their own: they read the original series inverted (high ↔ 1/low),
 * so both orientations always show the same history.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFlipKey, seriesFile, unflipKey } from '../../live/markets';
import { TFS, TF_CAP, aggregate, applyTick, bucketStart, invertCandles, mergeCandles, type Candle, type TF } from '../../market/candles';

type Row = [number, number, number, number, number, number, 0 | 1];
const toRow = (k: Candle): Row => [k.t, k.o, k.h, k.l, k.c, k.v, k.f ? 1 : 0];
const fromRow = (r: Row): Candle => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], ...(r[6] ? { f: 1 as const } : {}) });

export interface SeriesMeta { source: 'gecko' | 'onchain' | 'poll' | 'mixed'; backfilledTo?: number; updatedAt: number }

export class CandleStore {
  private data = new Map<string, Candle[]>();
  private meta = new Map<string, SeriesMeta>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** dir = null → memory only (tests) */
  constructor(private readonly dir: string | null, private readonly saveDelayMs = 5000) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  private key(pair: string, tf: TF) { return `${pair}|${tf}`; }

  private loadPair(pair: string) {
    if (!this.dir || [...this.data.keys()].some((k) => k.startsWith(pair + '|'))) return;
    const f = join(this.dir, `${seriesFile(pair)}.json`);
    let raw: { series?: Record<string, Row[]>; meta?: Record<string, SeriesMeta> } = {};
    if (existsSync(f)) { try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch { raw = {}; } }
    for (const tf of TFS) {
      this.data.set(this.key(pair, tf), (raw.series?.[tf] ?? []).map(fromRow));
      if (raw.meta?.[tf]) this.meta.set(this.key(pair, tf), raw.meta[tf]);
    }
  }

  private inverted = new Map<string, { src: Candle[]; n: number; t: number; c: number; out: Candle[] }>();

  get(pair: string, tf: TF): Candle[] {
    if (isFlipKey(pair)) {
      // Memoized on the source series identity + its tail (ticks mutate the last candle in place).
      const src = this.get(unflipKey(pair), tf), last = src[src.length - 1];
      const k = this.key(pair, tf), c = this.inverted.get(k);
      if (c && c.src === src && c.n === src.length && c.t === (last?.t ?? 0) && c.c === (last ? last.c * 1e6 + last.h + last.l : 0)) return c.out;
      const out = invertCandles(src);
      this.inverted.set(k, { src, n: src.length, t: last?.t ?? 0, c: last ? last.c * 1e6 + last.h + last.l : 0, out });
      return out;
    }
    this.loadPair(pair);
    const k = this.key(pair, tf);
    if (!this.data.has(k)) this.data.set(k, []);
    return this.data.get(k)!;
  }
  getMeta(pair: string, tf: TF): SeriesMeta | null { pair = unflipKey(pair); this.loadPair(pair); return this.meta.get(this.key(pair, tf)) ?? null; }

  /** A poll price this far from the last 1m close is held back until confirmed (guards against RPC glitches). */
  static readonly OUTLIER = 0.2;
  static readonly CONFIRM = 3;
  private outliers = new Map<string, { dir: number; n: number }>();

  /**
   * Live poll price → update the open bucket of every timeframe. Returns false when the price was held back as
   * an outlier: > OUTLIER from the last 1m close (within 15 min) and not yet seen CONFIRM polls in a row on that side.
   */
  tick(pair: string, price: number, tsSec: number): boolean {
    if (!(price > 0) || !Number.isFinite(price)) return false;
    // Flipped markets are derived from the original series (the poller always prices the original too).
    if (isFlipKey(pair)) return true;
    const last = this.get(pair, '1m').at(-1);
    if (last && tsSec - last.t < 900 && Math.abs(price / last.c - 1) > CandleStore.OUTLIER) {
      const dir = Math.sign(price - last.c), o = this.outliers.get(pair);
      const n = o && o.dir === dir ? o.n + 1 : 1;
      this.outliers.set(pair, { dir, n });
      if (n < CandleStore.CONFIRM) return false;
    }
    this.outliers.delete(pair);
    for (const tf of TFS) {
      const s = this.get(pair, tf);
      applyTick(s, price, tsSec, tf);
      if (s.length > TF_CAP[tf] * 1.1) s.splice(0, s.length - TF_CAP[tf]);
      const m = this.meta.get(this.key(pair, tf));
      this.meta.set(this.key(pair, tf), { source: m && m.source !== 'poll' ? 'mixed' : 'poll', backfilledTo: m?.backfilledTo, updatedAt: tsSec });
    }
    this.markDirty(pair);
    return true;
  }

  /** Merge externally sourced candles (incoming wins; the live open bucket keeps its range). */
  merge(pair: string, tf: TF, incoming: Candle[], source: 'gecko' | 'onchain', nowSec = Math.floor(Date.now() / 1000)) {
    if (!incoming.length) return;
    if (isFlipKey(pair)) { this.merge(unflipKey(pair), tf, invertCandles(incoming), source, nowSec); return; }
    const k = this.key(pair, tf);
    const merged = mergeCandles(this.get(pair, tf), incoming, TF_CAP[tf], bucketStart(nowSec, tf));
    this.data.set(k, merged);
    const m = this.meta.get(k);
    const first = incoming[0].t;
    this.meta.set(k, { source: m && m.source !== source ? 'mixed' : source, backfilledTo: Math.min(m?.backfilledTo ?? first, first), updatedAt: nowSec });
    this.markDirty(pair);
  }

  /** Merge 1m candles and derive every higher timeframe from them (used by the on-chain rebuilder). */
  mergeFrom1m(pair: string, oneMin: Candle[], source: 'gecko' | 'onchain', nowSec?: number) {
    for (const tf of TFS) this.merge(pair, tf, tf === '1m' ? oneMin : aggregate(oneMin, tf), source, nowSec);
  }

  private markDirty(pair: string) {
    if (!this.dir) return;
    this.dirty.add(pair);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.saveDelayMs);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dir) return;
    for (const pair of this.dirty) {
      const series: Record<string, Row[]> = {}, meta: Record<string, SeriesMeta> = {};
      for (const tf of TFS) {
        series[tf] = this.get(pair, tf).map(toRow);
        const m = this.meta.get(this.key(pair, tf)); if (m) meta[tf] = m;
      }
      const f = join(this.dir, `${seriesFile(pair)}.json`);
      writeFileSync(f + '.tmp', JSON.stringify({ pair, series, meta }));
      renameSync(f + '.tmp', f);
    }
    this.dirty.clear();
  }

  summary(pairs: string[]) {
    return pairs.map((pair) => ({
      pair,
      series: TFS.map((tf) => {
        const s = this.get(pair, tf);
        return { tf, count: s.length, from: s[0]?.t ?? null, to: s[s.length - 1]?.t ?? null, source: this.getMeta(pair, tf)?.source ?? null };
      }),
    }));
  }
}
