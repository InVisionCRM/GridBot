/**
 * The friends' gateway: the only port Tailscale Funnel exposes. It serves the log-in, invite and account pages, and
 * passes a logged-in friend's requests to their own copy and nothing else. A copy accepts local requests only, so the
 * gateway rewrites Host and drops the friend's cookie and Origin; it checks Origin itself on every change (the address
 * the host set, or the gateway's own local address), forbids framing, and sends no referrer to other sites.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import { join } from 'node:path';
import type { Friend, Friends } from './accounts';
import { COOKIE, cookieValue, readSession, RENEW_MS, sessionCookie, SESSION_MS, signSession } from './auth';
import type { CopyState } from './copies';
import { accountPage, copyDownPage, invitePage, linkGonePage, loginPage, resetPage } from './pages';

export interface GatewayDeps {
  friends: Friends;
  sessionKey: Buffer;
  copyState: (id: string) => CopyState;
  /** Live bots in the friend's copy (throws when the copy isn't running) */
  liveBots: (id: string) => Promise<number>;
  /** Uses the invite and starts the new friend's copy */
  signUp: (token: string, p: { name: string; password: string; key: string }) => Promise<Friend>;
  /** Saves or removes the key (refused while there are live bots) and restarts the copy */
  setKey: (id: string, raw: string | null) => Promise<void>;
  /** Origins a change may come from */
  origins: () => string[];
  /** The built app's folder: its icons and manifest are served before logging in */
  publicDir: string | null;
  now?: () => number;
}

