/** In-process activity bus: ring buffer + listeners. Feeds the SSE stream and the UI activity feed. */
import { EventEmitter } from 'node:events';

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
  kind?: 'grid' | 'trend' | 'system';
  pair?: string;
  /** EVM chain id of the market (explorer links, chain badge) */
  chainId?: number;
  /** Suggest a browser notification (fills, stops, errors, alerts, range exits) */
  notify?: boolean;
  data?: Record<string, unknown>;
}
export type ActivityInput = Omit<ActivityEvent, 'id' | 't' | 'level'> & { level?: ActivityEvent['level'] };
export type Emit = (e: ActivityInput) => void;

export class ActivityBus extends EventEmitter {
  private ring: ActivityEvent[] = [];
  private seq = 0;
  constructor(private readonly max = 400, private readonly now: () => number = Date.now) { super(); this.setMaxListeners(100); }
  emitEvent: Emit = (e) => {
    const ev: ActivityEvent = { level: 'info', ...e, id: ++this.seq, t: this.now() };
    this.ring.push(ev);
    if (this.ring.length > this.max) this.ring.shift();
    this.emit('activity', ev);
  };
  recent(n = 100, sinceId = 0) { return this.ring.filter((e) => e.id > sinceId).slice(-n); }
}
