/**
 * Slot for Web Push alerts landing on another branch.
 * Browser permission only. No server key is read.
 */
import { useState } from 'react';

const KINDS = ['Fills', 'Fees', 'Range', 'Stops', 'Errors'] as const;

export function WebPushSlot() {
  const [on, setOn] = useState<Record<string, boolean>>({ Fills: true, Fees: true, Range: true, Stops: true, Errors: true });
  const [note, setNote] = useState('Off until this browser allows it.');
  const enable = async () => {
    if (typeof Notification === 'undefined') { setNote('This browser has no notifications.'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setNote(perm === 'granted' ? 'Permission granted. Delivery stays on the Web Push branch.' : 'Permission was not granted.');
  };
  return (
    <section className="slot" aria-label="Web Push">
      <header>
        <h3>Web Push</h3>
        <span className="demo-pill">Slot</span>
      </header>
      <p className="muted small">Kept reachable beside the existing in-app alerts. This does not register a push subscription.</p>
      <button type="button" className="v2-btn" onClick={() => void enable()}>Allow on this browser</button>
      <p className="small">{note}</p>
      <ul className="push-list">
        {KINDS.map((k) => (
          <li key={k}>
            <label><input type="checkbox" checked={!!on[k]} onChange={() => setOn((s) => ({ ...s, [k]: !s[k] }))} /> {k}</label>
          </li>
        ))}
      </ul>
    </section>
  );
}
