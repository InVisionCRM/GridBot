import { LayoutGroup, MotionConfig } from 'motion/react';
import { useState } from 'react';
import { Icon } from '../ui/icons';
import { ActivityTape } from './activity-tape';
import { BotView } from './bot-view';
import { HomeView, Ticker } from './home-view';
import { MoreView } from './more-view';
import { press } from './press';
import { useDesk } from './use-desk';

type Page = { v: 'home' } | { v: 'bot'; id: string } | { v: 'activity' } | { v: 'more' };

export function DeskApp() {
  const { snap, stale } = useDesk();
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
            <span className="demo-pill">Demo data</span>
            <span className={`live-chip ${stale ? 'stale' : ''}`}><i className="live-dot" /> {stale ? 'Stale' : 'Live'}</span>
          </header>
          {stale && <p className="stale-banner" role="status">Connection dropped. Numbers are frozen until the stream returns.</p>}
          <div className="v2-body">
            <main>
              {!snap && <Skeleton />}
              {snap && page.v === 'home' && (
                <HomeView portfolio={snap.portfolio} bots={snap.bots} onOpen={(id) => go({ v: 'bot', id })} />
              )}
              {snap && page.v === 'bot' && bot && <BotView bot={bot} onBack={() => go({ v: 'home' })} />}
              {snap && page.v === 'bot' && !bot && <p className="muted">That bot is not in this snapshot.</p>}
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
                  <h2>Activity</h2>
                  <button type="button" className="text-btn" data-nav="activity" onClick={() => go({ v: 'activity' })}>Full feed</button>
                </header>
                <ActivityTape items={snap.activity} />
              </aside>
            )}
          </div>
          <nav className="tabbar">
            <button type="button" className={page.v === 'home' || page.v === 'bot' ? 'on' : ''} onClick={() => go({ v: 'home' })}><Icon name="home" size={18} /> Home</button>
            <button type="button" data-nav="activity" className={page.v === 'activity' ? 'on' : ''} onClick={() => go({ v: 'activity' })}><Icon name="activity" size={18} /> Activity</button>
            <button type="button" className={page.v === 'more' ? 'on' : ''} onClick={() => go({ v: 'more' })}><Icon name="more" size={18} /> More</button>
          </nav>
        </div>
      </LayoutGroup>
    </MotionConfig>
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
