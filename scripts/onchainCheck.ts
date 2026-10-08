/** READ-ONLY mainnet/testnet checks via the server Quoter. Sends nothing, needs no key. */
import { Contract, JsonRpcProvider } from 'ethers';
import { NETWORKS } from '../src/live/networks';
import { DEFAULT_LIMITS } from '../src/live/limits';
import { getAmountOut } from '../src/live/swapMath';
import { ERC20, Quoter, ROUTER } from '../src/server/bot/chain';
import { econFromMarket } from '../src/server/bot/econ';
import { analyzeEconomics } from '../src/live/economics';
import { STRATEGY_PRESETS, resolvePreset } from '../src/live/presets';
import { Interface } from 'ethers';
import { buildHub } from '../src/server/chains/build';
import { readCall, sameAddr } from '../src/server/dex/types';
import { FACTORY, PAIR, V3_QUOTER, V3_ROUTER } from '../src/server/dex/abis';
import type { Hub } from '../src/server/chains/hub';
import { NATIVE } from '../src/live/swapMath';
import { MultiBot, type MultiState } from '../src/server/bot/multi';
import { MemoryStore } from '../src/server/bot/store';
import { Logger } from '../src/server/bot/logger';
import type { ChainRuntime } from '../src/server/chains/runtime';

let failures = 0;
let warnings = 0;
const warn = (m: string) => { console.log(`  ! ${m}`); warnings++; };
const ok = (c: boolean, m: string) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };
const DUMMY = '0x000000000000000000000000000000000000dEaD';
const V3F = new Interface(['function feeAmountTickSpacing(uint24) view returns (int24)']);
const NATIVE_USD: Record<string, [number, number]> = { PLS: [1e-6, 1e-3], ETH: [500, 20_000] };


for (const net of Object.values(NETWORKS)) {
  console.log(`\n== ${net.label}`);
  const p = new JsonRpcProvider(net.rpcUrl, net.chainId, { staticNetwork: true });
  ok(Number((await p.getNetwork()).chainId) === net.chainId, `chainId ${net.chainId}`);
  ok((await p.getCode(net.pulsex.routerV2)).length > 2, 'router has code');
  const router = new Contract(net.pulsex.routerV2, ROUTER, p);
  ok((await router.factory()) === net.pulsex.factoryV2, 'router.factory() matches');
  ok((await router.WPLS()) === net.pulsex.wpls, 'router.WPLS() matches');
  for (const s of net.quotes) {
    const t = new Contract(s.address, ERC20, p);
    const onChainSym = String(await t.symbol());
    const expectSym = s.onChainSymbol ?? s.symbol;
    ok(onChainSym === expectSym && Number(await t.decimals()) === s.decimals,
      `${s.symbol} symbol/decimals (on-chain ${onChainSym}/${await t.decimals()})`);
    const q = new Quoter(p, net, s);
    const path = [net.pulsex.wpls, s.address];
    const [a, hops] = await Promise.all([q.amountsOut(10n ** 24n, path), q.hops(path)]);
    ok(a[1] === getAmountOut(10n ** 24n, hops[0].reserveIn, hops[0].reserveOut, net.pulsex.feeBps),
      `getAmountsOut(1M WPLS→${s.symbol}) = local 29-bps formula`);
    const price = await q.getPrice();
    const maxP = s.kind === 'stable' ? (net.isTestnet ? 10 : 0.01) : 100;
    ok(price > 0 && price < maxP, `price ${price.toPrecision(6)} ${s.symbol}/PLS`);
  }
  const q = new Quoter(p, net, net.quotes[0]);
  const buy = await q.quote('buy', 5, DEFAULT_LIMITS, DUMMY, 0n);
  ok(buy.call.method === 'swapExactTokensForETH' && buy.approveAmount === buy.amountIn,
    `buy 5 ${net.quotes[0].symbol}: ${buy.quotedOutHuman.toFixed(0)} PLS, impact ${(buy.priceImpact * 100).toFixed(4)}%`);
  const sell = await q.quote('sell', 500_000, DEFAULT_LIMITS, DUMMY, null);
  ok(sell.call.method === 'swapExactETHForTokens',
    `sell 500k PLS: ${sell.quotedOutHuman.toFixed(4)} ${net.quotes[0].symbol}, impact ${(sell.priceImpact * 100).toFixed(4)}%`);

  if (!net.isTestnet) {
    console.log('  -- preset economics vs live reserves (worst interval, exact approval)');
    const markets = Object.fromEntries(await Promise.all(net.quotes.map(async (t) => [t.symbol, await new Quoter(p, net, t).market()] as const)));
    const spots = Object.fromEntries(Object.entries(markets).map(([k, m]) => [k, m.spot]));
    // Flipped "Stack … with PLS" presets are checked on the deepest pool in flipChecks().
    for (const preset of STRATEGY_PRESETS.filter((x) => !x.legs.some((l) => l.flip))) {
      for (const leg of resolvePreset(preset, spots, net.defaultQuote)) {
        const e = econFromMarket(markets[leg.quote], leg, 'exact');
        ok(e.ok, `${preset.id} PLS/${leg.quote} ±${leg.bandPct * 100}%×${leg.gridCount} $${leg.capitalUsd}: size ${e.levelSize.toPrecision(5)} ${leg.quote}, step ${(e.spacingPct * 100).toFixed(3)}%, impact ${(e.impactPct * 100).toFixed(3)}%, gas ${(e.gasQuote * leg.usdPerQuote).toFixed(4)} USD, net ${(e.netPct * 100).toFixed(3)}% = $${(e.netPerRoundTrip * leg.usdPerQuote).toFixed(4)}/RT${e.ok ? '' : ' ' + e.reasons.join(' ')}`);
      }
    }
  }
}
await multiChainChecks();
console.log(failures ? `\n${failures} FAILED${warnings ? `, ${warnings} warning(s)` : ''}` : `\nAll read-only checks passed${warnings ? ` (${warnings} RPC-dependent warning(s))` : ''}.`);
process.exit(failures ? 1 : 0);

