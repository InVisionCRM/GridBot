import { CHAINS } from '../../src/live/chains';
import { defaultMarkets } from '../../src/live/markets';
const t = '`';
const out: string[] = [];
for (const c of CHAINS) {
  out.push(`\n### ${c.name} — chain ${c.id}${c.status === 'testnet' ? ' (TESTNET)' : ''} · ${c.stack === 'l1' ? 'L1' : c.stack === 'op' ? 'OP-stack L2' : 'Arbitrum/Orbit L2'} · gas ${c.nativeSymbol} · ${t}RPC_URL_${c.envSlug}${t} / ${t}PRIVATE_KEY_${c.envSlug}${t}`);
  if (c.note) out.push(`\n${c.note}`);
  if (!c.trading.enabled) out.push(`\n**Trading unavailable:** ${c.trading.reason}`);
  out.push('\n| Contract | Address | Fee |\n|---|---|---|');
  out.push(`| Wrapped native ${c.wrappedNative.symbol} | ${t}${c.wrappedNative.address}${t} | |`);
  for (const s of c.stables) out.push(`| ${s.symbol} (${s.decimals} dec) | ${t}${s.address}${t} | |`);
  for (const d of c.dexes) {
    const fee = d.kind === 'v3' ? `tiers ${d.feeTiers!.join(' / ')}` : `${d.feeBps! / 100}%`;
    out.push(`| ${d.name} factory | ${t}${d.factory}${t} | ${fee} |`);
    out.push(`| ${d.name} router${d.kind === 'v3' ? ' (IV3SwapRouter: SwapRouter02 / SmartRouter)' : ''} | ${t}${d.router}${t} | |`);
    if (d.quoter) out.push(`| ${d.name} QuoterV2 | ${t}${d.quoter}${t} | |`);
  }
  for (const m of defaultMarkets().filter((x) => x.chainId === c.id)) out.push(`| Default market ${m.base.symbol}/${m.quote.symbol} pool (${m.pool.dex}) | ${t}${m.pool.address}${t} | ${m.pool.feeTier! / 1e4}% |`);
  out.push(`\nRPC fallbacks: ${c.rpcs.map((u) => `${t}${u}${t}`).join(', ')} · explorer ${c.explorer}`);
  const src = [...c.sources.map((s) => `[${s.label}](${s.url})`), ...c.dexes.map((d) => `[${d.name}](${d.source})`)];
  out.push(`\nSources: ${[...new Set(src)].join(' · ')}`);
}
console.log(out.join('\n'));
