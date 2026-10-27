/**
 * Who stopped or closed a bot. Stored on the bot so a restart still shows it.
 * Request fields come from the request that is running now (AsyncLocalStorage). A timer, the tax watcher,
 * or startup has no request, so those are recorded as the app itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type HaltOrigin = 'localhost' | 'gateway-owner' | 'friend-copy' | 'system';

export interface Halt {
  at: number;
  what: string;
  detail: string;
  origin: HaltOrigin;
  endpoint: string | null;
  ua: string | null;
}

export interface RequestCtx {
  origin: HaltOrigin;
  endpoint: string;
  ua: string | null;
  from: string | null;
}

export const requestStore = new AsyncLocalStorage<RequestCtx>();

/** Button names the page sends. They replace the endpoint label. Anything else is ignored. */
const FROM: Record<string, { what: string; detail: string }> = {
  'header-stop-all': { what: 'button', detail: 'Stop all button' },
  'header-chain-stop': { what: 'button', detail: 'Stop all button for one chain' },
  'row-stop': { what: 'button', detail: 'Stop button' },
  'row-pause': { what: 'button', detail: 'Pause button' },
  'row-close': { what: 'button', detail: 'Close button' },
  'close-all': { what: 'button', detail: 'Close all button' },
  'start-anyway': { what: 'button', detail: 'Start anyway button' },
};

export function systemHalt(what: string, detail: string, at: number): Halt {
  return { at, what, detail, origin: 'system', endpoint: null, ua: null };
}

export function requestHalt(what: string, detail: string, at: number): Halt {
  const ctx = requestStore.getStore();
  const named = ctx?.from ? FROM[ctx.from] : undefined;
  return {
    at,
    what: named?.what ?? what,
    detail: named?.detail ?? detail,
    origin: ctx?.origin ?? 'system',
    endpoint: ctx?.endpoint ?? null,
    ua: ctx?.ua ?? null,
  };
}

/** A string is a safety pause (tax watcher). A Halt is copied. Nothing else is "Stopped" by the app. */
export function resolveHalt(why: string | Halt | undefined, at: number): Halt {
  if (isHalt(why)) return { ...why, at };
  if (typeof why === 'string') return systemHalt('safety-pause', why, at);
  return systemHalt('stop', 'Stopped', at);
}

export function isHalt(v: unknown): v is Halt {
  if (!v || typeof v !== 'object') return false;
  const o = v as Halt;
  return typeof o.at === 'number' && typeof o.what === 'string' && typeof o.detail === 'string'
    && (o.origin === 'localhost' || o.origin === 'gateway-owner' || o.origin === 'friend-copy' || o.origin === 'system');
}

/**
 * A LIVE run that went on without a completed safety check (3 tries couldn't complete it), on the last passing report:
 * - 'start-anyway': a start, after the Start anyway button (who pressed it: origin, endpoint, browser);
 * - 'resume': a Resume of a stopped live bot (who resumed it), no button needed since it was already vetted;
 * - 'boot': a live bot that was running when the app stopped and keeps running after the restart (the app).
 * Also when, why the check was blocked, and the last report it relied on.
 */
export type OverrideKind = 'start-anyway' | 'resume' | 'boot';
export interface StartOverride extends Halt {
  kind: OverrideKind;
  blockedBy: string;
  tries: number;
  lastKnownAt: number;
  lastKnownRisk: string;
}

export function startOverride(info: { blockedBy: string; tries: number; lastKnownAt: number; lastKnownRisk: string }, at: number, kind: OverrideKind = 'start-anyway'): StartOverride {
  const who = kind === 'boot' ? systemHalt('boot', 'App restart', at)
    : kind === 'resume' ? requestHalt('resume', 'Resume (API)', at)
    : requestHalt('start-anyway', 'Start anyway (API)', at);
  return { ...who, kind, ...info };
}

/** A start that a Stop all / STOP chain overtook while it was under way. It is refused; `halt` is that press. */
export class StartStopped extends Error {
  constructor(readonly halt: Halt) { super(`Not started: ${halt.detail} was pressed while it was starting.`); }
}