// ─────────────────────────────────────────────────────────────────────────────
// Multi-chain registry + PulseChain DEXes (PulseX V1 / V2, 9mm V2 / V3) + custom tokens. All eth_call / reads.
// ─────────────────────────────────────────────────────────────────────────────
async function multiChainChecks() {
  const { hub } = buildHub({ net: NETWORKS.mainnet, env: process.env });
  await pulsechainDexes(hub);
  await flipChecks(hub);
  for (const rt of hub.runtimes()) {
    try { await chainCheck(hub, rt); } catch (e) { ok(false, `${rt.cfg.name}: ${(e as Error).message.slice(0, 160)}`); }
  }
  await customTokens(hub);
}


async function pulsechainDexes(hub: Hub) {
  const rt = hub.rt(369), r = rt.reader, c = rt.cfg;
  const W = c.wrappedNative.address, DAI = NETWORKS.mainnet.quotes.find((q) => q.symbol === 'DAI')!.address;
  console.log('\n== PulseChain DEXes: PulseX V1 / PulseX V2 / 9mm V2 / 9mm V3');
  const outs: Record<string, bigint> = {};
  for (const d of c.dexes) {
    const code = async (a: string) => ((await r.getCode!(a)).length - 2) / 2;
    ok((await code(d.router)) > 0 && (await code(d.factory)) > 0, `${d.name}: router ${d.router} + factory ${d.factory} have code`);
    if (d.kind === 'v2') {
      const [f] = await readCall<[string]>(r, d.router, ROUTER, 'factory');
      ok(sameAddr(f, d.factory), `${d.name}: router.factory() = ${f}`);
      let w = '';
      try { [w] = await readCall<[string]>(r, d.router, ROUTER, 'WPLS'); } catch { [w] = await readCall<[string]>(r, d.router, ROUTER, 'WETH'); }
      ok(sameAddr(w, W), `${d.name}: router wrapped native = WPLS`);
      const [pair] = await readCall<[string]>(r, d.factory, FACTORY, 'getPair', [W, DAI]);
      const [[r0, r1], [t0]] = await Promise.all([readCall<[bigint, bigint]>(r, pair, PAIR, 'getReserves'), readCall<[string]>(r, pair, PAIR, 'token0')]);
      const [rIn, rOut] = sameAddr(t0, W) ? [r0, r1] : [r1, r0];
      const amt = rIn / 100_000n;
      const [[, out]] = await readCall<[bigint[]]>(r, d.router, ROUTER, 'getAmountsOut', [amt, [W, DAI]]);
      const measured = (1 - (Number(out) * Number(rIn)) / (Number(amt) * (Number(rOut) - Number(out)))) * 1e4;
      ok(Math.abs(measured - d.feeBps!) < 0.2, `${d.name}: fee measured from WPLS/DAI ${pair} = ${measured.toFixed(2)} bps (config ${d.feeBps})`);
      ok(out === getAmountOut(amt, rIn, rOut, d.feeBps!), `${d.name}: getAmountsOut = local ${d.feeBps}-bps formula`);
      const [[, o1m]] = await readCall<[bigint[]]>(r, d.router, ROUTER, 'getAmountsOut', [10n ** 24n, [W, DAI]]);
      outs[d.name] = o1m;
    } else {
      const [f, w] = await Promise.all([readCall<[string]>(r, d.router, V3_ROUTER, 'factory'), readCall<[string]>(r, d.router, V3_ROUTER, 'WETH9')]);
      ok(sameAddr(f[0], d.factory) && sameAddr(w[0], W), `${d.name}: SmartRouter.factory() + WETH9() match`);
      const [qf] = await readCall<[string]>(r, d.quoter!, V3_QUOTER, 'factory');
      ok(sameAddr(qf, d.factory), `${d.name}: QuoterV2.factory() matches`);
      const spacing = await Promise.all([...d.feeTiers!, 3000].map(async (t) => [t, Number((await readCall<[bigint]>(r, d.factory, V3F, 'feeAmountTickSpacing', [t]))[0])] as const));
      ok(spacing.filter(([t]) => d.feeTiers!.includes(t)).every(([, s]) => s > 0), `${d.name}: tiers ${d.feeTiers!.join('/')} enabled (tick spacing ${spacing.map(([t, s]) => `${t}:${s}`).join(' ')})`);
      const ad = rt.adapter(d.id);
      const pools = await ad.findPools(W, DAI);
      ok(pools.length > 0, `${d.name}: WPLS/DAI pools on tiers ${pools.map((p) => p.feeTier).join(', ')}`);
      let best = 0n;
      for (const p of pools) { try { best = [best, (await ad.quote(p, W, DAI, 10n ** 24n)).amountOut].reduce((a, b) => (b > a ? b : a)); } catch { /* tick range */ } }
      ok(best > 0n, `${d.name}: QuoterV2 1M WPLS → ${(Number(best) / 1e18).toFixed(4)} DAI (best tier)`);
      outs[d.name] = best;
    }
  }
  const ref = outs['PulseX V2'];
  for (const [k, v] of Object.entries(outs)) {
    if (k.startsWith('9mm V2')) continue; // thin pool: large impact at 1M
    ok(Math.abs(Number(v) / Number(ref) - 1) < 0.03, `${k}: 1M WPLS quote within 3% of PulseX V2 (${(Number(v) / 1e18).toFixed(4)} vs ${(Number(ref) / 1e18).toFixed(4)} DAI)`);
  }

  console.log('  -- best-pool selection PLS/DAI (≈$250 reference buy)');
  const ch = await hub.poolOptions('DAI');
  for (const p of ch.pools) console.log(`     ${p.dexName.padEnd(10)} ${(p.feeTier != null ? `${p.feeTier / 1e4}%` : `${p.feeBps / 100}%`).padEnd(6)} ${p.address}  TVL ${p.tvlUsd != null ? `$${Math.round(p.tvlUsd).toLocaleString('en-US')}` : '—'}  out ${p.refOut?.toFixed(0) ?? '—'} PLS${p.error ? `  (${p.error.slice(0, 50)})` : ''}`);
  const dexes = new Set(ch.pools.map((p) => p.dex));
  ok(['pulsex-v1', 'pulsex-v2', '9mm-v2', '9mm-v3'].every((x) => dexes.has(x)), `discovery found PulseX V1, PulseX V2, 9mm V2 and 9mm V3 pools (${ch.pools.length})`);
  ok(!!ch.best, `best pool: ${ch.best?.dexName} ${ch.best?.address}`);
  const q = hub.quoter('DAI');
  const prices: string[] = [];
  for (const id of ['pulsex-v1', 'pulsex-v2', '9mm-v3']) {
    const top = ch.pools.find((p) => p.dex === id && p.refOut != null);
    if (!top) { ok(false, `no quotable ${id} pool`); continue; }
    await hub.setPool('DAI', { pool: top.address }); // in-memory only (no custom store in this script)
    const [px, buy] = await Promise.all([q.getPrice(), q.quote('buy', 5, DEFAULT_LIMITS, DUMMY, 0n)]);
    const dex = c.dexes.find((x) => x.id === id)!;
    ok(sameAddr(buy.call.to, dex.router) && px > 0, `override → ${dex.name}: price ${px.toPrecision(6)} DAI/PLS, buy 5 DAI via ${buy.call.method} on ${buy.call.to}`);
    prices.push(`${dex.name}=${px.toPrecision(5)}`);
  }
  const auto = await hub.setPool('DAI', { auto: true });
  ok(auto.def.pool.address === ch.best?.address || auto.def.pool.dex === ch.best?.dex, `auto → ${hub.dexName(369, auto.def.pool.dex)} (${prices.join(', ')})`);
  await hub.setPool('DAI', { reset: true });
}

