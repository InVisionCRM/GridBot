/**
 * Tools → Convert: what the wallet holds on one chain, into one coin (server: src/server/convert). Check first: every
 * coin with what would be converted and why anything is left alone; nothing is sent until you confirm.
 */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { L, Tip } from './Tip';
import { explorerTx } from './chains';
import type { AnyObj } from './model';

interface Coin { id: string; address: string | null; symbol: string; name: string; decimals: number; tracked: boolean }
interface PlanRow { coin: Coin; balance: number; bots: number; keep: number; amount: number; steps: string[]; out: number | null; impact: number | null; gasNative: number | null; ok: boolean; why: string | null }
interface Unreadable { address: string; symbol: string; name: string; why: string }
interface Plan { id: string; chainId: number; owner: string; at: number; target: Coin; targetBalance: number; keepNative: number; maxImpact: number; listedBy: 'explorer' | 'markets'; rows: PlanRow[]; unreadable: Unreadable[] }
interface JobRow { coin: Coin; amount: number; status: 'waiting' | 'running' | 'done' | 'failed' | 'stopped'; steps: { label: string; hash: string | null; out: number | null }[]; out: number | null; error: string | null }
interface Job { id: string; chainId: number; target: Coin; startedAt: number; finishedAt: number | null; stopping: boolean; rows: JobRow[] }

const amt = (x: number | null | undefined) => (x == null ? '—' : Math.abs(x) >= 1 ? x.toLocaleString(undefined, { maximumFractionDigits: 4 }) : x === 0 ? '0' : x.toPrecision(4));
const STATUS: Record<JobRow['status'], string> = { waiting: 'waiting', running: 'converting…', done: 'done', failed: 'failed', stopped: 'stopped' };

