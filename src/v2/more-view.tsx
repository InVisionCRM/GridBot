import type { View } from '../ui/model';
import { press } from './press';
import { WebPushSlot } from './web-push-slot';

const LINKS: { label: string; view: View }[] = [
  { label: 'Classic home', view: { v: 'home' } },
  { label: 'Bots desk', view: { v: 'bots' } },
  { label: 'Holdings', view: { v: 'holdings' } },
  { label: 'Smart trader', view: { v: 'auto' } },
  { label: 'Opportunities', view: { v: 'opps' } },
  { label: 'New grid', view: { v: 'new', kind: 'grid' } },
  { label: 'New LP', view: { v: 'new', kind: 'lp' } },
  { label: 'New trend', view: { v: 'new', kind: 'trend' } },
  { label: 'Analytics', view: { v: 'tools', tab: 'analytics' } },
  { label: 'Alerts', view: { v: 'alerts' } },
  { label: 'Chart', view: { v: 'tools', tab: 'chart' } },
  { label: 'Backtest', view: { v: 'tools', tab: 'backtest' } },
  { label: 'Markets', view: { v: 'tools', tab: 'markets' } },
  { label: 'System', view: { v: 'tools', tab: 'system' } },
  { label: 'Convert', view: { v: 'tools', tab: 'convert' } },
  { label: 'Friends', view: { v: 'tools', tab: 'friends' } },
  { label: 'More', view: { v: 'more' } },
];

function openClassic(view: View) {
  press();
  try { localStorage.setItem('view', JSON.stringify(view)); } catch { /* storage unavailable */ }
  location.href = '/?classic=1';
}

export function MoreView() {
  return (
    <div className="more">
      <h1>More</h1>
      <p className="muted">The classic desk stays reachable. v2 only changes what is on screen.</p>
      <WebPushSlot />
      <ul className="more-links">
        {LINKS.map((link) => (
          <li key={link.label}>
            <button type="button" onClick={() => openClassic(link.view)}>{link.label}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
