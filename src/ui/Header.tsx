/** Sticky glass header: tabs open pictured menus, a net-worth chip, and the guarded Stop all control. */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKey } from 'react';
import { chainOf, chains, type ChainFilter } from './chains';
import { ChainMark, Icon, TokenMark, type IconName } from './icons';
import { formatUsdChip, type HoldingsSnapshot } from '../live/holdingsMath';
import type { AnyObj, Nav, View } from './model';

interface MenuItem {
  label: string;
  hint: string;
  icon: IconName;
  token?: string;
  chain?: { short: string; color: string };
  current?: boolean;
  href?: string;
  go?: () => void;
}
interface MenuCol { title: string; items: MenuItem[] }
interface MenuTab { id: string; label: string; current: boolean; cols: MenuCol[] }

function useNarrow(px = 860) {
  const [n, set] = useState(() => typeof window !== 'undefined' && window.matchMedia(`(max-width: ${px}px)`).matches);
  useEffect(() => {
    const m = window.matchMedia(`(max-width: ${px}px)`);
    const f = () => set(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [px]);
  return n;
}

function jump(nav: Nav, v: View, id?: string) {
  nav(v);
  if (!id) return;
  window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function ItemGlyph({ item }: { item: MenuItem }) {
  if (item.token) return <TokenMark symbol={item.token} size={32} />;
  if (item.chain) return <ChainMark short={item.chain.short} color={item.chain.color} size={32} />;
  return <span className="mega-ico"><Icon name={item.icon} size={18} /></span>;
}

function MenuRow({ item, onDone, menuitem = true }: { item: MenuItem; onDone: () => void; menuitem?: boolean }) {
  const role = menuitem ? 'menuitem' as const : undefined;
  const body = (
    <>
      <ItemGlyph item={item} />
      <span className="mega-copy"><span>{item.label}</span><small>{item.hint}</small></span>
    </>
  );
  if (item.href) {
    return <a className={`mega-item${item.current ? ' on' : ''}`} role={role} href={item.href} onClick={onDone}>{body}</a>;
  }
  return (
    <button type="button" className={`mega-item${item.current ? ' on' : ''}`} role={role} onClick={() => { item.go?.(); onDone(); }}>
      {body}
    </button>
  );
}

export function Header({
  s, view, nav, chain, setChain, showUsd, setShowUsd, connected, busy, running, ver, holdings, onStopAll, onActivity, onGuide,
}: {
  s: AnyObj;
  view: View;
  nav: Nav;
  chain: ChainFilter;
  setChain: (c: ChainFilter) => void;
  showUsd: boolean;
  setShowUsd: (on: boolean) => void;
  connected: boolean;
  busy: boolean;
  running: number;
  ver: AnyObj | null;
  holdings: HoldingsSnapshot | null;
  onStopAll: () => void;
  onActivity: () => void;
  onGuide: () => void;
}) {
  const narrow = useNarrow();
  const [open, setOpen] = useState<string | null>(null);
  const [chainOpen, setChainOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [secs, setSecs] = useState<string[]>(['trade']);
  const [slim, setSlim] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const tabBtn = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusMenu = useRef(false);
  const drawerId = useId();
  const cs = chains(s);
  const sel = chain === 'all' ? null : chainOf(s, chain);
  const tool = view.v === 'tools' ? view.tab : null;
  const showAccount = !!s.copy || (typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));
  const worth = !holdings ? null : !holdings.hasSigner ? null : holdings.netWorthExDustUsd ?? holdings.netWorthUsd;
  const worthText = !holdings ? '…' : !holdings.hasSigner ? 'Paper' : worth == null ? '—' : formatUsdChip(worth);

  const hold = (focus?: View & { v: 'holdings' }) => jump(nav, focus ?? { v: 'holdings' }, focus?.focus ? `hold-${focus.focus}` : undefined);
  const tabs: MenuTab[] = [
    {
      id: 'trade', label: 'Trade', current: view.v === 'home' || view.v === 'grid' || view.v === 'trend' || view.v === 'lp' || view.v === 'new',
      cols: [
        { title: 'Bots', items: [
          { label: 'Your bots', hint: 'Grids, trends and liquidity running now', icon: 'grid', current: view.v === 'home', go: () => nav({ v: 'home' }) },
          { label: 'Activity', hint: 'Trades, stops and errors as they happen', icon: 'activity', go: onActivity },
        ] },
        { title: 'Start one', items: [
          { label: 'New grid', hint: 'Buy and sell between two prices', icon: 'grid', token: 'HEX', current: view.v === 'new' && view.kind === 'grid', go: () => nav({ v: 'new', kind: 'grid' }) },
          { label: 'New trend', hint: 'Follow a candle signal', icon: 'trend', token: 'ETH', current: view.v === 'new' && view.kind === 'trend', go: () => nav({ v: 'new', kind: 'trend' }) },
          { label: 'New liquidity', hint: 'A range on a V3 pool, fees included', icon: 'drop', token: 'USDC', current: view.v === 'new' && view.kind === 'lp', go: () => nav({ v: 'new', kind: 'lp' }) },
        ] },
      ],
    },
    {
      id: 'smart', label: 'Smart trader', current: view.v === 'auto',
      cols: [
        { title: 'Hands off', items: [
          { label: 'Smart trader', hint: 'A budget per chain. It picks the pools.', icon: 'spark', current: view.v === 'auto', go: () => nav({ v: 'auto' }) },
        ] },
        { title: 'One coin', items: [
          { label: 'Token trader', hint: 'Size a coin from pool depth. Sniper buys new liquidity.', icon: 'target', token: 'PLS', go: () => jump(nav, { v: 'auto' }, 'token-trader') },
        ] },
      ],
    },
    {
      id: 'holdings', label: 'Holdings', current: view.v === 'holdings',
      cols: [
        { title: 'Where it sits', items: [
          { label: 'Net worth', hint: 'Wallet, pools, fees and bot grids', icon: 'coins', current: view.v === 'holdings' && !view.focus, go: () => hold() },
          { label: 'Wallet', hint: 'Coins at the address', icon: 'wallet', token: 'DAI', go: () => hold({ v: 'holdings', focus: 'wallet' }) },
          { label: 'Liquidity', hint: 'V3 NFTs and V2 LP tokens', icon: 'layers', token: 'ETH', go: () => hold({ v: 'holdings', focus: 'lp' }) },
          { label: 'Uncollected fees', hint: 'What a collect would pay. Nothing is sent.', icon: 'spark', go: () => hold({ v: 'holdings', focus: 'fees' }) },
          { label: 'Bot grids', hint: 'Coins live grids and trends are using', icon: 'grid', token: 'HEX', go: () => hold({ v: 'holdings', focus: 'bots' }) },
        ] },
        { title: 'By chain', items: cs.map((c) => ({
          label: c.name, hint: c.hasSigner ? (c.address ? shortAddr(c.address) : 'Signing wallet') : 'Paper only',
          icon: 'pulse' as IconName, chain: { short: c.short, color: c.color },
          go: () => { setChain(c.id); hold({ v: 'holdings', focus: 'chains' }); },
        })) },
        { title: 'Read it', items: [
          { label: 'How this is counted', hint: 'Why a balance and a position are different', icon: 'book', go: () => hold({ v: 'holdings', focus: 'how' }) },
        ] },
      ],
    },
    {
      id: 'markets', label: 'Markets', current: view.v === 'opps' || tool === 'chart' || tool === 'backtest' || tool === 'markets',
      cols: [
        { title: 'This week', items: [
          { label: 'Opportunities', hint: 'Every pool the daily check scored', icon: 'search', current: view.v === 'opps', go: () => nav({ v: 'opps' }) },
          { label: 'Best this week', hint: 'The three safe pools expected to earn the most', icon: 'spark', token: 'HEX', go: () => jump(nav, { v: 'home' }, 'best-week') },
        ] },
        { title: 'Look closer', items: [
          { label: 'Charts', hint: 'Candles for a pair', icon: 'chart', current: tool === 'chart', go: () => nav({ v: 'tools', tab: 'chart' }) },
          { label: 'Backtest', hint: 'Run a trend setup on past candles', icon: 'flask', current: tool === 'backtest', go: () => nav({ v: 'tools', tab: 'backtest' }) },
          { label: 'Market list', hint: 'Pairs this app can trade', icon: 'list', current: tool === 'markets', go: () => nav({ v: 'tools', tab: 'markets' }) },
        ] },
      ],
    },
    {
      id: 'tools', label: 'Tools', current: view.v === 'tools' && tool !== 'chart' && tool !== 'backtest' && tool !== 'markets',
      cols: [
        { title: 'Move and watch', items: [
          { label: 'Convert', hint: 'Swap a coin you already hold', icon: 'swap', token: 'USDG', current: tool === 'convert', go: () => nav({ v: 'tools', tab: 'convert' }) },
          { label: 'Alerts', hint: 'Which events ping this browser', icon: 'bell', current: tool === 'alerts', go: () => nav({ v: 'tools', tab: 'alerts' }) },
        ] },
        { title: 'The desk', items: [
          { label: 'Analytics', hint: 'What the bots made, by coin', icon: 'pulse', current: tool === 'analytics', go: () => nav({ v: 'tools', tab: 'analytics' }) },
          { label: 'System', hint: 'Version, feeds and what is healthy', icon: 'gear', current: tool === 'system', go: () => nav({ v: 'tools', tab: 'system' }) },
          ...(!s.copy ? [{ label: 'Friends', hint: 'Share a copy of this bot', icon: 'users' as IconName, current: tool === 'friends', go: () => nav({ v: 'tools', tab: 'friends' }) }] : []),
        ] },
      ],
    },
    {
      id: 'guide', label: 'Guide', current: false,
      cols: [
        { title: 'Learn', items: [
          { label: 'Open the guide', hint: 'What each bot does, in plain words', icon: 'book', go: onGuide },
          { label: 'How holdings are counted', hint: 'Wallet, pool, fees, and why dust is hidden', icon: 'layers', go: () => hold({ v: 'holdings', focus: 'how' }) },
        ] },
      ],
    },
    {
      id: 'account', label: 'Account', current: false,
      cols: [
        { title: 'This wallet', items: [
          { label: s.address ? shortAddr(s.address) : 'Paper only', hint: s.address ? 'No key means paper. A key reads this address.' : (s.copy ? 'Add a key under Account to leave paper mode.' : 'No signing key in .env. Every bot is paper.'), icon: 'user', go: () => hold() },
          { label: showUsd ? 'Dollars on' : 'Dollars off', hint: 'Coin amounts stay. This adds today’s dollar value.', icon: 'coins', token: 'USDC', go: () => setShowUsd(!showUsd) },
        ] },
        { title: 'This app', items: [
          { label: 'Activity', hint: 'The live log', icon: 'activity', go: onActivity },
          ...(!s.copy && ver ? [{ label: ver.title ?? 'Version', hint: ver.detail ?? 'Is this the latest code?', icon: 'gear' as IconName, go: () => nav({ v: 'tools', tab: 'system' }) }] : []),
          ...(showAccount ? [{ label: 'Account', hint: s.copy ? `Logged in as ${s.copy.friend}` : 'Phone login. Bots keep running if you log out.', icon: 'user' as IconName, href: '/account' }] : []),
        ] },
      ],
    },
  ];

  const closeMenus = () => { setOpen(null); setChainOpen(false); };
  const closeAll = () => { closeMenus(); setDrawer(false); };

  useEffect(() => {
    const onScroll = () => setSlim(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open && !chainOpen) return;
    const down = (e: MouseEvent) => { if (!headerRef.current?.contains(e.target as Node)) closeMenus(); };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [open, chainOpen]);

  useEffect(() => {
    if (!open || !focusMenu.current) return;
    focusMenu.current = false;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);

  useEffect(() => {
    if (!drawer) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = drawerRef.current;
    const selQ = 'button, a, input, [tabindex]:not([tabindex="-1"])';
    const items = () => [...(root?.querySelectorAll<HTMLElement>(selQ) ?? [])].filter((el) => !el.hasAttribute('disabled'));
    const prev = document.activeElement as HTMLElement | null;
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setDrawer(false); return; }
      if (e.key !== 'Tab') return;
      const f = items();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [drawer]);

  const onMenuKey = (e: ReactKey) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i <= 0) tabBtn.current[open ?? '']?.focus();
      else items[i - 1]?.focus();
    } else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); const id = open; setOpen(null); if (id) tabBtn.current[id]?.focus(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.id === open);
      const n = tabs[(idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      setOpen(n.id);
      tabBtn.current[n.id]?.focus();
    }
  };

  const openDrawer = (section?: string) => {
    closeMenus();
    if (section) setSecs((xs) => (xs.includes(section) ? xs : [...xs, section]));
    setDrawer(true);
  };

  const active = tabs.find((t) => t.id === open) ?? null;
  const stopName = sel ? `Stop all on ${sel.name}` : 'Stop all';

  return (
    <header className={`hdr${slim ? ' slim' : ''}`} ref={headerRef}>
      <div className="hdr-bar">
        <button type="button" className="logo" onClick={() => { closeAll(); nav({ v: 'home' }); }}>
          <i />GridBot
        </button>
        <nav className="hdr-tabs" aria-label="Main">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              ref={(el) => { tabBtn.current[tab.id] = el; }}
              className={tab.current ? 'on' : ''}
              aria-expanded={open === tab.id}
              aria-controls={open === tab.id ? 'hdr-mega' : undefined}
              onClick={() => { setChainOpen(false); setOpen(open === tab.id ? null : tab.id); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  focusMenu.current = true;
                  setChainOpen(false);
                  setOpen(tab.id);
                } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const i = tabs.findIndex((t) => t.id === tab.id);
                  const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
                  if (open) setOpen(n.id);
                  tabBtn.current[n.id]?.focus();
                } else if (e.key === 'Escape') setOpen(null);
                else if (e.key === 'Home') { e.preventDefault(); tabBtn.current[tabs[0].id]?.focus(); }
                else if (e.key === 'End') { e.preventDefault(); tabBtn.current[tabs[tabs.length - 1].id]?.focus(); }
              }}
            >{tab.label}</button>
          ))}
        </nav>
        <div className="hdr-tools">
          <button
            type="button"
            className="worth"
            aria-haspopup="menu"
            aria-expanded={open === 'holdings'}
            title={holdings?.hasSigner === false ? 'Paper mode: no wallet to price' : 'Net worth. Opens holdings.'}
            onClick={() => { if (narrow) openDrawer('holdings'); else { setChainOpen(false); setOpen(open === 'holdings' ? null : 'holdings'); } }}
          >
            <span className="mega-ico sm"><Icon name="coins" size={16} /></span>
            <span className="worth-k">Holdings</span>
            <b>{worthText}</b>
          </button>
          <button
            type="button"
            className="hdr-chain"
            aria-expanded={chainOpen}
            aria-haspopup="menu"
            title={sel ? `${sel.name}${sel.lowGas ? ', low gas' : ''}` : 'Every chain'}
            onClick={() => { setOpen(null); setChainOpen((v) => !v); }}
          >
            {sel ? <ChainMark short={sel.short} color={sel.color} size={22} /> : <span className="mega-ico sm"><Icon name="layers" size={16} /></span>}
            <span>{sel ? sel.short : 'All'}</span>
            {sel?.lowGas ? <i className="gas-low" aria-label="low gas" /> : null}
          </button>
          {chainOpen && (
            <div className="hdr-pop" role="menu" aria-label="Chain">
              <button type="button" role="menuitem" className={`mega-item${chain === 'all' ? ' on' : ''}`} onClick={() => { setChain('all'); setChainOpen(false); }}>
                <span className="mega-ico"><Icon name="layers" size={18} /></span>
                <span className="mega-copy"><span>All chains</span><small>Home, holdings and lists together</small></span>
              </button>
              {cs.map((c) => (
                <button key={c.id} type="button" role="menuitem" className={`mega-item${chain === c.id ? ' on' : ''}`} onClick={() => { setChain(c.id); setChainOpen(false); }}>
                  <ChainMark short={c.short} color={c.color} size={32} />
                  <span className="mega-copy"><span>{c.name}{c.lowGas ? ' · low gas' : ''}</span><small>{c.hasSigner ? `${c.nativeSymbol} for gas` : 'Paper only'}</small></span>
                </button>
              ))}
            </div>
          )}
          <button type="button" className={`pill usd-switch${showUsd ? ' on' : ''}`} aria-pressed={showUsd} onClick={() => setShowUsd(!showUsd)}
            title={showUsd ? 'Dollar values are shown beside coin amounts. Tap to show coins only.' : 'Results are shown in coins. Tap to also show their dollar value at today\'s price.'}>
            $ <span className="usd-word">{showUsd ? 'on' : 'off'}</span>
          </button>
          <span className={`pill live-pill${connected ? '' : ' warn'}`} title={connected ? 'Live: prices and trades stream in as they happen' : 'Live stream lost; polling every 3 s'}>
            <i />{connected ? <span className="live-word">Live</span> : <span className="live-word">Reconnecting</span>}
          </span>
          <button type="button" className="btn kill" disabled={busy || running === 0} onClick={onStopAll} aria-label={stopName}
            title={sel ? `Stop every bot on ${sel.name}. Holdings are kept.` : 'Stop every bot on every chain. Holdings are kept.'}>
            <span className="stop-long">{sel ? `Stop all on ${sel.short}` : 'Stop all'}</span>
            <span className="stop-short">Stop</span>
          </button>
          <button type="button" className="hdr-burger" aria-expanded={drawer} aria-controls={drawerId} onClick={() => (drawer ? setDrawer(false) : openDrawer(tabs.find((t) => t.current)?.id))}>
            <Icon name="list" size={20} />
            <span>Menu</span>
          </button>
        </div>
      </div>
      {active && !narrow && (
        <div className="mega" id="hdr-mega" ref={menuRef} role="menu" aria-label={active.label} onKeyDown={onMenuKey} style={{ ['--cols' as string]: String(active.cols.length) }}>
          {active.cols.map((col) => (
            <div key={col.title} className="mega-col">
              <h2>{col.title}</h2>
              {col.items.map((item) => <MenuRow key={item.label} item={item} onDone={closeMenus} />)}
            </div>
          ))}
        </div>
      )}
      {drawer && <>
        <div className="nav-scrim" onClick={() => setDrawer(false)} />
        <aside className="nav-drawer" id={drawerId} ref={drawerRef} role="dialog" aria-modal="true" aria-label="Menu">
          <div className="nav-drawer-head">
            <span className="logo"><i />GridBot</span>
            <button type="button" className="nav-x" onClick={() => setDrawer(false)}>Close</button>
          </div>
          <div className="nav-sec-block">
            <p className="nav-k">Chains</p>
            <button type="button" className={`mega-item${chain === 'all' ? ' on' : ''}`} onClick={() => { setChain('all'); setDrawer(false); }}>
              <span className="mega-ico"><Icon name="layers" size={18} /></span>
              <span className="mega-copy"><span>All chains</span><small>No filter</small></span>
            </button>
            {cs.map((c) => (
              <button key={c.id} type="button" className={`mega-item${chain === c.id ? ' on' : ''}`} onClick={() => { setChain(c.id); setDrawer(false); }}>
                <ChainMark short={c.short} color={c.color} size={32} />
                <span className="mega-copy"><span>{c.name}</span><small>{c.lowGas ? 'Low gas' : c.hasSigner ? 'Live wallet' : 'Paper only'}</small></span>
              </button>
            ))}
          </div>
          {tabs.map((tab) => {
            const shown = secs.includes(tab.id);
            return (
              <div key={tab.id} className="nav-sec-block">
                <button type="button" className="nav-sec" aria-expanded={shown} onClick={() => setSecs((xs) => shown ? xs.filter((id) => id !== tab.id) : [...xs, tab.id])}>
                  <span>{tab.label}</span>
                  <span className="nav-chev" aria-hidden="true">{shown ? '−' : '+'}</span>
                </button>
                {shown && tab.cols.map((col) => (
                  <div key={col.title} className="mega-col">
                    <h2>{col.title}</h2>
                    {col.items.map((item) => <MenuRow key={item.label} item={item} onDone={closeAll} menuitem={false} />)}
                  </div>
                ))}
              </div>
            );
          })}
        </aside>
      </>}
    </header>
  );
}
