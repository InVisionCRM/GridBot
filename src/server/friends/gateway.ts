/**
 * The friends' gateway: the only port Tailscale reaches. It serves the log-in, invite and account pages, and passes a
 * logged-in friend to their own copy and nothing else. The owner (host:password) is a separate login: that cookie is
 * passed to the host app on 127.0.0.1, with Host rewritten to loopback and a loopback Origin set only after this
 * gateway's own same-origin check. A friend's cookie is never forwarded, and is never aimed at the host app.
 * Copies and the host app accept local requests only, so the gateway drops Cookie, Origin and forwarding headers.
 * It allows only loopback and the configured public host (GATEWAY_HOST or Tools → Friends), forbids framing, and
 * sends no referrer to other sites.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import type { Friend, Friends } from './accounts';
import { COOKIE, cookieValue, HOST_ID, readSession, RENEW_MS, sessionCookie, SESSION_MS, signSession, type Session } from './auth';
import type { CopyState } from './copies';
import type { OwnerLogin } from './owner';
import { accountPage, copyDownPage, hostDownPage, invitePage, linkGonePage, loginPage, ownerAccountPage, resetPage } from './pages';
import { FUNNEL_OWNER_REFUSED, requestHostAllowed, viaFunnel } from './publicHost';

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
  /** Owner login, or null when npm run host:password has not been run */
  owner?: OwnerLogin | null;
  /** The host app's port (127.0.0.1). Owner sessions are proxied here. */
  hostPort?: number;
  /** Public hostnames (no port) besides loopback that may open the gateway. */
  publicHosts?: () => string[];
  now?: () => number;
}

const PUBLIC = ['/favicon.svg', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'];
/** Never passed on: the gateway's cookie, where the request came from, and hop-by-hop headers. */
const DROP_IN = /^(cookie|origin|referer|forwarded|x-forwarded-.*|x-real-ip|tailscale-.*|x-gridbot-via|connection|keep-alive|proxy-.*|upgrade)$/i;
const DROP_OUT = /^(connection|keep-alive|transfer-encoding|set-cookie)$/i;
const DONE: Record<string, string> = {
  key: 'Key saved. Your copy is restarting with it; give it a few seconds.',
  nokey: 'Key removed. Your copy is restarting in paper mode.',
  password: 'Password changed. Your other devices are logged out.',
};

function upstreamHeaders(src: http.IncomingHttpHeaders, port: number, owner: boolean, method: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) if (!DROP_IN.test(k)) headers[k] = v;
  headers.host = `127.0.0.1:${port}`;
  // The phone cannot claim to be the Mac. This gateway sets the label after dropping a client-supplied one.
  headers['x-gridbot-via'] = owner ? 'owner' : 'friend';
  // The host app rejects a non-local Origin. Set one only for a change this gateway already accepted.
  if (owner && method !== 'GET' && method !== 'HEAD') headers.origin = `http://127.0.0.1:${port}`;
  return headers;
}

