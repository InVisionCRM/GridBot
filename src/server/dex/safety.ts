/**
 * Token safety checks before a custom market may trade live.
 *
 *  1. Simulated round-trip (eth_call + state override, nothing is sent): SafetyProbe (contracts/SafetyProbe.sol)
 *     is injected at a throwaway address with a fake native balance, wraps ≈$20 of native, optionally swaps it
 *     to the quote token, BUYS the token on the market's pool, transfers 10 % to a fresh address and SELLS the
 *     rest back. Received vs quoted amounts give buy / transfer / sell tax; a revert = honeypot / blocked.
 *  2. Depth: price impact of $100 / $500 / $1k buys and sells on the chosen pool (QuoterV2 / getAmountsOut).
 *  3. Proxy / upgradeable contract flag (EIP-1967/1822/1167/OZ slots).
 *
 * 4. Token flags: maxTxAmount / maxWallet / blacklist / paused / tradingEnabled views.
 *
 * TAX POLICY (src/live/tax.ts): taxed tokens trade live on V2 pools up to MAX_TAX per side (fee-on-transfer router
 * methods, min-out after tax, taxes in every gate, PnL from actual balance changes); on V3 only if the round trip
 * through that pool was simulated successfully; above the cap / honeypot / paused / unverified → paper only.
 */
import { Interface } from 'ethers';
import type { MarketDef, SafetyReport } from '../../live/markets';
import { fromUnits } from '../../live/swapMath';
import { amountToUnits } from '../../live/decimals';
import { MAX_TAX, TAX_TOLERANCE } from '../../live/tax';
import type { TokenFlags } from './tokens';
import type { ChainRuntime } from '../chains/runtime';
import { SAFETY_PROBE_RUNTIME } from './probeCode';
import type { DexAdapter } from './types';

export const PROBE_ADDRESS = '0x5afe00000000000000000000000000000000be5e';
const PROBE_FROM = '0x000000000000000000000000000000000000dEaD';
const HOP = '(uint8 kind,address router,address quoter,uint24 fee,address tokenIn,address tokenOut)';
export const PROBE_IFACE = new Interface([
  `function probe(address weth, uint256 wethIn, ${HOP} prep, bool hasPrep, ${HOP} buy, ${HOP} sell) returns ((uint256 quoteIn,uint256 expectedBuy,uint256 gotBuy,uint256 transferSent,uint256 transferGot,uint256 sellIn,uint256 expectedSell,uint256 gotSell,uint8 stage,bytes err,uint256 gasBuy,uint256 gasSell) r)`,
]);

export interface ProbeResult {
  stage: number; quoteIn: bigint; expectedBuy: bigint; gotBuy: bigint; transferSent: bigint; transferGot: bigint;
  sellIn: bigint; expectedSell: bigint; gotSell: bigint; err: string; gasBuy: bigint; gasSell: bigint;
}

export { TAX_TOLERANCE, MAX_TAX };

export interface Hop { kind: number; router: string; quoter: string; fee: number; tokenIn: string; tokenOut: string }

export function hopFor(ad: DexAdapter, pool: MarketDef['pool'], tokenIn: string, tokenOut: string): Hop {
  return { kind: ad.kind === 'v2' ? 0 : 1, router: ad.cfg.router, quoter: ad.cfg.quoter ?? ad.cfg.router, fee: pool.feeTier ?? 0, tokenIn, tokenOut };
}

/** Minimal JSON-RPC quantity (no leading zeros — strict geth rejects 0x0de0…). */
export const qty = (n: bigint) => '0x' + n.toString(16);

const pct = (got: bigint, exp: bigint) => (exp > 0n ? Math.max(0, 1 - Number(got) / Number(exp)) : null);

export interface SafetyInputs {
  probe: ProbeResult | null;
  simError?: string | null;
  proxy: SafetyReport['proxy'];
  depth: SafetyReport['depth'];
  liquidityUsd: number | null;
  now?: number;
  /** Pool kind of the market (taxed tokens: V2 → fee-on-transfer methods; V3 → only if proven) */
  poolKind?: 'v2' | 'v3';
  flags?: TokenFlags | null;
  decimals?: number;
  /** Per-side live cap (fraction); default MAX_TAX */
  maxTax?: number;
}

