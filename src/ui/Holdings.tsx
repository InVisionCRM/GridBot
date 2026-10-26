/** Holdings: net worth, then where the coins actually sit. Read-only. */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago } from './fmt';
import { useChainFilter, type ChainInfo } from './chains';
import { ChainMark, TokenMark } from './icons';
import {
  formatTokenAmount, formatUsdAmount, HOW_HOLDINGS, type BotRef, type CoinView, type FeeRow, type HoldingsSnapshot, type PositionRow,
} from '../live/holdingsMath';
import { botView, errMsg, type AnyObj, type HoldingsFocus, type Nav } from './model';

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

interface Slice {
  wallet: HoldingsSnapshot['wallet'];
  positions: PositionRow[];
  fees: FeeRow[];
  bots: HoldingsSnapshot['bots'];
  freeUsd: number | null;
  botsUsd: number | null;
  lpUsd: number | null;
  feesUsd: number | null;
  net: number | null;
  hidden: number;
}

function sliceOf(snap: HoldingsSnapshot, chainId: number | 'all', showDust: boolean): Slice {
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
  const sum = (rows: { usd: number | null }[]) => {
    let usd = 0, priced = false;
    for (const r of rows) if (r.usd != null) { usd += r.usd; priced = true; }
    return { usd, priced };
  };
  const lp = sum(positions), fee = sum(fees);
  const priced = walletPriced || lp.priced || fee.priced;
  const hidden = snap.wallet.filter((r) => on(r.coin.chainId) && r.dust).length
    + snap.positions.filter((r) => on(r.chainId) && r.dust).length
    + snap.fees.filter((r) => on(r.chainId) && r.dust).length
    + snap.bots.filter((r) => on(r.chainId) && r.dust).length;
  if (!priced) return { wallet, positions, fees, bots, freeUsd: null, botsUsd: null, lpUsd: null, feesUsd: null, net: null, hidden };
  const botsUsd = Math.min(claim, walletUsd);
  return {
    wallet, positions, fees, bots, hidden,
    freeUsd: walletUsd - botsUsd, botsUsd, lpUsd: lp.usd, feesUsd: fee.usd,
    net: walletUsd + lp.usd + fee.usd,
  };
}

const RANGE: Record<string, string> = { in: 'In range', below: 'Below range', above: 'Above range' };

function money(n: number | null) {
  return n == null ? '—' : formatUsdAmount(n);
}

function PairMarks({ a, b }: { a: CoinView; b: CoinView }) {
  return (
    <span className="pair-marks">
      <TokenMark symbol={a.symbol} address={a.address} size={32} />
      <TokenMark symbol={b.symbol} address={b.address} size={32} />
    </span>
  );
}

function CoinBits({ c }: { c: CoinView }) {
  if (!(c.amount > 0)) return null;
  return <span className="hld-coin"><TokenMark symbol={c.symbol} address={c.address} size={18} />{formatTokenAmount(c.amount)} {c.symbol}</span>;
}

function BotChip({ bot, nav }: { bot: BotRef; nav: Nav }) {
  return <button type="button" className="hld-bot" onClick={() => nav(botView(bot.kind, bot.id))}>{bot.name}</button>;
}

function PositionCard({ row, chain, nav }: { row: PositionRow; chain: { short: string; color: string } | null; nav: Nav }) {
  return (
    <article className="hld-pos">
      <PairMarks a={row.token0} b={row.token1} />
      <div className="hld-pos-main">
        <div className="hld-pos-name">
          {chain && <ChainMark short={chain.short} color={chain.color} size={18} />}
          <b>{row.token0.symbol}/{row.token1.symbol}</b>
          <span className="tag">{row.dexName}</span>
          <span className="tag">{row.kind === 'v3' ? 'V3' : 'V2'} {row.feeLabel}</span>
          {row.range && <span className={`tag ${row.range === 'in' ? 'pos' : ''}`}>{RANGE[row.range]}</span>}
          {row.stranded && <span className="warn-t">{row.bot ? 'Closed bot, still funded' : 'No bot watching'}</span>}
        </div>
        <div className="hld-coins">
          <CoinBits c={row.token0} />
          <CoinBits c={row.token1} />
        </div>
        <p className="small muted">
          {row.kind === 'v2' ? 'Your share of the pair reserves.' : 'Liquidity in the position NFT, at the pool’s current price.'}
          {row.tokenId ? ` NFT ${row.tokenId}.` : ''}
          {row.bot ? <> Owned by <BotChip bot={row.bot} nav={nav} />.</> : ' Not tied to a bot.'}
          {row.partial ? ' One coin has no dollar price, so the total is short.' : ''}
        </p>
        {row.stranded && <p className="small warn-t">These coins are inside the position, so the wallet balance does not show them. A closed position that still has liquidity or uncollected tokens stays here until it is collected.</p>}
        {row.idleNote && <p className="small muted">{row.idleNote}</p>}
      </div>
      <div className="hld-val">{money(row.usd)}</div>
    </article>
  );
}

