/** Chain + market helpers for the UI: badges, grouped market pickers, explorer links, the global chain filter. */
import { createContext, useContext } from 'react';
import { flipKey, isFlipKey, orientedKey, unflipKey } from '../live/markets';

export { flipKey, isFlipKey, orientedKey, unflipKey };

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MarketInfo {
  key: string; label: string; chainId: number; base: string; quote: string; quoteKind: string; dex: string; kind: 'v2' | 'v3';
  feeBps: number; feeTier: number | null; pool: string | null; legacy: boolean; custom: boolean; risk: string | null;
  liveAllowed: boolean; tradable: boolean; spot: number | null; usdPerQuote: number | null;
  buyTaxPct?: number | null; sellTaxPct?: number | null; transferTaxPct?: number | null; taxMode?: string | null;
  dexName?: string; poolMode?: 'default' | 'auto' | 'manual';
  /** Orientation: flipped = base/quote swapped view of `pairKey` (HEX/PLS of PLS/HEX); spends = quote, stacks = base */
  flipped?: boolean; pairKey?: string; spends?: string; stacks?: string; quoteNative?: boolean;
}
export interface ChainInfo {
  id: number; key: string; name: string; short: string; color: string; status: 'live' | 'testnet'; tradable: boolean; reason: string | null;
  nativeSymbol: string; explorer: string; hasSigner: boolean; address: string | null; gasNative: number | null; lowGas: boolean;
  lowGasNative: number; nativeUsd: number | null; walletError: string | null; txBusy: boolean; rpc: string | null; bots: number;
  dexes: { id: string; name: string; kind: string }[];
}

/** 'all' or a chain id */
export type ChainFilter = 'all' | number;
export const ChainFilterCtx = createContext<{ chain: ChainFilter; setChain: (c: ChainFilter) => void }>({ chain: 'all', setChain: () => undefined });
export const useChainFilter = () => useContext(ChainFilterCtx);

export const chains = (s: AnyObj): ChainInfo[] => s?.chains ?? [];
export const chainOf = (s: AnyObj, id: number | null | undefined): ChainInfo | null => chains(s).find((c) => c.id === id) ?? null;
/** Markets in their configured orientation (one row per pair); flipped views are reached with mk(s, 'K~'). */
export const marketsOf = (s: AnyObj): MarketInfo[] => ((s?.marketList ?? []) as MarketInfo[]).filter((m) => !m.flipped);

/** Market by key (either orientation); legacy fallback when the server predates the market list. */
export function mk(s: AnyObj, key: string): MarketInfo {
  const m = ((s?.marketList ?? []) as MarketInfo[]).find((x) => x.key === key);
  if (m) return m;
  const fl = isFlipKey(key), k0 = unflipKey(key);
  return {
    key, label: fl ? `${k0}/PLS` : `PLS/${key}`, chainId: s?.legacyChainId ?? 369, base: fl ? k0 : 'PLS', quote: fl ? 'PLS' : key, quoteKind: 'token', dex: 'pulsex-v2', kind: 'v2',
    feeBps: 29, feeTier: null, pool: null, legacy: true, custom: false, risk: null, liveAllowed: true, tradable: true, spot: null, usdPerQuote: null,
    flipped: fl, pairKey: k0, spends: fl ? 'PLS' : key, stacks: fl ? k0 : 'PLS', quoteNative: fl,
  };
}
export const lbl = (s: AnyObj, key: string) => mk(s, key).label;

export function explorerTx(s: AnyObj, chainId: number | undefined, hash: string) {
  const c = chainOf(s, chainId ?? s?.legacyChainId) ?? null;
  return `${c?.explorer ?? s?.explorer}/tx/${hash}`;
}
export function explorerAddr(s: AnyObj, chainId: number | undefined, a: string) {
  const c = chainOf(s, chainId ?? s?.legacyChainId) ?? null;
  return `${c?.explorer ?? s?.explorer}/address/${a}`;
}

