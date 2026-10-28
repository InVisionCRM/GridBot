/** Sticky Pro Desk bar. Four destinations stay; chevrons open the strategy menu. Phone uses the bottom bar. */
import { useEffect, useRef, useState } from 'react';
import { chainOf, chains, type ChainFilter } from './chains';
import { Sparkline } from './charts';
import { Icon, type IconName } from './icons';
import { formatUsdChip, type HoldingsSnapshot } from '../live/holdingsMath';
import { pct } from './fmt';
import type { AnyObj, Nav, View } from './model';
import type { Opportunity } from '../market/scan';
import { isSafe, useOpportunities, wayOf } from './Opportunities';

const TABS: { id: 'home' | 'bots' | 'holdings' | 'more'; label: string; icon: IconName; menu?: boolean }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'bots', label: 'Bots', icon: 'grid', menu: true },
  { id: 'holdings', label: 'Holdings', icon: 'wallet' },
  { id: 'more', label: 'More', icon: 'more', menu: true },
];

function tabOf(view: View): (typeof TABS)[number]['id'] {
  if (view.v === 'home') return 'home';
  if (view.v === 'bots' || view.v === 'new' || view.v === 'grid' || view.v === 'trend' || view.v === 'lp') return 'bots';
  if (view.v === 'holdings') return 'holdings';
  return 'more';
}

function go(nav: Nav, id: (typeof TABS)[number]['id']) {
  if (id === 'home') nav({ v: 'home' });
  else if (id === 'bots') nav({ v: 'bots' });
  else if (id === 'holdings') nav({ v: 'holdings' });
  else nav({ v: 'more' });
}

