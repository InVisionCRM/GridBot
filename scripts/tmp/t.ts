import { NETWORKS } from '../../src/live/networks';
import { buildHub } from '../../src/server/chains/build';
import { DEFAULT_LIMITS } from '../../src/live/limits';
const { hub } = buildHub({ net: NETWORKS.mainnet, env: {} });
const t0 = Date.now();
await Promise.all(hub.list().filter((m) => !m.legacy || m.key === 'DAI').map(async (m) => {
  try {
    const q = hub.quoter(m.key);
    const p = await q.getPrice(); hub.setSpot(m.key, p);
    const mk = await q.market();
    console.log(m.key.padEnd(22), 'spot', p.toPrecision(6), 'fee', mk.feeBps, 'bps · depth', mk.quoteReserve.toPrecision(4), m.quote.symbol, '/', mk.plsReserve.toPrecision(4), m.base.symbol, '· gas', (mk.gasPriceNative! * 1e9).toPrecision(3), 'gwei · L1', mk.extraPlsPerSwap!.toExponential(2), 'tvl', mk.tvlQuote?.toPrecision(4));
  } catch (e) { console.log(m.key, 'ERR', (e as Error).message); }
}));
console.log('ms', Date.now() - t0);
const q = hub.quoter('base:ETH/USDC');
const buy = await q.quote('buy', 50, DEFAULT_LIMITS, '0x000000000000000000000000000000000000dEaD', 0n);
console.log('base buy 50 USDC →', buy.quotedOutHuman, 'ETH impact', (buy.priceImpact * 100).toFixed(4), '% method', buy.call.method, 'gasNative', buy.gasNativeEstimate, 'l1', buy.l1FeeWei);
const sell = await q.quote('sell', 0.02, DEFAULT_LIMITS, '0x000000000000000000000000000000000000dEaD', null);
console.log('base sell 0.02 ETH →', sell.quotedOutHuman, 'USDC value', sell.call.value, 'impact', (sell.priceImpact * 100).toFixed(4));
for (const [chainId, addr] of [[8453, '0x940181a94A35A4569E4529A3CDfB74e38FD98631'], [4663, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168']] as const) {
  try {
    const r = await hub.inspect({ chainId, address: addr, ...(chainId === 4663 ? { quote: 'WETH' } : {}) });
    console.log('\nINSPECT', chainId, r.token.symbol, r.token.name, r.token.decimals, 'proxy', JSON.stringify(r.token.proxy), 'quote', r.quote.symbol);
    for (const p of r.pools) console.log('  pool', p.dexName, p.feeTier ?? p.feeBps + 'bps', p.address, 'tvl$', p.tvlUsd?.toFixed(0), 'refOut', p.refOut?.toPrecision(5), 'impact', p.refImpact != null ? (p.refImpact * 100).toFixed(3) + '%' : '-', p.error ?? '');
    console.log('  chosen', r.chosen?.dexName, r.chosen?.feeTier, 'draft', r.draft?.key, 'probe', r.draft?.probe);
    console.log('  safety', r.safety?.risk, r.safety?.liveAllowed, r.safety?.reasons, 'taxes', r.safety?.buyTaxPct, r.safety?.transferTaxPct, r.safety?.sellTaxPct);
    console.log('  depth', JSON.stringify(r.safety?.depth));
    console.log('  probe', JSON.stringify(r.probe));
  } catch (e) { console.log('INSPECT ERR', chainId, (e as Error).message); }
}
process.exit(0);
