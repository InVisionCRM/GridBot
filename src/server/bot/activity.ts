/** In-process activity bus: ring buffer + listeners. Feeds the SSE stream and the UI activity feed. */
import { EventEmitter } from 'node:events';
import { redact } from './logger';
import { appendLogLine, readLogLines } from './fileLog';

export type ActivityType =
  | 'tick' | 'signal' | 'blocked' | 'queued' | 'sent' | 'confirmed' | 'filled' | 'skipped' | 'stop_moved'
  | 'alert' | 'range' | 'started' | 'stopped' | 'error' | 'info' | 'candles';

export interface ActivityEvent {
  id: number;
  t: number;
  type: ActivityType;
  level: 'info' | 'success' | 'warn' | 'error';
  msg: string;
  botId?: string;
  kind?: 'grid' | 'trend' | 'lp' | 'system';
  pair?: string;
  /** EVM chain id of the market (explorer links, chain badge) */
  chainId?: number;
  /** Suggest a browser notification (fills, stops, errors, alerts, range exits) */
  notify?: boolean;
  data?: Record<string, unknown>;
}
export type ActivityInput = Omit<ActivityEvent, 'id' | 't' | 'level'> & { level?: ActivityEvent['level'] };
export type Emit = (e: ActivityInput) => void;

function loadActivity(file: string, max: number): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const line of readLogLines(file, 1)) { // the backlog needs only the newest lines
    try {
      const e = JSON.parse(line) as ActivityEvent;
      if (e && typeof e.id === 'number' && typeof e.msg === 'string' && typeof e.t === 'number') out.push(e);
    } catch { /* a torn line from a crash is skipped */ }
  }
  return out.slice(-max);
}

export class ActivityBus extends EventEmitter {
  private ring: ActivityEvent[] = [];
  private seq = 0;
  private readonly file: string | null;
  constructor(private readonly max = 400, private readonly now: () => number = Date.now, file?: string) {
    super();
    this.setMaxListeners(100);
    this.file = file ?? null;
    if (file) {
      this.ring = loadActivity(file, max);
      this.seq = this.ring.reduce((m, e) => Math.max(m, e.id), 0);
    }
  }
  emitEvent: Emit = (e) => {
    const ev: ActivityEvent = { level: 'info', ...e, id: ++this.seq, t: this.now() };
    this.ring.push(ev);
    if (this.ring.length > this.max) this.ring.shift();
    if (this.file) appendLogLine(this.file, JSON.stringify({ ...ev, msg: redact(ev.msg) }));
    this.emit('activity', ev);
  };
  recent(n = 100, sinceId = 0) { return this.ring.filter((e) => e.id > sinceId).slice(-n); }
}
