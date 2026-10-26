/**
 * Pool-creation and liquidity-add logs for the sniper. Parsing only: no sockets, no RPC.
 *
 * Topics (ethers id of the canonical signature):
 *  V2  PairCreated(address indexed token0, address indexed token1, address pair, uint256)
 *      the pair address is NOT indexed — it sits in the data
 *  V3  PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
 *  V4  Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
 *      ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)
 *  Liquidity actually arriving:
 *  V2  Mint(address indexed sender, uint256 amount0, uint256 amount1) and Sync(uint112 reserve0, uint112 reserve1)
 *  V3  Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)
 *      (the pool's own Mint, not the position manager's IncreaseLiquidity)
 *
 * Uniswap V4's PoolManager on Ethereum is detected and skipped: this app does not swap V4.
 */
import { AbiCoder, id, Interface, getAddress } from 'ethers';

/** Canonical PoolManager. Verified as the address Uniswap publishes; the sniper still checks eth_getCode before trusting it. */
export const V4_POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';

export const PAIR_CREATED = 'PairCreated(address,address,address,uint256)';
export const POOL_CREATED = 'PoolCreated(address,address,uint24,int24,address)';
export const V4_INIT = 'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)';
export const V4_MODIFY = 'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)';
export const V2_MINT = 'Mint(address,uint256,uint256)';
export const V2_SYNC = 'Sync(uint112,uint112)';
export const V3_MINT = 'Mint(address,address,int24,int24,uint128,uint256,uint256)';

export const TOPIC = {
  pairCreated: id(PAIR_CREATED),
  poolCreated: id(POOL_CREATED),
  v4Init: id(V4_INIT),
  v4Modify: id(V4_MODIFY),
  v2Mint: id(V2_MINT),
  v2Sync: id(V2_SYNC),
  v3Mint: id(V3_MINT),
} as const;

// Names do not change the topic hash. They are here so parseLog exposes args.pair, args.amount0 and the rest.
const V2_FACTORY = new Interface(['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)']);
const V3_FACTORY = new Interface(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']);
const V4 = new Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
]);
const V2_PAIR = new Interface([
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
]);
const V3_POOL = new Interface(['event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)']);
const coder = AbiCoder.defaultAbiCoder();

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash?: string;
  logIndex?: number;
}

export type DexKind = 'v2' | 'v3' | 'v4';

export interface CreatedPool {
  kind: DexKind;
  pool: string;
  token0: string;
  token1: string;
  fee: number | null;
  /** V4 pool id (bytes32). This app does not swap it. */
  v4?: boolean;
  blockNumber: number;
}

export interface LiquidityAdd {
  kind: 'v2' | 'v3' | 'v4';
  /** Pair/pool address, or the V4 pool id when kind is v4 */
  pool: string;
  amount0: bigint;
  amount1: bigint;
  /** V4: signed liquidity change. Positive means liquidity was added. */
  liquidityDelta: bigint | null;
  blockNumber: number;
}

const addr = (a: string) => { try { return getAddress(a).toLowerCase(); } catch { return a.toLowerCase(); } };

export function parseCreation(log: RawLog): CreatedPool | null {
  const t0 = (log.topics[0] ?? '').toLowerCase();
  try {
    if (t0 === TOPIC.pairCreated) {
      const ev = V2_FACTORY.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      return { kind: 'v2', pool: addr(String(ev.args.pair)), token0: addr(String(ev.args.token0)), token1: addr(String(ev.args.token1)), fee: null, blockNumber: log.blockNumber };
    }
    if (t0 === TOPIC.poolCreated) {
      const ev = V3_FACTORY.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      return { kind: 'v3', pool: addr(String(ev.args.pool)), token0: addr(String(ev.args.token0)), token1: addr(String(ev.args.token1)), fee: Number(ev.args.fee), blockNumber: log.blockNumber };
    }
    if (t0 === TOPIC.v4Init) {
      const ev = V4.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      const id32 = String(ev.args.id).toLowerCase();
      return { kind: 'v4', pool: id32, token0: addr(String(ev.args.currency0)), token1: addr(String(ev.args.currency1)), fee: Number(ev.args.fee), v4: true, blockNumber: log.blockNumber };
    }
  } catch { return null; }
  return null;
}

