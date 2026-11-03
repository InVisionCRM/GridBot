/**
 * Swap: one coin you hold into any coin, on one chain (server: Converter.swap, sent by the same runner as Convert).
 * Pick or paste the coin to get. A coin the app has no market for is safety-checked before it is quoted; one that
 * fails the check is refused. Nothing is sent until you confirm. Kyle, 2026-11-03: "add a swap in interface inside the
 * app ... I could have just bought a couple cashcat".
 */
import { useEffect, useMemo, useState } from 'react';
import { http } from './api';
import { L } from './Tip';
import { explorerTx } from './chains';
import type { AnyObj } from './model';
import { amt, STATUS, type Coin, type Job, type Plan } from './Convert';

const OTHER = 'other';
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** A coin picker: the chain's own coin and the app's market coins, or a pasted token address. */
function CoinPick({ label, coins, value, other, onPick, onOther, disabled }: {
  label: string; coins: Coin[]; value: string; other: string; disabled: boolean;
  onPick: (v: string) => void; onOther: (v: string) => void;
}) {
  return (
    <label>{label}
      <select value={value} disabled={disabled} onChange={(e) => onPick(e.target.value)}>
        {coins.map((c) => <option key={c.id} value={c.id}>{c.symbol}</option>)}
        <option value={OTHER}>Paste an address…</option>
      </select>
      {value === OTHER && <input className="mono" value={other} placeholder="0x… token address" spellCheck={false} disabled={disabled} aria-label={`${label} token address`} onChange={(e) => onOther(e.target.value.trim())} />}
    </label>
  );
}

