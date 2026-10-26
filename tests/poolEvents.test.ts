import { describe, expect, it } from 'vitest';
import {
  backfillRanges, encodePairCreated, encodePoolCreated, encodeV2Mint, encodeV2Sync, encodeV3Mint, encodeV4Init, encodeV4Modify,
  liquidityArrived, parseCreation, parseLiquidity, V4_POOL_MANAGER,
} from '../src/market/poolEvents';

const T0 = '0x1111111111111111111111111111111111111111';
const T1 = '0x2222222222222222222222222222222222222222';
const PAIR = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const ID = '0x' + 'ab'.repeat(32);

describe('pool event parsing', () => {
  it('reads a V2 PairCreated with the pair address in the data', () => {
    const enc = encodePairCreated(T0, T1, PAIR);
    const got = parseCreation({ address: '0xfac', topics: enc.topics, data: enc.data, blockNumber: 10 });
    expect(got).toMatchObject({ kind: 'v2', pool: PAIR.toLowerCase(), token0: T0.toLowerCase(), token1: T1.toLowerCase(), fee: null, blockNumber: 10 });
  });

  it('reads a V3 PoolCreated, including the fee tier', () => {
    const enc = encodePoolCreated(T0, T1, 10000, POOL);
    const got = parseCreation({ address: '0xfac', topics: enc.topics, data: enc.data, blockNumber: 11 });
    expect(got).toMatchObject({ kind: 'v3', pool: POOL.toLowerCase(), fee: 10000, blockNumber: 11 });
  });

  it('reads a V4 Initialize and a positive ModifyLiquidity, and ignores an empty Sync', () => {
    const init = encodeV4Init(ID, T0, T1, 3000);
    const created = parseCreation({ address: V4_POOL_MANAGER, topics: init.topics, data: init.data, blockNumber: 12 });
    expect(created).toMatchObject({ kind: 'v4', v4: true, pool: ID, fee: 3000, token0: T0.toLowerCase() });

    const add = encodeV4Modify(ID, 1000n);
    const liq = parseLiquidity({ address: V4_POOL_MANAGER, topics: add.topics, data: add.data, blockNumber: 13 });
    expect(liq && liquidityArrived(liq)).toBe(true);

    const out = encodeV4Modify(ID, -5n);
    const gone = parseLiquidity({ address: V4_POOL_MANAGER, topics: out.topics, data: out.data, blockNumber: 14 });
    expect(gone && liquidityArrived(gone)).toBe(false);

    const mint = encodeV2Mint('0x0000000000000000000000000000000000000001', 5n, 0n);
    const added = parseLiquidity({ address: PAIR, topics: mint.topics, data: mint.data, blockNumber: 15 });
    expect(added && liquidityArrived(added)).toBe(true);

    const v3 = encodeV3Mint(1n, 2n, 3n);
    const v3add = parseLiquidity({ address: POOL, topics: v3.topics, data: v3.data, blockNumber: 16 });
    expect(v3add).toMatchObject({ kind: 'v3', amount0: 2n, amount1: 3n, liquidityDelta: 1n });

    const empty = encodeV2Sync(0n, 0n);
    const sync = parseLiquidity({ address: PAIR, topics: empty.topics, data: empty.data, blockNumber: 17 });
    expect(sync && liquidityArrived(sync)).toBe(false);
    const full = encodeV2Sync(10n, 10n);
    const synced = parseLiquidity({ address: PAIR, topics: full.topics, data: full.data, blockNumber: 18 });
    expect(synced && liquidityArrived(synced)).toBe(true);
  });

  it('backfill starts a fresh cursor behind the head and chunks, and does not reread a caught-up cursor', () => {
    expect(backfillRanges(0, 1000, 50, 80)).toEqual([{ from: 920, to: 969 }, { from: 970, to: 1000 }]);
    expect(backfillRanges(990, 1000, 20, 80)).toEqual([{ from: 991, to: 1000 }]);
    expect(backfillRanges(1000, 1000, 20, 80)).toEqual([]);
    expect(backfillRanges(0, 10, 100, 80)).toEqual([{ from: 0, to: 10 }]);
  });
});