async function chainCheck(hub: Hub, rt: ChainRuntime) {
  const c = rt.cfg, r = rt.reader;
  console.log(`\n== ${c.name} (${c.id}${c.status === 'testnet' ? ', TESTNET' : ''}) via ${r.currentUrl ?? '?'}`);
  const id = Number(await r.send!('eth_chainId', []));
  ok(id === c.id, `eth_chainId = ${id}`);
  ok(((await r.getCode!(c.wrappedNative.address)).length > 2), `wrapped native ${c.wrappedNative.symbol} ${c.wrappedNative.address} has code`);
  for (const s of c.stables) {
    const [sym] = await readCall<[string]>(r, s.address, ERC20, 'symbol').catch(() => ['?']);
    const [dec] = await readCall<[bigint]>(r, s.address, ERC20, 'decimals').catch(() => [-1n]);
    ok(Number(dec) === s.decimals, `${s.symbol} ${s.address}: on-chain ${sym}/${dec}`);
  }
  if (!rt.tradable) { console.log(`  · trading unavailable — ${c.trading.reason}`); ok(c.dexes.length === 0 || !c.trading.enabled, 'no tradable DEX configured, as documented'); return; }
  if (c.id === 369) { console.log('  · DEXes verified above'); }
  else for (const d of c.dexes) {
    const iface = d.kind === 'v2' ? ROUTER : V3_ROUTER;
    const [f] = await readCall<[string]>(r, d.router, iface, 'factory');
    ok(sameAddr(f, d.factory), `${d.name}: router ${d.router}.factory() = factory ${d.factory}`);
    if (d.kind === 'v3') { const [qf] = await readCall<[string]>(r, d.quoter!, V3_QUOTER, 'factory'); ok(sameAddr(qf, d.factory), `${d.name}: quoter ${d.quoter} factory matches`); }
  }
  for (const m of hub.byChain(c.id).filter((x) => !x.custom && !x.legacy)) {
    const px = await hub.quoter(m.key).getPrice();
    const [lo, hi] = NATIVE_USD[m.base.symbol] ?? [0, Infinity];
    ok(px > lo && px < hi, `${hub.label(m.key)} on ${hub.dexName(c.id, m.pool.dex)} ${m.pool.feeTier ? `${m.pool.feeTier / 1e4}%` : ''}: ${px.toPrecision(6)}`);
    const mk = await hub.quoter(m.key).market();
    ok(mk.feeBps === m.pool.feeBps && (mk.gasPriceNative ?? -1) >= 0, `market(): fee ${mk.feeBps} bps, gas ${(mk.gasPriceNative ?? 0).toExponential(3)} ${c.nativeSymbol}/gas${mk.extraPlsPerSwap ? `, L1 fee ≈ ${mk.extraPlsPerSwap.toExponential(3)} ${c.nativeSymbol}/swap` : ''}`);
  }
}