export function Swap({ s }: { s: AnyObj }) {
  const chains: AnyObj[] = useMemo(() => (s.chains ?? []).filter((c: AnyObj) => c.tradable && c.status === 'live'), [s.chains]);
  const [chainId, setChainId] = useState<number>(chains[0]?.id ?? 369);
  const chain = chains.find((c) => c.id === chainId);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [from, setFrom] = useState('native'), [fromOther, setFromOther] = useState('');
  const [to, setTo] = useState(''), [toOther, setToOther] = useState('');
  const [amount, setAmount] = useState('');
  const [impact, setImpact] = useState('3');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<'' | 'quote' | 'max'>('');
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    setPlan(null); setErr(null);
    http<{ targets: Coin[] }>(`/api/convert/targets?chainId=${chainId}`).then((r) => {
      setCoins(r.targets);
      setFrom('native');
      setTo(r.targets[1]?.id ?? '');
    }).catch((e) => setErr((e as Error).message));
  }, [chainId]);
  // the swap being sent, until it finishes
  useEffect(() => {
    if (!job || job.finishedAt) return;
    const t = setTimeout(() => { http<{ job: Job | null }>('/api/convert/job').then((r) => setJob(r.job)).catch(() => undefined); }, 2000);
    return () => clearTimeout(t);
  }, [job]);

  const fromId = from === OTHER ? fromOther : from, toId = to === OTHER ? toOther : to;
  const ready = !!chain?.hasSigner && (from !== OTHER || ADDR.test(fromOther)) && (to !== OTHER || ADDR.test(toOther)) && !!toId;
  const running = !!job && !job.finishedAt;
  const unknown = (id: string) => id !== 'native' && !coins.some((c) => c.id === id.toLowerCase());
  const reset = () => { setPlan(null); setErr(null); };

  const quote = async (max = false) => {
    setBusy(max ? 'max' : 'quote'); setErr(null); setPlan(null);
    try {
      const p = await http<Plan>('/api/convert/swap', 'POST', { chainId, from: fromId, to: toId, amount: max ? 'max' : Number(amount), maxImpact: Number(impact) / 100 });
      setPlan(p);
      if (max) setAmount(String(p.rows[0].amount));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const row = plan?.rows[0] ?? null;
  const go = async () => {
    if (!plan || !row?.ok || !chain) return;
    if (!confirm(`Swap ${amt(row.amount)} ${row.coin.symbol} for about ${amt(row.out)} ${plan.target.symbol} on ${chain.name}?\n\nThis sends real transactions from ${plan.owner}.`)) return;
    try {
      const r = await http<{ job: Job }>('/api/convert/run', 'POST', { planId: plan.id, coins: [{ id: row.coin.id, amount: row.amount }] });
      setJob(r.job); setPlan(null);
    } catch (e) { setErr((e as Error).message); }
  };
  const jr = job?.rows[0];

  return (
    <div className="card convert swap">
      <h3>Swap</h3>
      <p className="muted small">Swap a coin you hold for any coin on the same chain: pick one, or paste a token's address. A coin the app doesn't know is safety-checked first (honeypot, taxes, a sell that goes through); one that fails isn't swapped. Coins your live bots use, and some of the chain's own coin for gas, stay put. Nothing is sent until you confirm.</p>
      <div className="form-row">
        <label>Chain<select value={chainId} disabled={running || !!busy} onChange={(e) => setChainId(Number(e.target.value))}>{chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <CoinPick label="From" coins={coins} value={from} other={fromOther} disabled={running || !!busy} onPick={(v) => { setFrom(v); reset(); }} onOther={(v) => { setFromOther(v); reset(); }} />
        <label><L tip="How much of the From coin to swap. Max: all you can (your balance, less what live bots use and, for the chain's own coin, what's kept for gas).">Amount</L>
          <span className="pair-pick">
            <input value={amount} inputMode="decimal" placeholder="0" disabled={running || !!busy} aria-label="Amount to swap" onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setPlan(null); }} />
            <button type="button" className="btn small-btn" disabled={!ready || running || !!busy} onClick={() => void quote(true)}>{busy === 'max' ? '…' : 'Max'}</button>
          </span>
        </label>
        <CoinPick label="To" coins={coins} value={to} other={toOther} disabled={running || !!busy} onPick={(v) => { setTo(v); reset(); }} onOther={(v) => { setToOther(v); reset(); }} />
        <label><L tip="A swap whose price impact is over this is refused: you'd lose too much to the move itself.">Max price impact %</L>
          <input value={impact} inputMode="decimal" disabled={running || !!busy} onChange={(e) => { setImpact(e.target.value.replace(/[^\d.]/g, '')); setPlan(null); }} /></label>
        <button type="button" className="btn primary" disabled={!ready || running || !!busy || !(Number(amount) > 0)} onClick={() => void quote()}>{busy === 'quote' ? 'Quoting…' : 'Get quote'}</button>
      </div>
      {chain && !chain.hasSigner && <p className="small neg">{s.copy ? 'No key added yet (add it under Account)' : 'This chain has no signing key set in .env'}, so there is nothing to swap from.</p>}
      {busy && (unknown(toId) || unknown(fromId)) && <p className="muted small">Safety-checking the coin the app doesn't know yet: its pools, then a simulated buy, transfer and sell. On a busy chain this takes up to 20 s.</p>}
      {err && <div className="banner error"><span className="grow">{err}</span></div>}

      {plan && row && (
        <div className="swap-quote">
          {row.ok ? (
            <>
              <div className="swap-figs">
                <div><span className="k">You pay</span><b>{amt(row.amount)} {row.coin.symbol}</b></div>
                <div><span className="k"><L tip="From a live quote now, after pool fees and price impact. The real amount can differ by the slippage allowance; it is quoted again just before sending.">You get ≈</L></span><b className="pos">{amt(row.out)} {plan.target.symbol}</b></div>
                <div><span className="k">Price impact</span><b>{row.impact != null ? `${(row.impact * 100).toFixed(2)}%` : '—'}</b></div>
                <div><span className="k">Gas ≈</span><b>{amt(row.gasNative)} {chain?.nativeSymbol}</b></div>
              </div>
              <p className="muted small">Route: {row.steps.join(' → ')}. You hold {amt(plan.targetBalance)} {plan.target.symbol} now.</p>
              <button type="button" className="btn primary" disabled={running} onClick={() => void go()}>Swap {row.coin.symbol} for {plan.target.symbol}</button>
            </>
          ) : <p className="neg small">{row.why}</p>}
        </div>
      )}

      {job && jr && (
        <div className="convert-job">
          <h3>{running ? `Swapping ${jr.coin.symbol} for ${job.target.symbol}…` : `Last swap: ${jr.coin.symbol} → ${job.target.symbol}`}</h3>
          {jr.steps.map((st, i) => (
            <div key={i} className="small">{st.label}{st.hash ? <> · <a href={explorerTx(s, job.chainId, st.hash)} target="_blank" rel="noreferrer">{st.hash.slice(0, 10)}…</a></> : null}{st.out != null ? <span className="muted"> · got {amt(st.out)}</span> : null}</div>
          ))}
          <p className={`small ${jr.status === 'done' ? 'pos' : jr.status === 'failed' ? 'neg' : ''}`}>
            {STATUS[jr.status]}{jr.out != null ? `: ${amt(jr.amount)} ${jr.coin.symbol} → ${amt(jr.out)} ${job.target.symbol}` : ''}{jr.error ? ` · ${jr.error}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
