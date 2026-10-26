/**
 * Which score, measured on one week, predicts what a setup earns the NEXT week? (README: Opportunities → walk-forward)
 *   npx tsx scripts/walkForward.ts collect data/walk-forward.json [pools per chain, default 50]   (~30 min: GeckoTerminal pace)
 *   npx tsx scripts/walkForward.ts analyze data/walk-forward.json
 * collect: each chain's busiest pools on the DEXes the app trades (the scan's filter, one pool per coin), up to 4 weeks
 * of hourly candles (gap-filled, spikes clipped), the depth the app's quoter reads (V2: reserves; V3: active liquidity
 * from slot0 and liquidity()), today's gas and the share of fees LPs keep; every grid and liquidity setup on each week
 * at $1,000, re-centred at the week's start.
 * analyze: for each score on week w, its rank correlation with what the setup chosen in week w earned in week w+1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CHAINS, type ChainConfig, type DexConfig } from '../src/live/chains';
import { fillGaps, trimSpikes, type Candle } from '../src/market/candles';
import { runGridBacktest } from '../src/market/backtest';
import { LP_BANDS, runLpBacktest } from '../src/market/lp';
import { MIN_SELL_HOURS, SETUP_BANDS, SETUP_LEVELS } from '../src/market/scan';
import type { CostModel } from '../src/market/costs';

const TEST_USD = 1000, WEEK = 168;
const ZERO = '0x0000000000000000000000000000000000000000', EEEE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
/** LP share for V3 DEXes whose share is read live from slot0 (Uniswap 0.01/0.05% pools: 0.75; Pancake/9mm: 0.68) */
const V3_LP_SHARE: Record<string, number> = { uniswap: 0.75, pancake: 0.68 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface GridRow { band: number; levels: number; ret: number; earned: number; trades: number; sellHours: number }
interface LpRow { band: number | null; ret: number; earned: number; fees: number; inRange: number }
interface Week { grid: GridRow[]; lp: LpRow[]; volUsd: number; move: number; range: number }
interface PoolData { chain: string; dex: string; kind: 'v2' | 'v3'; name: string; pool: string; feeBps: number; liqUsd: number; depthUsd: number; lpShare: number; weeks: Week[] }

// ── collect ──────────────────────────────────────────────────────────────
let nextAt = 0;
/** GeckoTerminal, one request every 9 s (it allows ~6–7 a minute from one address); a 429 waits 65 s. */
async function gecko(url: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < 6; i++) {
    const w = nextAt - Date.now(); if (w > 0) await sleep(w);
    nextAt = Date.now() + 9000;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.status === 429) { nextAt = Date.now() + 65_000; continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`still rate limited: ${url}`);
}
async function rpc(c: ChainConfig, method: string, params: unknown[] = []): Promise<string> {
  for (let i = 0; i < 4; i++) {
    for (const u of c.rpcs) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json() as { result?: string };
        if (j.result) return j.result;
      } catch { /* the next RPC */ }
    }
    await sleep(1000 * 2 ** i);
  }
  throw new Error(`${c.name}: ${method} failed on every RPC`);
}
const call = (c: ChainConfig, to: string, data: string) => rpc(c, 'eth_call', [{ to, data }, 'latest']);

/** A V3 pool's depth at the price as the app's quoter reads it: virtual reserves of its active liquidity (L/√P, L·√P), human units. */
async function v3Depth(c: ChainConfig, pool: string, stack: string): Promise<{ stack: number; spend: number }> {
  const slot0 = await call(c, pool, '0x3850c7bd'), liq = await call(c, pool, '0x1a686502');
  const t0 = '0x' + (await call(c, pool, '0x0dfe1681')).slice(26).toLowerCase(), t1 = '0x' + (await call(c, pool, '0xd21220a7')).slice(26).toLowerCase();
  const sqrtP = Number(BigInt('0x' + slot0.slice(2, 66))) / 2 ** 96, L = Number(BigInt(liq));
  const d0 = Number(BigInt(await call(c, t0, '0x313ce567'))), d1 = Number(BigInt(await call(c, t1, '0x313ce567')));
  const r0 = L / sqrtP / 10 ** d0, r1 = (L * sqrtP) / 10 ** d1;
  return t0 === stack ? { stack: r0, spend: r1 } : { stack: r1, spend: r0 };
}

