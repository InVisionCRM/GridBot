/**
 * A bot's transaction in flight, step by step: each step ticks off as it confirms on-chain, with the link to the one
 * being confirmed. From the bot's own status only:
 *  - liquidity bot: `step` {action, stage, hash, sentAt}: the stages of that action, the current one running
 *  - grid and trend bot: `inFlight` {job.side, approvalTxHash, swapTxHash}: approve (when one was sent), swap, confirm
 * The card runs a moving border while it shows (styles.css .busy-ring), and so does a busy bot's row.
 */
import { useEffect, useState } from 'react';
import { explorerTx } from './chains';
import type { AnyObj } from './model';

export interface TxStep { label: string; state: 'done' | 'now' | 'wait' }
export interface TxView { title: string; steps: TxStep[]; hash: string | null; sentAt: number | null; note: string }

const LP_TITLE: Record<string, string> = { open: 'Opening the position', rerange: 'Moving the range', compound: 'Compounding the fees', send: 'Sending the fees', close: 'Closing the position' };
const LP_STAGES: Record<string, string[]> = {
  open: ['swap', 'approve', 'mint'], rerange: ['exit', 'swap', 'approve', 'mint'], compound: ['collect', 'approve', 'increase'], send: ['collect'], close: ['exit', 'swap'],
};
const LP_LABEL: Record<string, string> = { exit: 'take out', swap: 'swap to the mix', approve: 'approve', mint: 'open', collect: 'collect fees', increase: 'add to the position' };
const LP_NOTE: Record<string, string> = {
  exit: 'taking the position out…', swap: "swapping to the range's mix…", approve: 'approving the position manager…', mint: 'opening the position…',
  collect: 'collecting the fees…', increase: 'adding the fees to the position…',
};

const steps = (all: string[], at: number, label: (k: string) => string): TxStep[] =>
  all.map((k, i) => ({ label: label(k), state: i < at ? 'done' : i === at ? 'now' : 'wait' }));

/** The transaction a bot has in flight, as steps; null when nothing is being sent. */
export function txOf(b: AnyObj): TxView | null {
  if (b.kind === 'lp') {
    const st = b.step as { action: string; stage: string; hash: string | null; sentAt: number | null } | null;
    if (!st) return null;
    // a close sells to cash only when it reaches its swap; until then it is the exit alone
    const all = st.action === 'close' && st.stage !== 'swap' ? ['exit'] : LP_STAGES[st.action] ?? [st.stage];
    const at = Math.max(0, all.indexOf(st.stage));
    const label = (k: string) => (st.action === 'close' && k === 'swap' ? 'sell to cash' : LP_LABEL[k] ?? k);
    return { title: LP_TITLE[st.action] ?? st.action, steps: steps(all, at, label), hash: st.hash, sentAt: st.sentAt, note: st.hash ? 'sent, waiting for it to confirm…' : LP_NOTE[st.stage] ?? '…' };
  }
  const f = b.inFlight as { job?: { side?: string }; approvalTxHash?: string; swapTxHash?: string } | null | undefined;
  if (!f) return null;
  // an approval shows only when one was sent; the swap is sent, then confirmed
  const all = f.approvalTxHash ? ['approve', 'swap', 'confirm'] : ['swap', 'confirm'];
  const at = f.swapTxHash ? all.length - 1 : all.indexOf('swap');
  const base = b.base ?? 'coins';
  return {
    title: `${f.job?.side === 'sell' ? 'Selling' : 'Buying'} ${base}`, steps: steps(all, at, (k) => k), hash: f.swapTxHash ?? f.approvalTxHash ?? null, sentAt: null,
    note: f.swapTxHash ? 'swap sent, waiting for it to confirm…' : 'sending the swap…',
  };
}

/** The in-flight card for a bot's page; nothing when it has nothing in flight. */
export function TxProgress({ b, s }: { b: AnyObj; s: AnyObj }) {
  const tx = txOf(b);
  const [, tick] = useState(0);
  useEffect(() => { if (!tx?.sentAt) return; const i = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(i); }, [tx?.sentAt]);
  if (!tx) return null;
  const secs = tx.sentAt ? Math.max(0, Math.round((Date.now() - tx.sentAt) / 1000)) : null;
  return (
    <div className="busy-ring" data-testid="tx-progress">
      <div className="tx-card" role="status">
        <div className="tx-head">
          <b>{tx.title}</b>
          {tx.hash && <a className="mono small" href={explorerTx(s, b.chainId, tx.hash)} target="_blank" rel="noreferrer">{tx.hash.slice(0, 8)}…{tx.hash.slice(-4)}</a>}
        </div>
        <div className="tx-steps">
          {tx.steps.map((st, i) => (
            <span key={st.label} className="tx-step-wrap">
              {i > 0 && <span className={`tx-bar ${st.state !== 'wait' ? 'done' : ''}`} />}
              <span className={`tx-step ${st.state}`}><span className="tx-dot">{st.state === 'done' ? '✓' : ''}</span>{st.label}</span>
            </span>
          ))}
        </div>
        <div className="tx-foot"><span className="muted">{tx.note}</span>{secs != null && <span className="muted mono">{secs}s</span>}</div>
      </div>
    </div>
  );
}
