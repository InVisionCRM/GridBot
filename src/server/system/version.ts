/**
 * Is the server running the latest code? Four commits are compared:
 *   running  the build this process started from (dist/server/build.json read at start; dev mode: git HEAD at start)
 *   built    dist/server/build.json on disk now (what a restart would run)
 *   local    git HEAD of the checkout
 *   remote   origin/main on GitHub (git ls-remote, with the user's own git access)
 * Each gap has one fix: pull → build → restart.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildStamp { commit: string; builtAt: number }
export type VersionState = 'current' | 'update-available' | 'not-built' | 'not-restarted';

export interface VersionInput {
  dev: boolean;
  running: string;
  built: string | null;
  local: string;
  branch: string;
  dirty: boolean;
  /** origin/main, or null when GitHub couldn't be reached */
  remote: string | null;
  /** Whether origin/main is already part of the local checkout (null when GitHub couldn't be reached) */
  remoteInLocal: boolean | null;
}

export interface VersionVerdict { state: VersionState; title: string; detail: string; steps: string[]; notes: string[] }

const RESTART = 'Restart the server: press Ctrl+C in its window and run npm start (or pm2 restart grid-bot)';
const short = (c: string | null) => (c ? c.slice(0, 7) : '—');

/** The first gap between GitHub, the checkout, the build and the running server decides the state. */
export function compareVersions(i: VersionInput): VersionVerdict {
  const notes: string[] = [];
  if (i.branch !== 'main') notes.push(`The checkout is on branch "${i.branch}", not main. Run git checkout main to get the released version.`);
  if (i.dirty) notes.push('Some files in the checkout were edited by hand. git pull may refuse until they are reverted (git stash).');
  if (i.remote == null) notes.push("GitHub couldn't be reached, so newer code can't be ruled out.");
  if (i.remote != null && i.remoteInLocal === false) {
    return {
      state: 'update-available', title: 'Update available',
      detail: `GitHub has newer code (${short(i.remote)}) than this checkout (${short(i.local)}).`,
      steps: ['git pull', 'npm install', 'npm run build', RESTART], notes,
    };
  }
  if (!i.dev && i.built !== i.local) {
    return {
      state: 'not-built', title: 'Pulled but not built',
      detail: `The checkout is at ${short(i.local)} but the built app is ${short(i.built)}, so the new code isn't in use yet.`,
      steps: ['npm run build', RESTART], notes,
    };
  }
  if (!i.dev && i.running !== i.built) {
    return {
      state: 'not-restarted', title: 'Built but not restarted',
      detail: `The server is still running ${short(i.running)}; the new build ${short(i.built)} starts on the next restart.`,
      steps: [RESTART], notes,
    };
  }
  return { state: 'current', title: 'Up to date', detail: `Running ${short(i.running)}${i.remote ? ', the same as GitHub main' : ''}.`, steps: [], notes };
}

export interface VersionReport extends VersionVerdict {
  running: BuildStamp & { dev: boolean };
  built: BuildStamp | null;
  local: string;
  branch: string;
  remote: string | null;
  checkedAt: number;
}

function git(root: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: String(stdout).trim() });
    });
  });
}

const stampPath = (root: string) => join(root, 'dist', 'server', 'build.json');
function readStamp(root: string): BuildStamp { return JSON.parse(readFileSync(stampPath(root), 'utf8')) as BuildStamp; }

export class VersionCheck {
  private cache: VersionReport | null = null;
  private constructor(private readonly root: string, readonly running: BuildStamp & { dev: boolean }) {}

  /** Production reads the stamp `npm run build` wrote; dev (tsx) runs the checkout itself, so HEAD at start. */
  static async start(root: string, dev: boolean): Promise<VersionCheck> {
    if (!dev) return new VersionCheck(root, { ...readStamp(root), dev });
    const head = await git(root, ['rev-parse', 'HEAD']);
    if (head.code !== 0) throw new Error(`git rev-parse HEAD failed in ${root}`);
    return new VersionCheck(root, { commit: head.out, builtAt: Date.now(), dev });
  }

  async report(force = false): Promise<VersionReport> {
    if (!force && this.cache && Date.now() - this.cache.checkedAt < 120_000) return this.cache;
    const [head, branch, status, ls] = await Promise.all([
      git(this.root, ['rev-parse', 'HEAD']),
      git(this.root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(this.root, ['status', '--porcelain', '--untracked-files=no']),
      git(this.root, ['ls-remote', 'origin', 'refs/heads/main']),
    ]);
    if (head.code !== 0) throw new Error(`git rev-parse HEAD failed in ${this.root}`);
    const remote = ls.code === 0 && ls.out ? ls.out.split(/\s+/)[0] : null;
    // exit 0 = origin/main is an ancestor of HEAD (or HEAD itself); 1 = not; 128 = that commit isn't here yet (behind)
    const remoteInLocal = remote == null ? null : (await git(this.root, ['merge-base', '--is-ancestor', remote, 'HEAD'])).code === 0;
    let built: BuildStamp | null = null;
    try { built = readStamp(this.root); } catch { built = null; }
    const verdict = compareVersions({
      dev: this.running.dev, running: this.running.commit, built: built?.commit ?? null, local: head.out,
      branch: branch.out, dirty: status.out.length > 0, remote, remoteInLocal,
    });
    this.cache = { ...verdict, running: this.running, built, local: head.out, branch: branch.out, remote, checkedAt: Date.now() };
    return this.cache;
  }
}
