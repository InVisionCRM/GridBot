import { NETWORKS } from '../../src/live/networks';
import { buildHub } from '../../src/server/chains/build';
const { hub, readers } = buildHub({ net: NETWORKS.mainnet, env: {} });
const r = readers.get(8453)!;
let n = 0, inflight = 0;
for (const m of ['call', 'getCode', 'getStorage', 'send', 'getBalance', 'getFeeData'] as const) {
  const orig = (r as any)[m].bind(r);
  (r as any)[m] = async (...a: unknown[]) => { n++; inflight++; const t = Date.now(); try { return await orig(...a); } catch (e) { console.log('  ERR', m, (e as Error).message.slice(0, 100), Date.now() - t, 'ms'); throw e; } finally { inflight--; } };
}
const iv = setInterval(() => console.log('calls', n, 'inflight', inflight, 'rpc', r.currentUrl, JSON.stringify(r.status)), 3000);
const t0 = Date.now();
try {
  const res = await hub.inspect({ chainId: 8453, address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', quote: 'WETH' });
  console.log('done', Date.now() - t0, 'ms', res.token.symbol, res.pools.length, res.safety?.risk, res.safety?.reasons);
  for (const p of res.pools) console.log('  pool', p.dexName, p.feeTier ?? p.feeBps + 'bps', p.address, 'tvl$', p.tvlUsd?.toFixed(0), 'refOut', p.refOut?.toPrecision(5), 'impact', p.refImpact != null ? (p.refImpact * 100).toFixed(3) + '%' : '-', p.error ?? '');
  console.log(JSON.stringify(res.probe), JSON.stringify(res.safety?.depth));
} catch (e) { console.log('ERR', (e as Error).message); }
clearInterval(iv);
process.exit(0);
