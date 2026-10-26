/** A short sticky bar on desktop, and a bottom tab bar on a phone. */
import { useEffect, useRef, useState } from 'react';
import { chainOf, chains, type ChainFilter } from './chains';
import { Icon, type IconName } from './icons';
import { formatUsdChip, type HoldingsSnapshot } from '../live/holdingsMath';
import type { AnyObj, Nav, View } from './model';

const TABS: { id: 'home' | 'bots' | 'holdings' | 'more'; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'bots', label: 'Bots', icon: 'grid' },
  { id: 'holdings', label: 'Holdings', icon: 'wallet' },
  { id: 'more', label: 'More', icon: 'more' },
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

export function Header({
  s, view, nav, chain, setChain, showUsd, setShowUsd, connected, ver, holdings, onActivity,
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
}) {
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLElement>(null);
  const current = tabOf(view);
  const cs = chains(s);
  const sel = chain === 'all' ? null : chainOf(s, chain);
  const worth = !holdings ? null : !holdings.hasSigner ? null : holdings.netWorthExDustUsd ?? holdings.netWorthUsd;
  const worthText = !holdings ? '…' : !holdings.hasSigner ? '—' : worth == null ? '—' : formatUsdChip(worth);
  const letter = s.address ? s.address.slice(2, 4).toUpperCase() : 'P';
  const showAccount = !!s.copy || (typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [menu]);

  return (
    <>
      <header className="top" ref={root}>
        <button type="button" className="brand" onClick={() => { setMenu(false); nav({ v: 'home' }); }}>GridBot</button>
        <nav className="top-tabs" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.id} type="button" className={current === t.id ? 'on' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => go(nav, t.id)}>{t.label}</button>
          ))}
        </nav>
        <div className="top-end">
          <button type="button" className="worth-num" onClick={() => { setMenu(false); nav({ v: 'holdings' }); }} title="Net worth">{worthText}</button>
          <button type="button" className={`avatar${connected ? '' : ' off'}`} aria-expanded={menu} aria-haspopup="menu" aria-label="Account" onClick={() => setMenu((v) => !v)}>{letter}</button>
          {menu && (
            <div className="menu" role="menu">
              <p className="menu-note">{s.address ? `${s.address.slice(0, 6)}…${s.address.slice(-4)}` : 'Paper only. No signing key.'}</p>
              <button type="button" role="menuitem" className={chain === 'all' ? 'on' : ''} onClick={() => setChain('all')}>All chains</button>
              {cs.map((c) => (
                <button key={c.id} type="button" role="menuitem" className={chain === c.id ? 'on' : ''} onClick={() => setChain(c.id)}>
                  {c.name}{c.lowGas ? ' · low gas' : ''}{c.hasSigner ? '' : ' · paper'}
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => setShowUsd(!showUsd)}>{showUsd ? 'Hide dollar amounts' : 'Show dollar amounts'}</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onActivity(); }}>Activity</button>
              {!s.copy && ver && <button type="button" role="menuitem" onClick={() => { setMenu(false); nav({ v: 'tools', tab: 'system' }); }}>{ver.title ?? 'Version'}</button>}
              {showAccount && <a role="menuitem" href="/account">{s.copy ? 'Account' : 'Account'}</a>}
              {sel && <p className="menu-note">Filtered to {sel.name}</p>}
            </div>
          )}
        </div>
      </header>
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={current === t.id ? 'on' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => go(nav, t.id)}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
