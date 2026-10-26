/**
 * Tools → Friends (the host's own app only): the address friends open (Tailscale Funnel), invite and new-password
 * links, and each friend's copy (server: /api/friends, friends/host.ts). A copy runs on this computer with the
 * friend's own bots and key; it never sees the host's.
 */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago, dur } from './fmt';
import { Copy } from './System';
import type { AnyObj } from './model';

type On = { on: true; port: number; host: { name: string; address: string | null }; invites: AnyObj[]; friends: AnyObj[] };
type View = { on: false; off: string } | On;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const STATE: Record<string, [string, string]> = {
  running: ['Running', 'pos'], starting: ['Starting', ''], stopped: ['Stopped', ''], crashed: ['Restarting', 'live'],
};

export function Friends() {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => http<View>('/api/friends').then((x) => setV(x)).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!v) return <section className="card"><p className="muted">{err ?? 'Loading…'}</p></section>;
  return (
    <>
      <section className="card">
        <h2>Friends</h2>
        <p className="small muted">Friends get their own copy of GridBot on this computer and open it on their phone: their own bots, their own key and their own log-in. A copy never sees your key, and shares your app's market data and daily scan.</p>
        {err && <div className="banner error" role="alert"><span className="grow">{err}</span><button type="button" className="btn ghost small-btn" onClick={() => setErr(null)}>Dismiss</button></div>}
        {!v.on && <>
          <div className="banner info"><span className="grow">{v.off}</span></div>
          <ol className="steps small">
            <li>In the gridbot folder, run <code>npm run friends:setup</code> once. It adds a secret to .env that locks your friends' keys.</li>
            <li>Run <code>npm run build</code>, then <code>npm start</code>.</li>
          </ol>
        </>}
      </section>
      {v.on && <On v={v} busy={busy} run={run} />}
    </>
  );
}

function On({ v, busy, run }: { v: On; busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState(v.host.name);
  const [address, setAddress] = useState(v.host.address ?? '');
  const [friend, setFriend] = useState('');
  const [link, setLink] = useState<{ label: string; url: string } | null>(null);
  const ready = !!v.host.name && !!v.host.address;
  const saveHost = () => run(() => http('/api/friends/host', 'PUT', { name, address }));
  const invite = () => run(async () => {
    const r = await http<{ link: string }>('/api/friends/invites', 'POST', { name: friend });
    setLink({ label: `Invite for ${friend.trim()}`, url: r.link });
    setFriend('');
  });
  const act = (f: AnyObj, what: 'start' | 'stop' | 'restart' | 'reset' | 'remove') => {
    if (what === 'stop' && !window.confirm(`Stop ${f.name}'s copy? Their bots stop until you start it again. Coins stay where they are (in their account, or in a liquidity position).`)) return;
    if (what === 'remove' && !window.confirm(`Remove ${f.name}? Their copy, bots, history and saved key are deleted from this computer. Their coins stay in their own account.`)) return;
    void run(async () => {
      if (what === 'remove') return http(`/api/friends/${f.id}`, 'DELETE');
      const r = await http<{ link?: string }>(`/api/friends/${f.id}/${what}`, 'POST');
      if (r.link) setLink({ label: `New password link for ${f.name}`, url: r.link });
    });
  };

  return (
    <>
      <section className="card">
        <h3>1 · Where friends open it</h3>
        <p className="small muted">
          Friends reach this computer through Tailscale Funnel (free). Install Tailscale here and log in, then run <code>tailscale funnel --bg {v.port}</code> once.
          It prints an address starting with https://; paste it below. <a href="https://tailscale.com/kb/1223/funnel" target="_blank" rel="noreferrer">Funnel guide</a>
        </p>
        <div className="form-row">
          <label>Your name<input value={name} placeholder="Kyle" onChange={(e) => setName(e.target.value)} /></label>
          <label className="grow2">Address<input className="mono" value={address} placeholder="https://your-computer.your-tailnet.ts.net" spellCheck={false} onChange={(e) => setAddress(e.target.value)} /></label>
          <button type="button" className="btn" disabled={busy || !name.trim() || !address.trim()} onClick={() => void saveHost()}>Save</button>
        </div>
        <p className="small muted">Friends see your name on their log-in page.</p>
      </section>

      <section className="card">
        <h3>2 · Invite a friend</h3>
        <div className="form-row narrow">
          <label>Their name<input value={friend} placeholder="Alex" onChange={(e) => setFriend(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && friend.trim() && ready) void invite(); }} /></label>
          <button type="button" className="btn primary" disabled={busy || !friend.trim() || !ready} onClick={() => void invite()}>Make invite link</button>
        </div>
        {!ready && <p className="small warn-t">Save your name and address first.</p>}
        {link && (
          <div className="link-box">
            <span className="small muted">{link.label}</span>
            <div className="actions"><code className="mono grow link-url">{link.url}</code><Copy text={link.url} /></div>
            <p className="small muted">Text it to them. It works once, for 7 days. On their phone they choose a password and, if they want to trade live, paste their key.</p>
          </div>
        )}
        {v.invites.length > 0 && (
          <div className="friend-list">
            {v.invites.map((i) => (
              <div key={i.id} className="friend-row">
                <div className="actions"><b>{i.name}</b><span className="tag">{i.reset ? 'new password link' : 'invited'}</span><span className="grow" />
                  <button type="button" className="btn ghost small-btn" disabled={busy} onClick={() => void run(() => http(`/api/friends/invites/${i.id}`, 'DELETE'))}>Cancel link</button></div>
                <span className="small muted">Unused · works for {dur(i.expiresAt - Date.now())} more</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h3>Friends ({v.friends.length})</h3>
        {v.friends.length === 0 && <p className="small muted">Nobody has signed up yet.</p>}
        <div className="friend-list">
          {v.friends.map((f) => {
            const [label, tone] = f.stopped ? STATE.stopped : STATE[f.copy.state];
            return (
              <div key={f.id} className="friend-row">
                <div className="actions"><b>{f.name}</b><span className={`tag ${tone}`}>{label}</span><span className="grow" />
                  {f.stopped
                    ? <button type="button" className="btn small-btn" disabled={busy} onClick={() => act(f, 'start')}>Start</button>
                    : <>
                      <button type="button" className="btn ghost small-btn" disabled={busy} onClick={() => act(f, 'restart')}>Restart</button>
                      <button type="button" className="btn ghost small-btn" disabled={busy} onClick={() => act(f, 'stop')}>Stop</button>
                    </>}
                  <button type="button" className="btn ghost small-btn" disabled={busy || !ready} onClick={() => act(f, 'reset')}>New password link</button>
                  <button type="button" className="btn ghost small-btn neg" disabled={busy} onClick={() => act(f, 'remove')}>Remove</button>
                </div>
                <span className="small muted">
                  {f.address ? <>Trades from <span className="mono" title={f.address}>{short(f.address)}</span></> : 'No key: paper only'}
                  {' · '}{f.lastLoginAt ? `last opened ${ago(f.lastLoginAt)}` : 'never opened'} · port {f.port}
                </span>
                {f.copy.state === 'crashed' && <span className="small neg">It stopped unexpectedly ({f.copy.lastExit}) and is starting again. Its log is data/friends/{f.id}/app.log.</span>}
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