interface Pool { dex: DexConfig; address: string; name: string; stack: string; feeBps: number; liqUsd: number; vol24Usd: number; tx24: number; usdStack: number; usdSpend: number }
const idAddr = (id: string) => id.slice(id.lastIndexOf('_') + 1).toLowerCase();

async function topPools(c: ChainConfig, perChain: number): Promise<{ pools: Pool[]; nativeUsd: number }> {
  const wrapped = c.wrappedNative.address.toLowerCase();
  const spendable = new Set([wrapped, ...c.stables.map((s) => s.address.toLowerCase())]);
  const norm = (a: string) => (a === ZERO || a === EEEE ? wrapped : a);
  const out: Pool[] = [];
  let nativeUsd: number | null = null;
  for (const dex of c.dexes) {
    if (!dex.gecko) continue;
    for (let page = 1; page <= 3; page++) {
      const rows: any[] = (await gecko(`https://api.geckoterminal.com/api/v2/networks/${c.geckoSlug}/dexes/${dex.gecko}/pools?sort=h24_volume_usd_desc&page=${page}`)).data ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const p of rows) {
        const a = p.attributes, rel = p.relationships;
        const base = norm(idAddr(rel.base_token.data.id)), quote = norm(idAddr(rel.quote_token.data.id));
        const b = spendable.has(base), q = spendable.has(quote);
        if (b === q) continue;
        const usdBase = Number(a.base_token_price_usd), usdQuote = Number(a.quote_token_price_usd);
        nativeUsd ??= base === wrapped ? usdBase : quote === wrapped ? usdQuote : null;
        const name: string = a.name ?? '';
        const feeBps = dex.kind === 'v3' ? Number((/([\d.]+)%\s*$/.exec(name) ?? [])[1]) * 100 : dex.feeBps ?? NaN;
        if (!Number.isFinite(feeBps)) continue;
        const tx = a.transactions?.h24 ?? {};
        out.push({
          dex, address: String(a.address).toLowerCase(), name, stack: b ? quote : base, feeBps,
          liqUsd: Number(a.reserve_in_usd) || 0, vol24Usd: Number(a.volume_usd?.h24) || 0, tx24: (Number(tx.buys) || 0) + (Number(tx.sells) || 0),
          usdStack: b ? usdQuote : usdBase, usdSpend: b ? usdBase : usdQuote,
        });
      }
      if (rows.length < 20) break;
    }
  }
  if (nativeUsd == null) throw new Error(`${c.name}: no USD price for ${c.nativeSymbol}`);
  // the scan's filter (lower thresholds than the scan's 50 trades, to keep enough pools), one pool per coin, busiest first
  const seen = new Set<string>();
  const pools = out.filter((p) => p.liqUsd >= 10_000 && p.tx24 >= 20 && p.vol24Usd / p.liqUsd <= 20 && p.usdStack > 0 && p.usdSpend > 0)
    .sort((a, b) => b.vol24Usd - a.vol24Usd)
    .filter((p) => (seen.has(p.stack) ? false : (seen.add(p.stack), true)))
    .slice(0, perChain);
  return { pools, nativeUsd };
}

async function ohlcv(c: ChainConfig, pool: string, token: string, feeBps: number): Promise<Candle[]> {
  const j = await gecko(`https://api.geckoterminal.com/api/v2/networks/${c.geckoSlug}/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=token&token=${token}`);
  const rows: number[][] = j.data?.attributes?.ohlcv_list ?? [];
  const k = 1 - feeBps / 10_000;
  return rows.filter((x) => x.length >= 6 && x[4] > 0).map(([t, o, h, l, cl, v]) => ({ t, o: o * k, h: h * k, l: l * k, c: cl * k, v })).sort((a, b) => a.t - b.t);
}

