/** System: is the running app the latest code, and is everything the bots need actually working right now? */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago, time } from './fmt';
import { errMsg, type AnyObj, type Nav } from './model';

const STATE_TONE: Record<string, 'pass' | 'warn' | 'fail'> = { current: 'pass', 'update-available': 'warn', 'not-built': 'fail', 'not-restarted': 'fail' };
const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : '—');

/** Version report, loaded once and every 10 min (the server caches GitHub for 2 min). */
export function useVersion() {
  const [v, setV] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback((refresh = false) => http(`/api/system/version${refresh ? '?refresh=1' : ''}`).then((x) => { setV(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 600_000); return () => clearInterval(t); }, [load]);
  return { v, err, reload: () => load(true) };
}

/** Top-bar pill: green when the running code is the latest, amber/red with the fix otherwise. */
export function VersionPill({ v, nav }: { v: AnyObj | null; nav: Nav }) {
  if (!v) return null;
  const tone = STATE_TONE[v.state];
  return (
    <button type="button" className={`vpill vp-${tone}`} title={`${v.detail}${v.steps.length ? ` Fix: ${v.steps.join(' → ')}` : ''}`} onClick={() => nav({ v: 'tools', tab: 'system' })}>
      <i />{v.title}
    </button>
  );
}

export function Copy({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return <button type="button" className="btn ghost small-btn" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); }}>{ok ? 'Copied' : 'Copy'}</button>;
}

function VersionCard({ v, err, reload }: { v: AnyObj | null; err: string | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const again = async () => { setBusy(true); await reload(); setBusy(false); };
  if (err) return <div className="card"><h3>Version</h3><p className="neg small">{err}</p></div>;
  if (!v) return <div className="card"><h3>Version</h3><p className="muted small spin">Checking…</p></div>;
  const tone = STATE_TONE[v.state];
  const cmds = v.steps.filter((x: string) => !x.startsWith('Restart'));
  return (
    <section className={`card vcard vc-${tone}`} aria-label="Version">
      <div className="card-head">
        <span className={`vbig vp-${tone}`}><i />{v.title}</span>
        <span className="grow" />
        <span className="muted small">checked {ago(v.checkedAt)}</span>
        <button type="button" className="btn small-btn" disabled={busy} onClick={again}>{busy ? 'Checking…' : 'Check again'}</button>
      </div>
      <p className="small">{v.detail}</p>
      <div className="vchain">
        {[
          ['GitHub main', v.remote, 'the latest released code'],
          ['Your copy', v.local, `branch ${v.branch}`],
          ['Built', v.built?.commit, v.built ? `built ${time(v.built.builtAt)}` : 'not built'],
          ['Running', v.running.commit, v.running.dev ? 'dev mode (runs your copy directly)' : `started from the build of ${time(v.running.builtAt)}`],
        ].map(([k, c, sub], i, all) => {
          const next = all[i + 1]?.[1] as string | undefined;
          const gap = i < all.length - 1 && next != null && c != null && c !== next && !(i >= 1 && v.running.dev);
          return (
            <div key={k as string} className={`vnode ${gap ? 'gap' : ''}`}>
              <span className="vk">{k}</span><b className="mono">{short(c as string | null)}</b><span className="muted small">{sub}</span>
            </div>
          );
        })}
      </div>
      {v.steps.length > 0 && (
        <div className="vsteps">
          <b>To fix, in your GridBot folder:</b>
          {cmds.length > 0 && <div className="cmd"><code>{cmds.join(' && ')}</code><Copy text={cmds.join(' && ')} /></div>}
          {v.steps.some((x: string) => x.startsWith('Restart')) && <p className="small">Then restart the server: press Ctrl+C in its window and run <code>npm start</code> (or <code>pm2 restart grid-bot</code>).</p>}
        </div>
      )}
      {v.notes.map((n: string) => <p key={n} className="small warn-t">{n}</p>)}
    </section>
  );
}

const ICON: Record<string, string> = { pass: '✓', warn: '!', fail: '✕' };

function SelfTest() {
  const [r, setR] = useState<AnyObj | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setR(await http('/api/system/check')); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void run(); }, [run]);
  const groups = r ? [...new Set<string>(r.checks.map((c: AnyObj) => c.group))] : [];
  return (
    <section className="card" aria-label="Self-test">
      <div className="card-head">
        <h3>Self-test</h3>
        {r && <span className="counts"><span className="ct pass">{r.counts.pass} ok</span><span className="ct warn">{r.counts.warn} to look at</span><span className="ct fail">{r.counts.fail} broken</span></span>}
        <span className="grow" />
        {r && <span className="muted small">ran {ago(r.at)}</span>}
        <button type="button" className="btn small-btn primary" disabled={busy} onClick={run}>{busy ? 'Testing…' : 'Run again'}</button>
      </div>
      <p className="small muted">Asks every chain's RPC, reads your wallet, reads each running bot's pool the way a trade would, and checks every bot is reading prices, has no stuck transaction and has no level that can't trade.</p>
      {err && <p className="neg small">{err}</p>}
      {busy && !r && <p className="muted small spin">Testing chains, wallet and bots…</p>}
      {r && groups.map((g) => (
        <div key={g} className="tgroup">
          <h4>{g}</h4>
          {r.checks.filter((c: AnyObj) => c.group === g).map((c: AnyObj, i: number) => (
            <div key={c.id} className={`trow t-${c.state}`} style={{ animationDelay: `${i * 45}ms` }}>
              <span className="ticon">{ICON[c.state]}</span>
              <div className="tbody">
                <b>{c.name}</b> <span className="small">{c.detail}</span>
                {c.fix && <div className="small tfix">Fix: {c.fix}</div>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

/** A friend's copy has no version card: the host keeps it up to date. */
export function SystemTab({ ver, copy }: { ver: ReturnType<typeof useVersion>; copy: boolean }) {
  return (
    <>
      {!copy && <VersionCard v={ver.v} err={ver.err} reload={ver.reload} />}
      <SelfTest />
    </>
  );
}
