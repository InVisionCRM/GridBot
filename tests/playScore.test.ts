/**
 * Per-play scores. The fixture is Robinhood Chain (4663): WETH/USDG 0.01% pool
 * 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca, WETH 0x0Bd7…cAD73, USDG 0x5fc5…d168.
 * The live pool's fee tier is 100. A second read of 500 is the dynamic-fee case:
 * the exit fee is not copied from the entry.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { Logger } from '../src/server/bot/logger';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { TokenTrader, type TraderState } from '../src/server/bot/tokenTrader';
import { MockChain, NET } from './helpers/mockChain';
import type { FreshPool, GateInput } from '../src/market/tokenTrader';
import {
  blankPlay, feeFraction, playFromCandidate, playLeaderboard, scorePlay, setHorizon,
  type PlayRecord,
} from '../src/metrics/playScore';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-18T15:00:00Z');
const CHAIN = 4663;
const POOL = '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

const clean = (o: Partial<GateInput> = {}): GateInput => ({
  mode: 'paper', risk: 'safe', honeypot: false, sellSimOk: true, paused: false, decimals: 18,
  buyTax: 0, sellTax: 0, liquidityUsd: 80_000, minLiquidityUsd: 0,
  canMint: false, canPause: false, canBlacklist: false, proxy: false, lpUnlocked: null,
  holderConcentration: null, recentLiqPull: false, liveAllowed: true, ...o,
});

let n = 0;
const pool = (o: Partial<FreshPool> = {}): FreshPool => ({
  chainId: CHAIN, pool: '0x' + (n++).toString(16).padStart(40, 'b'), dex: 'uniswap-v3', kind: 'v3',
  token: WETH, spend: USDG, tokenSymbol: 'WETH', spendSymbol: 'USDG',
  liquidityUsd: 2_000_000, volumeUsd: 50_000, createdAt: 0, source: 'new',
  quoteReserve: 1_000_000, tokenReserve: 250, feeBps: 1, price: 4000, usdPerSpend: 1, ...o,
});

/** A closed Robinhood play with receipt gas of zero, so the grade is measured and the net is quote_out − size. */
function graded(over: Partial<PlayRecord> = {}): PlayRecord {
  return blankPlay({
    play_id: 'p', kind: 'play', signal_type: 'new_pool', source: 'uniswap-v3',
    passed: true, rejected: false, chain_id: CHAIN, pool_address: POOL, token_contract: WETH,
    priceAtFlag: 4000, entry_at: T0, exit_at: T0 + HOUR, entry_price: 4000, exit_price: 4200,
    feeTierEntry: 100, feeTierExit: 100, price_impact_entry: 0, price_impact_exit: 0, sell_tax: 0,
    size_spend: 1000, spend_symbol: 'USDG', usd_per_spend: 1, native_to_spend: 4000,
    gas_used: 0, gas_price: 0, gas_native: 0, gas_assumed: false, quote_out: 1010,
    target_pct: 0.5, stop_pct: 0.25, ...over,
  });
}

