/** Chain + market helpers for the UI: badges, grouped market pickers, explorer links, the global chain filter. */
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { flipKey, isFlipKey, orientedKey, unflipKey } from '../live/markets';
import { http } from './api';
import { Tip } from './Tip';

export { flipKey, isFlipKey, orientedKey, unflipKey };

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MarketInfo {
  key: string; label: string; chainId: number; base: string; quote: string; quoteKind: string; dex: string; kind: 'v2' | 'v3';
  feeBps: number; feeTier: number | null; pool: string | null; legacy: boolean; custom: boolean; risk: string | null; riskWhy?: string | null;
  liveAllowed: boolean; tradable: boolean; spot: number | null; usdPerQuote: number | null;
  buyTaxPct?: number | null; sellTaxPct?: number | null; transferTaxPct?: number | null; taxMode?: string | null;
  dexName?: string; poolMode?: 'default' | 'auto' | 'manual';
  /** Orientation: flipped = base/quote swapped view of `pairKey` (HEX/PLS of PLS/HEX); spends = quote, stacks = base */
  flipped?: boolean; pairKey?: string; spends?: string; stacks?: string; quoteNative?: boolean;
  /** Lowercase token addresses (the wrapped native token's address for native sides) */
  quoteAddress?: string; baseAddress?: string; baseNative?: boolean;
  /** A liquidity bot can run here (V3 pool on a DEX with a verified position manager) */
  lpOk?: boolean;
}
export interface ChainInfo {
  id: number; key: string; name: string; short: string; color: string; status: 'live' | 'testnet'; tradable: boolean; reason: string | null;
  nativeSymbol: string; explorer: string; hasSigner: boolean; address: string | null; gasNative: number | null; lowGas: boolean;
  lowGasNative: number; nativeUsd: number | null; walletError: string | null; txBusy: boolean; rpc: string | null; bots: number;
  dexes: { id: string; name: string; kind: string }[];
  /** Per-chain RPC health (server: FallbackReader.health) */
  rpcHealth?: RpcHealth | null;
}
export interface RpcHealth {
  state: 'ok' | 'degraded' | 'down'; failingSince: number | null; lastFailAt: number | null; lastOkAt: number | null;
  failures: number; lastError: string | null; alerted: boolean; current: string; switches: number;
  endpoints: { url: string; ok: boolean; failsInRow: number; lastError: string | null; lastOkAt: number | null; lastFailAt: number | null; coolUntil: number | null }[];
}
/** Chains whose RPCs have kept failing long enough to alert (the server decides; see RPC_ALERT_MINUTES). */
export const rpcAlerts = (s: AnyObj): ChainInfo[] => chains(s).filter((c) => c.rpcHealth?.alerted);

/** 'all' or a chain id */
export type ChainFilter = 'all' | number;
export const ChainFilterCtx = createContext<{ chain: ChainFilter; setChain: (c: ChainFilter) => void }>({ chain: 'all', setChain: () => undefined });
export const useChainFilter = () => useContext(ChainFilterCtx);
/** The app's status refresh: a picker that just added a pair selects it once the market list has it. */
export const RefreshCtx = createContext<() => Promise<void>>(async () => undefined);

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
              {flipped ? mk(s, flipKey(m.key)).label : m.label}{m.custom || m.risk ? ` · ${m.risk ?? 'unchecked'}${m.liveAllowed ? '' : ' (paper only)'}` : ''}
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
              {c.rpcHealth && c.rpcHealth.state !== 'ok' && (
                <span className={c.rpcHealth.state === 'down' ? 'neg small' : 'muted small'} title={`${c.name} RPC ${c.rpcHealth.state}${c.rpcHealth.lastError ? `: ${c.rpcHealth.lastError}` : ''}`}>⚠ rpc</span>
              )}
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