export function parseLiquidity(log: RawLog): LiquidityAdd | null {
  const t0 = (log.topics[0] ?? '').toLowerCase();
  try {
    if (t0 === TOPIC.v2Mint) {
      const ev = V2_PAIR.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      return { kind: 'v2', pool: addr(log.address), amount0: ev.args.amount0 as bigint, amount1: ev.args.amount1 as bigint, liquidityDelta: null, blockNumber: log.blockNumber };
    }
    if (t0 === TOPIC.v2Sync) {
      const ev = V2_PAIR.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      return { kind: 'v2', pool: addr(log.address), amount0: ev.args.reserve0 as bigint, amount1: ev.args.reserve1 as bigint, liquidityDelta: null, blockNumber: log.blockNumber };
    }
    if (t0 === TOPIC.v3Mint) {
      const ev = V3_POOL.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      return { kind: 'v3', pool: addr(log.address), amount0: ev.args.amount0 as bigint, amount1: ev.args.amount1 as bigint, liquidityDelta: ev.args.amount as bigint, blockNumber: log.blockNumber };
    }
    if (t0 === TOPIC.v4Modify) {
      const ev = V4.parseLog({ topics: log.topics, data: log.data });
      if (!ev) return null;
      const delta = ev.args.liquidityDelta as bigint;
      return { kind: 'v4', pool: String(ev.args.id).toLowerCase(), amount0: 0n, amount1: 0n, liquidityDelta: delta, blockNumber: log.blockNumber };
    }
  } catch { return null; }
  return null;
}

/** True when a liquidity log actually added something (an empty Sync at creation does not). */
export function liquidityArrived(a: LiquidityAdd): boolean {
  if (a.kind === 'v4') return (a.liquidityDelta ?? 0n) > 0n;
  return a.amount0 > 0n || a.amount1 > 0n;
}

export const poolKey = (chainId: number, pool: string) => `${chainId}:${pool.toLowerCase()}`;

/**
 * Blocks still to read. A cursor of 0 means "never read": start `lookback` blocks behind head,
 * not at genesis. Each piece is at most `chunk` blocks.
 */
export function backfillRanges(cursor: number, head: number, chunk: number, lookback: number): { from: number; to: number }[] {
  if (!(head >= 0) || !(chunk >= 1)) return [];
  const start = cursor > 0 ? cursor + 1 : Math.max(0, head - Math.max(0, lookback));
  if (start > head) return [];
  const out: { from: number; to: number }[] = [];
  for (let from = start; from <= head;) {
    const to = Math.min(head, from + chunk - 1);
    out.push({ from, to });
    if (to === head) break;
    from = to + 1;
  }
  return out;
}

/** Encode a V2 PairCreated log (tests). `pair` is in the data word. */
export function encodePairCreated(token0: string, token1: string, pair: string): { topics: string[]; data: string } {
  const ev = V2_FACTORY.getEvent('PairCreated')!;
  const encoded = V2_FACTORY.encodeEventLog(ev, [token0, token1, pair, 1n]);
  return { topics: [...encoded.topics], data: encoded.data };
}

export function encodePoolCreated(token0: string, token1: string, fee: number, pool: string): { topics: string[]; data: string } {
  const ev = V3_FACTORY.getEvent('PoolCreated')!;
  const encoded = V3_FACTORY.encodeEventLog(ev, [token0, token1, fee, 60, pool]);
  return { topics: [...encoded.topics], data: encoded.data };
}

export function encodeV4Init(id32: string, c0: string, c1: string, fee: number): { topics: string[]; data: string } {
  const ev = V4.getEvent('Initialize')!;
  const encoded = V4.encodeEventLog(ev, [id32, c0, c1, fee, 60, '0x0000000000000000000000000000000000000000', 1n, 0]);
  return { topics: [...encoded.topics], data: encoded.data };
}

export function encodeV2Mint(sender: string, amount0: bigint, amount1: bigint): { topics: string[]; data: string } {
  const ev = V2_PAIR.getEvent('Mint')!;
  const encoded = V2_PAIR.encodeEventLog(ev, [sender, amount0, amount1]);
  return { topics: [...encoded.topics], data: encoded.data };
}

export function encodeV2Sync(r0: bigint, r1: bigint): { topics: string[]; data: string } {
  const data = coder.encode(['uint112', 'uint112'], [r0, r1]);
  return { topics: [TOPIC.v2Sync], data };
}

export function encodeV3Mint(amount: bigint, amount0: bigint, amount1: bigint): { topics: string[]; data: string } {
  const ev = V3_POOL.getEvent('Mint')!;
  const encoded = V3_POOL.encodeEventLog(ev, ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', 0, 60, amount, amount0, amount1]);
  return { topics: [...encoded.topics], data: encoded.data };
}

export function encodeV4Modify(id32: string, delta: bigint): { topics: string[]; data: string } {
  const ev = V4.getEvent('ModifyLiquidity')!;
  const encoded = V4.encodeEventLog(ev, [id32, '0x0000000000000000000000000000000000000001', 0, 60, delta, '0x' + '11'.repeat(32)]);
  return { topics: [...encoded.topics], data: encoded.data };
}
