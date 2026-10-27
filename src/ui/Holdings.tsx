/** Holdings: one total, then each chain as a short list. Read-only. */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago } from './fmt';
import { useChainFilter, type ChainInfo } from './chains';
import { TokenMark, ChainMark } from './icons';
import {
  formatTokenAmount, formatUsdAmount, HOW_HOLDINGS, type FeeRow, type HoldingsSnapshot, type PositionRow,
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
  let walletUsd = 0, walletPriced = false, claim = 0;
  for (const row of wallet) {
    if (row.coin.usd != null) { walletUsd += row.coin.usd; walletPriced = true; }
    if (row.coin.usdEach == null) continue;
    let room = row.coin.amount;
    for (const b of row.bots) {
      if (b.bot.kind === 'lp' || b.bot.mode !== 'live') continue;
      const take = Math.min(Math.max(0, b.amount), Math.max(0, room));
      room -= take;
      claim += take * row.coin.usdEach;
    }
  }
  const sum = (rows: { usd: number | null }[]) => rows.reduce((s, r) => (r.usd != null ? s + r.usd : s), 0);
  const priced = walletPriced || positions.some((r) => r.usd != null) || fees.some((r) => r.usd != null);
  const hidden = snap.wallet.filter((r) => on(r.coin.chainId) && r.dust).length
    + snap.positions.filter((r) => on(r.chainId) && r.dust).length
    + snap.fees.filter((r) => on(r.chainId) && r.dust).length
    + snap.bots.filter((r) => on(r.chainId) && r.dust).length;
  const net = priced ? walletUsd + sum(positions) + sum(fees) : null;
  return { wallet, positions, fees, bots, hidden, net, botsUsd: priced ? Math.min(claim, walletUsd) : null };
}

const money = (n: number | null | undefined) => (n == null ? '—' : formatUsdAmount(n));
const RANGE: Record<string, string> = { in: 'In range', below: 'Below range', above: 'Above range' };

function amounts(row: PositionRow | FeeRow) {
  const bits = [row.token0, row.token1].filter((c) => c.amount > 0).map((c) => `${formatTokenAmount(c.amount)} ${c.symbol}`);
  return bits.join(' · ');
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
    const usdOf = (id: number) => sliceOf(snap!, id, showDust).net ?? 0;
    return usdOf(b) - usdOf(a);
  });

  return (
    <main className="home">
      <section className="home-fig" aria-label="Net worth">
        <div>
          <p className="home-num">{view ? money(view.net) : loading ? '…' : '—'}</p>
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
      {snap?.overdrawn && <p className="note">Bot books add up to more than the wallet. The total uses the wallet, not the books.</p>}
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
              <b>{money(part.net)}</b>
            </h2>
            {part.wallet.map((row) => (
              <div key={`${id}-${row.coin.address ?? 'native'}`} className="line static">
                <TokenMark symbol={row.coin.symbol} address={row.coin.address} size={22} />
                <span className="line-name">{row.coin.symbol}<span>{formatTokenAmount(row.coin.amount)}{row.bots.length ? ' · in a bot' : ''}</span></span>
                <b>{money(row.coin.usd)}</b>
              </div>
            ))}
            {part.positions.filter((r) => (r.usd ?? 0) > 1).map((row) => (
              <div key={`${row.pool}-${row.tokenId ?? ''}`} className="fold-row open-pos">
                <span>
                  {row.token0.symbol}/{row.token1.symbol}
                  <small>{row.dexName} {row.feeLabel}{row.range ? ` · ${RANGE[row.range]}` : ''}{row.stranded ? ' · still in the position' : ''}</small>
                  <small>{amounts(row)}</small>
                </span>
                <b>{money(row.usd)}</b>
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
                      <small>{amounts(row)}</small>
                    </span>
                    <b>{money(row.usd)}</b>
                  </div>
                ))}
              </details>
            )}
            {!!part.fees.length && (
              <details className="fold">
                <summary>Uncollected <span>{part.fees.length}</span> <b>{money(part.fees.reduce((s, r) => s + (r.usd ?? 0), 0))}</b></summary>
                {part.fees.map((row) => (
                  <div key={`${row.pool}-${row.tokenId ?? ''}-fee`} className="fold-row">
                    <span>
                      {row.token0.symbol}/{row.token1.symbol}
                      <small>{row.leftover ? 'Left behind when the position closed' : 'Not collected yet'} · {amounts(row)}</small>
                    </span>
                    <b>{money(row.usd)}</b>
                  </div>
                ))}
              </details>
            )}
            {!!part.bots.length && (
              <details className="fold">
                <summary>In grids <b>{money(part.botsUsd)}</b></summary>
                {part.bots.map((bag) => (
                  <button key={bag.bot.id} type="button" className="fold-row as-btn" onClick={() => nav(botView(bag.bot.kind, bag.bot.id))}>
                    <span>{bag.bot.name}<small>{bag.coins.map((c) => `${formatTokenAmount(c.amount)} ${c.symbol}`).join(' · ')}</small></span>
                    <b>{money(bag.usd)}</b>
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
