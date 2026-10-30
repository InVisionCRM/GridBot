/**
 * The home's bottom drawer: one sheet for a bot's details, a profit moment, starting a bot, wallet & funds, and the
 * full list behind a column's "+N more". It slides up over the board; Escape, the scrim or Close put it away. A profit
 * moment closes on its own after a few seconds unless it was opened by a tap.
 */
import { useEffect, useState } from 'react';
import { useRowActions } from './botRow';
import { metricsOf } from './deskStats';
import { amountsText, type BankedItem, type OpenItem } from './deskModel';
import { ago, qty, usd } from './fmt';
import type { HoldingsSnapshot } from '../live/holdingsMath';
import type { AnyObj, BotKind, Nav, View } from './model';
import { NewBot } from './NewBot';
import { holdingsByToken } from './units';
import { useChainFilter } from './chains';

export type SheetOf =
  | { kind: 'bot'; botId: string }
  | { kind: 'moment'; item: BankedItem; pinned?: boolean }
  | { kind: 'new' }
  | { kind: 'wallet' }
  | { kind: 'list'; title: string; items: (OpenItem | BankedItem)[] };

const MOMENT_MS = 4500;

export function DeskSheet({ sheet, close, s, bots, trader, holdings, nav, act, busy }: {
  sheet: SheetOf; close: () => void; s: AnyObj; bots: AnyObj[]; trader: AnyObj | null; holdings: HoldingsSnapshot | null;
  nav: Nav; act: (fn: () => Promise<unknown>) => void; busy: boolean;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [close]);
  const auto = sheet.kind === 'moment' && !sheet.pinned;
  useEffect(() => { if (!auto) return; const t = setTimeout(close, MOMENT_MS); return () => clearTimeout(t); }, [auto, close]);
  const go = (v: View) => { close(); nav(v); };
  const tall = sheet.kind === 'new' || sheet.kind === 'list' || sheet.kind === 'wallet';
  return (
    <>
      {!auto && <div className={`dk-scrim ${shown ? 'on' : ''}`} onClick={close} />}
      <div className={`dk-sheet-wrap ${shown ? 'on' : ''}`} role="dialog" aria-modal={!auto} aria-label={sheetLabel(sheet)}>
        <div className={`dk-sheet ${tall ? 'tall' : ''}`}>
          <span className="dk-grab" aria-hidden="true" />
          {sheet.kind === 'bot' && <BotSheet botId={sheet.botId} bots={bots} trader={trader} go={go} close={close} />}
          {sheet.kind === 'moment' && <MomentSheet item={sheet.item} close={close} />}
          {sheet.kind === 'new' && <NewSheet s={s} go={go} act={act} busy={busy} />}
          {sheet.kind === 'wallet' && <WalletSheet holdings={holdings} go={go} />}
          {sheet.kind === 'list' && <ListSheet title={sheet.title} items={sheet.items} />}
          {sheet.kind !== 'moment' && <button type="button" className="dk-btn dk-close" onClick={close}>Close</button>}
        </div>
      </div>
    </>
  );
}
const sheetLabel = (s: SheetOf) => (s.kind === 'bot' ? 'Bot details' : s.kind === 'moment' ? 'Profit banked' : s.kind === 'new' ? 'New bot' : s.kind === 'wallet' ? 'Wallet and funds' : s.title);

const FACE = (
  <span className="dk-face" aria-hidden="true">
    <svg width="34" height="20" viewBox="0 0 34 20" fill="none" stroke="#0E0F11" strokeWidth="3" strokeLinecap="round"><path d="M3 14c3-8 7-8 10 0M21 14c3-8 7-8 10 0" /></svg>
  </span>
);

function MomentSheet({ item, close }: { item: BankedItem; close: () => void }) {
  const up = item.amounts.every((a) => a.amt >= 0);
  return (
    <>
      {FACE}
      <span className={`dk-eyebrow ${up ? 'pos' : 'neg'}`}>{item.title} · {up ? 'profit banked' : 'closed at a loss'}</span>
      <span className={`dk-huge ${up ? 'pos' : 'neg'}`}>{amountsText(item.amounts, 5)}</span>
      <span className="dk-chips">{item.usd != null && <span>{usd(item.usd, true)}</span>}<span>{item.sub}</span><span>{ago(item.t)}</span></span>
      <button type="button" className="dk-btn primary wide" onClick={close}>Nice</button>
    </>
  );
}

