/**
 * Markets tab: add a custom token on any chain (inspect → pools → safety → add), every market with its pool / fee /
 * risk, and the chain + DEX registry with verified addresses and sources.
 */
import { Fragment, useEffect, useState } from 'react';
import { http } from './api';
import { px } from './fmt';
import { ChainBadge, RiskBadge, chainOf, chains, explorerAddr, feeLabel, flipKey, marketsOf, mk, useChainFilter, type MarketInfo } from './chains';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const usd = (x: number | null | undefined) => (x == null ? '—' : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(x < 10 ? 2 : 0)}`);
const pct = (x: number | null | undefined, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Addr({ s, chainId, a }: { s: AnyObj; chainId: number; a: string | null | undefined }) {
  if (!a) return <span className="muted">—</span>;
  return <a className="mono" href={explorerAddr(s, chainId, a)} target="_blank" rel="noreferrer" title={a}>{short(a)}</a>;
}

function SafetyCard({ r, probe }: { r: AnyObj; probe?: AnyObj | null }) {
  const tax = (x: number | null) => (x == null ? '—' : x < 0.0001 ? '0%' : pct(x, 2));
  return (
    <div className={`safety-card risk-${r.risk}`}>
      <div className="safety-head">
        <RiskBadge risk={r.risk} />
        <strong>{r.liveAllowed ? 'Live trading allowed' : r.risk === 'unknown' ? 'Unverified — paper only' : 'Live trading BLOCKED — paper only'}</strong>
        <span className="muted small">{r.simulated ? 'eth_call buy → transfer → sell simulated' : 'not simulated'} · {new Date(r.at).toLocaleTimeString()}</span>
      </div>
      <div className="safety-grid">
        <div><span className="k">Buy tax</span>{tax(r.buyTaxPct)}</div>
        <div><span className="k">Transfer tax</span>{tax(r.transferTaxPct)}</div>
        <div><span className="k">Sell tax</span>{tax(r.sellTaxPct)}</div>
        <div><span className="k">Honeypot</span>{r.honeypot == null ? '—' : r.honeypot ? <b className="neg">YES</b> : 'no'}</div>
        <div><span className="k">Proxy</span>{r.proxy ? <span className="warn-t" title={r.proxy.implementation ?? ''}>{r.proxy.kind}</span> : 'no'}</div>
        <div><span className="k">Liquidity</span>{usd(r.liquidityUsd)}</div>
        <div><span className="k">Tax mode</span>{r.taxMode ?? '—'}</div>
        <div><span className="k">Max tx</span>{r.maxTxTokens != null ? r.maxTxTokens.toPrecision(6) : '—'}</div>
        <div><span className="k">Max wallet</span>{r.maxWalletTokens != null ? r.maxWalletTokens.toPrecision(6) : '—'}</div>
        <div><span className="k">Blacklist</span>{r.blacklist ? <span className="warn-t">{r.blacklist}</span> : 'no'}</div>
        <div><span className="k">Paused</span>{r.paused == null ? '—' : r.paused ? <b className="neg">YES</b> : 'no'}</div>
        <div><span className="k">Decimals</span>{r.decimals ?? '—'}</div>
      </div>
      {r.depth?.length > 0 && (
        <table className="depth"><thead><tr><th>Size</th>{r.depth.map((d: AnyObj) => <th key={d.usd}>${d.usd}</th>)}</tr></thead>
          <tbody>
            <tr><td className="muted">buy impact</td>{r.depth.map((d: AnyObj) => <td key={d.usd} className={d.buyImpactPct > 0.03 ? 'neg' : ''}>{pct(d.buyImpactPct)}</td>)}</tr>
            <tr><td className="muted">sell impact</td>{r.depth.map((d: AnyObj) => <td key={d.usd} className={d.sellImpactPct > 0.03 ? 'neg' : ''}>{pct(d.sellImpactPct)}</td>)}</tr>
          </tbody></table>
      )}
      <ul className="reasons">{r.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
      {probe && <p className="muted small mono">stage {probe.stage}{probe.err ? ` · ${probe.err}` : ''} · gas buy {probe.gasBuy?.toLocaleString()} / sell {probe.gasSell?.toLocaleString()}</p>}
    </div>
  );
}

const feeOf = (p: AnyObj) => (p.kind === 'v3' && p.feeTier != null ? `${+(p.feeTier / 10000).toFixed(2)}%` : `${+(p.feeBps / 100).toFixed(2)}%`);

/** Every pool for one market across the chain's DEXes, ranked by the quote for a ≈$250 buy; switch / auto / reset. */
function PoolPicker({ s, m, act, busy }: { s: AnyObj; m: MarketInfo & AnyObj; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const [r, setR] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { setErr(null); void http(`/api/markets/${encodeURIComponent(m.key)}/pools`).then(setR).catch((e) => setErr((e as Error).message)); };
  useEffect(load, [m.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const put = (body: AnyObj) => act(async () => { await http(`/api/markets/${encodeURIComponent(m.key)}/pool`, 'PUT', body); load(); });
  if (err) return <p className="neg small">{err}</p>;
  if (!r) return <p className="muted small">Discovering pools on every DEX…</p>;
  const best = r.best?.address?.toLowerCase();
  const bestOut = r.best?.refOut ?? null;
  return (
    <div className="pool-picker">
      <table className="pools">
        <thead><tr><th>DEX</th><th>Fee</th><th>Pool</th><th>TVL</th><th>Mid</th><th title={`${m.base} received for ≈$250 of ${m.quote}`}>Out @ ≈$250</th><th>vs best</th><th>Impact</th><th></th></tr></thead>
        <tbody>
          {r.pools.map((p: AnyObj) => {
            const cur = !!m.pool && p.address.toLowerCase() === m.pool.toLowerCase();
            const ok = p.refOut != null && p.mid != null && !p.error;
            return (
              <tr key={p.address} className={cur ? 'selected' : p.offMarket || p.error ? 'failed-row' : ''}>
                <td>{p.dexName}{p.address.toLowerCase() === best && <span className="tag pos">best</span>}</td>
                <td>{feeOf(p)}</td>
                <td><Addr s={s} chainId={m.chainId} a={p.address} /></td>
                <td>{usd(p.tvlUsd)}</td>
                <td>{p.mid && !p.error ? px(p.mid, 6) : '—'}</td>
                <td>{p.refOut != null ? px(p.refOut, 6) : '—'}</td>
                <td className={bestOut && p.refOut != null && p.refOut < bestOut ? 'neg' : ''}>{bestOut && p.refOut != null ? pct(p.refOut / bestOut - 1, 3) : '—'}</td>
                <td>{pct(p.refImpact, 3)}</td>
                <td className="nowrap small">{cur ? <b>trading</b> : ok
                  ? <button type="button" className="btn small-btn" disabled={busy} onClick={() => put({ pool: p.address })}>Use</button>
                  : <span className="neg">{(p.error ?? 'off-market').slice(0, 40)}</span>}</td>
              </tr>
            );
          })}
          {r.pools.length === 0 && <tr><td colSpan={10} className="muted">no pools found</td></tr>}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" className="btn small-btn" disabled={busy || !r.best} onClick={() => put({ auto: true })}>Auto: best quote</button>
        {!m.custom && <button type="button" className="btn small-btn" disabled={busy || m.poolMode === 'default'} onClick={() => put({ reset: true })}>Reset to default</button>}
        <button type="button" className="btn small-btn" onClick={load}>Refresh</button>
        <span className="muted small">mode: {m.poolMode} · ranked by output for a ≈$250 buy (fee + depth), then TVL · candles stay on the original pool · switching is refused while a tx is in flight</span>
      </div>
    </div>
  );
}

export function Markets({ status: s, act, busy }: { status: AnyObj; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const { chain } = useChainFilter();
  const tradable = chains(s).filter((c) => c.tradable);
  const [f, setF] = useState({ chainId: '', address: '', quote: '', pool: '' });
  const [res, setRes] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reg, setReg] = useState<AnyObj[]>([]);
  const [showReg, setShowReg] = useState(false);
  const [poolsFor, setPoolsFor] = useState<string | null>(null);
  const [flipAll, setFlipAll] = useState(false);
  const [flipRow, setFlipRow] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!f.chainId && tradable.length) setF((x) => ({ ...x, chainId: String(chain !== 'all' && tradable.some((c) => c.id === chain) ? chain : tradable[0].id) }));
  }, [chain, tradable, f.chainId]);
  useEffect(() => { if (showReg && !reg.length) void http('/api/chains').then((r) => setReg(r.chains)).catch(() => undefined); }, [showReg, reg.length]);

  const cid = Number(f.chainId);
  const c = chainOf(s, cid);
  const inspect = async (pool?: string) => {
    setLoading(true); setErr(null);
    try {
      const r = await http('/api/tokens/inspect', 'POST', { chainId: cid, address: f.address.trim(), quote: f.quote || undefined, pool: pool ?? (f.pool || undefined) });
      setRes(r);
      if (pool) setF((x) => ({ ...x, pool }));
    } catch (e) { setErr((e as Error).message); setRes(null); } finally { setLoading(false); }
  };
  const add = () => act(async () => {
    await http('/api/markets', 'POST', { chainId: cid, address: f.address.trim(), quote: res?.quote?.address, pool: res?.chosen?.address });
    setRes(null); setF((x) => ({ ...x, address: '', pool: '' }));
  });

  const list: MarketInfo[] = marketsOf(s).filter((m) => chain === 'all' || m.chainId === chain);
  const quoteOpts: AnyObj[] = res?.quoteOptions ?? (c ? [{ symbol: 'auto (deepest)', address: '' }] : []);

  return (
    <>
      <div className="card">
        <h3>Add custom token <span className="muted small">any ERC-20 on any supported chain · metadata → pool discovery → eth_call buy/sell simulation → risk</span></h3>
        <div className="form-row">
          <label>Chain<select value={f.chainId} onChange={(e) => { setF({ chainId: e.target.value, address: f.address, quote: '', pool: '' }); setRes(null); }}>
            {tradable.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></label>
          <label className="grow2">Token address<input className="mono" value={f.address} placeholder="0x…" spellCheck={false} onChange={(e) => setF((x) => ({ ...x, address: e.target.value, pool: '' }))} /></label>
          <label>Pair with<select value={f.quote} onChange={(e) => setF((x) => ({ ...x, quote: e.target.value, pool: '' }))}>
            <option value="">auto (deepest)</option>
            {quoteOpts.filter((o) => o.address).map((o) => <option key={o.address} value={o.address}>{o.symbol}</option>)}
          </select></label>
          <div className="actions"><button type="button" className="btn primary" disabled={loading || !/^0x[0-9a-fA-F]{40}$/.test(f.address.trim())} onClick={() => void inspect()}>{loading ? 'Inspecting…' : 'Inspect'}</button></div>
        </div>
        {c && <p className="muted small" style={{ marginTop: 6 }}><ChainBadge c={c} /> DEXes: {c.dexes.map((d) => `${d.name} (${d.kind.toUpperCase()})`).join(' · ')} — V3 pools are searched on every fee tier.</p>}
        {err && <p className="neg small">{err}</p>}

        {res && (
          <div className="inspect">
            <div className="stats">
              <div><span className="k">Token</span><b>{res.token.symbol}</b> <span className="muted">{res.token.name}</span> <Addr s={s} chainId={res.chainId} a={res.token.address} /></div>
              <div><span className="k">Decimals</span>{res.token.decimals}</div>
              <div><span className="k">Code</span>{res.token.codeSize.toLocaleString()} bytes{res.token.proxy ? <span className="warn-t"> · {res.token.proxy.kind}</span> : ''}</div>
              <div><span className="k">Quote</span>{res.quote.symbol} <span className="muted small">({res.quote.kind})</span></div>
              {res.existing && <div><span className="k">Existing</span>{res.existing}</div>}
              {res.token.warnings?.length > 0 && <div className="neg small">{res.token.warnings.join(' · ')}</div>}
            </div>
            <table className="pools">
              <thead><tr><th></th><th>DEX</th><th>Fee</th><th>Pool</th><th>TVL</th><th>Mid ({res.quote.symbol}/{res.token.symbol})</th><th>Impact @ ref</th><th></th></tr></thead>
              <tbody>
                {res.pools.map((p: AnyObj) => {
                  const on = res.chosen?.address?.toLowerCase() === p.address.toLowerCase();
                  return (
                    <tr key={p.address} className={on ? 'selected' : p.offMarket || p.error ? 'failed-row' : ''}>
                      <td><input type="radio" name="pool" checked={on} disabled={loading || !!p.error || p.refOut == null} onChange={() => void inspect(p.address)} aria-label={`use pool ${p.address}`} /></td>
                      <td>{p.dexName}</td>
                      <td>{p.kind === 'v3' ? `${+(p.feeTier / 10000).toFixed(2)}%` : `${+(p.feeBps / 100).toFixed(2)}%`}</td>
                      <td><Addr s={s} chainId={res.chainId} a={p.address} /></td>
                      <td>{usd(p.tvlUsd)}</td>
                      <td>{p.mid && !p.error ? px(p.mid, 6) : '—'}</td>
                      <td>{pct(p.refImpact, 3)}</td>
                      <td className="small">{p.error ? <span className="neg">{p.error.slice(0, 50)}</span> : p.offMarket ? <span className="neg">off-market</span> : on ? <b>selected</b> : ''}</td>
                    </tr>
                  );
                })}
                {res.pools.length === 0 && <tr><td colSpan={8} className="muted">no pool found for {res.token.symbol}/{res.quote.symbol}</td></tr>}
              </tbody>
            </table>
            <p className="muted small">Default = deepest pool by output for the reference size (≈$25), then TVL. Pick another pool to override; safety is re-run on it.</p>
            {res.safety && <SafetyCard r={res.safety} probe={res.probe} />}
            {res.draft && (() => {
              const ex = res.existing ? marketsOf(s).find((x) => x.key === res.existing) : null;
              const dup = !!ex && !!ex.pool && ex.pool.toLowerCase() === res.chosen?.address?.toLowerCase();
              return (
              <div className="actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn primary" disabled={busy || loading || dup} onClick={add}>
                  {dup ? `Already added as ${res.existing}` : `Add ${res.draft.key}${res.safety?.liveAllowed ? '' : ' (paper only)'}`}
                </button>
                <span className="muted small">{dup ? 'Pick another pool to add a second market on it, or use Re-check below.' : 'Saved to data/custom.json · usable in grids, trend bots, backtests, charts, market panels and alerts.'}</span>
              </div>
              );
            })()}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Markets <span className="muted small">{list.length} · sell-side price = quote per base after the LP fee · every pair trades either way round (⇄)</span>{' '}
          <button type="button" className={`flip-btn ${flipAll ? 'on' : ''}`} aria-pressed={flipAll} title="Show every market flipped (token/PLS: spend PLS, stack the token)" onClick={() => { setFlipAll((v) => !v); setFlipRow({}); }}>⇄ {flipAll ? 'flipped' : 'as configured'}</button></h3>
        <div className={`table-wrap ${poolsFor ? 'open-picker' : 'tall'}`}><table className="markets-table">
          <thead><tr><th>Chain</th><th>Market</th><th>DEX</th><th>Fee</th><th>Pool</th><th>Spot</th><th>≈$/quote</th><th>Risk</th><th title="Buy / sell tax measured by the eth_call safety probe; re-checked while bots run">Tax b/s</th><th></th></tr></thead>
          <tbody>
            {list.map((m: MarketInfo & AnyObj) => {
              const ch = chainOf(s, m.chainId);
              const open = poolsFor === m.key;
              const fl = flipRow[m.key] ?? flipAll;
              const v: MarketInfo = fl ? mk(s, flipKey(m.key)) : m; // displayed orientation (same pool)
              return (
                <Fragment key={m.key}>
                <tr className={open ? 'selected' : ''}>
                  <td><ChainBadge c={ch} /></td>
                  <td>
                    <button type="button" className={`flip-btn ${fl ? 'on' : ''}`} style={{ marginRight: 6, padding: '0 0.4rem' }} aria-pressed={fl} title={`Flip → ${mk(s, flipKey(v.key)).label}`} onClick={() => setFlipRow((r) => ({ ...r, [m.key]: !fl }))}>⇄</button>
                    <b>{v.base}/{v.quote}</b> {m.custom ? <span className="tag">custom</span> : m.legacy ? <span className="tag">PulseChain</span> : null}
                    <div className="muted small"><span className="mono">{v.key}</span> · spends {v.quote} · stacks {v.base}</div></td>
                  <td className="small">{m.dexName ?? ch?.dexes.find((d) => d.id === m.dex)?.name ?? m.dex}{m.poolMode && m.poolMode !== 'default' && !m.custom ? <span className="tag">{m.poolMode}</span> : null}</td>
                  <td>{feeLabel(m)}</td>
                  <td><Addr s={s} chainId={m.chainId} a={m.pool} /></td>
                  <td title={`${v.quote} per ${v.base}`}>{v.spot != null ? px(v.spot, 6) : '—'}</td>
                  <td className="small">{v.usdPerQuote != null ? px(v.usdPerQuote, 4) : '—'}</td>
                  <td>{m.custom ? <RiskBadge risk={m.risk ?? 'unknown'} title={m.liveAllowed ? 'live allowed' : 'paper only'} /> : <span className="muted small">built-in</span>}</td>
                  <td className="small">{m.buyTaxPct != null || m.sellTaxPct != null ? `${((m.buyTaxPct ?? 0) * 100).toFixed(1)}% / ${((m.sellTaxPct ?? 0) * 100).toFixed(1)}%` : <span className="muted">—</span>}</td>
                  <td className="nowrap">
                    {ch?.tradable && <><button type="button" className="btn small-btn" onClick={() => setPoolsFor(open ? null : m.key)}>{open ? 'Hide' : 'Pools'}</button>{' '}</>}
                    {m.custom && <>
                      <button type="button" className="btn small-btn" disabled={busy} onClick={() => act(() => http(`/api/markets/${encodeURIComponent(m.key)}/recheck`, 'POST'))}>Re-check</button>{' '}
                      <button type="button" className="btn small-btn danger" disabled={busy} onClick={() => act(() => http(`/api/markets/${encodeURIComponent(m.key)}`, 'DELETE'))}>Remove</button>
                    </>}
                  </td>
                </tr>
                {open && <tr className="subrow"><td colSpan={10}><PoolPicker s={s} m={m} act={act} busy={busy} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table></div>
      </div>

      <div className="card">
        <h3>Chains &amp; DEXes <button type="button" className="btn small-btn" onClick={() => setShowReg((v) => !v)}>{showReg ? 'hide' : 'show'} addresses &amp; sources</button></h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Chain</th><th>ID</th><th>Status</th><th>DEXes</th><th>Gas wallet</th><th>RPC</th></tr></thead>
          <tbody>
            {chains(s).map((x) => (
              <tr key={x.id}>
                <td><ChainBadge c={x} /> {x.name}</td>
                <td className="mono">{x.id}</td>
                <td className="small">{x.tradable ? <span className="pos">tradable</span> : <span className="neg" title={x.reason ?? ''}>unavailable — {x.reason?.slice(0, 60)}…</span>}</td>
                <td className="small">{x.dexes.map((d) => d.name).join(', ') || '—'}</td>
                <td className="small">{x.hasSigner ? <>{x.gasNative != null ? x.gasNative.toPrecision(4) : '—'} {x.nativeSymbol}{x.lowGas ? <b className="neg"> LOW</b> : ''}</> : <span className="muted">no key (paper)</span>}</td>
                <td className="small mono">{x.rpc?.replace(/^https?:\/\//, '').slice(0, 34)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {showReg && reg.map((x) => (
          <div key={x.id} className="reg-chain">
            <h4><ChainBadge c={x as never} /> {x.name} <span className="muted small">chain {x.id} · {x.stack} · native {x.nativeSymbol} · wrapped <Addr s={s} chainId={x.id} a={x.wrappedNative.address} /></span></h4>
            {x.note && <p className="muted small">{x.note}</p>}
            <table className="small"><thead><tr><th>DEX</th><th>Kind</th><th>Factory</th><th>Router</th><th>Quoter</th><th>Fee</th></tr></thead>
              <tbody>{x.dexes.map((d: AnyObj) => (
                <tr key={d.id}><td>{d.name}{d.note ? <span className="muted"> · {d.note}</span> : null}</td><td>{d.kind}</td><td><Addr s={s} chainId={x.id} a={d.factory} /></td><td><Addr s={s} chainId={x.id} a={d.router} /></td><td><Addr s={s} chainId={x.id} a={d.quoter} /></td><td>{d.kind === 'v3' ? d.tiers.join(' / ') : `${d.feeBps / 100}%`}</td></tr>
              ))}{x.dexes.length === 0 && <tr><td colSpan={6} className="muted">none — {x.reason}</td></tr>}</tbody></table>
            <p className="small">Sources: {x.sources.map((src: AnyObj, i: number) => <span key={i}>{i ? ' · ' : ''}<a href={src.url} target="_blank" rel="noreferrer">{src.label}</a></span>)}</p>
          </div>
        ))}
      </div>
    </>
  );
}