/** Pure classifier (unit-tested with mocked probe results). */
export function classify(i: SafetyInputs): SafetyReport {
  const reasons: string[] = [];
  let risk = 'low' as SafetyReport['risk'];
  const bump = (r: SafetyReport['risk']) => {
    const order = ['low', 'medium', 'high', 'unknown', 'blocked'];
    if (order.indexOf(r) > order.indexOf(risk)) risk = r;
  };
  const p = i.probe;
  let buyTax: number | null = null, sellTax: number | null = null, xferTax: number | null = null, honeypot: boolean | null = null;
  let taxMode: SafetyReport['taxMode'] = 'blocked';
  if (!p) {
    bump('unknown');
    reasons.push(`Buy/sell simulation unavailable${i.simError ? ` (${i.simError})` : ''} — live trading blocked until it passes; paper is fine.`);
  } else {
    // Only stages that completed carry a measurement (1 prep · 2 buy · 3 transfer · 4 sell failed).
    buyTax = p.stage === 0 || p.stage >= 3 ? pct(p.gotBuy, p.expectedBuy) : null;
    xferTax = (p.stage === 0 || p.stage === 4) && p.transferSent > 0n ? pct(p.transferGot, p.transferSent) : null;
    sellTax = p.stage === 0 ? pct(p.gotSell, p.expectedSell) : null;
    honeypot = p.stage === 4 || p.stage === 3;
    if (p.stage === 1) { bump('unknown'); reasons.push(`Could not fund the simulation (native → quote swap failed${p.err ? `: ${p.err}` : ''}).`); }
    if (p.stage === 2) { bump('blocked'); reasons.push(`Simulated BUY reverts${p.err ? `: ${p.err}` : ''}.`); }
    if (p.stage === 3) { bump('blocked'); reasons.push('Token transfers between wallets revert — honeypot pattern.'); }
    if (p.stage === 4) { bump('blocked'); reasons.push(`Simulated SELL reverts${p.err ? `: ${p.err}` : ''} — honeypot (can buy, cannot sell) or a transfer tax the pool rejects.`); }
    if (p.stage === 0 && p.expectedBuy === 0n) { bump('unknown'); reasons.push('Router/quoter returned no quote for the simulated buy.'); }
    const taxes = [['buy', buyTax], ['transfer', xferTax], ['sell', sellTax]] as const;
    const taxed = taxes.filter(([, t]) => t != null && t > TAX_TOLERANCE);
    const cap = i.maxTax ?? MAX_TAX;
    const list = taxed.map(([k, t]) => `${k} ${(t! * 100).toFixed(2)}%`).join(', ');
    if (taxed.length && p.stage === 0) {
      const over = taxed.filter(([, t]) => t! > cap + 1e-9);
      if (over.length) {
        bump('blocked'); taxMode = 'blocked';
        reasons.push(`Tax above the ${(cap * 100).toFixed(0)}% live cap (${over.map(([k, t]) => `${k} ${(t! * 100).toFixed(2)}%`).join(', ')}) — paper only.`);
      } else if (i.poolKind === 'v3') {
        // The probe swapped through this V3 pool and router successfully (buy, transfer and sell) — proven.
        bump('high'); taxMode = 'v3-proven';
        reasons.push(`Tax token on a V3 pool (${list}). Allowed live only because the simulated buy → transfer → sell through this exact pool succeeded; V3 routers have no fee-on-transfer mode, so the router minimum is set on the pre-tax output and the received amount is checked from the balance change. Prefer a V2 pool.`);
      } else {
        const worst = Math.max(...taxed.map(([, t]) => t!));
        bump(worst >= 0.05 ? 'high' : 'medium'); taxMode = 'v2-fot';
        reasons.push(`Fee-on-transfer token (${list}). Live on this V2 pool uses the router's SupportingFeeOnTransferTokens methods, sets the minimum out after tax, counts both taxes in every cost gate and books PnL from the actual amounts received. Re-checked periodically; bots pause if a tax rises.`);
      }
    } else if (p.stage === 0) taxMode = 'none';
    if (p.stage !== 0) taxMode = 'blocked';
  }
  const f = i.flags;
  const human = (raw: string | null | undefined) => (raw && i.decimals != null ? fromUnits(BigInt(raw), i.decimals) : null);
  const maxTxTokens = human(f?.maxTx), maxWalletTokens = human(f?.maxWallet);
  if (f?.paused) { bump('blocked'); reasons.push(`${f.pausedBy ?? 'paused()'} — trading is paused / not enabled; paper only until it opens.`); }
  if (f?.blacklist) { bump('medium'); reasons.push(`Owner can blacklist wallets (${f.blacklist}) — a blacklisted bot wallet could not sell.`); }
  if (maxTxTokens != null) { bump('medium'); reasons.push(`Max transaction ${maxTxTokens.toPrecision(6)} tokens — orders above it are skipped.`); }
  if (maxWalletTokens != null) { bump('medium'); reasons.push(`Max wallet ${maxWalletTokens.toPrecision(6)} tokens — buys that would exceed it are skipped.`); }
  if (i.proxy) { bump('medium'); reasons.push(`Upgradeable proxy (${i.proxy.kind}) — the owner can change the token logic.`); }
  if (i.liquidityUsd != null) {
    if (i.liquidityUsd < 10_000) { bump('high'); reasons.push(`Thin pool: ≈$${Math.round(i.liquidityUsd).toLocaleString('en-US')} liquidity.`); }
    else if (i.liquidityUsd < 50_000) { bump('medium'); reasons.push(`Modest pool: ≈$${Math.round(i.liquidityUsd).toLocaleString('en-US')} liquidity.`); }
  }
  const d100 = i.depth.find((d) => d.usd === 100), d1k = i.depth.find((d) => d.usd === 1000);
  const worst = (d?: { buyImpactPct: number | null; sellImpactPct: number | null }) => Math.max(d?.buyImpactPct ?? 0, d?.sellImpactPct ?? 0);
  if (d100 && worst(d100) > 0.03) { bump('high'); reasons.push(`$100 trade moves the price ${(worst(d100) * 100).toFixed(2)}%.`); }
  else if (d1k && worst(d1k) > 0.05) { bump('medium'); reasons.push(`$1k trade moves the price ${(worst(d1k) * 100).toFixed(2)}%.`); }
  if (!reasons.length) reasons.push('Simulated buy, transfer and sell matched quotes exactly; no proxy; adequate depth.');
  const r = risk as SafetyReport['risk'];
  return {
    at: i.now ?? Date.now(), risk: r, liveAllowed: r !== 'blocked' && r !== 'unknown', reasons,
    buyTaxPct: buyTax, sellTaxPct: sellTax, transferTaxPct: xferTax, honeypot, proxy: i.proxy, depth: i.depth,
    liquidityUsd: i.liquidityUsd, simulated: !!p,
    taxMode, poolKind: i.poolKind, taxCapPct: i.maxTax ?? MAX_TAX, maxTxTokens, maxWalletTokens,
    blacklist: f?.blacklist ?? null, paused: f?.paused ?? null, ...(i.decimals != null ? { decimals: i.decimals } : {}),
  };
}