async function customTokens(hub: Hub) {
  const cases: { chainId: number; address: string; label: string; expect: 'ok' | 'fot' }[] = [
    { chainId: 1, address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78', label: 'PAXG on Ethereum (upgradeable proxy, no tax)', expect: 'ok' },
    { chainId: 1, address: '0xa7DE087329BFcda5639247F96140f9DAbe3DeED1', label: 'STA on Ethereum (1% transfer burn)', expect: 'fot' },
    { chainId: 369, address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab', label: 'PLSX on PulseChain (PulseX V1/V2 + 9mm)', expect: 'ok' },
  ];
  for (const t of cases) {
    console.log(`\n== Custom token: ${t.label}`);
    try {
      const r = await hub.inspect({ chainId: t.chainId, address: t.address });
      ok(!!r.token.symbol && r.token.codeSize > 0, `metadata: ${r.token.symbol} "${r.token.name}" ${r.token.decimals} dec, code ${r.token.codeSize} B${r.token.proxy ? `, proxy ${r.token.proxy.kind}` : ''}`);
      ok(r.pools.length > 0 && !!r.chosen, `discovery vs ${r.quote.symbol}: ${r.pools.length} pool(s) — ${[...new Set(r.pools.map((p) => p.dexName))].join(', ')}; chosen ${r.chosen?.dexName} ${r.chosen?.feeTier ? `${r.chosen.feeTier / 1e4}%` : `${(r.chosen?.feeBps ?? 0) / 100}%`} TVL ≈ $${Math.round(r.chosen?.tvlUsd ?? 0).toLocaleString('en-US')}`);
      const s = r.safety;
      if (!s) { ok(false, 'no safety report'); continue; }
      const line = `safety ${s.risk} (live ${s.liveAllowed ? 'allowed' : 'blocked'}) taxes buy/xfer/sell ${[s.buyTaxPct, s.transferTaxPct, s.sellTaxPct].map((x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`)).join('/')} · ${s.reasons[0]}`;
      if (s.risk === 'unknown') { warn(`${line} (simulation needs an RPC that accepts eth_call state overrides)`); continue; }
      if (t.expect !== 'fot') { ok(s.simulated && (s.buyTaxPct ?? 0) < 0.001 && (s.sellTaxPct ?? 0) < 0.001, line); continue; }
      // Taxed token: taxes measured separately, policy applied for the pool kind, quote is tax-aware.
      const taxed = [s.buyTaxPct, s.transferTaxPct, s.sellTaxPct].some((x) => (x ?? 0) > 0.001);
      ok(taxed && (s.taxMode === (r.chosen?.kind === 'v3' ? 'v3-proven' : 'v2-fot') || s.taxMode === 'blocked'), `${line} · mode ${s.taxMode} on ${r.chosen?.dexName} (${r.chosen?.kind})`);
      if (r.draft && r.chosen) {
        const rt = hub.rt(t.chainId);
        const d = { ...r.draft, safety: s };
        const taxes = { buy: s.buyTaxPct ?? 0, sell: s.sellTaxPct ?? 0, transfer: s.transferTaxPct ?? 0 };
        const q = new Quoter(rt.reader, d, {
          chain: rt.cfg, adapter: rt.adapter(d.pool.dex), resolve: (id) => rt.adapter(id),
          taxOf: (a) => (a.toLowerCase() === d.base.address.toLowerCase() ? taxes : { buy: 0, sell: 0, transfer: 0 }),
        });
        const usdIn = 20;
        const quoteUsd = r.quote.kind === 'stable' ? 1 : (hub.nativeUsd(t.chainId) ?? 0);
        if (quoteUsd > 0) {
          const qb = await q.quote('buy', usdIn / quoteUsd, DEFAULT_LIMITS, '0x000000000000000000000000000000000000dEaD', null);
          const ratio = Number(qb.quotedOut) / Number(qb.routerOut);
          ok(Math.abs(ratio - (1 - taxes.buy)) < 1e-4 && Number(qb.call.amountOutMin) <= Number(qb.quotedOut) && (d.pool.kind !== 'v2' || /SupportingFeeOnTransferTokens$/.test(qb.call.method)),
            `tax-aware buy quote: router out ${qb.routerOut} → after ${(taxes.buy * 100).toFixed(2)}% buy tax ${qb.quotedOut}; minOut ${qb.call.amountOutMin}; method ${qb.call.method}`);
          const qs = await q.quote('sell', Number(qb.quotedOut) / 10 ** d.base.decimals, DEFAULT_LIMITS, '0x000000000000000000000000000000000000dEaD', null, { amountInUnits: qb.quotedOut });
          ok(qs.poolIn < qs.amountIn || taxes.sell === 0, `tax-aware sell quote: ${qs.amountIn} in → pool receives ${qs.poolIn} after ${(taxes.sell * 100).toFixed(2)}% sell tax → ${qs.quotedOutHuman.toPrecision(6)} ${r.quote.symbol}`);
          const econIn = { lowerPrice: r.chosen.mid! * 0.9, upperPrice: r.chosen.mid! * 1.1, gridCount: 10, capital: 1000 / quoteUsd, spot: r.chosen.mid!, pool: { quoteReserve: 1e9, plsReserve: 1e9 / r.chosen.mid! }, gasPricePls: 0, approval: 'max' as const, feeBps: d.pool.feeBps };
          const clean = analyzeEconomics(econIn);
          const econ = analyzeEconomics({ ...econIn, buyTaxPct: taxes.buy, sellTaxPct: taxes.sell });
          ok(econ.netPct < clean.netPct && econ.roundTripFeePct > clean.roundTripFeePct,
            `start gate counts the measured taxes (±10% ×10): round-trip cost ${(clean.roundTripFeePct * 100).toFixed(3)}% → ${(econ.roundTripFeePct * 100).toFixed(3)}%, worst net ${(clean.netPct * 100).toFixed(3)}% → ${(econ.netPct * 100).toFixed(3)}% (${econ.ok ? 'still OK' : 'BLOCKED: ' + econ.reasons[0]})`);
          const tight = analyzeEconomics({ ...econIn, lowerPrice: r.chosen.mid! * 0.99, upperPrice: r.chosen.mid! * 1.01, buyTaxPct: taxes.buy, sellTaxPct: taxes.sell });
          ok(!tight.ok, `tight ±1% ×10 grid with these taxes is blocked: ${tight.reasons[0]}`);
        }
      }
    } catch (e) { warn(`${t.label}: ${(e as Error).message.slice(0, 160)}`); }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Base/quote flip: HEX/PLS (spend PLS, stack HEX) quoted read-only on the deepest pool across PulseX V1/V2 + 9mm.
// ─────────────────────────────────────────────────────────────────────────────
async function flipChecks(hub: Hub) {
  console.log('\n== Flipped markets (HEX/PLS, PLSX/PLS, eHEX/PLS): spend PLS, stack the token — deepest pool, read-only');
  const unwrapSel = V3_ROUTER.getFunction('unwrapWETH9')!.selector;
  const plsUsd = hub.nativeUsd(369) ?? (await hub.nativeUsdAsync(369)) ?? null;
  for (const sym of ['HEX', 'PLSX', 'eHEX']) {
    try {
      const key = `${sym}~`;
      const def = hub.def(key), orig = hub.def(sym);
      ok(def.flipped === true && def.base.symbol === sym && def.quote.symbol === 'PLS' && !!def.quote.native && def.quote.decimals === 18 && def.base.decimals === orig.quote.decimals,
        `${hub.label(key)}: base ${def.base.symbol} (${def.base.decimals} dec) / quote ${def.quote.symbol} native (${def.quote.decimals} dec)`);
      if (sym === 'HEX') ok(def.base.decimals === 8, 'HEX has 8 decimals, PLS 18');
      const choice = await hub.poolOptions(sym);
      const best = choice.best;
      for (const p of choice.pools.slice(0, 6)) console.log(`     ${p === best ? '★' : ' '} ${p.dexName.padEnd(10)} ${p.feeTier != null ? `${p.feeTier / 1e4}%`.padEnd(6) : `${p.feeBps / 100}%`.padEnd(6)} TVL ≈ $${Math.round(p.tvlUsd ?? 0).toLocaleString('en-US').padStart(12)}${p.offMarket ? ' (off-market)' : ''}${p.error ? ` err ${p.error.slice(0, 40)}` : ''}`);
      if (!best) { ok(false, `${sym}: no pool found`); continue; }
      const pool = { dex: best.dex, kind: best.kind, address: best.address, feeBps: best.feeBps, ...(best.feeTier != null ? { feeTier: best.feeTier } : {}) };
      const fq = hub.quoterOnPool(key, pool), cq = hub.quoterOnPool(sym, pool);
      const fee = pool.feeBps / 10_000, f1 = 1 - fee;
      const [flipPx, origPx] = await Promise.all([fq.getPrice(), cq.getPrice()]);
      const prod = flipPx * origPx;
      ok(prod > f1 * f1 * 0.99 && prod < 1.0001, `deepest pool ${best.dexName} ${best.feeTier != null ? `${best.feeTier / 1e4}%` : `${best.feeBps / 100}%`}: ${flipPx.toPrecision(6)} PLS per ${sym} × ${origPx.toPrecision(6)} ${sym} per PLS = ${prod.toFixed(5)} (≈ (1−fee)² = ${(f1 * f1).toFixed(5)}; 1/x inversion within fee + probe impact)`);
      // Flipped BUY: ≈ $25 of PLS → token (PLS in as msg.value)
      const plsIn = plsUsd ? Math.round(25 / plsUsd) : 1_000_000;
      const buy = await fq.quote('buy', plsIn, DEFAULT_LIMITS, DUMMY, null);
      const methodOk = best.kind === 'v2' ? /^swapExactETHForTokens/.test(buy.call.method) : buy.call.method === 'multicall' && !(buy.call.args[1] as string[]).some((d) => d.startsWith(unwrapSel));
      ok(buy.tokenIn === NATIVE && buy.call.value === buy.amountIn && buy.approveAmount == null && methodOk && buy.decimalsIn === 18 && buy.decimalsOut === def.base.decimals,
        `flipped BUY ${plsIn.toLocaleString('en-US')} PLS → ${buy.quotedOutHuman.toFixed(def.base.decimals > 4 ? 4 : def.base.decimals)} ${sym} via ${buy.call.method} (value = ${buy.amountIn} wei, no approve), price ${buy.price.toPrecision(6)} PLS/${sym}, impact ${(buy.priceImpact * 100).toFixed(4)}%, gas ≈ ${buy.gasPlsEstimate.toPrecision(3)} ${sym}`);
      ok(buy.price >= flipPx && buy.price / flipPx < 1 / (f1 * f1) * (1 + 2 * buy.priceImpact) + 0.002, `buy price ${buy.price.toPrecision(6)} vs bid ${flipPx.toPrecision(6)}: spread ${((buy.price / flipPx - 1) * 100).toFixed(3)}% ≈ 2 × fee + impact`);
      // Flipped SELL: the exact token units bought → PLS (unwrapped)
      const sell = await fq.quote('sell', buy.quotedOutHuman, DEFAULT_LIMITS, DUMMY, 0n, { amountInUnits: buy.quotedOut });
      const sellOk = best.kind === 'v2' ? /^swapExactTokensForETH/.test(sell.call.method) : sell.call.method === 'multicall' && (sell.call.args[1] as string[]).some((d) => d.startsWith(unwrapSel));
      ok(sell.tokenOut === NATIVE && sell.call.value === 0n && sell.amountIn === buy.quotedOut && sellOk && sell.approveAmount === sell.amountIn,
        `flipped SELL ${buy.quotedOut} raw ${sym} (exact lot) → ${sell.quotedOutHuman.toFixed(2)} PLS via ${sell.call.method}${best.kind === 'v3' ? ' + unwrapWETH9' : ''} (approve ${sym} first), impact ${(sell.priceImpact * 100).toFixed(4)}%`);
      const rt = sell.quotedOutHuman / plsIn;
      ok(rt < 1 && rt > f1 * f1 * (1 - 2 * Math.max(buy.priceImpact, sell.priceImpact)) - 0.001, `round trip PLS → ${sym} → PLS returns ${(rt * 100).toFixed(3)}% (fees ${((1 - f1 * f1) * 100).toFixed(3)}%)`);
      // Classic orientation on the same pool still uses the opposite native legs.
      const cb = await cq.quote('buy', buy.quotedOutHuman, DEFAULT_LIMITS, DUMMY, null);
      ok(cb.tokenOut === NATIVE && cb.tokenIn !== NATIVE, `classic PLS/${sym} buy on the same pool spends ${sym} for native PLS (${cb.call.method})`);
    } catch (e) { ok(false, `${sym}~: ${(e as Error).message.slice(0, 200)}`); }
  }
  // Presets through the real MultiBot code path (best pool per leg, no pool switch — preview only).
  const bot = new MultiBot({ net: NETWORKS.mainnet, reader: hub.rt(369).reader, signer: null, store: new MemoryStore<MultiState>(), log: new Logger(true), hub });
  for (const id of ['stack-hex', 'stack-plsx', 'stack-ehex']) {
    try {
      const pv = await bot.previewPreset(id);
      for (const l of pv.legs) {
        const e = l.econ;
        const k = hub.usdPerQuote(l.quote) ?? 0;
        ok(e.ok, `${id} ${l.label} ±${l.bandPct * 100}%×${l.gridCount} $${l.capitalUsd} → ${Math.round(l.totalCapitalUsd).toLocaleString('en-US')} PLS on ${l.pool?.dexName ?? 'current pool'}${l.pool?.switchTo ? ' (would switch to this pool on start)' : ''}: range ${l.lowerPrice.toPrecision(5)}–${l.upperPrice.toPrecision(5)} PLS/${l.label.split('/')[0]}, size ${e.levelSize.toPrecision(5)} PLS, step ${(e.spacingPct * 100).toFixed(3)}%, impact ${(e.impactPct * 100).toFixed(3)}%, gas ≈ $${(e.gasQuote * k).toFixed(4)}, net ${(e.netPct * 100).toFixed(3)}% ≈ $${(e.netPerRoundTrip * k).toFixed(4)}/RT${e.ok ? '' : ' ' + e.reasons.join(' ')}`);
      }
    } catch (e) { ok(false, `${id}: ${(e as Error).message.slice(0, 200)}`); }
  }
}
