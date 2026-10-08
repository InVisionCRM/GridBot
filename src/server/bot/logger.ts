/** Console + ring-buffer logger. Registered secrets are redacted from every message. */
export interface LogEntry { t: number; level: 'info' | 'warn' | 'error'; msg: string }

const secrets: string[] = [];
export function registerSecret(s: string) {
  const v = s.trim();
  if (v.length < 16) return;
  secrets.push(v, v.startsWith('0x') ? v.slice(2) : `0x${v}`);
}
export function redact(msg: string): string {
  let out = msg;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

export class Logger {
  readonly entries: LogEntry[] = [];
  constructor(private readonly quiet = false, private readonly max = 200) {}
  private push(level: LogEntry['level'], msg: string) {
    const e = { t: Date.now(), level, msg: redact(msg) };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    if (!this.quiet) (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${new Date(e.t).toISOString()}] ${level.toUpperCase()} ${e.msg}`);
  }
  info(m: string) { this.push('info', m); }
  warn(m: string) { this.push('warn', m); }
  error(m: string) { this.push('error', m); }
}