function week(k: Candle[], costs: CostModel, capital: number, kind: 'v2' | 'v3', lpShare: number, usdSpend: number): Week {
  const p0 = k[0].o, grid: GridRow[] = [], lp: LpRow[] = [];
  for (const band of SETUP_BANDS) for (const levels of SETUP_LEVELS) {
    try {
      const r = runGridBacktest(k, { lowerPrice: p0 * (1 - band), upperPrice: p0 * (1 + band), gridCount: levels, capital }, '1h', costs);
      grid.push({ band, levels, ret: r.metrics.totalReturn, earned: r.metrics.earned / capital, trades: r.metrics.trades, sellHours: new Set(r.trades.map((t) => t.exitT)).size });
    } catch { /* not possible at this size */ }
  }
  for (const band of kind === 'v2' ? [null] : LP_BANDS) {
    try {
      const r = runLpBacktest(k, { kind, capital, bandPct: band, lpShare }, costs);
      lp.push({ band, ret: r.returnPct, earned: r.earnedPct, fees: r.feesPct, inRange: r.inRangePct });
    } catch { /* opening costs more than the amount */ }
  }
  return { grid, lp, volUsd: k.reduce((a, x) => a + x.v, 0) * usdSpend, move: k[k.length - 1].c / k[0].o - 1, range: k.reduce((a, x) => a + Math.log(x.h / x.l), 0) };
}

async function collect(file: string, perChain: number) {
  const out: PoolData[] = [];
  for (const c of CHAINS.filter((x) => x.status === 'live' && x.geckoSlug)) {
    const { pools, nativeUsd } = await topPools(c, perChain);
    const gasNative = Number(BigInt(await rpc(c, 'eth_gasPrice'))) / 1e18;
    log(`${c.name}: ${pools.length} pools`);
    for (const [i, p] of pools.entries()) {
      try {
        const lastClosed = Math.floor(Date.now() / 3_600_000) * 3600 - 3600;
        const k = trimSpikes(fillGaps((await ohlcv(c, p.address, p.stack, p.feeBps)).filter((x) => x.t <= lastClosed), '1h', lastClosed));
        const weeks = Math.min(4, Math.floor(k.length / WEEK));
        if (weeks < 2) { log(`${p.name}: ${k.length} hours of history, skipped`); continue; }
        const depth = p.dex.kind === 'v3' ? await v3Depth(c, p.address, p.stack) : { spend: p.liqUsd / 2 / p.usdSpend, stack: p.liqUsd / 2 / p.usdStack };
        const costs: CostModel = {
          feeBps: p.feeBps, approval: 'exact', slippageBps: 10, pool: { quoteReserve: depth.spend, plsReserve: depth.stack },
          gasPricePls: gasNative * (nativeUsd / p.usdStack), gasUnits: c.gasUnits,
        };
        const lpShare = p.dex.lpShare ?? (p.dex.kind === 'v3' ? V3_LP_SHARE[p.dex.protocolFee ?? 'uniswap'] : 1);
        const ws = Array.from({ length: weeks }, (_, w) => k.slice(k.length - (weeks - w) * WEEK, k.length - (weeks - w - 1) * WEEK));
        out.push({
          chain: c.name, dex: p.dex.id, kind: p.dex.kind, name: p.name, pool: p.address, feeBps: p.feeBps, liqUsd: p.liqUsd,
          depthUsd: depth.spend * p.usdSpend * 2, lpShare, weeks: ws.map((x) => week(x, costs, TEST_USD / p.usdSpend, p.dex.kind, lpShare, p.usdSpend)),
        });
        log(`${c.name} ${i + 1}/${pools.length} ${p.name}: ${weeks} weeks`);
      } catch (e) { log(`${p.name}: ${(e as Error).message}`); }
      writeFileSync(file, JSON.stringify(out));
    }
  }
  log(`done: ${out.length} pools → ${file}`);
}