/** lookalike: a coin the app doesn't know that uses a known coin's name (that name) */
interface FoundCoin { address: string; symbol: string; name: string; lookalike: string | null }
/** A pool DexScreener knows on one of the app's DEXes (GET /api/pools/search). */
interface FoundPool {
  chainId: number; dex: string; dexName: string; kind: 'v2' | 'v3'; pool: string;
  base: FoundCoin; quote: FoundCoin;
  feeTier: number | null; feeBps: number | null; liquidityUsd: number | null; volume24hUsd: number | null; market: string | null; lpOk: boolean;
}
const usdShort = (x: number | null) => (x == null ? '—' : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);

/**
 * Pair picker with search and the ⇄ orientation toggle. `value` is the market key in its orientation ('HEX' = PLS/HEX,
 * 'HEX~' = HEX/PLS). Typing filters your pairs; from 2 letters (or an address) it also lists the pools DexScreener knows
 * on the app's DEXes. Picking one of those runs the safety check and adds it as a pair if it passes. `lp`: only pairs a
 * liquidity bot can use (V3 with a verified position manager).
 */
export function PairPicker({ s, value, onChange, label = 'Pair', disabled = false, lp = false }: { s: AnyObj; value: string; onChange: (key: string) => void; label?: string; disabled?: boolean; lp?: boolean }) {
  const { chain } = useChainFilter();
  const refresh = useContext(RefreshCtx);
  const fl = isFlipKey(value), m = mk(s, value);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; pools: FoundPool[]; error: string | null } | null>(null);
  const [adding, setAdding] = useState<{ pool: string; error: string | null } | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const term = q.trim(), lq = term.toLowerCase();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // DexScreener, 350 ms after the last key
  useEffect(() => {
    setActive(0);
    if (!open || term.length < 2) { setFound(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      http<{ pools: FoundPool[] }>(`/api/pools/search?q=${encodeURIComponent(term)}&chain=${chain}`)
        .then((r) => { if (alive) setFound({ q: term, pools: r.pools, error: null }); })
        .catch((e) => { if (alive) setFound({ q: term, pools: [], error: (e as Error).message }); });
    }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [open, term, chain]);

  const mine = marketsOf(s).filter((x) => x.tradable && (!lp || x.lpOk) && (chain === 'all' || x.chainId === chain)
    && (!lq || [x.label, x.base, x.quote, x.baseAddress, x.quoteAddress, x.dexName].some((v) => v?.toLowerCase().includes(lq))));
  // only the answer for what's typed now (Enter mustn't pick a pool from the last search)
  const fresh = found?.q === term ? found : null;
  const more = (fresh?.pools ?? []).filter((p) => (!lp || p.lpOk) && !(p.market && mine.some((x) => x.key === p.market)));

  const choose = (key: string) => { onChange(key); setOpen(false); setQ(''); setAdding(null); };
  // a found pool is picked the way round its row shows it
  const pick = async (p: FoundPool) => {
    if (p.market) return choose(mk(s, p.market).baseAddress === p.base.address.toLowerCase() ? p.market : flipKey(p.market));
    setAdding({ pool: p.pool, error: null });
    try {
      const r = await http<{ key: string }>('/api/markets/pool', 'POST', { chainId: p.chainId, pool: p.pool, base: p.base.address, quote: p.quote.address });
      await refresh();
      choose(r.key);
    } catch (e) { setAdding({ pool: p.pool, error: (e as Error).message }); }
  };
  const rows = [...mine.map((x) => () => choose(orientedKey(x.key, fl))), ...more.map((p) => () => void pick(p))];
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!adding) rows[active]?.(); }
  };

  return (
    <div className="pair-field" ref={box}>
      <span>{label}</span>
      <span className="pair-pick">
        <button type="button" className="pair-current" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChainBadge c={chainOf(s, m.chainId)} testnet={false} />
          <b>{m.base}/{m.quote}</b>
          {m.dexName && <DexTag name={m.dexName} feeBps={m.kind === 'v2' ? m.feeBps : null} feeTier={m.feeTier} />}
          <i className="pair-caret" aria-hidden />
        </button>
        <button type="button" className={`flip-btn ${fl ? 'on' : ''}`} disabled={disabled} aria-pressed={fl} aria-label="flip base and quote"
          title={`Flip orientation → ${mk(s, flipKey(value)).label} (spend ${mk(s, flipKey(value)).quote}, stack ${mk(s, flipKey(value)).base})`}
          onClick={() => onChange(flipKey(value))}>⇄</button>
      </span>
      {open && (
        <div className="pair-pop">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} placeholder="Search a coin, or paste a coin or pool address" aria-label={`search ${label.toLowerCase()}s`} />
          <div className="pair-list" role="listbox">
            <div className="pair-group">Your pairs{lp ? ' a liquidity bot can use' : ''}</div>
            {mine.map((x, i) => (
              <button type="button" role="option" key={x.key} aria-selected={unflipKey(value) === x.key} className={`pair-row ${active === i ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(orientedKey(x.key, fl))}>
                <span className="pair-main"><ChainBadge c={chainOf(s, x.chainId)} testnet={false} /><b>{fl ? `${x.quote}/${x.base}` : `${x.base}/${x.quote}`}</b>{x.dexName && <DexTag name={x.dexName} feeBps={x.kind === 'v2' ? x.feeBps : null} feeTier={x.feeTier} />}{x.risk && <RiskBadge risk={x.risk} />}</span>
              </button>
            ))}
            {!mine.length && <div className="pair-note">{lq ? `None of your pairs match “${term}”.` : 'No pairs yet.'}</div>}
            <div className="pair-group">
              More pools <span className="muted">· DexScreener</span>
              <Tip>Pools on the DEXes this app trades (PulseX and 9mm on PulseChain, Uniswap and PancakeSwap on Robinhood, Uniswap on Ethereum){lp ? ', only V3 pools a liquidity bot can hold a position in' : ''}. Picking one runs the safety check: a simulated buy, transfer and sell. If it passes, it's added as a pair; a honeypot, a tax over 10% or a coin that can't be checked is not added.</Tip>
            </div>
            {term.length < 2 && <div className="pair-note">Type 2 letters to search every pool.</div>}
            {term.length >= 2 && !fresh && <div className="pair-note">Searching…</div>}
            {fresh?.error && <div className="pair-note neg">{fresh.error}</div>}
            {fresh && !fresh.error && !more.length && <div className="pair-note">No {lp ? 'V3 ' : ''}pools for “{term}” on the app's DEXes.</div>}
            {more.map((p, j) => {
              const i = mine.length + j, busy = adding?.pool === p.pool;
              return (
                <button type="button" role="option" key={`${p.chainId}:${p.pool}`} aria-selected={false} className={`pair-row ${active === i ? 'active' : ''}`} disabled={!!adding && !busy} onMouseEnter={() => setActive(i)} onClick={() => { if (!adding) void pick(p); }}>
                  <span className="pair-main"><ChainBadge c={chainOf(s, p.chainId)} testnet={false} /><b>{p.base.symbol}/{p.quote.symbol}</b><DexTag name={p.dexName} feeBps={p.feeBps} feeTier={p.feeTier} /></span>
                  <span className="pair-meta">
                    {p.base.address.slice(0, 6)}…{p.base.address.slice(-4)} · {usdShort(p.liquidityUsd)} in the pool · {usdShort(p.volume24hUsd)} traded today
                    {p.base.lookalike && <span className="pair-warn"> · same name as {p.base.lookalike}, a different coin</span>}
                  </span>
                  <span className={`pair-act ${busy && !adding?.error ? 'busy' : ''}`}>{p.market ? 'added' : busy && !adding?.error ? 'checking safety…' : 'add'}</span>
                  {busy && adding?.error && <span className="pair-err">{adding.error}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
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
