/**
 * Each friend's copy of the app: the same built server (dist/server/index.js) run as a child process in its own folder
 * (data/friends/<id>/), so it has its own bots, history and settings. Its environment is built from an allow-list, never
 * copied from the host's: no PRIVATE_KEY*, RPC_URL* (they can hold API keys), FRIENDS_SECRET or HOST_PASSWORD_HASH reach it. The friend's
 * own key is never in the copy's environment (which other processes of the same user can read, e.g. /proc/<pid>/environ,
 * and which crash reports and `ps e` show): the copy asks for it over the IPC channel once at start (env.ts
 * receiveFriendKey) and the host answers that one request. The same channel ties the copy to the host: when the host
 * stops, even when killed, the channel closes and the copy shuts down.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

/** Host settings a copy shares. Everything else in the host's environment stays with the host. */
export const SHARED_ENV = ['NETWORK', 'CHAINS', 'POLL_MS', 'APPROVAL_MODE', 'MAX_RETRIES', 'RETRY_DELAY_MS', 'CANDLES_GECKO', 'MAX_TOKEN_TAX_PCT', 'TAX_RECHECK_MIN'] as const;

export interface CopySpec { id: string; name: string; port: number; key: string | null }

export function childEnv(hostEnv: NodeJS.ProcessEnv, c: CopySpec, host: { name: string; url: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SHARED_ENV) { const v = hostEnv[k]; if (v != null && v !== '') env[k] = v; }
  Object.assign(env, { NODE_ENV: 'production', PORT: String(c.port), FRIEND_NAME: c.name, HOST_NAME: host.name, HOST_URL: host.url });
  // No key here: it goes over IPC (keyMessage).
  return env;
}

/** A port on 127.0.0.1 that nothing listens on. */
/** IPC: the copy asks once (KEY_REQUEST); the host answers with the friend's key, or null for a paper-only copy. */
export const KEY_REQUEST = 'friend-key?';
export const KEY_REPLY = 'friend-key';
export function keyMessage(c: CopySpec) { return { type: KEY_REPLY, key: c.key ?? null }; }

/** A port on 127.0.0.1 that nothing listens on. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export type CopyState = 'starting' | 'running' | 'stopped' | 'crashed';
export interface CopyStatus { state: CopyState; since: number; restarts: number; lastExit: string | null }

interface Proc extends CopyStatus { spec: CopySpec; child: ChildProcess | null; stopping: boolean; timer: ReturnType<typeof setTimeout> | null; backoffMs: number }

/** A crashed copy is restarted after 2 s, doubling to 60 s; a copy that ran 5 min starts again from 2 s. */
const BACKOFF_MS = [2000, 60_000] as const;
const STABLE_MS = 5 * 60_000;
const LOG_MAX = 5 * 1024 * 1024;

export class Copies {
  private procs = new Map<string, Proc>();

  constructor(private readonly o: {
    /** data/friends */
    root: string;
    /** The built server the host runs (dist/server/index.js) */
    entry: string;
    hostEnv: NodeJS.ProcessEnv;
    host: () => { name: string; url: string };
    say: (msg: string, level: 'info' | 'warn') => void;
    now?: () => number;
  }) {}

  private now() { return (this.o.now ?? Date.now)(); }
  dir(id: string) { return join(this.o.root, id); }

  status(id: string): CopyStatus {
    const p = this.procs.get(id);
    return p ? { state: p.state, since: p.since, restarts: p.restarts, lastExit: p.lastExit } : { state: 'stopped', since: 0, restarts: 0, lastExit: null };
  }

  start(spec: CopySpec) {
    const p = this.procs.get(spec.id);
    if (p?.child) throw new Error(`${spec.name}'s copy is already running.`);
    const proc: Proc = p ?? { spec, child: null, stopping: false, timer: null, backoffMs: BACKOFF_MS[0], state: 'stopped', since: 0, restarts: 0, lastExit: null };
    Object.assign(proc, { spec, stopping: false });
    if (proc.timer) { clearTimeout(proc.timer); proc.timer = null; }
    this.procs.set(spec.id, proc);
    this.launch(proc);
  }

