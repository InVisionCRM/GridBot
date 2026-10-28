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
/** Origins (scheme://host[:port]) of RPC URLs that carry a key in their path, query or userinfo, and how to show them. */
const keyedUrls: { key: string; shown: string; re: RegExp }[] = [];
/**
 * After a keyed origin, anything up to a space, quote or backslash is the URL's path, query or fragment. It is cut,
 * even when a message was truncated in the middle of the key (then the key is not whole and no secret matches it).
 */
const REST = String.raw`[^\s"'<>\\]*`;
/** user:password@ in any URL. */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function addUrlRule(key: string, re: RegExp, shown: string) {
  if (keyedUrls.some((x) => x.key === key)) return;
  keyedUrls.push({ key, shown, re });
}
/** Register the origin of a keyed RPC URL. From then on every log line shows that URL as its origin only. */
export function registerUrlOrigin(origin: string) {
  const o = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+$/.test(o)) return;
  addUrlRule(`o ${o}`, new RegExp(`${esc(o)}(?![a-z0-9.:-])(?:[/?#]${REST})?`, 'gi'), o);
}
/**
 * Register the start of a keyed URL with userinfo (scheme://user: or scheme://user@). Everything after it, up to a
 * space or quote, is shown as `shown` (the origin), even when the message was cut inside the password.
 */
export function registerUrlPrefix(prefix: string, shown: string) {
  const p = prefix.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*[:@]$/i.test(p)) return;
  addUrlRule(`p ${p}`, new RegExp(`${esc(p)}${REST}`, 'gi'), shown);
}
export function redact(msg: string): string {
  let out = msg;
  for (const u of keyedUrls) if (u.key.startsWith('p ')) out = out.replace(u.re, u.shown);
  out = out.replace(USERINFO, '$1');
  for (const u of keyedUrls) if (u.key.startsWith('o ')) out = out.replace(u.re, u.shown);
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
