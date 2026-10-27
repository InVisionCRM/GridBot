import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import type { ActivityItem } from './metrics';
import { formatWhen, shortenFigures } from './format';
import { PairLabel } from './pair-label';

const KIND = { fill: 'Fill', recenter: 'Range', fee: 'Fee' } as const;

export function ActivityTape({ items, full = false }: { items: ActivityItem[]; full?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = items.find((item) => item.id === openId) ?? null;
  return (
    <div className="tape-wrap">
      {full ? <FullTape items={items} openId={openId} onOpen={setOpenId} /> : <Peek items={items} openId={openId} onOpen={setOpenId} />}
      {open && <p className="tape-detail">{open.text}</p>}
    </div>
  );
}

function Peek({ items, openId, onOpen }: { items: ActivityItem[]; openId: string | null; onOpen: (id: string | null) => void }) {
  const peek = items.slice(0, 7);
  return (
    <div className="tape" aria-label="Activity">
      <AnimatePresence initial={false}>
        {peek.map((item) => (
          <motion.div
            key={item.id}
            className={`tape-row tone-${item.tone}`}
            layout
            initial={{ y: -14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', bounce: 0, visualDuration: 0.28 }}
          >
            <Row item={item} open={openId === item.id} onOpen={onOpen} />
          </motion.div>
        ))}
      </AnimatePresence>
      {!peek.length && <p className="muted">Nothing yet.</p>}
    </div>
  );
}

function Row({ item, open, onOpen }: { item: ActivityItem; open: boolean; onOpen: (id: string | null) => void }) {
  const short = shortenFigures(item.text);
  return (
    <button
      type="button"
      className="tape-hit"
      title={item.text}
      aria-expanded={open}
      onClick={() => onOpen(open ? null : item.id)}
    >
      <time>{formatWhen(item.t)}</time>
      <span className="tape-who">
        <PairLabel pair={item.pair || 'Bot'} chain={item.chain} />
        <span className="kind-pill">{KIND[item.kind]}</span>
      </span>
      <span className="tape-msg">{open ? item.text : short}</span>
    </button>
  );
}

function FullTape({ items, openId, onOpen }: { items: ActivityItem[]; openId: string | null; onOpen: (id: string | null) => void }) {
  return (
    <div className="tape tape-full" aria-label="Activity">
      {items.map((item) => (
        <div key={item.id} className={`tape-row tone-${item.tone}`}>
          <Row item={item} open={openId === item.id} onOpen={onOpen} />
        </div>
      ))}
      {!items.length && <p className="muted">Nothing yet.</p>}
    </div>
  );
}
