/**
 * Crypto units only (Kyle's rule), shared by the server and the UI: a figure that only exists in dollars (a pool's
 * liquidity, a liquidity floor, a trade size) is shown as "≈ N ETH", or "—" when there is no ETH price. Comparisons
 * and stored settings stay in dollars; only the words a screen or a notification shows change.
 *
 * ETH price on the server: the chain hub's native/stable read (Hub.nativeUsd, the same number the status payload sends
 * as chains[].nativeUsd), Ethereum (chain 1) first, then any other chain whose native coin is ETH. The hub registers it
 * with registerHubEthUsd when it starts; until then the text is "—". Tests pin a price with setEthUsdSource.
 */

/** A plain number of coins: about 4 significant figures, thousands separators, never scientific notation. */
export function coinNum(x: number, sig = 4): string {
  const a = Math.abs(x);
  if (a === 0) return '0';
  if (a >= 1000) return a.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (a >= 1) return a.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, sig - 1 - Math.floor(Math.log10(a))) });
  return a.toLocaleString('en-US', { maximumFractionDigits: Math.min(10, sig - 1 - Math.floor(Math.log10(a))) });
}

const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Dollars per ETH from a list of chains ({ id, nativeSymbol, nativeUsd }): Ethereum first, then any ETH-native chain. */
export function ethUsdFromChains(cs: readonly { id: number; nativeSymbol?: string | null; nativeUsd?: number | null }[] | null | undefined): number | null {
  const eth = (cs ?? []).filter((c) => String(c.nativeSymbol ?? '').toUpperCase() === 'ETH' && ok(c.nativeUsd));
  const c = eth.find((x) => x.id === 1) ?? eth[0];
  return c ? (c.nativeUsd as number) : null;
}

let hub: (() => number | null) | null = null;
let pinned: (() => number | null) | null = null;
/** The chain hub's ETH price (the latest hub built wins; one per server). */
export function registerHubEthUsd(fn: () => number | null) { hub = fn; }
/** A fixed ETH price source that wins over the hub's (tests); null clears it. */
export function setEthUsdSource(fn: (() => number | null) | null) { pinned = fn; }
/** The ETH price now, or null. */
export function ethUsdNow(): number | null {
  try { const v = (pinned ?? hub)?.() ?? null; return ok(v) ? v : null; } catch { return null; }
}

/** "≈ 34.17 ETH" for a dollar amount (ethUsd defaults to the registered source); "—" without a price. */
export function usdAsEth(usd: number | null | undefined, ethUsd: number | null | undefined = ethUsdNow()): string {
  if (usd == null || !Number.isFinite(usd) || !ok(ethUsd)) return '—';
  const e = usd / ethUsd;
  return `≈ ${e < 0 ? '−' : ''}${coinNum(e)} ETH`;
}