function FeeCard({ row, chain, nav }: { row: FeeRow; chain: { short: string; color: string } | null; nav: Nav }) {
  return (
    <article className="hld-pos hld-fee">
      <PairMarks a={row.token0} b={row.token1} />
      <div className="hld-pos-main">
        <div className="hld-pos-name">
          {chain && <ChainMark short={chain.short} color={chain.color} size={18} />}
          <b>{row.token0.symbol}/{row.token1.symbol}</b>
          <span className="tag">{row.dexName}</span>
          {row.leftover && <span className="warn-t">Left behind</span>}
          {row.stranded && !row.leftover && <span className="warn-t">Uncollected</span>}
        </div>
        <div className="hld-coins"><CoinBits c={row.token0} /><CoinBits c={row.token1} /></div>
        <p className="small muted">
          {row.leftover
            ? 'The position has no liquidity left. These tokens are still owed — principal that was not swept, or fees. Collecting them is a transaction this page does not send.'
            : 'What the position would pay if you collected. Read with a simulated call, so nothing is sent.'}
          {row.bot ? <> <BotChip bot={row.bot} nav={nav} /></> : ''}
        </p>
      </div>
      <div className="hld-val">{money(row.usd)}</div>
    </article>
  );
}

export function Holdings({ s, snap, loading, error, reload, focus, nav }: {
  s: AnyObj;
  snap: HoldingsSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  focus?: HoldingsFocus;
  nav: Nav;
}) {
  const { chain, setChain } = useChainFilter();
  const [showDust, setShowDust] = useState(() => { try { return localStorage.getItem(DUST_KEY) === '0'; } catch { return false; } });
  const toggleDust = () => setShowDust((v) => {
    const next = !v;
    try { localStorage.setItem(DUST_KEY, next ? '0' : '1'); } catch { /* storage unavailable */ }
    return next;
  });
  useEffect(() => {
    if (!focus) return;
    const t = window.setTimeout(() => document.getElementById(`hold-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
    return () => window.clearTimeout(t);
  }, [focus]);

  const chainName = (id: number): { short: string; color: string; name: string; address: string | null } | null => {
    const c = (s.chains as ChainInfo[] | undefined)?.find((x) => x.id === id);
    if (c) return { short: c.short, color: c.color, name: c.name, address: c.address };
    const r = snap?.chains.find((x) => x.chainId === id);
    return r ? { short: r.short, color: r.color, name: r.name, address: r.address } : null;
  };
  const view = snap ? sliceOf(snap, chain, showDust) : null;
  const bars = snap ? snap.chains.map((c) => ({ ...c, shown: sliceOf(snap, c.chainId, showDust).net ?? 0 })) : [];
  const barSum = bars.reduce((n, c) => n + c.shown, 0);

  return (
    <main className="hld">
      <header className="hld-hero">
        <div>
          <p className="k">Net worth</p>
          <p className="hld-net">{view ? money(view.net) : loading ? 'Reading…' : '—'}</p>
          <p className="small muted">
            {snap?.hasSigner === false && 'Paper mode. There is no signing key, so there is no wallet on a chain to read.'}
            {snap?.hasSigner && snap.address && <>Wallet {snap.address.slice(0, 6)}…{snap.address.slice(-4)}</>}
            {snap?.at ? ` · read ${ago(snap.at)}` : ''}
            {chain !== 'all' && snap ? ` · ${chainName(chain)?.name ?? 'this chain'} only` : ''}
            {snap?.unpriced ? ` · ${snap.unpriced} coin${snap.unpriced === 1 ? '' : 's'} with no dollar price` : ''}
          </p>
        </div>
        <div className="hld-hero-act">
          <button type="button" className={`pill usd-switch${showDust ? ' on' : ''}`} aria-pressed={showDust} onClick={toggleDust}>
            {showDust ? 'Showing dust' : view && view.hidden ? `${view.hidden} dust hidden` : 'Dust hidden'}
          </button>
          <button type="button" className="btn small-btn" disabled={loading} onClick={reload}>{loading ? 'Reading…' : 'Read again'}</button>
        </div>
      </header>

      {error && <div className="banner error" role="alert"><span className="grow">{error}</span></div>}
      {snap?.overdrawn && <div className="banner">Bot books add up to more than the wallet holds. The bot tile stops at the wallet so net worth is not counted twice. The bot list below still shows the full book.</div>}
      {snap?.errors.map((e, i) => <div key={i} className="banner" role="status"><span className="grow">{e.message}</span></div>)}

      {view && (
        <div className="hld-tiles">
          <button type="button" onClick={() => document.getElementById('hold-wallet')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <span>Wallet</span><b>{money(view.freeUsd)}</b><small>At the address, not booked by a grid</small>
          </button>
          <button type="button" onClick={() => document.getElementById('hold-bots')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <span>Bot grids</span><b>{money(view.botsUsd)}</b><small>Already inside the wallet figure</small>
          </button>
          <button type="button" onClick={() => document.getElementById('hold-lp')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <span>Liquidity</span><b>{money(view.lpUsd)}</b><small>Inside position NFTs and LP tokens</small>
          </button>
          <button type="button" onClick={() => document.getElementById('hold-fees')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <span>Uncollected fees</span><b>{money(view.feesUsd)}</b><small>Owed by a position, not in the wallet</small>
          </button>
        </div>
      )}

      {!!bars.length && (
        <section className="hld-sec" id="hold-chains">
          <h2>By chain</h2>
          <div className="hld-meter" aria-hidden="true">
            {bars.map((c) => <i key={c.chainId} style={{ flexGrow: Math.max(c.shown, barSum > 0 ? 0 : 1), background: c.color }} />)}
          </div>
          <div className="hld-chains">
            {bars.map((c) => (
              <button key={c.chainId} type="button" className={chain === c.chainId ? 'on' : ''} onClick={() => setChain(chain === c.chainId ? 'all' : c.chainId)}>
                <ChainMark short={c.short} color={c.color} size={28} />
                <span><b>{c.name}</b><small>{c.address ? `${c.address.slice(0, 6)}…${c.address.slice(-4)}` : 'No address'}</small></span>
                <em>{formatUsdAmount(c.shown)}</em>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="hld-sec" id="hold-lp">
        <h2>Liquidity positions</h2>
        <p className="small muted">Each V3 position NFT this wallet holds, plus V2 LP tokens for pools the bots use or this app already knows (PulseX, 9mm, Uniswap). A closed bot is listed when the NFT still has liquidity.</p>
        {view?.positions.map((row) => <PositionCard key={`${row.chainId}-${row.kind}-${row.pool}-${row.tokenId ?? ''}`} row={row} chain={chainName(row.chainId)} nav={nav} />)}
        {view && !view.positions.length && <p className="small muted">No liquidity with a balance{showDust ? '' : ' above dust'}. A position that was fully collected, including the Robinhood ETH/USDG close once its tokens were taken out, leaves nothing here.</p>}
      </section>

      <section className="hld-sec" id="hold-fees">
        <h2>Uncollected fees</h2>
        <p className="small muted">Quoted by asking the position manager what collect would pay, without sending it. When liquidity is already zero, the quote is whatever tokens are still sitting there.</p>
        {view?.fees.map((row) => <FeeCard key={`${row.chainId}-${row.pool}-${row.tokenId ?? ''}-fee`} row={row} chain={chainName(row.chainId)} nav={nav} />)}
        {view && !view.fees.length && <p className="small muted">Nothing uncollected{showDust ? '' : ' above dust'}.</p>}
      </section>

      <section className="hld-sec" id="hold-wallet">
        <h2>Wallet</h2>
        <p className="small muted">Native coin and token balances at the address. Coins a live grid or trend is using are in this list too — they are not held somewhere else. Liquidity-bot coins that are in a pool are not in this list.</p>
        {view?.wallet.map((row) => (
          <article key={`${row.coin.chainId}-${row.coin.address ?? 'native'}`} className="hld-wallet">
            <TokenMark symbol={row.coin.symbol} address={row.coin.address} size={32} />
            <div>
              <div className="hld-pos-name">
                {(() => { const c = chainName(row.coin.chainId); return c ? <ChainMark short={c.short} color={c.color} size={18} /> : null; })()}
                <b>{row.coin.symbol}</b>
                {row.dust && <span className="tag">Dust</span>}
              </div>
              <p className="small muted">
                {formatTokenAmount(row.coin.amount)}
                {row.bots.length > 0 && <> · {row.bots.map((b) => <BotChip key={b.bot.id} bot={b.bot} nav={nav} />)}</>}
              </p>
            </div>
            <div className="hld-val">{money(row.coin.usd)}</div>
          </article>
        ))}
        {view && !view.wallet.length && <p className="small muted">No wallet balances{showDust ? '' : ' above dust'}.</p>}
      </section>

      <section className="hld-sec" id="hold-bots">
        <h2>Bot grids</h2>
        <p className="small muted">Live grid and trend inventory. It is a slice of the wallet above, not extra coins. Liquidity bots keep their position in the pool, so they show under Liquidity.</p>
        {view?.bots.map((bag) => (
          <article key={bag.bot.id} className="hld-wallet">
            <span className="mega-ico"><TokenMark symbol={bag.coins[0]?.symbol ?? '?'} address={bag.coins[0]?.address} size={32} /></span>
            <div>
              <div className="hld-pos-name"><b>{bag.bot.name}</b><span className="tag">{bag.bot.kind}</span><span className="tag">{bag.bot.status}</span></div>
              <div className="hld-coins">{bag.coins.map((c) => <CoinBits key={c.symbol} c={c} />)}</div>
            </div>
            <div className="hld-val">{money(bag.usd)}</div>
          </article>
        ))}
        {view && !view.bots.length && <p className="small muted">No live grid or trend is booking coins here.</p>}
      </section>

      <section className="hld-sec" id="hold-how">
        <h2>How this is counted</h2>
        {(snap?.how ?? HOW_HOLDINGS).map((line) => <p key={line} className="small">{line}</p>)}
        <p className="small muted">Amounts under $0.01 are hidden until you show dust. A tiny balance is written out in full (0.00000000093) instead of scientific notation. Decimals come from the token contract. Dollar prices come from the same sources the rest of the app uses. Nothing on this page sends a transaction.</p>
      </section>
    </main>
  );
}
