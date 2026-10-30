/**
 * More, Coinbase style: eight tiles on one screen, each with a live figure. Wallet, Alerts, System and Settings open a
 * drawer; the others open their page. Charts, Backtest and the Market list share one "Charts & tools" page; Convert
 * lives in the Wallet; Activity is the home's Live river.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { http } from './api';
import { allBots, totalGeneratedUsd } from './botRow';
import { chainOf, marketsOf } from './chains';
import { pct, usd } from './fmt';
import { Icon, type IconName } from './icons';
import { isSafe, useOpportunities, wayOf } from './Opportunities';
import { Sheet } from './Sheet';
import { WalletView } from './Wallet';
import { worthChange, worthLine } from './walletModel';
import { Sparkline } from './charts';
import type { HoldingsSnapshot } from '../live/holdingsMath';
import type { Opportunity } from '../market/scan';
import type { AnyObj, Nav } from './model';

function useJson<T = AnyObj>(path: string, everyMs = 0) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http<T>(path).then((d) => { if (!dead) setData(d); }).catch(() => undefined);
    void load();
    const t = everyMs ? setInterval(load, everyMs) : null;
    return () => { dead = true; if (t) clearInterval(t); };
  }, [path, everyMs]);
  return data;
}

type Drawer = 'wallet' | 'settings' | null;

function Tile({ icon, tone, label, value, sub, subTone, chart, onClick }: {
  icon: IconName; tone: string; label: string; value: ReactNode; sub: ReactNode; subTone?: 'pos' | 'neg' | 'warn' | null; chart?: ReactNode; onClick: () => void;
}) {
  return (
    <button type="button" className="mo-tile" onClick={onClick}>
      <span className="mo-ic" style={{ color: tone, background: `color-mix(in srgb, ${tone} 16%, transparent)` }}><Icon name={icon} size={20} /></span>
      <span className="mo-label">{label}</span>
      <b className="mo-value">{value}</b>
      <span className={`mo-sub ${subTone ?? ''}`}>{sub}</span>
      {chart && <span className="mo-chart">{chart}</span>}
    </button>
  );
}

export function More({ s, nav, holdings, onGuide }: { s: AnyObj; nav: Nav; holdings: HoldingsSnapshot | null; onGuide: () => void }) {
  const [drawer, setDrawer] = useState<Drawer>(null);
  const auto = useJson('/api/autopilot', 30_000);
  const trader = useJson('/api/token-trader', 15_000);
  const check = useJson<{ counts: { pass: number; warn: number; fail: number } }>('/api/system/check');
  const pushView = useJson<{ subscribed: number }>('/api/push/status');
  const day = useJson<{ points: { t: number; usd: number }[] }>('/api/holdings/history?range=1D&chain=all', 60_000);
  const { p } = useOpportunities();

  // Wallet: the dust-free total and today's change, as the drawer shows them
  const worth = holdings?.hasSigner ? holdings.netWorthExDustUsd : null;
  const line = holdings && day ? worthLine(day.points, { t: holdings.at, usd: worth }) : [];
  const change = worthChange(line);
  // Auto traders
  const autoOn = !!auto?.on, tradeOn = !!trader?.on;
  const bought = trader?.funnel?.bought ?? 0;
  // Opportunities: the best safe pick
  const best = ((p?.chains ?? []) as AnyObj[]).flatMap((c) => (c.items ?? []) as Opportunity[]).filter((o) => isSafe(o))
    .flatMap((o) => { const w = wayOf(o, 'best'); return w ? [{ o, w }] : []; }).sort((a, b) => b.w.expected - a.w.expected)[0];
  // History: what the live bots generated, closed ones included
  const generated = totalGeneratedUsd(allBots(s, 'all'), 'live');
  const markets = marketsOf(s).filter((m) => m.tradable).length;
  const health = check?.counts;
  const showAccount = !!s.copy || (typeof window !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname));

  return (
    <main className="mo">
      <h1 className="mo-title">More</h1>
      <div className="mo-grid">
        <Tile icon="wallet" tone="#5CD08D" label="Wallet" onClick={() => setDrawer('wallet')}
          value={worth == null ? (holdings?.hasSigner === false ? 'Paper' : '…') : usd(worth)}
          sub={change ? `${change.usd >= 0 ? '▲' : '▼'} ${usd(Math.abs(change.usd))}${change.pct != null ? ` (${Math.abs(change.pct * 100).toFixed(2)}%)` : ''} today` : holdings?.hasSigner === false ? 'no wallet key' : 'today'}
          subTone={change ? (change.usd >= 0 ? 'pos' : 'neg') : null}
          chart={line.length >= 2 ? <Sparkline points={line.map((x) => x.usd)} width={120} height={34} /> : undefined} />
        <Tile icon="spark" tone="#B58CFF" label="Auto traders" onClick={() => nav({ v: 'auto' })}
          value={autoOn || tradeOn ? 'On' : 'Off'}
          sub={tradeOn ? `token trader · ${bought} bought today${trader?.options?.mode === 'live' ? '' : ' (paper)'}` : autoOn ? `smart trader · ${auto?.mode ?? ''}` : 'smart and token traders'}
          subTone={autoOn || tradeOn ? 'pos' : null} />
        <Tile icon="search" tone="#5B8DEF" label="Opportunities" onClick={() => nav({ v: 'opps' })}
          value={best ? pct(best.w.expected, 1, true) : '—'}
          sub={best ? `${best.o.label} · ${chainOf(s, best.o.chainId)?.short ?? ''} · a week` : 'checking the busiest pools'}
          subTone={best ? 'pos' : null} />
        <Tile icon="bell" tone="#F5B841" label="Alerts" onClick={() => nav({ v: 'alerts' })}
          value={pushView ? (pushView.subscribed ? 'On' : 'Off') : '—'}
          sub={pushView ? (pushView.subscribed ? `${pushView.subscribed} phone${pushView.subscribed === 1 ? '' : 's'} get pushes` : 'turn on lock-screen alerts') : 'lock screen and this tab'} />
        <Tile icon="coins" tone="#5CD08D" label="History" onClick={() => nav({ v: 'tools', tab: 'analytics' })}
          value={generated == null ? '—' : usd(generated, true)}
          sub="generated by live bots" subTone={generated == null ? null : generated >= 0 ? 'pos' : 'neg'} />
        <Tile icon="pulse" tone={health?.fail ? '#F2706B' : health?.warn ? '#F5B841' : '#5CD08D'} label="System" onClick={() => nav({ v: 'tools', tab: 'system' })}
          value={!health ? '…' : health.fail ? `${health.fail} broken` : health.warn ? `${health.warn} to check` : 'All good'}
          sub={health ? `${health.pass} checks ok` : 'running the self-test'} subTone={!health ? null : health.fail ? 'neg' : health.warn ? 'warn' : 'pos'} />
        <Tile icon="chart" tone="#5B8DEF" label="Charts & tools" onClick={() => nav({ v: 'tools', tab: 'chart' })}
          value={`${markets} pairs`} sub="charts · backtest · market list" />
        <Tile icon="gear" tone="#8A8F98" label="Settings" onClick={() => setDrawer('settings')}
          value={s.copy ? s.copy.friend : 'You'} sub="friends · account · guide" />
      </div>
      {drawer === 'wallet' && (
        <Sheet label="Wallet" close={() => setDrawer(null)} tall>
          <WalletView s={s} snap={holdings} mode="drawer" nav={(v) => { setDrawer(null); nav(v); }} />
        </Sheet>
      )}
      {drawer === 'settings' && (
        <Sheet label="Settings" close={() => setDrawer(null)} tall>
          <span className="dk-eyebrow">Settings</span>
          <div className="mo-list">
            {!s.copy && <button type="button" className="wl-row" onClick={() => { setDrawer(null); nav({ v: 'tools', tab: 'friends' }); }}><span className="mo-ic sm"><Icon name="users" size={18} /></span><span className="wl-name"><b>Friends</b><small>Share a copy of this bot</small></span><span className="mo-go">›</span></button>}
            {showAccount && <a className="wl-row" href="/account"><span className="mo-ic sm"><Icon name="user" size={18} /></span><span className="wl-name"><b>Account</b><small>{s.copy ? `Signed in as ${s.copy.friend}` : 'Phone login'}</small></span><span className="mo-go">›</span></a>}
            <button type="button" className="wl-row" onClick={() => { setDrawer(null); onGuide(); }}><span className="mo-ic sm"><Icon name="book" size={18} /></span><span className="wl-name"><b>Guide</b><small>What each bot does</small></span><span className="mo-go">›</span></button>
          </div>
        </Sheet>
      )}
    </main>
  );
}
