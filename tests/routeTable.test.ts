/** Route table: bridge candidates and token mappings. Pure — no chain calls. */
import { getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { chainByKey } from '../src/live/chains';
import { NETWORKS } from '../src/live/networks';
import {
  BRIDGE_ROUTES, PULSE_BRIDGED_WETH, TOKEN_MAPPINGS, autoRoutes, bridgeRoutes, counterpart, isAutoRoute,
} from '../src/market/routeTable';

const ETH = chainByKey('ethereum')!;
const USDC = ETH.stables.find((s) => s.symbol === 'USDC')!;
const WETH = ETH.wrappedNative.address;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const PLS_USDC = NETWORKS.mainnet.quotes.find((q) => q.symbol === 'USDC')!;

describe('token mappings', () => {
  it('maps Ethereum USDC to Robinhood USDG 0x5fc5…d168', () => {
    const leg = counterpart(1, USDC.address, 4663);
    expect(leg).toMatchObject({ address: USDG, symbol: 'USDG', decimals: 6, chainId: 4663 });
    expect(leg!.address.startsWith('0x5fc5') || leg!.address.startsWith('0x5fc5')).toBe(true);
    expect(leg!.address.toLowerCase().endsWith('d168')).toBe(true);
    expect(leg!.address).toBe(chainByKey('robinhood')!.stables.find((s) => s.symbol === 'USDG')!.address);
    expect(counterpart(4663, USDG, 1)).toMatchObject({ address: USDC.address, symbol: 'USDC', decimals: 6 });
  });

  it('maps PulseChain bridged WETH and USDC back to Ethereum', () => {
    expect(counterpart(1, USDC.address, 369)).toMatchObject({ address: PLS_USDC.address, symbol: 'USDC', decimals: 6, kind: 'bridged' });
    expect(counterpart(1, WETH, 369)).toMatchObject({ address: PULSE_BRIDGED_WETH, symbol: 'WETH', decimals: 18, kind: 'bridged' });
    expect(PULSE_BRIDGED_WETH).toBe('0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C');
    expect(counterpart(369, PULSE_BRIDGED_WETH, 1)!.address).toBe(WETH);
    expect(counterpart(369, PLS_USDC.address, 1)!.address).toBe(USDC.address);
  });

  it('publishes checksummed addresses', () => {
    for (const m of TOKEN_MAPPINGS) for (const leg of m.legs) expect(getAddress(leg.address)).toBe(leg.address);
    for (const r of BRIDGE_ROUTES) if (r.address) expect(getAddress(r.address)).toBe(r.address);
  });
});

describe('auto routes skip canonical slow bridges', () => {
  it('Ethereum → Robinhood prefers Across, then Relay, and never the 7-day bridge or Li.Fi', () => {
    const all = bridgeRoutes(1, 4663, WETH);
    expect(all.some((r) => r.protocol === 'canonical' && r.speed === 'slow' && r.autoSelect === false)).toBe(true);
    expect(all.some((r) => r.protocol === 'lifi' && r.role === 'discovery')).toBe(true);
    expect(autoRoutes(1, 4663, WETH).map((r) => r.protocol)).toEqual(['across', 'relay']);
    const dollar = autoRoutes(1, 4663, USDC.address);
    expect(dollar.map((r) => r.protocol)).toEqual(['across', 'relay']);
    expect(dollar[0].tokenOut).toBe(USDG);
  });

  it('refuses a canonical or slow row even if autoSelect is turned on', () => {
    const slow = bridgeRoutes(4663, 1, WETH).find((r) => r.protocol === 'canonical')!;
    expect(slow.speed).toBe('slow');
    expect(isAutoRoute(slow)).toBe(false);
    expect(isAutoRoute({ ...slow, autoSelect: true, role: 'primary' })).toBe(false);
    expect(isAutoRoute({ ...slow, autoSelect: true, role: 'primary', speed: 'fast' })).toBe(false);
    expect(autoRoutes(1, 4663, '0x' + '11'.repeat(20))).toEqual([]);
    expect(bridgeRoutes(1, 4663, '0x' + '11'.repeat(20)).every((r) => r.protocol === 'canonical')).toBe(true);
  });

  it('Ethereum ↔ PulseChain auto-selects only the official OmniBridge', () => {
    expect(autoRoutes(1, 369, WETH).map((r) => r.protocol)).toEqual(['pulse-omnibridge']);
    expect(autoRoutes(369, 1, PULSE_BRIDGED_WETH).map((r) => r.protocol)).toEqual(['pulse-omnibridge']);
    expect(autoRoutes(1, 369, USDC.address)[0]).toMatchObject({ protocol: 'pulse-omnibridge', tokenOut: PLS_USDC.address });
    expect(autoRoutes(1, 369, WETH).every((r) => r.protocol !== 'canonical' && r.speed !== 'slow')).toBe(true);
    expect(autoRoutes(4663, 369, WETH)).toEqual([]);
  });
});