const PUBLIC = ['/favicon.svg', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'];
/** Never passed on to a copy: the gateway's cookie, where the request came from, and hop-by-hop headers. */
const DROP_IN = /^(cookie|origin|referer|forwarded|x-forwarded-.*|x-real-ip|tailscale-.*|connection|keep-alive|proxy-.*|upgrade)$/i;
const DROP_OUT = /^(connection|keep-alive|transfer-encoding|set-cookie)$/i;
const DONE: Record<string, string> = {
  key: 'Key saved. Your copy is restarting with it; give it a few seconds.',
  nokey: 'Key removed. Your copy is restarting in paper mode.',
  password: 'Password changed. Your other devices are logged out.',
};

export function createGateway(d: GatewayDeps) {
  const app = express();
  app.disable('x-powered-by');
  const now = () => (d.now ?? Date.now)();
  const host = () => d.friends.host().name;
  const agent = new http.Agent({ keepAlive: true });
  const form = express.urlencoded({ extended: false, limit: '8kb' });
  const field = (req: Request, k: string): string => (typeof req.body?.[k] === 'string' ? req.body[k] : '');
  const html = (res: Response, status: number, body: string) => res.status(status).set('Cache-Control', 'no-store').type('html').send(body);
  const setSession = (res: Response, f: Friend) => res.append('Set-Cookie', sessionCookie(signSession(d.sessionKey, { f: f.id, s: f.session, e: now() + SESSION_MS })));
  /** Express 4 doesn't catch a rejected handler: an error here must never take the host (and its bots) down. */
  const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const me = (res: Response): Friend => res.locals.friend as Friend;

  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    // same-origin, not no-referrer: under no-referrer browsers send "Origin: null" on form posts, which the check below
    // refuses. Other sites still get no referrer, so an invite link never leaks (e.g. to the font server).
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (!origin || !d.origins().includes(origin)) return res.status(403).type('text/plain').send('Refused: this request didn\'t come from the GridBot page.');
    }
    const s = readSession(d.sessionKey, cookieValue(req.headers.cookie, COOKIE), now());
    const f = s ? d.friends.current(s) : null;
    res.locals.friend = f;
    if (f && s && s.e - now() < RENEW_MS) setSession(res, f);
    next();
  });

  if (d.publicDir) {
    const dir = d.publicDir;
    app.get(PUBLIC, (req, res) => res.sendFile(join(dir, req.path), (e) => { if (e && !res.headersSent) res.status(404).end(); }));
  }

  // ── Log in / out ─────────────────────────────────────────────────────
  app.get('/login', (_req, res) => (res.locals.friend ? res.redirect(303, '/') : html(res, 200, loginPage(host()))));
  app.post('/login', form, h(async (req, res) => {
    const name = field(req, 'name');
    try {
      setSession(res, await d.friends.login(name, field(req, 'password')));
      res.redirect(303, '/');
    } catch (e) { html(res, 400, loginPage(host(), { error: (e as Error).message, name })); }
  }));
  app.post('/logout', (_req, res) => { res.append('Set-Cookie', sessionCookie(null)); res.redirect(303, '/login'); });

  // ── Invite and new-password links ────────────────────────────────────
  app.get('/invite/:token', (req, res) => {
    const inv = d.friends.inviteFor(req.params.token);
    if (!inv) return html(res, 410, linkGonePage(host()));
    html(res, 200, inv.friendId ? resetPage(host(), req.params.token, inv.name) : invitePage(host(), req.params.token, { name: inv.name }));
  });
  app.post('/invite/:token', form, h(async (req, res) => {
    const token = req.params.token;
    const inv = d.friends.inviteFor(token);
    if (!inv) return html(res, 410, linkGonePage(host()));
    const password = field(req, 'password');
    try {
      if (password !== field(req, 'again')) throw new Error('The two passwords are different. Type the same one twice.');
      setSession(res, inv.friendId ? await d.friends.resetPassword(token, password) : await d.signUp(token, { name: field(req, 'name'), password, key: field(req, 'key') }));
      res.redirect(303, '/');
    } catch (e) {
      const error = (e as Error).message;
      html(res, 400, inv.friendId ? resetPage(host(), token, inv.name, { error }) : invitePage(host(), token, { error, name: field(req, 'name') || inv.name }));
    }
  }));

  // ── Account ──────────────────────────────────────────────────────────
  const authed = (_req: Request, res: Response, next: NextFunction) => (res.locals.friend ? next() : res.redirect(303, '/login'));
  const account = async (res: Response, m: { error?: string; ok?: string }, status = 200) => {
    const f = me(res);
    const liveBots = await d.liveBots(f.id).catch(() => null);
    html(res, status, accountPage({ name: f.name, host: host(), address: f.address, liveBots }, m));
  };
  app.get('/account', authed, h((req, res) => account(res, { ok: DONE[String(req.query.done ?? '')] })));
  app.post('/account/password', authed, form, h(async (req, res) => {
    try {
      if (field(req, 'password') !== field(req, 'again')) throw new Error('The two new passwords are different. Type the same one twice.');
      setSession(res, await d.friends.changePassword(me(res).id, field(req, 'current'), field(req, 'password')));
      res.redirect(303, '/account?done=password');
    } catch (e) { await account(res, { error: (e as Error).message }, 400); }
  }));
  app.post('/account/key', authed, form, h(async (req, res) => {
    try {
      const raw = field(req, 'key');
      if (!raw.trim()) throw new Error('Paste your key first.');
      await d.setKey(me(res).id, raw);
      res.redirect(303, '/account?done=key');
    } catch (e) { await account(res, { error: (e as Error).message }, 400); }
  }));
  app.post('/account/key/remove', authed, h(async (_req, res) => {
    try {
      await d.setKey(me(res).id, null);
      res.redirect(303, '/account?done=nokey');
    } catch (e) { await account(res, { error: (e as Error).message }, 400); }
  }));

  // ── Everything else: the friend's own copy ───────────────────────────
  app.use((req, res) => {
    const f = res.locals.friend as Friend | null;
    if (!f) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Please log in again.', login: true }) : res.redirect(303, '/login');
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_IN.test(k)) headers[k] = v;
    headers.host = `127.0.0.1:${f.port}`;
    const up = http.request({ host: '127.0.0.1', port: f.port, method: req.method, path: req.originalUrl, headers, agent }, (r) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP_OUT.test(k) && v != null) out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      const state = d.copyState(f.id);
      if (req.path.startsWith('/api/')) res.status(503).json({ error: state === 'stopped' ? `${host()} has stopped your copy.` : 'Your copy is starting. Try again in a few seconds.' });
      else html(res, 503, copyDownPage(host(), state === 'running' ? 'starting' : state));
    });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  });

  app.use((_e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.headersSent) res.status(500).type('text/plain').send('Something went wrong. Try again.');
  });
  return app;
}