function decodeErr(data: string): string {
  if (!data || data === '0x') return '';
  try {
    if (data.startsWith('0x08c379a0')) return String(new Interface(['function Error(string)']).decodeFunctionData('Error', data)[0]).slice(0, 80);
  } catch { /* fallthrough */ }
  return data.slice(0, 18);
}

/** Run the probe via eth_call with a state override. Throws if the RPC rejects overrides. */
export async function simulateRoundTrip(
  rt: ChainRuntime, a: { weth: string; wethIn: bigint; prep: Hop | null; buy: Hop; sell: Hop },
): Promise<ProbeResult> {
  if (!rt.reader.send) throw new Error('reader cannot send raw eth_call');
  const zero: Hop = { kind: 0, router: a.weth, quoter: a.weth, fee: 0, tokenIn: a.weth, tokenOut: a.weth };
  const data = PROBE_IFACE.encodeFunctionData('probe', [a.weth, a.wethIn, a.prep ?? zero, !!a.prep, a.buy, a.sell]);
  const params = [
    { from: PROBE_FROM, to: PROBE_ADDRESS, data, gas: qty(20_000_000n) }, 'latest',
    { [PROBE_ADDRESS]: { code: SAFETY_PROBE_RUNTIME, balance: qty(a.wethIn * 4n) } },
  ];
  // State-override support differs per RPC (some reject it with 400 / invalid argument): try each endpoint.
  const raw = (rt.reader.sendEach ? await rt.reader.sendEach('eth_call', params) : await rt.reader.send('eth_call', params)) as string;
  const [r] = PROBE_IFACE.decodeFunctionResult('probe', raw);
  return {
    stage: Number(r.stage), quoteIn: r.quoteIn, expectedBuy: r.expectedBuy, gotBuy: r.gotBuy, transferSent: r.transferSent,
    transferGot: r.transferGot, sellIn: r.sellIn, expectedSell: r.expectedSell, gotSell: r.gotSell, err: decodeErr(r.err),
    gasBuy: r.gasBuy, gasSell: r.gasSell,
  };
}

/** Depth: impact of buying and selling $usd worth on the market's pool. */
export async function depthAt(ad: DexAdapter, m: MarketDef, quoteUsd: number, baseUsd: number, usds = [100, 500, 1000]): Promise<SafetyReport['depth']> {
  return Promise.all(usds.map(async (usd) => {
    const row = { usd, buyImpactPct: null as number | null, sellImpactPct: null as number | null };
    try {
      const qIn = amountToUnits(usd / quoteUsd, m.quote.decimals);
      row.buyImpactPct = (await ad.quote(m.pool, m.quote.address, m.base.address, qIn)).impact;
    } catch { /* no quote */ }
    try {
      const bIn = amountToUnits(usd / baseUsd, m.base.decimals);
      row.sellImpactPct = (await ad.quote(m.pool, m.base.address, m.quote.address, bIn)).impact;
    } catch { /* no quote */ }
    return row;
  }));
}

export { fromUnits };
