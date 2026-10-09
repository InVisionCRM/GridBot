/** Tools: charts, backtest, analytics, markets (custom tokens, pools) and alerts. */
import { useEffect, useState } from 'react';
import { http } from './api';
import { Chart } from './Chart';
import { Backtest } from './Backtest';
import { Analytics, MarketPanels } from './Analytics';
import { Markets } from './Markets';
import { Alerts, type NotifyPrefs } from './Alerts';
import { lbl, marketsOf, useChainFilter } from './chains';
import type { Ticks } from './useStream';
import { TOOL_TABS, type AnyObj, type Nav, type View } from './model';

function ChartTab({ s, ticks }: { s: AnyObj; ticks: Ticks | null }) {
  const { chain } = useChainFilter();
  const keys = marketsOf(s).filter((m) => m.tradable && (chain === 'all' || m.chainId === chain)).map((m) => m.key);
  const [pair, setPair] = useState<string>(keys[0] ?? s.quotes?.[0] ?? 'DAI');
  useEffect(() => { if (keys.length && !keys.includes(pair)) setPair(keys[0]); }, [chain]); // eslint-disable-line react-hooks/exhaustive-deps
  const [panel, setPanel] = useState<AnyObj | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => http(`/api/market/panel?pair=${encodeURIComponent(pair)}`).then((p) => { if (!dead) setPanel(p); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [pair]);
  return (
    <>
      <div className="card"><Chart status={s} ticks={ticks} pairs={keys.length ? keys : s.quotes ?? []} pair={pair} onPairChange={setPair} height={520} /></div>
      {panel && <div className="card"><h3>Market · {lbl(s, pair)}</h3><MarketPanels panels={[panel]} /></div>}
    </>
  );
}

export function Tools({ s, view, ticks, nav, act, busy, prefs, setPrefs }: {
  s: AnyObj; view: Extract<View, { v: 'tools' }>; ticks: Ticks | null; nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean;
  prefs: NotifyPrefs; setPrefs: (p: NotifyPrefs) => void;
}) {
  const tab = view.tab;
  return (
    <main className="stack">
      <nav className="tabs" aria-label="Tools">
        {TOOL_TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k} onClick={() => nav({ v: 'tools', tab: k })}>{l}</button>)}
      </nav>
      {tab === 'chart' && <ChartTab s={s} ticks={ticks} />}
      {tab === 'backtest' && <Backtest status={s} prefill={view.btPrefill ?? null}
        onUse={(p) => nav(p.created ? { v: 'trend', id: p.created } : { v: 'new', kind: 'trend', trendPrefill: { pair: p.pair, tf: p.tf, cfg: p.cfg, capitalUsd: p.capitalUsd, nonce: Date.now() } })} />}
      {tab === 'analytics' && <Analytics status={s} />}
      {tab === 'markets' && <Markets status={s} act={act} busy={busy} />}
      {tab === 'alerts' && <Alerts status={s} prefs={prefs} setPrefs={setPrefs} />}
    </main>
  );
}