function Caret({ up }: { up?: boolean }) {
  return (
    <svg className={up ? 'up' : ''} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function DeskMenu({ s, nav, onGuide, onActivity, close }: { s: AnyObj; nav: Nav; onGuide: () => void; onActivity: () => void; close: () => void }) {
  const { p } = useOpportunities();
  const picks = ((p?.chains ?? []) as AnyObj[])
    .flatMap((c) => (c.items ?? []) as Opportunity[])
    .filter((o) => isSafe(o))
    .flatMap((o) => { const w = wayOf(o, 'best'); return w ? [{ o, w }] : []; })
    .sort((a, b) => b.w.expected - a.w.expected)
    .slice(0, 4);
  const spark = picks.length > 1 ? picks.map((x) => x.w.expected) : [0, picks[0]?.w.expected ?? 0];
  const jump = (v: Parameters<Nav>[0]) => { close(); nav(v); };
  return (
    <div className="mega" role="menu">
      <div>
        <p className="mega-k">Strategies</p>
        <div className="tiles">
          <button type="button" className="tile" onClick={() => jump({ v: 'new', kind: 'grid' })}><Icon name="grid" size={18} /><b>Grid</b><small>Buy low, sell one level up</small></button>
          <button type="button" className="tile" onClick={() => jump({ v: 'new', kind: 'trend' })}><Icon name="trend" size={18} /><b>Trend</b><small>Follow a move, then stand aside</small></button>
          <button type="button" className="tile" onClick={() => jump({ v: 'new', kind: 'lp' })}><Icon name="drop" size={18} /><b>Liquidity</b><small>Earn fees inside a range</small></button>
          <button type="button" className="tile" onClick={() => jump({ v: 'auto' })}><Icon name="target" size={18} /><b>Token trader</b><small>New pools, size limits, exits</small></button>
        </div>
      </div>
      <div>
        <p className="mega-k">Desk</p>
        <div className="mega-links">
          <button type="button" className="mega-link" onClick={() => jump({ v: 'opps' })}>Opportunities<small>Best this week, full list</small></button>
          <button type="button" className="mega-link" onClick={() => jump({ v: 'tools', tab: 'chart' })}>Charts<small>Candles for a pair</small></button>
          <button type="button" className="mega-link" onClick={() => jump({ v: 'tools', tab: 'analytics' })}>Analytics<small>What the bots made</small></button>
          <button type="button" className="mega-link" onClick={() => jump({ v: 'tools', tab: 'convert' })}>Convert<small>Swap a coin you hold</small></button>
          <button type="button" className="mega-link" onClick={() => { close(); onGuide(); }}>Guide<small>What each bot does</small></button>
          <button type="button" className="mega-link" onClick={() => { close(); onActivity(); }}>Activity<small>Trades and stops</small></button>
        </div>
      </div>
      <button type="button" className="best-card" onClick={() => jump({ v: 'opps' })}>
        <p className="mega-k">Best this week</p>
        <Sparkline points={spark} width={220} height={56} />
        {picks[0]
          ? <span>{picks[0].o.label} · {chainOf(s, picks[0].o.chainId)?.short}<b className="pos"> {pct(picks[0].w.expected, 1, true)}</b></span>
          : <span className="muted">{p ? 'No safe pools in this check.' : 'Checking pools…'}</span>}
      </button>
    </div>
  );
}

/** Views that show crypto units only (no dollars): Home, Bots, the grid, trend and LP pages, and the smart/token trader page. */
export const CRYPTO_ONLY = new Set(['home', 'bots', 'grid', 'trend', 'lp', 'auto']);

export function Header({
  s, view, nav, chain, setChain, showUsd, setShowUsd, connected, ver, holdings, onActivity, onGuide,
}: {
  s: AnyObj;
  view: View;
  nav: Nav;
  chain: ChainFilter;
  setChain: (c: ChainFilter) => void;
  showUsd: boolean;
  setShowUsd: (on: boolean) => void;
  connected: boolean;
  ver: AnyObj | null;
  holdings: HoldingsSnapshot | null;
  onActivity: () => void;
  onGuide: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [chainsOpen, setChainsOpen] = useState(false);
  const [mega, setMega] = useState<null | 'bots' | 'more' | 'phone'>(null);
  const root = useRef<HTMLElement>(null);
  const current = tabOf(view);
  const cs = chains(s);
  const sel = chain === 'all' ? null : chainOf(s, chain);
  const worth = !holdings ? null : !holdings.hasSigner ? null : holdings.netWorthExDustUsd ?? holdings.netWorthUsd;
  const worthText = !holdings ? '…' : !holdings.hasSigner ? '—' : worth == null ? '—' : formatUsdChip(worth);
  const letter = s.address ? s.address.slice(2, 4).toUpperCase() : 'P';
  const showAccount = !!s.copy || (typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));

  useEffect(() => {
    if (!menu && !chainsOpen && !mega) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setMenu(false); setChainsOpen(false); setMega(null); } };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); setChainsOpen(false); setMega(null); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [menu, chainsOpen, mega]);

  const shut = () => { setMega(null); setMenu(false); setChainsOpen(false); };

  return (
    <>
      <header className="top" ref={root}>
        <button type="button" className="brand" onClick={() => { shut(); nav({ v: 'home' }); }}><i className="logo-mark" aria-hidden="true" />GridBot</button>
        <button type="button" className="mega-launch" aria-expanded={mega != null} aria-label="Open menu" onClick={() => { setMenu(false); setChainsOpen(false); setMega((v) => v ? null : 'phone'); }}><Caret up={mega != null} /></button>
        <nav className="top-tabs" aria-label="Main">
          {TABS.map((t) => (
            <div key={t.id} className={`tab${current === t.id ? ' on' : ''}`}>
              <button type="button" aria-current={current === t.id ? 'page' : undefined} onClick={() => { shut(); go(nav, t.id); }}>{t.label}</button>
              {t.menu && (
                <button type="button" className="tab-chev" aria-expanded={mega === t.id} aria-label={`${t.label} menu`} onClick={() => { const id = t.id as 'bots' | 'more'; setMenu(false); setChainsOpen(false); setMega((v) => v === id ? null : id); }}>
                  <Caret up={mega === t.id} />
                </button>
              )}
            </div>
          ))}
        </nav>
        <div className="top-end">
          {/* Home, Bots, the bot pages and the trader page show crypto units only (Kyle): no dollar net worth in the bar there */}
          {!CRYPTO_ONLY.has(view.v) && <button type="button" className="worth-num" onClick={() => { shut(); nav({ v: 'holdings' }); }} title="Net worth">{worthText}</button>}
          <button type="button" className="pill-btn" aria-expanded={chainsOpen} aria-haspopup="menu" onClick={() => { setMenu(false); setMega(null); setChainsOpen((v) => !v); }}>
            {sel ? sel.short : 'All chains'} <Caret up={chainsOpen} />
          </button>
          <span className={`live-pill${connected ? ' on' : ''}`}><i className="live-dot" />{connected ? 'Live' : 'Off'}</span>
          <button type="button" className={`avatar${connected ? '' : ' off'}`} aria-expanded={menu} aria-haspopup="menu" aria-label="Account" onClick={() => { setChainsOpen(false); setMega(null); setMenu((v) => !v); }}>{letter}</button>
          {chainsOpen && (
            <div className="menu chain-menu" role="menu">
              <button type="button" role="menuitem" className={chain === 'all' ? 'on' : ''} onClick={() => { setChain('all'); setChainsOpen(false); }}>All chains</button>
              {cs.map((c) => (
                <button key={c.id} type="button" role="menuitem" className={chain === c.id ? 'on' : ''} onClick={() => { setChain(c.id); setChainsOpen(false); }}>
                  {c.name}{c.lowGas ? ' · low gas' : ''}{c.hasSigner ? '' : ' · paper'}
                </button>
              ))}
            </div>
          )}
          {menu && (
            <div className="menu" role="menu">
              <p className="menu-note">{s.address ? `${s.address.slice(0, 6)}…${s.address.slice(-4)}` : 'Paper only. No signing key.'}</p>
              <button type="button" role="menuitem" onClick={() => setShowUsd(!showUsd)}>{showUsd ? 'Hide dollar amounts' : 'Show dollar amounts'}</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onActivity(); }}>Activity</button>
              {!s.copy && ver && <button type="button" role="menuitem" onClick={() => { setMenu(false); nav({ v: 'tools', tab: 'system' }); }}>{ver.title ?? 'Version'}</button>}
              {showAccount && <a role="menuitem" href="/account">Account</a>}
            </div>
          )}
        </div>
        {mega && <DeskMenu s={s} nav={nav} onGuide={onGuide} onActivity={onActivity} close={() => setMega(null)} />}
      </header>
      {mega && <div className="shade" onClick={() => setMega(null)} />}
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={current === t.id ? 'on' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => { shut(); go(nav, t.id); }}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