export function createGateway(d: GatewayDeps) {
  const app = express();
  app.disable('x-powered-by');
  const now = () => (d.now ?? Date.now)();
  const host = () => d.friends.host().name;
  const agent = new http.Agent({ keepAlive: true });
  const form = express.urlencoded({ extended: false, limit: '8kb' });
  const field = (req: Request, k: string): string => (typeof req.body?.[k] === 'string' ? req.body[k] : '');
  const html = (res: Response, status: number, body: string) => res.status(status).set('Cache-Control', 'no-store').type('html').send(body);
  const stamp = (res: Response, s: Session) => res.append('Set-Cookie', sessionCookie(signSession(d.sessionKey, s)));
  const friendSession = (f: Friend): Session => ({ f: f.id, s: f.session, e: now() + SESSION_MS });
  const ownerSession = (session: number): Session => ({ f: HOST_ID, s: session, e: now() + SESSION_MS, role: 'host' });
  /** Express 4 doesn't catch a rejected handler: an error here must never take the host (and its bots) down. */
  const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };
  const me = (res: Response): Friend => res.locals.friend as Friend;

  app.use((req, res, next) => {
    if (!requestHostAllowed(req.headers.host, d.publicHosts?.() ?? [])) {
      return res.status(403).type('text/plain').send('Refused: open this page at the address set for it.');
    }
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
    // Through Funnel (the internet) an owner cookie is not honored: the owner reaches the bots from the tailnet only.
    const funnel = viaFunnel(req.headers, req.socket.remoteAddress);
    res.locals.funnel = funnel;
    const ownerOn = !funnel && !!(s?.role === 'host' && d.owner?.current(s));
    const f = ownerOn || !s || s.role === 'host' ? null : d.friends.current(s);
    res.locals.owner = ownerOn;
    res.locals.friend = f;
    if (ownerOn && s && s.e - now() < RENEW_MS) stamp(res, ownerSession(s.s));
    else if (f && s && s.e - now() < RENEW_MS) stamp(res, friendSession(f));
    next();
  });

  if (d.publicDir) {
    const dir = d.publicDir;
    app.get(PUBLIC, (req, res) => res.sendFile(join(dir, req.path), (e) => { if (e && !res.headersSent) res.status(404).end(); }));
  }

  // ── Log in / out ─────────────────────────────────────────────────────
  app.get('/login', (_req, res) => (res.locals.friend || res.locals.owner ? res.redirect(303, '/') : html(res, 200, loginPage(host()))));
  app.post('/login', form, h(async (req, res) => {
    const name = field(req, 'name');
    const password = field(req, 'password');
    try {
      if (d.owner?.isOwnerName(name)) {
        // Refused before the password is checked: no guess through Funnel counts, or locks the owner name.
        if (res.locals.funnel) throw new Error(FUNNEL_OWNER_REFUSED);
        const o = await d.owner.login(name, password);
        stamp(res, ownerSession(o.session));
      } else stamp(res, friendSession(await d.friends.login(name, password)));
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
      // A new friend, never the owner: signUp only creates a friend record.
      stamp(res, friendSession(inv.friendId ? await d.friends.resetPassword(token, password) : await d.signUp(token, { name: field(req, 'name'), password, key: field(req, 'key') })));
      res.redirect(303, '/');
    } catch (e) {
      const error = (e as Error).message;
      html(res, 400, inv.friendId ? resetPage(host(), token, inv.name, { error }) : invitePage(host(), token, { error, name: field(req, 'name') || inv.name }));
    }
  }));

  // ── Account (friends). The owner gets a log-out page, not a friend's key form. ──
  const authed = (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.owner) return res.status(403).type('text/plain').send('That page is for a friend\'s login.');
    return res.locals.friend ? next() : res.redirect(303, '/login');
  };
  const account = async (res: Response, m: { error?: string; ok?: string }, status = 200) => {
    const f = me(res);
    const liveBots = await d.liveBots(f.id).catch(() => null);
    html(res, status, accountPage({ name: f.name, host: host(), address: f.address, liveBots }, m));
  };
  app.get('/account', (req, res, next) => {
    if (res.locals.owner) return html(res, 200, ownerAccountPage());
    next();
  }, authed, h((req, res) => account(res, { ok: DONE[String(req.query.done ?? '')] })));
  app.post('/account/password', authed, form, h(async (req, res) => {
    try {
      if (field(req, 'password') !== field(req, 'again')) throw new Error('The two new passwords are different. Type the same one twice.');
      stamp(res, friendSession(await d.friends.changePassword(me(res).id, field(req, 'current'), field(req, 'password'))));
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

  // ── Everything else: the owner's app, or the friend's own copy ───────
  app.use((req, res) => {
    const owner = res.locals.owner === true;
    const f = res.locals.friend as Friend | null;
    if (!owner && !f) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Please log in again.', login: true }) : res.redirect(303, '/login');
    const port = owner ? d.hostPort : f!.port;
    if (!port) {
      return req.path.startsWith('/api/')
        ? res.status(503).json({ error: 'The app is not answering.' })
        : html(res, 503, hostDownPage());
    }
    const headers = upstreamHeaders(req.headers, port, owner, req.method);
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.originalUrl, headers, agent }, (r) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP_OUT.test(k) && v != null) out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) { res.destroy(); return; }
      if (owner) {
        if (req.path.startsWith('/api/')) res.status(503).json({ error: 'The app is not answering. On the computer, check that it is running.' });
        else html(res, 503, hostDownPage());
        return;
      }
      const state = d.copyState(f!.id);
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

/** WebSocket (and any other upgrade) for a logged-in owner or friend. The cookie is not forwarded. */
export function proxyUpgrade(d: GatewayDeps, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const fail = (code: number, msg: string) => {
    if (socket.writable) socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  if (!requestHostAllowed(req.headers.host, d.publicHosts?.() ?? [])) return fail(403, 'Forbidden');
  // Browsers always send Origin on a WebSocket. Another site's page could otherwise open one with the cookie (CSWSH).
  const origin = req.headers.origin;
  if (!origin || !d.origins().includes(origin)) return fail(403, 'Forbidden');
  const now = (d.now ?? Date.now)();
  const s = readSession(d.sessionKey, cookieValue(req.headers.cookie, COOKIE), now);
  const owner = !viaFunnel(req.headers, req.socket.remoteAddress) && !!(s?.role === 'host' && d.owner?.current(s));
  const friend = owner || !s || s.role === 'host' ? null : d.friends.current(s);
  const port = owner ? d.hostPort : friend?.port;
  if (!port) return fail(401, 'Unauthorized');
  const headers = upstreamHeaders(req.headers, port, owner, req.method ?? 'GET');
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade ?? 'websocket';
  const up = http.request({ host: '127.0.0.1', port, method: req.method ?? 'GET', path: req.url, headers });
  const shut = () => { socket.destroy(); up.destroy(); };
  up.on('upgrade', (res, usock, uhead) => {
    const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`];
    for (const [k, v] of Object.entries(res.headers)) {
      // Keep Connection and Upgrade: the client needs them to finish the handshake. Still drop a copied Set-Cookie.
      if (v == null || /^(transfer-encoding|set-cookie)$/i.test(k)) continue;
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (uhead.length) socket.write(uhead);
    if (head.length) usock.write(head);
    usock.on('error', () => socket.destroy());
    socket.on('error', () => usock.destroy());
    usock.pipe(socket);
    socket.pipe(usock);
  });
  up.on('response', (res) => {
    if (socket.writable) socket.write(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`);
    res.pipe(socket);
  });
  up.on('error', shut);
  socket.on('error', () => up.destroy());
  up.end();
}
