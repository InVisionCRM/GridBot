import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { ActivityItem } from './metrics';
import { formatWhen } from './format';

const ROW = 52;

export function ActivityTape({ items, full = false }: { items: ActivityItem[]; full?: boolean }) {
  if (full) return <VirtualTape items={items} />;
  const peek = items.slice(0, 7);
  return (
    <div className="tape" aria-label="Activity">
      <AnimatePresence initial={false}>
        {peek.map((item) => (
          <motion.article
            key={item.id}
            className={`tape-row tone-${item.tone}`}
            layout
            initial={{ y: -14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', bounce: 0, visualDuration: 0.28 }}
          >
            <Row item={item} />
          </motion.article>
        ))}
      </AnimatePresence>
      {!peek.length && <p className="muted">Nothing yet.</p>}
    </div>
  );
}

function Row({ item }: { item: ActivityItem }) {
  return (
    <>
      <time>{formatWhen(item.t)}</time>
      <b>{item.kind}</b>
      <span>{item.text}</span>
    </>
  );
}

function VirtualTape({ items }: { items: ActivityItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ scroll: 0, height: 480 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setBox({ scroll: el.scrollTop, height: el.clientHeight || 480 });
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', read); ro.disconnect(); };
  }, []);
  const start = Math.max(0, Math.floor(box.scroll / ROW) - 2);
  const end = Math.min(items.length, start + Math.ceil(box.height / ROW) + 6);
  return (
    <div ref={ref} className="tape tape-full" aria-label="Activity">
      <div style={{ height: items.length * ROW, position: 'relative' }}>
        {items.slice(start, end).map((item, i) => (
          <article key={item.id} className={`tape-row tape-abs tone-${item.tone}`} style={{ transform: `translateY(${(start + i) * ROW}px)`, height: ROW }}>
            <Row item={item} />
          </article>
        ))}
      </div>
      {!items.length && <p className="muted">Nothing yet.</p>}
    </div>
  );
}
