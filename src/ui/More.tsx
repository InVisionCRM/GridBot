/** Grouped menus. Each group is a submenu; nothing that used to be a page is dropped. */
import { useEffect, useState } from 'react';
import { http } from './api';
import { Icon, type IconName } from './icons';
import type { AnyObj, Nav, ToolTab } from './model';

function useJson(path: string) {
  const [data, setData] = useState<AnyObj | null>(null);
  useEffect(() => {
    let dead = false;
    http<AnyObj>(path).then((d) => { if (!dead) setData(d); }).catch(() => undefined);
    return () => { dead = true; };
  }, [path]);
  return data;
}

export function More({ s, nav, onGuide, onActivity }: { s: AnyObj; nav: Nav; onGuide: () => void; onActivity: () => void }) {
  const auto = useJson('/api/autopilot');
  const trader = useJson('/api/token-trader');
  const showAccount = !!s.copy || (typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));
  const tool = (tab: ToolTab, icon: IconName, label: string, hint: string) => (
    <button type="button" className="more-row" onClick={() => nav({ v: 'tools', tab })}>
      <Icon name={icon} size={18} /><span>{label}<small>{hint}</small></span>
    </button>
  );
  return (
    <main className="more">
      <h1>More</h1>
      <details className="more-sec" open>
        <summary><Icon name="chart" size={18} /><span>Markets</span></summary>
        <button type="button" className="more-row" onClick={() => nav({ v: 'opps' })}><Icon name="search" size={18} /><span>Opportunities<small>Best this week, and the full list</small></span></button>
        {tool('chart', 'chart', 'Charts', 'Candles for a pair')}
        {tool('backtest', 'flask', 'Backtest', 'A trend setup on past candles')}
        {tool('markets', 'list', 'Market list', 'Pairs this app can trade')}
      </details>
      <details className="more-sec">
        <summary><Icon name="spark" size={18} /><span>Smart trader</span><em>{auto ? (auto.on ? `On · ${auto.mode}` : 'Off') : ''}</em></summary>
        <button type="button" className="more-row" onClick={() => nav({ v: 'auto' })}><Icon name="spark" size={18} /><span>Open<small>{auto?.budgets?.length ? `${auto.budgets.length} budget${auto.budgets.length === 1 ? '' : 's'}` : 'Set a budget per chain'}</small></span></button>
      </details>
      <details className="more-sec">
        <summary><Icon name="target" size={18} /><span>Token trader</span><em>{trader ? `${trader.on ? 'On' : 'Off'} · sniper ${trader.options?.sniper?.on ? 'on' : 'off'}` : ''}</em></summary>
        <button type="button" className="more-row" onClick={() => nav({ v: 'auto' })}><Icon name="target" size={18} /><span>Sniper and limits<small>New pools, size limits, and exits</small></span></button>
      </details>
      <details className="more-sec">
        <summary><Icon name="gear" size={18} /><span>Tools</span></summary>
        {tool('convert', 'swap', 'Convert', 'Swap a coin you already hold')}
        {tool('alerts', 'bell', 'Alerts', 'Which events ping this browser')}
        {tool('analytics', 'activity', 'Analytics', 'What the bots made')}
        {tool('system', 'pulse', 'System', 'Version and what is healthy')}
        {!s.copy && tool('friends', 'users', 'Friends', 'Share a copy of this bot')}
      </details>
      <details className="more-sec">
        <summary><Icon name="book" size={18} /><span>Guide</span></summary>
        <button type="button" className="more-row" onClick={onGuide}><Icon name="book" size={18} /><span>Guide<small>What each bot does</small></span></button>
      </details>
      <details className="more-sec">
        <summary><Icon name="user" size={18} /><span>Account</span></summary>
        <button type="button" className="more-row" onClick={onActivity}><Icon name="activity" size={18} /><span>Activity<small>Trades and stops as they happen</small></span></button>
        {showAccount && <a className="more-row" href="/account"><Icon name="user" size={18} /><span>Account<small>{s.copy ? `Signed in as ${s.copy.friend}` : 'Phone login'}</small></span></a>}
      </details>
    </main>
  );
}
