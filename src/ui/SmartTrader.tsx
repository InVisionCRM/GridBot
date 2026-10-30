/**
 * Smart trader: give it a budget per chain and turn it on (server: bot/autopilot.ts). It picks from every pool the
 * daily check found, runs them as grid and liquidity bots, keeps each at least a week, and replaces one only when a
 * better pool pays for the switch. This page sets it up, shows what it holds and why it did what it did.
 */
import { useCallback, useEffect, useState } from 'react';
import { http } from './api';
import { ago, num, pct } from './fmt';
import { ChainBadge, chainOf } from './chains';
import { errMsg, botView, type AnyObj, type Nav } from './model';
import { L } from './Tip';
import { useOpportunities } from './Opportunities';
import { TraderSwitch } from './TokenTraderPage';
import { haltText } from './haltText';

type Risk = 'safe' | 'medium' | 'any';
interface Opts { grid: boolean; lp: boolean; newTokens: boolean; risk: Risk; slots: number; stopLossPct: number }
interface BudgetRow { chainId: number; coin: string; amount: string }

const RISK: [Risk, string, string][] = [
  ['safe', 'Safe', 'Only tokens that passed the safety check with low risk.'],
  ['medium', 'Up to medium', 'Also tokens with some risk, such as a tax or an upgradeable contract.'],
  ['any', 'Any that can trade live', 'Everything the safety check lets trade live, sorted only by what it is expected to earn.'],
];
const big = (x: number) => (Math.abs(x) >= 1000 ? num(x, 0) : num(x, Math.abs(x) >= 1 ? 2 : 6));

function useAuto() {
  const [a, setA] = useState<AnyObj | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => http('/api/autopilot').then((x) => { setA(x); setErr(null); }).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  return { a, setA, err, load };
}

export function SmartTrader({ s, nav }: { s: AnyObj; nav: Nav }) {
  const { a, setA, err, load } = useAuto();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<AnyObj | void>) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); if (r) setA(r); else await load(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  if (err) return <main className="stack smart"><TraderSwitch at="auto" nav={nav} /><div className="banner error"><span className="grow">{err}</span></div></main>;
  if (!a) return <main className="stack smart"><TraderSwitch at="auto" nav={nav} /><p className="muted">Loading…</p></main>;
  // An account with bots, swaps or coins other than its budget's still to settle stays on the page (and keeps new budgets out)
  const holding = a.accounts.some((x: AnyObj) => x.holds);
  const showAccounts = a.on || holding || a.accounts.some((x: AnyObj) => x.halted || x.killed);

  return (
    <main className="stack smart">
      <TraderSwitch at="auto" nav={nav} />
      <section className="card smart-head">
        <div className="card-head">
          <h2>Smart trader</h2>
          <span className={`tag ${a.on ? (a.mode === 'live' ? 'live' : 'pos') : ''}`}>{a.on ? `On · ${a.mode}` : 'Off'}</span>
          <span className="muted small">{a.reviewedAt ? `last review ${ago(a.reviewedAt)}` : ''}</span>
          <span className="grow" />
          {a.on && <button type="button" className="btn small-btn" disabled={busy} onClick={() => void run(() => http('/api/autopilot/review', 'POST'))}>Review now</button>}
        </div>
        <p className="small">
          Give it an amount on a chain and it runs it for you: it picks from <b>every pool</b> the daily check found there, as grids or liquidity ranges,
          {' '}best expected first. A pool that trades against another coin gets that coin by a swap, and back when it closes; those swaps' fees count against the pool.
          {' '}Each bot is kept at least a week, and replaced only when a better pool earns more than switching costs.
        </p>
        {msg && <div className="banner error" role="alert"><span className="grow">{msg}</span></div>}
        {a.lastError && <div className="banner"><span className="grow">Last check: {a.lastError}</span></div>}
      </section>

      {showAccounts && a.accounts.map((x: AnyObj) => <AccountCard key={x.chainId} s={s} x={x} nav={nav} busy={busy} run={run} />)}
      {(a.on || holding) && <OnControls a={a} busy={busy} run={run} />}
      {!a.on && !holding && <Setup s={s} a={a} busy={busy} run={run} />}
      <Decisions log={a.log} s={s} />
    </main>
  );
}

