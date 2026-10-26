/** Everything that is not the daily screen: markets, tools, the guide, account. */
import type { AnyObj, Nav, ToolTab } from './model';

export function More({ s, nav, onGuide, onActivity }: { s: AnyObj; nav: Nav; onGuide: () => void; onActivity: () => void }) {
  const tool = (tab: ToolTab, label: string, hint: string) => (
    <button type="button" className="more-row" onClick={() => nav({ v: 'tools', tab })}>
      <span>{label}</span><small>{hint}</small>
    </button>
  );
  const showAccount = !!s.copy || (typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));
  return (
    <main className="more">
      <h1>More</h1>
      <section>
        <h2>Markets</h2>
        <button type="button" className="more-row" onClick={() => nav({ v: 'opps' })}><span>Opportunities</span><small>Best this week, and the full list</small></button>
        {tool('chart', 'Charts', 'Candles for a pair')}
        {tool('backtest', 'Backtest', 'A trend setup on past candles')}
        {tool('markets', 'Market list', 'Pairs this app can trade')}
      </section>
      <section>
        <h2>Trading</h2>
        <button type="button" className="more-row" onClick={() => nav({ v: 'auto' })}><span>Smart trader</span><small>A budget per chain, and the token trader</small></button>
        <button type="button" className="more-row" onClick={() => nav({ v: 'new', kind: 'grid' })}><span>New grid</span><small>Buy and sell between two prices</small></button>
        <button type="button" className="more-row" onClick={() => nav({ v: 'new', kind: 'trend' })}><span>New trend</span><small>Follow a candle signal</small></button>
        <button type="button" className="more-row" onClick={() => nav({ v: 'new', kind: 'lp' })}><span>New liquidity</span><small>A range on a V3 pool</small></button>
      </section>
      <section>
        <h2>Tools</h2>
        {tool('convert', 'Convert', 'Swap a coin you already hold')}
        {tool('alerts', 'Alerts', 'Which events ping this browser')}
        {tool('analytics', 'Analytics', 'What the bots made')}
        {tool('system', 'System', 'Version and what is healthy')}
        {!s.copy && tool('friends', 'Friends', 'Share a copy of this bot')}
      </section>
      <section>
        <h2>App</h2>
        <button type="button" className="more-row" onClick={onGuide}><span>Guide</span><small>What each bot does</small></button>
        <button type="button" className="more-row" onClick={onActivity}><span>Activity</span><small>Trades and stops as they happen</small></button>
        {showAccount && <a className="more-row" href="/account"><span>Account</span><small>{s.copy ? `Signed in as ${s.copy.friend}` : 'Phone login'}</small></a>}
      </section>
    </main>
  );
}