describe('scorePlay', () => {
  it('nets a dynamic Robinhood fee, impact, gas and tax from the two reads', () => {
    const feeIn = 100 / 1_000_000;
    const feeOut = 500 / 1_000_000;
    const impIn = 0.001, impOut = 0.002, tax = 0;
    const size = 1000, entry = 4000, exit = 4200;
    const gasNative = (180_000 * 100_000_000) / 1e18;
    const gas = gasNative * 4000;
    const tokens = (size * (1 - feeIn) * (1 - impIn)) / entry;
    const quote = tokens * (1 - tax) * exit * (1 - feeOut) * (1 - impOut);
    const expected = quote - size - gas;

    const read = (fee: number, feePct: number, at: number) => ({ fee, feePct, dynamic: true, readAt: at, source: 'pool.fee()' });
    const row = graded({
      quote_out: null, sell_tax: tax, size_spend: size, entry_price: entry, exit_price: exit,
      price_impact_entry: impIn, price_impact_exit: impOut,
      feeTierEntry: read(100, feeIn, T0), feeTierExit: read(500, feeOut, T0 + 2 * HOUR),
      gas_used: 180_000, gas_price: 100_000_000, gas_native: gasNative, gas_assumed: false, gas_note: null,
      usd_per_spend: 1,
    });
    const asNumbers = graded({ ...row, feeTierEntry: 100, feeTierExit: 500 });
    const score = scorePlay(row);
    expect(score.basis).toBe('model');
    expect(score.measured).toBe(true);
    expect(score.assumed).toBe(false);
    expect(score.assumptions).toEqual([]);
    expect(score.netTokens).toBeCloseTo(expected, 8);
    expect(score.netUsd).toBeCloseTo(expected, 8);
    expect(score.costs.feeEntry).toBeCloseTo(size * feeIn, 8);
    expect(score.costs.gas).toBeCloseTo(gas, 8);
    expect(score.costs.feeExit).toBeCloseTo(tokens * (1 - tax) * exit * feeOut, 8);
    expect(scorePlay(asNumbers).netTokens).toBeCloseTo(expected, 8);
    expect(feeFraction(100).frac).toBe(feeIn);
    expect(feeFraction(500).frac).toBe(feeOut);
    for (const h of ['+1h', '+4h', '+24h', '+72h'] as const) expect(score.horizons[h]).toBeNull();
  });

  it('leaves horizons pending until a real print, and does not invent one', () => {
    const open = graded({ exit_at: null, exit_price: null, quote_out: null });
    expect(scorePlay(open).netTokens).toBeNull();
    expect(scorePlay(open).horizons['+1h']).toBeNull();
    const refused = setHorizon(open, '+1h', { at: T0 + HOUR, price: Number.NaN, feeTier: null, impact: null });
    expect(refused.horizons['+1h']).toBeNull();
    const marked = setHorizon(open, '+4h', { at: T0 + 4 * HOUR, price: 6400, feeTier: null, impact: null });
    expect(marked.horizons['+1h']).toBeNull();
    expect(marked.horizons['+24h']).toBeNull();
    expect(marked.horizons['+72h']).toBeNull();
    const horizon = scorePlay(marked).horizons['+4h'];
    expect(horizon?.price).toBe(6400);
    expect(horizon?.netTokens).toBeNull();
  });

  it('does not charge the swap fee twice when the fill already netted it', () => {
    const row = graded({ quote_out: 1100, size_spend: 1000, feeTierEntry: 3000, feeTierExit: 3000, gas_native: 0 });
    const score = scorePlay(row);
    expect(score.basis).toBe('fill');
    expect(score.netTokens).toBe(100);
    expect(score.costs.feeEntry).toBeNull();
    expect(score.costs.tax).toBeNull();
  });

  it('flags a default gas figure and the leaderboard does not apply one on its own', () => {
    const row = graded({
      quote_out: null, gas_used: null, gas_price: null, gas_native: null, gas_note: 'no receipt gas',
      play_id: 'no-gas',
    });
    const plain = scorePlay(row);
    expect(plain.netTokens).toBeNull();
    expect(plain.assumed).toBe(false);
    expect(plain.assumptions.join(' ')).toMatch(/no receipt gas/);
    const assumed = scorePlay(row, { assumeGas: { units: 220_000, priceWei: 100_000_000, nativeToSpend: 4000, note: 'default 220000 gas units' } });
    expect(assumed.assumed).toBe(true);
    expect(assumed.measured).toBe(false);
    expect(assumed.netTokens).not.toBeNull();
    expect(assumed.assumptions.join(' ')).toMatch(/default 220000 gas units/);
    const board = playLeaderboard([row]).plays.bySignalType[0];
    expect(board.sample).toBe(0);
    expect(board.assumed).toBe(0);
    expect(board.partial).toBe(1);
    expect(board.avgNetTokens).toBeNull();
    expect(board.assumptions.join(' ')).toMatch(/no receipt gas/);
    expect(board.assumptions.join(' ')).not.toMatch(/220000/);
  });
});