function Setup({ s, a, busy, run }: { s: AnyObj; a: AnyObj; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<void> }) {
  const { p } = useOpportunities();
  const chains: AnyObj[] = (s.chains ?? []).filter((c: AnyObj) => c.tradable);
  const [mode, setMode] = useState<'paper' | 'live'>(a.mode);
  const [opts, setOpts] = useState<Opts>(a.options);
  const [rows, setRows] = useState<BudgetRow[]>(a.budgets.length ? a.budgets.map((b: AnyObj) => ({ chainId: b.chainId, coin: b.coin, amount: String(b.amount) })) : []);
  /** The coins a chain's pools trade against (from the daily check), the chain's own coin first */
  const coins = (chainId: number) => {
    const c = chainOf(s, chainId);
    const seen = ((p?.chains ?? []) as AnyObj[]).find((x) => x.chainId === chainId)?.items.map((o: AnyObj) => o.spend) ?? [];
    return [...new Set([c?.nativeSymbol, ...seen].filter(Boolean))] as string[];
  };
  const pools = (chainId: number) => ((p?.chains ?? []) as AnyObj[]).find((x) => x.chainId === chainId)?.items.length ?? 0;
  const free = chains.filter((c) => !rows.some((r) => r.chainId === c.id));
  const liveBlocked = rows.some((r) => !chainOf(s, r.chainId)?.hasSigner);
  const set = (i: number, r: Partial<BudgetRow>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...r } : x)));
  // Asked before anything is saved: cancelling leaves the settings as they were
  const start = () => {
    if (mode === 'live' && !confirm(`Turn the smart trader on with real money? It opens, closes and swaps on its own, up to the budgets you set (${rows.map((r) => `${r.amount} ${r.coin}`).join(', ')}).`)) return;
    return run(async () => {
      await http('/api/autopilot', 'PUT', { mode, options: opts, budgets: rows.map((r) => ({ chainId: r.chainId, coin: r.coin, amount: Number(r.amount) })) });
      return http('/api/autopilot/on', 'POST');
    });
  };

  return (
    <section className="card">
      <h3>Set it up</h3>
      <div className="smart-field">
        <span className="k">Money</span>
        <div className="seg" role="radiogroup" aria-label="Paper or live">
          <button type="button" role="radio" aria-checked={mode === 'paper'} className={mode === 'paper' ? 'on' : ''} onClick={() => setMode('paper')}>Paper (practice)</button>
          <button type="button" role="radio" aria-checked={mode === 'live'} className={mode === 'live' ? 'on live' : ''} onClick={() => setMode('live')}>Live</button>
        </div>
        {mode === 'live' && liveBlocked && <span className="small neg">A chain below has no key: live needs one.</span>}
      </div>

      <div className="smart-field">
        <span className="k"><L tip="One budget per chain. It can use every pool there: a pool that trades against another coin is reached with a swap.">Budgets</L></span>
        {rows.map((r, i) => (
          <div key={r.chainId} className="budget-row">
            <ChainBadge c={chainOf(s, r.chainId)} testnet={false} />
            <b>{chainOf(s, r.chainId)?.name}</b>
            <input value={r.amount} inputMode="decimal" aria-label="Amount" placeholder="Amount" onChange={(e) => set(i, { amount: e.target.value.replace(/[^\d.]/g, '') })} />
            <select value={r.coin} aria-label="Coin" onChange={(e) => set(i, { coin: e.target.value })}>
              {[...new Set([...coins(r.chainId), r.coin].filter(Boolean))].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="small muted">{pools(r.chainId)} pools to pick from</span>
            <button type="button" className="btn ghost small-btn" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {free.length > 0 && (
          <div className="actions">
            {free.map((c) => (
              <button key={c.id} type="button" className="btn small-btn" onClick={() => setRows([...rows, { chainId: c.id, coin: coins(c.id).find((x) => x !== c.nativeSymbol) ?? c.nativeSymbol, amount: '' }])}>+ {c.name}</button>
            ))}
          </div>
        )}
      </div>

      <OptionsForm opts={opts} setOpts={setOpts} />
      <button type="button" className="btn primary smart-go" disabled={busy || !rows.length || rows.some((r) => !(Number(r.amount) > 0) || !r.coin) || (mode === 'live' && liveBlocked)} onClick={() => void start()}>
        Turn on {mode === 'live' ? '(live)' : '(paper)'}
      </button>
    </section>
  );
}

function OptionsForm({ opts, setOpts }: { opts: Opts; setOpts: (o: Opts) => void }) {
  const tog = (k: 'grid' | 'lp' | 'newTokens', label: string, tip: string) => (
    <label className="check-pill" title={tip}><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} /> {label}</label>
  );
  return (
    <>
      <div className="smart-field">
        <span className="k">It may use</span>
        <div className="actions">
          {tog('grid', 'Grids', 'Buys low and sells high between levels; works on any pool.')}
          {tog('lp', 'Liquidity', 'Earns a share of a V3 pool\'s trading fees.')}
          {tog('newTokens', 'New tokens', 'Coins from the daily check that aren\'t in the app yet (safety-checked when added).')}
        </div>
      </div>
      <div className="smart-field">
        <span className="k">Risk</span>
        <div className="seg" role="radiogroup" aria-label="Risk">
          {RISK.map(([v, t, tip]) => <button key={v} type="button" role="radio" title={tip} aria-checked={opts.risk === v} className={opts.risk === v ? 'on' : ''} onClick={() => setOpts({ ...opts, risk: v })}>{t}</button>)}
        </div>
      </div>
      <div className="smart-field">
        <span className="k"><L tip="Up to this many bots per budget, the money split evenly. More bots spread the risk; fewer put more into the best pools.">Bots per budget</L></span>
        <div className="seg" role="radiogroup" aria-label="Bots per budget">
          {[1, 2, 3, 4, 5, 6].map((n) => <button key={n} type="button" role="radio" aria-checked={opts.slots === n} className={opts.slots === n ? 'on' : ''} onClick={() => setOpts({ ...opts, slots: n })}>{n}</button>)}
        </div>
      </div>
      <div className="smart-field">
        <span className="k"><L tip="When a budget is worth this much less than it started with, every bot of it is closed back to its coin and it stops.">Loss limit</L></span>
        <div className="inline"><input className="smart-pct" value={String(Math.round(opts.stopLossPct * 100))} inputMode="numeric" onChange={(e) => setOpts({ ...opts, stopLossPct: Number(e.target.value.replace(/\D/g, '')) / 100 })} />% down</div>
      </div>
    </>
  );
}

/** A bot's state as the trader sees it: running, or why it is waiting */
function botState(b: AnyObj): { tag: string; cls: string; tip: string } | null {
  if (b.cashedOut) return { tag: 'closed, coming back', cls: 'risk-mid', tip: 'Closed: what it held returns to the budget on the next check, and coins other than the budget\'s are swapped back.' };
  if (b.retiring && b.status !== 'running' && b.status !== 'closed') return { tag: `closing paused: ${b.retiring.why}`, cls: 'risk-high', tip: 'It was stopped (by hand, KILL ALL or a safety pause) before its close finished. Resume it on its page to finish.' };
  if (b.retiring) return { tag: `closing: ${b.retiring.why}`, cls: 'risk-mid', tip: 'Being closed; its money comes back to the budget.' };
  if (b.status !== 'running') return { tag: b.status ?? 'missing', cls: 'risk-high', tip: 'Not running: it keeps its slot, and the smart trader leaves it alone until you resume it on its page.' };
  return null;
}

function AccountCard({ s, x, nav, busy, run }: { s: AnyObj; x: AnyObj; nav: Nav; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<void> }) {
  const base = x.amount - x.withdrawn;
  const v: number | null = x.value, r = v == null || !(base > 0) ? null : v / base - 1;
  const others = Object.entries(x.coins as Record<string, number>).filter(([c, n]) => c !== x.coin && n > 0);
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="inline"><ChainBadge c={chainOf(s, x.chainId)} testnet={false} />{x.chain} · {big(x.amount)} {x.coin}</h3>
        <span className="grow" />
        <span className="smart-value">
          <b className={r == null ? '' : r >= 0 ? 'pos' : 'neg'}>{v == null ? 'measuring…' : `${big(v)} ${x.coin}`}</b>
          {r != null && <span className="small muted">{pct(r, 2, true)} since {ago(x.startedAt)}</span>}
        </span>
      </div>
      {x.halted && <div className="banner error"><span className="grow">Stopped by the loss limit: {x.halted}.</span></div>}
      {x.killed && (
        <div className="banner error" role="status">
          <span className="grow">Stopped by {x.killed}{x.killHalt ? ` (${haltText(x.killHalt)})` : ''}: nothing is sent for this budget (no swap, close or new bot). Its bots stay stopped until you resume them on their pages.</span>
          <button type="button" className="btn small-btn" disabled={busy} onClick={() => void run(() => http('/api/autopilot/carry-on', 'POST', { chainId: x.chainId }))}>Carry on</button>
        </div>
      )}
      <p className="small muted">
        Not in a bot: {big(x.coins[x.coin] ?? 0)} {x.coin}{others.map(([c, n]) => ` + ${big(n)} ${c}`).join('')}{x.pending ? ` · ${x.pending} swap${x.pending === 1 ? '' : 's'} confirming` : ''}
        {x.gasNative > 0 ? ` · its swaps' gas ${big(x.gasNative)} ${x.nativeSym}` : ''}
        {x.withdrawn > 0 ? ` · ${big(x.withdrawn)} ${x.coin} taken out by hand (removed bots)` : ''}
      </p>
      {!x.bots.length && <p className="small muted">No bots yet.</p>}
      <div className="smart-bots">
        {x.bots.map((b: AnyObj) => {
          const gain = b.valueBudget == null ? null : b.valueBudget / b.cost - 1, st = botState(b);
          return (
            <button key={b.id} type="button" className="smart-bot" onClick={() => nav(botView(b.kind, b.id))}>
              <span className="smart-bot-name"><b>{b.label}</b><span className={`tag ${b.kind === 'lp' ? 'way-lp' : 'way-grid'}`}>{b.kind === 'lp' ? 'Liquidity' : 'Grid'}</span>
                {st && <span className={`tag ${st.cls}`} title={st.tip}>{st.tag}</span>}</span>
              <span className="small muted">{big(b.capital)} {b.spend}{b.spend !== x.coin ? ` (${big(b.cost)} ${x.coin})` : ''} · expected {pct(b.expected, 1, true)} a week · {Date.now() < b.holdUntil ? `kept until ${new Date(b.holdUntil).toLocaleDateString()}` : 'reviewed daily'}</span>
              <span className="smart-bot-v">{b.valueBudget == null ? '—' : <><b className={gain! >= 0 ? 'pos' : 'neg'}>{pct(gain, 2, true)}</b><span className="small muted">{big(b.valueBudget)} {x.coin}</span></>}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OnControls({ a, busy, run }: { a: AnyObj; busy: boolean; run: (fn: () => Promise<AnyObj | void>) => Promise<void> }) {
  const [opts, setOpts] = useState<Opts>(a.options);
  const changed = JSON.stringify(opts) !== JSON.stringify(a.options);
  return (
    <section className="card">
      <h3>Settings</h3>
      <OptionsForm opts={opts} setOpts={setOpts} />
      <div className="actions">
        {changed && <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => http('/api/autopilot/options', 'PUT', opts))}>Save settings</button>}
        <span className="grow" />
        {a.on ? <>
          <button type="button" className="btn" disabled={busy} title="It stops deciding; its bots keep running as they are."
            onClick={() => void run(() => http('/api/autopilot/off', 'POST', { sell: false }))}>Turn off, keep its bots</button>
          <button type="button" className="btn danger" disabled={busy}
            onClick={() => { if (confirm('Turn off and close every bot it runs back to its coin?')) void run(() => http('/api/autopilot/off', 'POST', { sell: true })); }}>Turn off, close its bots</button>
        </> : <>
          {a.closeAll && a.accounts.some((x: AnyObj) => x.bots.length || x.pending)
            ? <span className="small muted">Closing its bots back to their coins; it can be turned on again once they are back.</span>
            : <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => http('/api/autopilot/on', 'POST'))}>Turn on again</button>
              <button type="button" className="btn danger" disabled={busy}
                onClick={() => { if (confirm('Close every bot it ran back to its coin?')) void run(() => http('/api/autopilot/off', 'POST', { sell: true })); }}>Close its bots</button>
            </>}
        </>}
      </div>
    </section>
  );
}

function Decisions({ log, s }: { log: AnyObj[]; s: AnyObj }) {
  if (!log.length) return null;
  return (
    <section className="card">
      <h3>What it did, and why</h3>
      <ul className="smart-log">
        {log.map((e, i) => (
          <li key={i} className={e.level}>
            <span className="small muted mono">{new Date(e.t).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            {e.chainId != null && <ChainBadge c={chainOf(s, e.chainId)} testnet={false} />}
            <span>{e.msg}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