  private launch(p: Proc) {
    const dir = this.dir(p.spec.id);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'app.log');
    try { if (statSync(log).size > LOG_MAX) renameSync(log, `${log}.1`); } catch { /* no log yet, or the old one is still in use */ }
    const fd = openSync(log, 'a');
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.o.entry], { cwd: dir, env: childEnv(this.o.hostEnv, p.spec, this.o.host()), stdio: ['ignore', fd, fd, 'ipc'] });
    } finally {
      closeSync(fd);
    }
    // The key, once, to the copy that asks for it (never in its environment, never logged).
    let handed = false;
    child.on('message', (m: unknown) => {
      if (handed || (m as { type?: unknown } | null)?.type !== KEY_REQUEST || !child.connected) return;
      handed = true;
      child.send(keyMessage(p.spec), () => { /* a copy that died meanwhile: its exit is handled below */ });
    });
    Object.assign(p, { child, state: 'starting', since: this.now() });
    child.once('exit', (code, signal) => this.exited(p, child, `exit code ${code}`, signal));
    // A copy that can't be started emits 'error' (maybe without 'exit'); unhandled, it would take the host down.
    child.once('error', (e) => this.exited(p, child, `couldn't start: ${e.message}`, null));
    void this.waitReady(p, child);
  }

  /** 'running' once the copy answers on its port (it listens after loading its bots). */
  private async waitReady(p: Proc, child: ChildProcess) {
    while (p.child === child && p.state === 'starting') {
      try {
        const r = await fetch(`http://127.0.0.1:${p.spec.port}/api/health`);
        if (r.ok && p.child === child) { p.state = 'running'; return; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private exited(p: Proc, child: ChildProcess, why: string, signal: NodeJS.Signals | null) {
    if (p.child !== child) return;
    const ranMs = this.now() - p.since;
    Object.assign(p, { child: null, lastExit: signal ? `stopped by ${signal}` : why, since: this.now() });
    if (p.stopping) { p.state = 'stopped'; return; }
    p.state = 'crashed';
    p.restarts++;
    if (ranMs >= STABLE_MS) p.backoffMs = BACKOFF_MS[0];
    const wait = p.backoffMs;
    p.backoffMs = Math.min(BACKOFF_MS[1], p.backoffMs * 2);
    this.o.say(`${p.spec.name}'s copy stopped unexpectedly (${p.lastExit}); starting it again in ${Math.round(wait / 1000)} s. Its log: ${join(this.dir(p.spec.id), 'app.log')}`, 'warn');
    p.timer = setTimeout(() => { p.timer = null; if (!p.stopping && !p.child) this.launch(p); }, wait);
  }

  /** SIGTERM (the copy saves and exits like the host on Ctrl+C), then SIGKILL after 15 s. */
  async stop(id: string): Promise<void> {
    const p = this.procs.get(id);
    if (!p) return;
    p.stopping = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    const child = p.child;
    if (!child) { p.state = 'stopped'; return; }
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      child.kill('SIGTERM');
    });
  }

  async restart(spec: CopySpec) { await this.stop(spec.id); this.start(spec); }

  /** Stops the copy and deletes its folder (its bots, history and log). */
  async remove(id: string) {
    await this.stop(id);
    this.procs.delete(id);
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** Host shutdown: the copies get SIGTERM; the closing IPC channel also stops any copy this misses. */
  stopAll() { for (const id of this.procs.keys()) void this.stop(id); }

  /** Live bots in a copy (any state): while there are some, its key can't change and it can't be removed. */
  async liveBots(id: string): Promise<number> {
    const p = this.procs.get(id);
    if (!p || p.state !== 'running') throw new Error('Their copy isn\'t running, so its bots can\'t be checked. Start it first.');
    const r = await fetch(`http://127.0.0.1:${p.spec.port}/api/bot/status`);
    if (!r.ok) throw new Error(`Their copy didn't answer (HTTP ${r.status}).`);
    const s = (await r.json()) as { grids: { mode: string }[]; trends: { mode: string }[]; lps: { mode: string }[] };
    return [...s.grids, ...s.trends, ...s.lps].filter((b) => b.mode === 'live').length;
  }
}
