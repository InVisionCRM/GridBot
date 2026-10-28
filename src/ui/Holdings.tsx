/**
 * Holdings: each chain as a short list of coin amounts. Read-only. Crypto units only (Kyle, #73): every amount in its own
 * coin ("34,000 USDG"), never a dollar figure, and no total across coins or chains.
 */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago } from './fmt';
import { useChainFilter, type ChainInfo } from './chains';
import { TokenMark, ChainMark } from './icons';
import {
  HOW_HOLDINGS, type FeeRow, type HoldingsSnapshot, type PositionRow,
} from '../live/holdingsMath';
import { botView, errMsg, type AnyObj, type Nav } from './model';

const DUST_KEY = 'holdingsDust';

export function useHoldings() {
  const [data, setData] = useState<HoldingsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback((refresh = false) => {
    if (refresh) setLoading(true);
    return http<HoldingsSnapshot>(`/api/holdings${refresh ? '?refresh=1' : ''}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), 60_000);
    return () => clearInterval(t);
  }, [load]);
  return { data, err, loading, reload: () => load(true) };
}

function sliceOf(snap: HoldingsSnapshot, chainId: number | 'all', showDust: boolean) {
  const on = (id: number) => chainId === 'all' || chainId === id;
  const keep = (dust: boolean) => showDust || !dust;
  const wallet = snap.wallet.filter((r) => on(r.coin.chainId) && keep(r.dust));
  const positions = snap.positions.filter((r) => on(r.chainId) && keep(r.dust));
  const fees = snap.fees.filter((r) => on(r.chainId) && keep(r.dust));
  const bots = snap.bots.filter((r) => on(r.chainId) && keep(r.dust));
  const hidden = snap.wallet.filter((r) => on(r.coin.chainId) && r.dust).length
    + snap.positions.filter((r) => on(r.chainId) && r.dust).length
    + snap.fees.filter((r) => on(r.chainId) && r.dust).length
    + snap.bots.filter((r) => on(r.chainId) && r.dust).length;
  // dollar values only order the chains and fold away tiny positions; none is shown
  const sortUsd = [...wallet.map((r) => r.coin.usd), ...positions.map((r) => r.usd), ...fees.map((r) => r.usd)].reduce<number>((a, u) => a + (u ?? 0), 0);
  return { wallet, positions, fees, bots, hidden, sortUsd };
}

/** A coin amount in full, grouped: "34,000 USDG", "21.3 SPY", "0.00016568 NVDA". */
export const coinAmount = (n: number, symbol: string) =>
  `${!Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}${Number(Math.abs(n).toPrecision(6)).toLocaleString(undefined, { maximumFractionDigits: 12 })}`} ${symbol}`;
const RANGE: Record<string, string> = { in: 'In range', below: 'Below range', above: 'Above range' };

function amounts(row: PositionRow | FeeRow) {
  const bits = [row.token0, row.token1].filter((c) => c.amount > 0).map((c) => coinAmount(c.amount, c.symbol));
  return bits.join(' · ') || '—';
}

export function Holdings({ s, snap, loading, error, reload, nav }: {
  s: AnyObj;
  snap: HoldingsSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  focus?: string;
  nav: Nav;
}) {
  const { chain } = useChainFilter();
  const [showDust, setShowDust] = useState(() => { try { return localStorage.getItem(DUST_KEY) === '0'; } catch { return false; } });
  const toggleDust = () => setShowDust((v) => {
    const next = !v;
    try { localStorage.setItem(DUST_KEY, next ? '0' : '1'); } catch { /* storage unavailable */ }
    return next;
  });
  const view = snap ? sliceOf(snap, chain, showDust) : null;
  const names = (id: number) => (s.chains as ChainInfo[] | undefined)?.find((c) => c.id === id) ?? null;
  const chainIds = view
    ? [...new Set([...view.wallet.map((r) => r.coin.chainId), ...view.positions.map((r) => r.chainId), ...view.fees.map((r) => r.chainId), ...view.bots.map((r) => r.chainId)])]
    : [];
  chainIds.sort((a, b) => {
    const usdOf = (id: number) => sliceOf(snap!, id, showDust).sortUsd;
    return usdOf(b) - usdOf(a);
  });

  return (
    <main className="home">
      <section className="home-fig" aria-label="Holdings">
        <div>
          <p className="home-num">{view || !loading ? 'Your coins' : '…'}</p>
          <p className="home-day muted">
            {snap?.hasSigner === false && 'Paper mode. No wallet to read.'}
            {snap?.hasSigner && snap.address && <>{snap.address.slice(0, 6)}…{snap.address.slice(-4)}</>}
            {snap?.at ? ` · ${ago(snap.at)}` : ''}
          </p>
        </div>
      </section>
      <p className="foot-links">
        <button type="button" onClick={toggleDust}>{showDust ? 'Hide dust' : view?.hidden ? `Show ${view.hidden} dust` : 'Dust hidden'}</button>
        <button type="button" disabled={loading} onClick={reload}>{loading ? 'Reading…' : 'Read again'}</button>
      </p>
      {error && <p className="note bad">{error}</p>}
      {snap?.overdrawn && <p className="note">Bot books add up to more than the wallet holds. The amounts here are the wallet's, not the books'.</p>}
      {snap?.errors.map((e, i) => <p key={i} className="note">{e.message}</p>)}

      {view && chainIds.map((id) => {
        const part = sliceOf(snap!, id, showDust);
        const info = names(id);
        const name = info?.name ?? snap?.chains.find((c) => c.chainId === id)?.name ?? 'Chain';
        return (
          <section key={id} className="chain-group">
            <h2 className="chain-head">
              {info && <ChainMark short={info.short} color={info.color} size={22} />}
              <span>{name}</span>
            </h2>
            {part.wallet.map((row) => (
              <div key={`${id}-${row.coin.address ?? 'native'}`} className="line static">
                <TokenMark symbol={row.coin.symbol} address={row.coin.address} size={22} />
                <span className="line-name">{row.coin.symbol}{row.bots.length ? <span>in a bot</span> : null}</span>
                <b>{coinAmount(row.coin.amount, row.coin.symbol)}</b>
              </div>
            ))}
            {part.positions.filter((r) => (r.usd ?? 0) > 1).map((row) => (
              <div key={`${row.pool}-${row.tokenId ?? ''}`} className="fold-row open-pos">
                <span>
                  {row.token0.symbol}/{row.token1.symbol}
                  <small>{row.dexName} {row.feeLabel}{row.range ? ` · ${RANGE[row.range]}` : ''}{row.stranded ? ' · still in the position' : ''}</small>
                </span>
                <b>{amounts(row)}</b>
                {row.bot && <button type="button" className="text-link" onClick={() => nav(botView(row.bot!.kind, row.bot!.id))}>{row.bot.name}</button>}
              </div>
            ))}
            {!!part.positions.filter((r) => (r.usd ?? 0) <= 1).length && (
              <details className="fold">
                <summary>Smaller positions <span>{part.positions.filter((r) => (r.usd ?? 0) <= 1).length}</span></summary>
                {part.positions.filter((r) => (r.usd ?? 0) <= 1).map((row) => (
                  <div key={`${row.pool}-${row.tokenId ?? ''}`} className="fold-row">
                    <span>
                      {row.token0.symbol}/{row.token1.symbol}
                      <small>{row.dexName} {row.feeLabel}{row.range ? ` · ${RANGE[row.range]}` : ''}</small>
                    </span>
                    <b>{amounts(row)}</b>
                  </div>
                ))}
              </details>
            )}
            {!!part.fees.length && (
              <details className="fold">
                <summary>Uncollected <span>{part.fees.length}</span></summary>
                {part.fees.map((row) => (
                  <div key={`${row.pool}-${row.tokenId ?? ''}-fee`} className="fold-row">
                    <span>
                      {row.token0.symbol}/{row.token1.symbol}
                      <small>{row.leftover ? 'Left behind when the position closed' : 'Not collected yet'}</small>
                    </span>
                    <b>{amounts(row)}</b>
                  </div>
                ))}
              </details>
            )}
            {!!part.bots.length && (
              <details className="fold">
                <summary>In grids <span>{part.bots.length}</span></summary>
                {part.bots.map((bag) => (
                  <button key={bag.bot.id} type="button" className="fold-row as-btn" onClick={() => nav(botView(bag.bot.kind, bag.bot.id))}>
                    <span>{bag.bot.name}</span>
                    <b>{bag.coins.map((c) => coinAmount(c.amount, c.symbol)).join(' · ') || '—'}</b>
                  </button>
                ))}
              </details>
            )}
          </section>
        );
      })}
      {view && !chainIds.length && snap?.hasSigner && <p className="muted home-empty">Nothing above dust.</p>}
      <details className="fold how">
        <summary>How this is counted</summary>
        {(snap?.how ?? HOW_HOLDINGS).map((line) => <p key={line}>{line}</p>)}
      </details>
    </main>
  );
}
