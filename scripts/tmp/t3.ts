import { NETWORKS } from '../../src/live/networks';
import { buildHub } from '../../src/server/chains/build';
const { hub } = buildHub({ net: NETWORKS.mainnet, env: {} });
const list: [number, string, string][] = [[56, '0xc748673057861a797275CD8A068AbB95A902e8de', 'WBNB'], [56, '0x42981d0bfbAf196529376EE702F2a9Eb9092fcB5', 'WBNB'], [56, '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E', 'WBNB'], [4663, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'WETH'], [369, '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', 'DAI']];
for (const [c, a, q] of list) {
  const t0 = Date.now();
  try {
    const r = await hub.inspect({ chainId: c, address: a, quote: q });
    console.log(c, r.token.symbol, 'dec', r.token.decimals, 'proxy', r.token.proxy?.kind ?? '-', 'ms', Date.now() - t0, '| chosen', r.chosen?.dexName, r.chosen?.feeTier ?? r.chosen?.feeBps, 'tvl$', r.chosen?.tvlUsd?.toFixed(0));
    console.log('  ', r.safety?.risk, 'live', r.safety?.liveAllowed, '| taxes', r.safety?.buyTaxPct?.toFixed(4), r.safety?.transferTaxPct?.toFixed(4), r.safety?.sellTaxPct?.toFixed(4), '| stage', r.probe?.stage, r.probe?.err, '|', r.safety?.reasons.join(' | '));
  } catch (e) { console.log(c, a, 'ERR', (e as Error).message); }
}
process.exit(0);
