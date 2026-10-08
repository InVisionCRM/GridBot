import { getAddress, zeroPadValue } from 'ethers';
import { describe, expect, it } from 'vitest';
import { NETWORKS, networkByChainId, getStable, txUrl } from '../src/live/networks';
import { ERC20, parseAmountOut, WPLS_EVENTS } from '../src/server/bot/chain';
import { NATIVE } from '../src/live/swapMath';

describe('network config', () => {
  it('chain ids and hex agree; known ids resolve', () => {
    for (const n of Object.values(NETWORKS)) expect(parseInt(n.chainIdHex, 16)).toBe(n.chainId);
    expect(networkByChainId(369)?.key).toBe('mainnet');
    expect(networkByChainId(943n)?.key).toBe('testnet');
    expect(networkByChainId(1)).toBeNull();
  });
  it('every address is a valid EIP-55 checksum address', () => {
    for (const n of Object.values(NETWORKS)) {
      for (const a of [n.pulsex.routerV2, n.pulsex.factoryV2, n.pulsex.wpls, ...n.stables.map((s) => s.address)]) {
        expect(getAddress(a)).toBe(a);
      }
    }
  });
  it('pins the verified mainnet PulseX V2 + bridged stable addresses', () => {
    const m = NETWORKS.mainnet;
    expect(m.pulsex.routerV2).toBe('0x165C3410fC91EF562C50559f7d2289fEbed552d9');
    expect(m.pulsex.factoryV2).toBe('0x29eA7545DEf87022BAdc76323F373EA1e707C523');
    expect(m.pulsex.wpls).toBe('0xA1077a294dDE1B09bB078844df40758a5D0f9a27');
    expect(m.stables.find((s) => s.symbol === 'USDC')).toMatchObject({ address: '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07', decimals: 6 });
    expect(m.stables.find((s) => s.symbol === 'DAI')).toMatchObject({ address: '0xefD766cCb38EaF1dfd701853BFCe31359239F305', decimals: 18 });
  });
  it('builds explorer tx links', () => {
    expect(txUrl(NETWORKS.testnet, '0xabc')).toBe('https://scan.v4.testnet.pulsechain.com/tx/0xabc');
  });
});

describe('parseAmountOut (receipt logs)', () => {
  const net = NETWORKS.mainnet;
  const me = '0x1111111111111111111111111111111111111111';
  const dai = net.stables[0];
  const r = (logs: unknown[]) => ({ status: 1, gasUsed: 0n, logs }) as never;
  it('reads ERC20 Transfer to the wallet for stable output', () => {
    const ev = ERC20.getEvent('Transfer')!;
    const log = { address: dai.address, topics: [ev.topicHash, zeroPadValue(net.pulsex.routerV2, 32), zeroPadValue(me, 32)], data: zeroPadValue('0x03e8', 32) };
    expect(parseAmountOut(r([log]), me, dai.address, net.pulsex.wpls)).toBe(1000n);
  });
  it('ignores Transfers to someone else', () => {
    const ev = ERC20.getEvent('Transfer')!;
    const log = { address: dai.address, topics: [ev.topicHash, zeroPadValue(me, 32), zeroPadValue(net.pulsex.routerV2, 32)], data: zeroPadValue('0x03e8', 32) };
    expect(parseAmountOut(r([log]), me, dai.address, net.pulsex.wpls)).toBeNull();
  });
  it('reads WPLS Withdrawal for native PLS output', () => {
    const ev = WPLS_EVENTS.getEvent('Withdrawal')!;
    const log = { address: net.pulsex.wpls, topics: [ev.topicHash, zeroPadValue(net.pulsex.routerV2, 32)], data: zeroPadValue('0x0de0b6b3a7640000', 32) };
    expect(parseAmountOut(r([log]), me, NATIVE, net.pulsex.wpls)).toBe(10n ** 18n);
  });
});

describe('mainnet HEX / eHEX / PLSX quotes', () => {
  const net = NETWORKS.mainnet;
  it('lists verified addresses and prefers WPLS grids (kind=token)', () => {
    const hex = net.quotes.find((q) => q.symbol === 'HEX')!;
    const ehex = net.quotes.find((q) => q.symbol === 'eHEX')!;
    const plsx = net.quotes.find((q) => q.symbol === 'PLSX')!;
    expect(hex).toMatchObject({ address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', decimals: 8, kind: 'token' });
    expect(ehex).toMatchObject({ address: '0x57fde0a71132198BBeC939B98976993d8D89D225', decimals: 8, onChainSymbol: 'HEX', kind: 'token' });
    expect(plsx).toMatchObject({ address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab', decimals: 18, kind: 'token' });
    expect(getStable(net, 'eHEX').symbol).toBe('eHEX');
  });
});