export function ChainBadge({ c, testnet = true }: { c: Pick<ChainInfo, 'short' | 'color' | 'name' | 'status'> | null; testnet?: boolean }) {
  if (!c) return null;
  return (
    <span className="chain-badge" style={{ ['--cc' as string]: c.color }} title={c.name}>
      {c.short}{testnet && c.status === 'testnet' ? <i>TESTNET</i> : null}
    </span>
  );
}

export function RiskBadge({ risk, title }: { risk: string | null | undefined; title?: string }) {
  if (!risk) return null;
  return <span className={`risk-badge risk-${risk}`} title={title}>{risk}</span>;
}

export const feeLabel = (m: Pick<MarketInfo, 'feeBps' | 'feeTier' | 'kind'>) =>
  m.kind === 'v3' && m.feeTier != null ? `${+(m.feeTier / 10000).toFixed(2)}%` : `${+(m.feeBps / 100).toFixed(2)}%`;

/**
 * Grouped <option>s for every tradable market (respects the global chain filter unless `all`). Values are the
 * ORIGINAL keys; `flipped` only changes the labels (HEX/PLS instead of PLS/HEX) — PairPicker adds the '~'.
 */
export function MarketOptions({ s, all = false, includeKey, flipped = false }: { s: AnyObj; all?: boolean; includeKey?: string; flipped?: boolean }) {
  const { chain } = useChainFilter();
  const inc = includeKey ? unflipKey(includeKey) : undefined;
  const ms = marketsOf(s).filter((m) => (m.tradable && (all || chain === 'all' || m.chainId === chain)) || m.key === inc);
  if (!ms.length) return <>{(s.quotes ?? []).map((q: string) => <option key={q} value={q}>PLS/{q}</option>)}</>;
  const groups = chains(s).map((c) => ({ c, list: ms.filter((m) => m.chainId === c.id) })).filter((g) => g.list.length);
  return (
    <>
      {groups.map(({ c, list }) => (
        <optgroup key={c.id} label={`${c.name}${c.status === 'testnet' ? ' (TESTNET)' : ''}`}>
          {list.map((m) => (
            <option key={m.key} value={m.key}>
              {flipped ? mk(s, flipKey(m.key)).label : m.label}{m.custom ? ` · ${m.risk ?? 'unchecked'}${m.liveAllowed ? '' : ' (paper only)'}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

const nf = (x: number | null | undefined, d = 4) => (x == null ? '—' : x.toLocaleString(undefined, { maximumFractionDigits: d }));

/** Chain selector strip: All + each chain with gas balance, status and per-chain STOP. */
export function ChainBar({ s, busy, onStop }: { s: AnyObj; busy: boolean; onStop: (c: ChainInfo) => void }) {
  const { chain, setChain } = useChainFilter();
  const cs = chains(s);
  if (!cs.length) return null;
  return (
    <div className="chainbar" role="tablist" aria-label="chain selector">
      <button type="button" role="tab" aria-selected={chain === 'all'} className={`chip ${chain === 'all' ? 'on' : ''}`} onClick={() => setChain('all')}>
        All chains <span className="muted small">{cs.length}</span>
      </button>
      {cs.map((c) => {
        const on = chain === c.id;
        const gasTitle = c.hasSigner
          ? `${c.name}: ${nf(c.gasNative, 6)} ${c.nativeSymbol}${c.lowGas ? ` — LOW (< ${c.lowGasNative})` : ''}${c.walletError ? ` · ${c.walletError}` : ''}`
          : `${c.name}: no key — paper only`;
        return (
          <span key={c.id} className={`chip ${on ? 'on' : ''} ${c.tradable ? '' : 'off'}`} title={c.tradable ? `${c.name} · ${c.dexes.map((d) => d.name).join(', ')} · RPC ${c.rpc ?? '?'}` : `${c.name}: trading unavailable — ${c.reason}`}>
            <button type="button" role="tab" aria-selected={on} className="chip-main" onClick={() => setChain(c.id)}>
              <ChainBadge c={c} />
              <span className="chip-gas" title={gasTitle}>
                {c.tradable ? (c.hasSigner ? <>{nf(c.gasNative, c.gasNative != null && c.gasNative < 1 ? 5 : 1)} {c.nativeSymbol}</> : <span className="muted">paper</span>) : <span className="muted">unavailable</span>}
              </span>
              {c.lowGas && <span className="neg small" title={gasTitle}>⚠ gas</span>}
              {c.txBusy && <span className="busy-pill">tx</span>}
              {c.bots ? <span className="muted small">{c.bots}</span> : null}
            </button>
            {c.bots > 0 && (
              <button type="button" className="chip-stop" disabled={busy} title={`Stop every bot on ${c.name}`} onClick={() => onStop(c)}>■</button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** DEX id → display name on a chain ('pulsex-v1' → 'PulseX V1'). Fills recorded before DEX tagging were PulseX V2. */
export function dexName(s: AnyObj, chainId: number | undefined, id: string | null | undefined): string {
  const cid = chainId ?? 369;
  const dexId = id ?? (cid === 369 || cid === 943 ? 'pulsex-v2' : null);
  if (!dexId) return '—';
  return chainOf(s, cid)?.dexes.find((d) => d.id === dexId)?.name ?? dexId;
}
const feeTxt = (feeBps?: number | null, feeTier?: number | null) => (feeTier != null ? `${+(feeTier / 10000).toFixed(2)}%` : feeBps != null ? `${+(feeBps / 100).toFixed(2)}%` : '');
/** Compact "PulseX V1 0.29%" tag for grids, bots, fills and pools. */
export function DexTag({ name, feeBps, feeTier, title }: { name: string | null | undefined; feeBps?: number | null; feeTier?: number | null; title?: string }) {
  if (!name) return null;
  return <span className="dex-tag" title={title ?? `DEX/pool version · LP fee`}>{name}{feeBps != null || feeTier != null ? ` ${feeTxt(feeBps, feeTier)}` : ''}</span>;
}

/**
 * Pair picker with the ⇄ orientation toggle. `value` is the market key in its orientation ('HEX' = PLS/HEX,
 * 'HEX~' = HEX/PLS); the select picks the pair, the button flips base ↔ quote.
 */
export function PairPicker({ s, value, onChange, all = false, label = 'Pair', disabled = false }: { s: AnyObj; value: string; onChange: (key: string) => void; all?: boolean; label?: string; disabled?: boolean }) {
  const fl = isFlipKey(value), m = mk(s, value);
  return (
    <label>{label}
      <span className="pair-pick">
        <select value={unflipKey(value)} disabled={disabled} onChange={(e) => onChange(orientedKey(e.target.value, fl))} aria-label={`${label} (${m.label})`}>
          <MarketOptions s={s} all={all} includeKey={value} flipped={fl} />
        </select>
        <button type="button" className={`flip-btn ${fl ? 'on' : ''}`} disabled={disabled} aria-pressed={fl} aria-label="flip base and quote"
          title={`Flip orientation → ${mk(s, flipKey(value)).label} (spend ${mk(s, flipKey(value)).quote}, stack ${mk(s, flipKey(value)).base})`}
          onClick={() => onChange(flipKey(value))}>⇄</button>
      </span>
    </label>
  );
}

/** "HEX/PLS · Spends: PLS · Stacks: HEX" — what the bot spends on buys and accumulates. */
export function Orientation({ m, compact = false }: { m: Pick<MarketInfo, 'base' | 'quote' | 'flipped' | 'label'>; compact?: boolean }) {
  return (
    <span className={`orient ${m.flipped ? 'flipped' : ''}`} title={m.flipped ? 'Flipped orientation: base/quote swapped' : 'Configured orientation'}>
      {!compact && <b>{m.base}/{m.quote}</b>}{!compact && ' · '}Spends: <b>{m.quote}</b> · Stacks: <b>{m.base}</b>{m.flipped ? <i className="flip-tag">⇄</i> : null}
    </span>
  );
}