describe('playLeaderboard', () => {
  it('keeps launchpad, rejected candidates and other chains out of the play averages', () => {
    const win = graded({ play_id: 'win', quote_out: 1010, exit_at: T0 + HOUR });
    const loss = graded({ play_id: 'loss', quote_out: 990, exit_at: T0 + 2 * HOUR });
    const pad = graded({ play_id: 'pad', kind: 'launchpad', signal_type: 'launch', quote_out: 1100, exit_at: T0 + HOUR });
    const rejected = graded({ play_id: 'rej', passed: false, rejected: true, reason: 'honeypot', quote_out: null, exit_at: null });
    const eth = graded({ play_id: 'eth', chain_id: 1, pool_address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', quote_out: 5000 });
    const assumed = graded({
      play_id: 'gas', quote_out: 1010, gas_assumed: true, gas_native: 0.01, gas_note: 'default 220000 gas units', exit_at: T0 + 3 * HOUR,
    });
    const board = playLeaderboard([win, loss, pad, rejected, eth, assumed]);
    const plays = board.plays.bySignalType.find((g) => g.key === 'new_pool');
    expect(plays?.sample).toBe(2);
    expect(plays?.hitRate).toBe(0.5);
    expect(plays?.avgNetTokens).toBe(0);
    expect(plays?.maxDrawdown).toBe(10);
    expect(plays?.assumed).toBe(1);
    expect(plays?.avgNetTokensAssumed).toBeCloseTo(1010 - 1000 - 40, 8);
    expect(plays?.assumptions.join(' ')).toMatch(/default 220000 gas units/);
    expect(board.launchpad.bySignalType[0].sample).toBe(1);
    expect(board.launchpad.bySignalType[0].avgNetTokens).toBe(100);
    expect(board.launchpad.bySignalType[0].key).toBe('launch');
    expect(board.rejected.bySignalType[0].sample).toBe(1);
    expect(board.rejected.bySignalType[0].hitRate).toBeNull();
    expect(board.rejected.bySignalType[0].avgNetTokens).toBeNull();
    expect(board.excluded.map((r) => r.play_id)).toEqual(['eth']);
    expect(board.plays.bySource[0].key).toBe('uniswap-v3');
    expect(board.plays.bySource[0].sample).toBe(2);
  });

  it('does not mix a price-model net into a fill average', () => {
    const fill = graded({ play_id: 'fill', quote_out: 1010 });
    const model = graded({
      play_id: 'model', quote_out: null, entry_price: 100, exit_price: 110, size_spend: 1000,
      feeTierEntry: 0, feeTierExit: 0, price_impact_entry: 0, price_impact_exit: 0, sell_tax: 0, gas_native: 0,
    });
    const row = playLeaderboard([fill, model]).plays.bySignalType[0];
    expect(row.sample).toBe(1);
    expect(row.avgNetTokens).toBe(10);
    expect(row.heldOut).toBe(1);
    expect(row.assumptions.join(' ')).toMatch(/price-model/);
  });

  it('times the target from the first real print and leaves the other horizons null', () => {
    const row = setHorizon(graded({ quote_out: 1010, exit_price: 4200, target_pct: 0.5 }), '+4h', {
      at: T0 + 4 * HOUR, price: 6400, feeTier: null, impact: null,
    });
    const board = playLeaderboard([row]).plays.bySignalType[0];
    expect(board.timeToTargetMs).toBe(4 * HOUR);
    expect(row.horizons['+1h']).toBeNull();
    expect(row.horizons['+24h']).toBeNull();
    expect(row.horizons['+72h']).toBeNull();
  });

  it('maps a candidate row without renaming chain, pool, token, fee tier or X fields', () => {
    const feeTier = { fee: 100, feePct: 0.0001, dynamic: true, readAt: T0, source: 'pool.fee()' };
    const play = playFromCandidate({
      chain_id: CHAIN, pool_address: POOL, token_contract: WETH, feeTier, priceAtFlag: 3995,
      xMentions: 12, xUniqueAuthors: 7, xUniqueAuthorsBasis: 'posts sampled 2026-10-18',
      signal_type: 'new_pool', source: 'uniswap-v3',
    }, 'cand-1');
    expect(play.play_id).toBe('cand-1');
    expect(play.chain_id).toBe(CHAIN);
    expect(play.pool_address).toBe(POOL);
    expect(play.token_contract).toBe(WETH);
    expect(play.feeTierEntry).toEqual(feeTier);
    expect(play.priceAtFlag).toBe(3995);
    expect(play.xMentions).toBe(12);
    expect(play.xUniqueAuthors).toBe(7);
    expect(play.xUniqueAuthorsBasis).toBe('posts sampled 2026-10-18');
    expect(play.horizons['+72h']).toBeNull();
    expect(play.rejected).toBe(true);
    const scored = playLeaderboard([play]);
    expect(scored.rejected.bySignalType[0].sample).toBe(1);
    expect(scored.plays.bySignalType).toEqual([]);
  });
});

describe('token trader plays', () => {
  it('records the entry fee, a later fee read, and pending horizons, and does not trim plays when the trade log caps at 200', async () => {
    const now = T0;
    const store = new MemoryStore<TraderState>();
    const t = new TokenTrader({
      store, now: () => now, discover: async () => (t.status().positions.length ? [] : [pool({ pool: POOL })]),
      assess: async () => clean(),
    });
    t.configure({ perTradeUsd: 1000, totalUsd: 5000, minPoolAgeSec: 0, chains: [CHAIN] });
    t.turnOn();
    await t.tick();
    const open = t.plays().find((p) => p.passed);
    expect(open?.chain_id).toBe(CHAIN);
    expect(open?.pool_address).toBe(POOL.toLowerCase());
    expect(open?.token_contract).toBe(WETH.toLowerCase());
    expect(open?.feeTierEntry).toMatchObject({ fee: 100, feePct: 0.0001, source: 'pool.feeBps' });
    expect(open?.priceAtFlag).toBe(4000);
    expect(open?.price_impact_entry).toEqual(expect.any(Number));
    expect(open?.gas_assumed).toBe(false);
    expect(open?.gas_used).toBeNull();
    expect(open?.horizons).toEqual({ '+1h': null, '+4h': null, '+24h': null, '+72h': null });
    expect(open?.xMentions).toBeNull();
    expect(open?.xUniqueAuthors).toBeNull();
    const id = t.status().positions[0].id;
    t.mark(id, { price: t.status().positions[0].entryPrice * 0.7, feeBps: 5 });
    await t.tick();
    const closed = t.plays().find((p) => p.play_id === id);
    expect(closed?.feeTierExit).toMatchObject({ fee: 500, feePct: 0.0005, dynamic: true, source: 'position.feeBps' });
    expect(closed?.assumptions.join(' ')).not.toMatch(/not read again/);
    expect(closed?.quote_out).toBeGreaterThan(0);
    expect(closed?.sell_tax).toBe(0);
    expect(scorePlay(closed!).netTokens).toBeNull();
    expect(scorePlay(closed!).assumptions.join(' ')).toMatch(/no receipt gas/);
    expect(t.status().trades.some((tr) => /hard stop/.test(tr.why))).toBe(true);

    const book = new MemoryStore<TraderState>();
    const gate = { busy: false };
    const many = new TokenTrader({
      store: book, now: () => now,
      discover: async () => (gate.busy ? [] : [pool()]),
      assess: async () => clean(),
    });
    many.configure({ perTradeUsd: 50, totalUsd: 50, minPoolAgeSec: 0 });
    many.turnOn();
    for (let k = 0; k < 101; k++) {
      gate.busy = false;
      await many.tick();
      gate.busy = true;
      const pos = many.status().positions[0];
      many.mark(pos.id, { price: pos.entryPrice * 0.7 });
      await many.tick();
    }
    expect(many.status().trades).toHaveLength(200);
    expect(many.plays().filter((p) => p.passed)).toHaveLength(101);
    const resumed = new TokenTrader({ store: book, now: () => now });
    expect(resumed.plays().filter((p) => p.passed)).toHaveLength(101);
  });

  it('keeps a rejected candidate once, and a live receipt gas figure is not marked assumed', async () => {
    const now = T0;
    const bad = pool({ tokenSymbol: 'BAD' });
    const good = pool({ pool: POOL, tokenSymbol: 'WETH' });
    let bought = false;
    const { t } = (() => {
      const store = new MemoryStore<TraderState>();
      const trader = new TokenTrader({
        store, now: () => now,
        discover: async () => {
          const rows = [bad];
          if (!bought) { bought = true; rows.push(good); }
          return rows;
        },
        assess: async (p) => clean({ honeypot: p.tokenSymbol === 'BAD' }),
        live: {
          buy: async (_pool, spend) => ({ tokens: spend / 4000, spent: spend, spentUsd: spend, price: 4000, impact: 0.001, tx: '0x' + 'ab'.repeat(32), gasUsed: 100_000, gasPriceWei: 100_000_000 }),
          sell: async (p, tokens) => ({ quoteOut: tokens * p.price, tokensIn: tokens, price: p.price, impact: 0.002, tx: '0x' + 'cd'.repeat(32), gasUsed: 80_000, gasPriceWei: 100_000_000 }),
        },
      });
      return { t: trader };
    })();
    t.configure({ mode: 'live', perTradeUsd: 1000, totalUsd: 5000, minPoolAgeSec: 0, chains: [CHAIN] });
    t.turnOn();
    await t.tick();
    await t.tick();
    const rejected = t.plays().filter((p) => p.rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/honeypot/);
    const id = t.status().positions[0].id;
    t.mark(id, { price: t.status().positions[0].entryPrice * 0.7, feeBps: 1 });
    await t.tick();
    const closed = t.plays().find((p) => p.play_id === id)!;
    expect(closed.gas_assumed).toBe(false);
    expect(closed.gas_used).toBe(180_000);
    expect(closed.gas_price).toBe(100_000_000);
    expect(closed.tx_entry).toBe('0x' + 'ab'.repeat(32));
    expect(closed.tx_exit).toBe('0x' + 'cd'.repeat(32));
    const score = scorePlay(closed);
    expect(score.basis).toBe('fill');
    expect(score.measured).toBe(true);
    expect(score.netTokens).toBeCloseTo((closed.quote_out ?? 0) - closed.size_spend - (closed.gas_native ?? 0) * (closed.native_to_spend ?? 0), 8);
    expect(score.costs.feeEntry).toBeNull();
  });

  it('serves the scorecard and keeps a non-Robinhood row out of the groups', async () => {
    const now = T0;
    let fresh = true;
    const hood = pool({ pool: POOL });
    const eth = pool({ chainId: 1, tokenSymbol: 'PEPE', spendSymbol: 'WETH', price: 0.00001, usdPerSpend: 4000, feeBps: 30 });
    const store = new MemoryStore<TraderState>();
    const t = new TokenTrader({
      store, now: () => now, discover: async () => (fresh ? (fresh = false, [hood, eth]) : []), assess: async () => clean(),
    });
    t.configure({ perTradeUsd: 100, totalUsd: 500, minPoolAgeSec: 0 });
    t.turnOn();
    await t.tick();
    expect(t.plays().map((p) => p.chain_id).sort()).toEqual([1, CHAIN]);
    const bot = new MultiBot({ net: NET, reader: new MockChain(), signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), now: () => now });
    const server = createApp({ bot, net: NET, tokenTrader: t }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const body = await new Promise<{ chainId: number; excluded: PlayRecord[]; plays: { bySignalType: { open: number }[] } }>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/plays/scorecard', headers: { host: `127.0.0.1:${port}` } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b)));
      }).on('error', reject);
    });
    server.close();
    expect(body.chainId).toBe(CHAIN);
    expect(body.excluded).toHaveLength(1);
    expect(body.excluded[0].chain_id).toBe(1);
    expect(body.plays.bySignalType[0].open).toBe(1);
    expect(t.plays()).toHaveLength(2);
  });
});
