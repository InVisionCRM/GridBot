import { LayoutGroup, MotionConfig } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../ui/icons';
import { ActivityTape } from './activity-tape';
import { BotView } from './bot-view';
import { deskStatusPill } from './format';
import { HoldingsView } from './holdings-view';
import { HomeView, Ticker } from './home-view';
import { MoreView } from './more-view';
import { press } from './press';
import { useDesk } from './use-desk';

type Page = { v: 'home' } | { v: 'bot'; id: string } | { v: 'activity' } | { v: 'holdings' } | { v: 'more' };

export function DeskApp() {
  const { snap, stale, failed } = useDesk();
  const [page, setPage] = useState<Page>({ v: 'home' });
  const bot = snap && page.v === 'bot' ? snap.bots.find((b) => b.metrics.botId === page.id) : undefined;
  const go = (next: Page) => { press(); setPage(next); };
  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        <div className="v2">
          <div className="ambient" aria-hidden="true" />
          {snap && <Ticker prices={snap.prices} />}
          <header className="v2-head">
            <strong>GridBot</strong>
            {snap && <StatusPill source={snap.source} asOf={snap.portfolio.asOf} stale={stale} />}
          </header>
          {snap?.source === 'fixture' && <p className="sample-banner" role="status">Sample data, not your bots</p>}
          {failed && !snap && <StreamError />}
          {stale && snap && (
            <p className="stale-banner" role="status">
              Connection dropped. Numbers are frozen until the stream returns. <a href="/?classic=1">Open classic view</a>
            </p>
          )}
          <div className="v2-body">
            <main>
              {!snap && !failed && <Skeleton />}
              {snap && page.v === 'home' && (
                <HomeView portfolio={snap.portfolio} bots={snap.bots} prices={snap.prices} onOpen={(id) => go({ v: 'bot', id })} />
              )}
              {snap && page.v === 'bot' && bot && (
                <BotView
                  bot={bot}
                  activity={snap.activity.filter((a) => a.botId === bot.metrics.botId)}
                  prices={snap.prices}
                  onBack={() => go({ v: 'home' })}
                  onActivity={() => go({ v: 'activity' })}
                />
              )}
              {snap && page.v === 'bot' && !bot && <p className="muted">That bot is not in this snapshot.</p>}
              {snap && page.v === 'holdings' && <HoldingsView rows={snap.holdings} />}
              {snap && page.v === 'activity' && (
                <>
                  <header className="act-head">
                    <h1>Activity</h1>
                    <button type="button" className="text-btn" onClick={() => go({ v: 'home' })}>Home</button>
                  </header>
                  <ActivityTape items={snap.activity} full />
                </>
              )}
              {page.v === 'more' && <MoreView />}
            </main>
            {snap && page.v !== 'activity' && (
              <aside className="side-tape glass">
                <header>
                  <h2>{page.v === 'bot' ? 'This bot' : 'Activity'}</h2>
                  <button type="button" className="text-btn" data-nav="activity" onClick={() => go({ v: 'activity' })}>
                    {page.v === 'bot' ? 'All activity' : 'Full feed'}
                  </button>
                </header>
                <ActivityTape
                  key={page.v === 'bot' && bot ? bot.metrics.botId : 'desk'}
                  items={page.v === 'bot' && bot ? snap.activity.filter((a) => a.botId === bot.metrics.botId) : snap.activity}
                />
              </aside>
            )}
          </div>
          <nav className="tabbar">
            <button type="button" className={page.v === 'home' || page.v === 'bot' ? 'on' : ''} onClick={() => go({ v: 'home' })}><Icon name="home" size={18} /> Home</button>
            <button type="button" data-nav="activity" className={page.v === 'activity' ? 'on' : ''} onClick={() => go({ v: 'activity' })}><Icon name="activity" size={18} /> Activity</button>
            <button type="button" data-nav="holdings" className={page.v === 'holdings' ? 'on' : ''} onClick={() => go({ v: 'holdings' })}><Icon name="wallet" size={18} /> Holdings</button>
            <button type="button" className={page.v === 'more' ? 'on' : ''} onClick={() => go({ v: 'more' })}><Icon name="more" size={18} /> More</button>
          </nav>
        </div>
      </LayoutGroup>
    </MotionConfig>
  );
}

function StatusPill({ source, asOf, stale }: { source: string; asOf: number; stale: boolean }) {
  const pill = deskStatusPill(source, asOf, stale);
  const cls = pill.tone === 'snap' ? 'is-snap' : pill.tone === 'stale' ? 'stale' : '';
  return <span className={`live-chip ${cls}`}><i className="live-dot" /> {pill.text}</span>;
}

function StreamError() {
  return (
    <div className="stream-error" role="alert">
      <p>The desk stream didn't connect. Nothing here is live.</p>
      <a href="/?classic=1">Open classic view</a>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="skel" aria-busy="true" aria-label="Loading">
      <div className="shimmer hero-skel" />
      <div className="shimmer card-skel" />
      <div className="shimmer card-skel" />
    </div>
  );
}
