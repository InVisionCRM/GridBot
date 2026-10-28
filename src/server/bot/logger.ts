/** Console + ring-buffer logger. Registered secrets are redacted from every message. An optional file is append-only. */
import { appendLogLine } from './fileLog';

export interface LogEntry { t: number; level: 'info' | 'warn' | 'error'; msg: string }

const secrets: string[] = [];
/**
 * Shorter than this is never a redaction needle. A 1-character quote key would blank that
 * character on every log line. Quote keys use this floor; private keys keep the default of 16.
 */
export const REDACT_FLOOR = 6;
/**
 * Register a string that must never appear in a log line.
 * The default minimum is 16 so a short accidental value cannot blank every log.
 * The 0x twin is only added for long values (a private key logged with or without 0x).
 */
export function registerSecret(s: string, minLength = 16) {
  const v = s.trim();
  const need = Math.max(REDACT_FLOOR, minLength);
  if (v.length < need || secrets.includes(v)) return;
  secrets.push(v);
  if (v.length < 16) return;
  const alt = v.startsWith('0x') ? v.slice(2) : `0x${v}`;
  if (alt.length >= 16 && !secrets.includes(alt)) secrets.push(alt);
}
export function redact(msg: string): string {
  let out = msg;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}

export class Logger {
  readonly entries: LogEntry[] = [];
  private file: string | null;
  constructor(private readonly quiet = false, private readonly max = 200, file?: string) { this.file = file ?? null; }
  /** Start appending to this file. Does not rewrite what is already there. */
  attach(file: string) { this.file = file; }
  private push(level: LogEntry['level'], msg: string) {
    const e = { t: Date.now(), level, msg: redact(msg) };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    if (this.file) appendLogLine(this.file, JSON.stringify(e));
    if (!this.quiet) (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${new Date(e.t).toISOString()}] ${level.toUpperCase()} ${e.msg}`);
  }
  info(m: string) { this.push('info', m); }
  warn(m: string) { this.push('warn', m); }
  error(m: string) { this.push('error', m); }
}