function BotSheet({ botId, bots, trader, go, close }: { botId: string; bots: AnyObj[]; trader: AnyObj | null; go: (v: View) => void; close: () => void }) {
  const { pause, err } = useRowActions();
  const b = botId === 'token-trader' ? (trader ? { ...trader, kind: 'token', metrics: trader.metrics } : null) : bots.find((x) => x.id === botId);
  if (!b) return <p className="muted">This bot isn't in the latest status any more.</p>;
  const m = metricsOf(b);
  const gen = Object.entries(m?.generated ?? {}).filter(([, v]) => v !== 0);
  const name = b.kind === 'token' ? 'Token trader' : `${b.base}/${b.quoteSym ?? b.quote ?? ''} ${b.kind === 'lp' ? 'liquidity' : b.kind}`;
  const running = b.kind === 'token' ? !!b.on : b.status === 'running';
  const facts: [string, string][] = [];
  if (b.kind === 'grid') {
    const held = (b.intervals ?? []).filter((i: AnyObj) => i.status === 'holding').length;
    facts.push(['Levels holding', `${held} of ${(b.intervals ?? []).length}`], ['Range', `${b.config?.lowerPrice?.toPrecision?.(5) ?? '—'} – ${b.config?.upperPrice?.toPrecision?.(5) ?? '—'}`], ['Price', b.price?.toPrecision?.(6) ?? '—']);
  } else if (b.kind === 'lp') {
    facts.push(['Range', b.position ? `${b.position.lower.toPrecision(6)} – ${b.position.upper.toPrecision(6)}` : 'not open'], ['Fees waiting', `${qty(b.owed?.base ?? 0, b.base, 4, false)} · ${qty(b.owed?.quote ?? 0, b.quote, 4, false)}`], ['Range moves', String(b.reranges ?? 0)]);
  } else if (b.kind === 'trend') {
    facts.push(['Position', b.position ? `long from ${b.position.entryPrice.toPrecision(6)}` : 'waiting for a signal'], ['Price', b.price?.toPrecision?.(6) ?? '—']);
  } else {
    facts.push(['Holding', (b.positions ?? []).map((p: AnyObj) => `$${String(p.label).split('/')[0]}`).join(', ') || 'nothing'], ['Mode', b.options?.mode === 'live' ? 'Live' : 'Paper']);
  }
  const page: View | null = b.kind === 'grid' || b.kind === 'trend' || b.kind === 'lp' ? { v: b.kind, id: b.id } : b.kind === 'token' ? { v: 'auto' } : null;
  return (
    <>
      <span className="dk-eyebrow">{name} · {b.mode === 'live' || b.options?.mode === 'live' ? 'Live' : 'Paper'} · {running ? 'running' : b.status ?? 'off'}</span>
      <span className={`dk-huge ${(m?.generatedUsd ?? 0) < 0 ? 'neg' : 'pos'}`}>{m?.generatedUsd == null ? '—' : usd(m.generatedUsd, true)}</span>
      <span className="dk-chips">{gen.length ? gen.map(([sym, v]) => <span key={sym} className={v >= 0 ? 'pos' : 'neg'}>{qty(v, sym, 5)}</span>) : <span>nothing generated yet</span>}</span>
      <dl className="dk-kv">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {err && <p className="neg small">{err}</p>}
      <div className="dk-row">
        {b.kind !== 'token' && <button type="button" className="dk-btn" onClick={() => { pause(b); close(); }}>{running ? 'Pause' : 'Resume'}</button>}
        {page && <button type="button" className="dk-btn primary" onClick={() => go(page)}>Open full page</button>}
      </div>
    </>
  );
}

function NewSheet({ s, go, act, busy }: { s: AnyObj; go: (v: View) => void; act: (fn: () => Promise<unknown>) => void; busy: boolean }) {
  const [kind, setKind] = useState<BotKind>('grid');
  // picking a bot type stays in the drawer; anything else (a started bot's page) leaves it
  const nav: Nav = (v) => { if (v.v === 'new') setKind(v.kind ?? 'grid'); else go(v); };
  return <div className="dk-sheet-body"><NewBot s={s} kind={kind} nav={nav} act={act} busy={busy} /></div>;
}

function WalletSheet({ holdings, go }: { holdings: HoldingsSnapshot | null; go: (v: View) => void }) {
  const { chain } = useChainFilter();
  if (!holdings) return <p className="muted">Reading the wallet…</p>;
  if (!holdings.hasSigner) return <><span className="dk-eyebrow">Wallet & funds</span><p className="muted">No wallet key on this server: bots run on paper.</p></>;
  const coins = holdingsByToken(holdings, chain).slice(0, 8);
  const worth = holdings.netWorthExDustUsd ?? holdings.netWorthUsd;
  return (
    <>
      <span className="dk-eyebrow">Wallet & funds</span>
      <span className="dk-huge">{worth == null ? '—' : usd(worth)}</span>
      <dl className="dk-kv">{coins.map((c) => <div key={c.sym}><dt>{c.sym}</dt><dd>{qty(c.amount, c.sym, 6, false)}{c.usd != null ? <small> · {usd(c.usd)}</small> : null}</dd></div>)}</dl>
      <div className="dk-row">
        <button type="button" className="dk-btn" onClick={() => go({ v: 'tools', tab: 'convert' })}>Convert</button>
        <button type="button" className="dk-btn primary" onClick={() => go({ v: 'holdings' })}>Open wallet</button>
      </div>
    </>
  );
}

function ListSheet({ title, items }: { title: string; items: (OpenItem | BankedItem)[] }) {
  return (
    <>
      <span className="dk-eyebrow">{title} · {items.length}</span>
      <div className="dk-sheet-body dk-sheet-list">
        {items.map((i) => (
          <div key={i.key} className="dk-ev">
            <span className="dk-what"><b>{i.title}</b> · {i.sub}</span>
            {(() => { const a = 'value' in i ? i.value : i.amounts; return <span className={a.some((x) => x.amt < 0) ? 'neg' : 'pos'}>{amountsText(a)}</span>; })()}
          </div>
        ))}
      </div>
    </>
  );
}
