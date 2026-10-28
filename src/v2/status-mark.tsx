import type { BotStatus } from './metrics';

const TONE_LABEL = { in: 'In', near: 'Near', out: 'Out', idle: 'Idle' } as const;

/** Color plus a word and a shape. Not a control, so it does not take a 44pt hit target. */
export function StatusMark({ tone, status }: { tone: 'in' | 'near' | 'out' | 'idle'; status: BotStatus }) {
  const label = tone === 'idle'
    ? (status === 'closed' ? 'Closed' : status === 'paused' ? 'Paused' : status === 'stopped' ? 'Stopped' : 'Idle')
    : TONE_LABEL[tone];
  const shape = tone === 'out' ? 'square' : tone === 'idle' ? 'hollow' : 'dot';
  return (
    <span className={`status-mark tone-${tone} shape-${shape}`}>
      <i aria-hidden="true" />
      <em>{label}</em>
    </span>
  );
}