// ── analyze ──────────────────────────────────────────────────────────────
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Ranks with ties averaged (0-based). */
function ranks(xs: number[]): number[] {
  const o = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]), r = new Array<number>(xs.length);
  for (let i = 0; i < o.length;) {
    let j = i;
    while (j + 1 < o.length && xs[o[j + 1]] === xs[o[i]]) j++;
    for (let k = i; k <= j; k++) r[o[k]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a), rb = ranks(b), ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

interface Sample { pool: string; scores: Record<string, number>; next: number; nextByRet: number; nextRet: number }

function samples(d: PoolData[]) {
  const G: Sample[] = [], LP: Sample[] = [];
  const pickGrid = (rows: GridRow[], k: 'earned' | 'ret') => { const ok = rows.filter((r) => r.sellHours >= MIN_SELL_HOURS); return (ok.length ? ok : rows).reduce((a, b) => (b[k] > a[k] ? b : a)); };
  const pickLp = (rows: LpRow[], k: 'earned' | 'ret') => rows.reduce((a, b) => (b[k] > a[k] ? b : a));
  for (const p of d) {
    for (let w = 0; w + 1 < p.weeks.length; w++) {
      const a = p.weeks[w], b = p.weeks[w + 1];
      const feat = { turnover: a.volUsd / Math.max(p.depthUsd, 1), swing: a.range };
      if (a.grid.length && b.grid.length) {
        const ge = pickGrid(a.grid, 'earned'), gr = pickGrid(a.grid, 'ret');
        const ne = b.grid.find((r) => r.band === ge.band && r.levels === ge.levels), nr = b.grid.find((r) => r.band === gr.band && r.levels === gr.levels);
        if (ne && nr) G.push({ pool: p.name, scores: { ...feat, earned: ge.earned, totalReturn: gr.ret }, next: ne.earned, nextByRet: nr.earned, nextRet: ne.ret });
      }
      // a liquidity bot runs V3 ranges only (±1–50%)
      const la = p.kind === 'v3' ? a.lp.filter((r) => r.band != null) : [], lb = p.kind === 'v3' ? b.lp.filter((r) => r.band != null) : [];
      if (la.length && lb.length && p.lpShare > 0) {
        const le = pickLp(la, 'earned'), lr = pickLp(la, 'ret');
        const ne = lb.find((r) => r.band === le.band), nr = lb.find((r) => r.band === lr.band);
        if (ne && nr) LP.push({ pool: p.name, scores: { ...feat, earned: le.earned, totalReturn: lr.ret }, next: ne.earned, nextByRet: nr.earned, nextRet: ne.ret });
      }
    }
  }
  return { G, LP };
}

function analyze(file: string) {
  const d = JSON.parse(readFileSync(file, 'utf8')) as PoolData[];
  const { G, LP } = samples(d);
  for (const [name, S] of [['Grid', G], ['Liquidity', LP]] as const) {
    console.log(`\n${name}: ${S.length} pool-weeks from ${new Set(S.map((s) => s.pool)).size} pools · next-week earned mean ${pct(mean(S.map((s) => s.next)))}`);
    for (const sc of ['earned', 'totalReturn', 'swing', 'turnover']) {
      const top = [...S].sort((a, b) => b.scores[sc] - a.scores[sc]).slice(0, Math.max(1, Math.floor(S.length / 10)));
      console.log(`  ${sc.padEnd(12)} rank correlation ${spearman(S.map((s) => s.scores[sc]), S.map((s) => s.next)).toFixed(2).padStart(5)} · top 10% next week ${pct(mean(top.map((t) => t.next)))} (${top.filter((t) => t.next > 0).length}/${top.length} positive)`);
    }
    console.log(`  next ÷ last week's figure: ${(mean(S.map((s) => s.next)) / mean(S.map((s) => s.scores.earned))).toFixed(2)} · chosen by earned ${pct(mean(S.map((s) => s.next)))} vs by total return ${pct(mean(S.map((s) => s.nextByRet)))} the next week · next week's total return ${pct(mean(S.map((s) => s.nextRet)))}`);
  }
  // the same comparison on each half of the pools separately (names in sorted order, every other one)
  const names = [...new Set(G.map((s) => s.pool))].sort(), half = new Set(names.filter((_, i) => i % 2 === 0));
  for (const inHalf of [true, false]) {
    const T = G.filter((s) => half.has(s.pool) === inHalf);
    console.log(`  grid, half ${inHalf ? 'A' : 'B'} of the pools (${T.length} pool-weeks): swing ${spearman(T.map((s) => s.scores.swing), T.map((s) => s.next)).toFixed(2)} · last week's grid earnings ${spearman(T.map((s) => s.scores.earned), T.map((s) => s.next)).toFixed(2)}`);
  }
}

const [mode, file, n] = process.argv.slice(2);
if (mode === 'collect' && file) await collect(file, Number(n ?? 50));
else if (mode === 'analyze' && file) analyze(file);
else throw new Error('usage: npx tsx scripts/walkForward.ts collect|analyze <file.json> [pools per chain]');