export function Convert({ s }: { s: AnyObj }) {
  const chains: AnyObj[] = useMemo(() => (s.chains ?? []).filter((c: AnyObj) => c.tradable && c.status === 'live'), [s.chains]);
  const [chainId, setChainId] = useState<number>(chains[0]?.id ?? 369);
  const chain = chains.find((c) => c.id === chainId);
  const [targets, setTargets] = useState<Coin[]>([]);
  const [target, setTarget] = useState('');
  const [keep, setKeep] = useState('');
  const [impact, setImpact] = useState('3');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    setPlan(null); setErr(null); setTarget('');
    http<{ targets: Coin[] }>(`/api/convert/targets?chainId=${chainId}`).then((r) => { setTargets(r.targets); setTarget(r.targets[1]?.id ?? r.targets[0]?.id ?? ''); }).catch((e) => setErr((e as Error).message));
  }, [chainId]);
  // the last conversion, and while one runs, its progress
  useEffect(() => {
    let alive = true, t: ReturnType<typeof setTimeout> | null = null;
    const load = () => http<{ job: Job | null }>('/api/convert/job').then((r) => {
      if (!alive) return;
      setJob(r.job);
      if (r.job && !r.job.finishedAt) t = setTimeout(load, 2000);
    }).catch(() => undefined);
    void load();
    return () => { alive = false; if (t) clearTimeout(t); };
  }, [job?.id, job?.finishedAt == null]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = !!job && !job.finishedAt;
  const check = async () => {
    setChecking(true); setErr(null); setPlan(null);
    try {
      const p = await http<Plan>('/api/convert/plan', 'POST', {
        chainId, target, ...(keep.trim() ? { keepNative: Number(keep) } : {}), maxImpact: Number(impact) / 100,
      });
      setPlan(p);
      setPick(new Set(p.rows.filter((r) => r.ok).map((r) => r.coin.id)));
      if (!keep.trim()) setKeep(String(p.keepNative));
    } catch (e) { setErr((e as Error).message); } finally { setChecking(false); }
  };
  const chosen = plan ? plan.rows.filter((r) => r.ok && pick.has(r.coin.id)) : [];
  const total = chosen.reduce((a, r) => a + (r.out ?? 0), 0), gas = chosen.reduce((a, r) => a + (r.gasNative ?? 0), 0);
  const run = async () => {
    if (!plan || !chain) return;
    const list = chosen.map((r) => `${amt(r.amount)} ${r.coin.symbol}`).join(', ');
    if (!confirm(`Convert ${list} into ${plan.target.symbol} on ${chain.name}?\n\nThis sends real transactions from ${plan.owner}, one coin at a time. You should get about ${amt(total)} ${plan.target.symbol}.`)) return;
    try {
      const r = await http<{ job: Job }>('/api/convert/run', 'POST', { planId: plan.id, coins: chosen.map((x) => x.coin.id) });
      setJob(r.job); setPlan(null);
    } catch (e) { setErr((e as Error).message); }
  };
  const toggle = (id: string) => setPick((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="card convert">
      <h3>Convert to one coin</h3>
      <p className="muted small">Swaps the coins this wallet holds on one chain into a single coin. Coins your live bots are using stay with them, and some of the chain's own coin stays for gas. You see every coin first; nothing is sent until you confirm.</p>
      <div className="form-row">
        <label>Chain<select value={chainId} disabled={running || checking} onChange={(e) => setChainId(Number(e.target.value))}>{chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Into<select value={target} disabled={running || checking} onChange={(e) => { setTarget(e.target.value); setPlan(null); }}>{targets.map((t) => <option key={t.id} value={t.id}>{t.symbol}</option>)}</select></label>
        <label><L tip={`How much ${chain?.nativeSymbol ?? 'native coin'} stays in the wallet to pay for transactions, the bots' included. Empty: twice the low-gas warning level.`}>Keep for gas</L>
          <input value={keep} inputMode="decimal" placeholder={chain ? String(2 * chain.lowGasNative) : ''} disabled={running || checking} onChange={(e) => { setKeep(e.target.value.replace(/[^\d.]/g, '')); setPlan(null); }} /></label>
        <label><L tip="A coin whose swap would move its pool's price more than this is left alone: you'd lose too much to the move itself.">Max price impact %</L>
          <input value={impact} inputMode="decimal" disabled={running || checking} onChange={(e) => { setImpact(e.target.value.replace(/[^\d.]/g, '')); setPlan(null); }} /></label>
        <button type="button" className="btn primary" disabled={running || checking || !target || !chain?.hasSigner} onClick={check}>{checking ? 'Checking…' : 'Check my coins'}</button>
      </div>
      {chain && !chain.hasSigner && <p className="small neg">{s.copy ? 'No key added yet (add it under Account)' : 'This chain has no signing key set in .env'}, so there is nothing to convert from.</p>}
      {checking && <p className="muted small">Reading balances and running the safety check on coins the app doesn't know yet. On PulseChain this takes up to a minute.</p>}
      {err && <div className="banner error"><span className="grow">{err}</span></div>}

      {plan && (
        <>
          <p className="small">
            Into <b>{plan.target.symbol}</b> (you have {amt(plan.targetBalance)}). {plan.listedBy === 'markets'
              ? <span className="muted">This chain's explorer doesn't answer servers, so only the coins of the app's markets are listed.</span>
              : <span className="muted">Every coin the explorer lists for this wallet, with balances read from the chain.</span>}
          </p>
          <div className="table-wrap tall"><table className="convert-table">
            <thead><tr>
              <th />
              <th>Coin <Tip>Under each coin: its swaps in order (a coin with no direct pool goes through the chain's own coin; wrapped {chain?.nativeSymbol} is unwrapped first), or why it's left alone.</Tip></th>
              <th className="narrow-hide">Have</th>
              <th className="narrow-hide">Bots use <Tip>Coins your live bots rely on (a grid's coins, a liquidity bot's spare coins). They stay put.</Tip></th>
              <th className="narrow-hide">Converting</th>
              <th>You get ≈ <Tip>From a live quote now, after pool fees and price impact. The real amount can differ by the slippage allowance.</Tip></th>
              <th className="narrow-hide">Impact</th>
            </tr></thead>
            <tbody>{plan.rows.map((r) => (
              <tr key={r.coin.id} className={r.ok ? 'pickable' : 'muted-row'} onClick={() => r.ok && toggle(r.coin.id)}>
                <td>{r.ok ? <input type="checkbox" checked={pick.has(r.coin.id)} onChange={() => toggle(r.coin.id)} onClick={(e) => e.stopPropagation()} aria-label={`Convert ${r.coin.symbol}`} /> : null}</td>
                <td className="txt">
                  <b>{r.coin.symbol}</b>{!r.coin.tracked && <span className="muted small" title={r.coin.address ?? ''}> · {r.coin.address?.slice(0, 8)}… found by the explorer</span>}
                  <div className="small">{r.ok ? <span className="muted">{r.steps.join(' → ')}</span> : <span className={r.why?.startsWith('Named like a website') || r.why?.startsWith('Failed the safety') ? 'neg' : 'muted'}>{r.why}</span>}</div>
                </td>
                <td className="narrow-hide">{amt(r.balance)}</td>
                <td className="narrow-hide">{r.bots ? amt(r.bots) : '—'}</td>
                <td className="narrow-hide">{r.ok ? amt(r.amount) : '—'}</td>
                <td>{r.ok ? amt(r.out) : '—'}</td>
                <td className="narrow-hide">{r.ok && r.impact != null ? `${(r.impact * 100).toFixed(2)}%` : '—'}</td>
              </tr>
            ))}{plan.unreadable.map((u) => (
              <tr key={u.address} className="muted-row">
                <td />
                <td className="txt">
                  <b>{u.symbol}</b><span className="muted small" title={u.address}> · {u.address.slice(0, 8)}… found by the explorer</span>
                  <div className="small"><span className={u.why.startsWith('Named like a website') ? 'neg' : 'muted'}>{u.why}</span></div>
                </td>
                <td className="narrow-hide">—</td><td className="narrow-hide">—</td><td className="narrow-hide">—</td><td>—</td><td className="narrow-hide">—</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="convert-go">
            <span className="small">{chosen.length ? <>≈ <b>{amt(total)} {plan.target.symbol}</b> from {chosen.length} coin{chosen.length === 1 ? '' : 's'}, about {amt(gas)} {chain?.nativeSymbol} of gas.</> : 'Nothing chosen.'}</span>
            <button type="button" className="btn primary" disabled={!chosen.length || running} onClick={run}>Convert {chosen.length} coin{chosen.length === 1 ? '' : 's'} to {plan.target.symbol}</button>
          </div>
        </>
      )}

      {job && (
        <div className="convert-job">
          <div className="card-head">
            <h3>{running ? `Converting to ${job.target.symbol}…` : `Last conversion to ${job.target.symbol}`}</h3>
            {running && <button type="button" className="btn small-btn" disabled={job.stopping} onClick={() => http('/api/convert/stop', 'POST').catch(() => undefined)}>{job.stopping ? 'Stopping after this coin…' : 'Stop'}</button>}
          </div>
          <div className="table-wrap"><table>
            <thead><tr><th>Coin</th><th>Amount</th><th>Steps</th><th>Got</th><th>Status</th></tr></thead>
            <tbody>{job.rows.map((r) => (
              <tr key={r.coin.id}>
                <td className="txt"><b>{r.coin.symbol}</b></td>
                <td>{amt(r.amount)}</td>
                <td className="txt small">{r.steps.map((st, i) => (
                  <div key={i}>{st.label}{st.hash ? <> · <a href={explorerTx(s, job.chainId, st.hash)} target="_blank" rel="noreferrer">{st.hash.slice(0, 10)}…</a></> : null}</div>
                ))}</td>
                <td>{r.out != null ? `${amt(r.out)} ${job.target.symbol}` : '—'}</td>
                <td className={`txt ${r.status === 'done' ? 'pos' : r.status === 'failed' ? 'neg' : ''}`}>{STATUS[r.status]}{r.error ? <div className="small muted">{r.error}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {!running && <p className="small">Got <b>{amt(job.rows.reduce((a, r) => a + (r.out ?? 0), 0))} {job.target.symbol}</b> from {job.rows.filter((r) => r.status === 'done').length} of {job.rows.length} coins.</p>}
        </div>
      )}
    </div>
  );
}
