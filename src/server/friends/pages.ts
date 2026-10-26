/**
 * The gateway's own pages (log in, invite, new password, account, copy starting), as plain HTML forms: they work on
 * any phone browser, need no script, and keep the key field out of the app's bundle. Night Desk look, mobile first.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{--bg:#0b0f0e;--surface:#121917;--surface-2:#18211e;--line:#1f2a27;--line-2:#2c3a36;--text:#e6efec;--muted:#7f918b;--profit:#3dffa2;--on-profit:#04150d;--loss:#ff6b6b;--warn:#f2c14e;
color-scheme:dark;font-family:'Jost','Avenir Next','Segoe UI',sans-serif;font-size:16px;line-height:1.5;color:var(--text);background:var(--bg)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;justify-content:center;padding:max(28px,env(safe-area-inset-top)) 16px 48px;
background:radial-gradient(640px 340px at 85% -90px,rgba(61,255,162,.07),transparent 70%),radial-gradient(520px 300px at -10% 110%,rgba(61,255,162,.035),transparent 70%),var(--bg)}
main{width:100%;max-width:420px;display:flex;flex-direction:column;gap:16px;animation:rise .35s ease-out both}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
.logo{font-weight:600;font-size:1.15rem;letter-spacing:-.01em;display:flex;align-items:center;gap:8px;margin-bottom:4px}
.logo i{width:10px;height:10px;border-radius:2px;background:var(--profit);box-shadow:0 0 14px rgba(61,255,162,.5)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:14px}
h1{font-size:1.5rem;font-weight:600;margin:0;letter-spacing:-.015em;line-height:1.2}
h2{font-size:1.05rem;font-weight:600;margin:0}
p{margin:0}
.muted{color:var(--muted)}.small{font-size:.86rem}.mono{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace}
form{display:flex;flex-direction:column;gap:14px;margin:0}
label{display:flex;flex-direction:column;gap:6px;font-size:.92rem;font-weight:500}
label small{font-weight:400;color:var(--muted);font-size:.82rem}
input{font:inherit;font-size:16px;color:var(--text);background:var(--bg);border:1px solid var(--line-2);border-radius:9px;padding:12px;width:100%}
input:focus{outline:2px solid var(--profit);outline-offset:1px;border-color:transparent}
button,.btn{font:inherit;font-size:1rem;font-weight:600;border-radius:10px;padding:13px 16px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--text);cursor:pointer;text-align:center;text-decoration:none;display:block;width:100%}
button.primary{background:var(--profit);color:var(--on-profit);border-color:transparent}
button.danger{background:transparent;color:var(--loss);border-color:rgba(255,107,107,.4)}
.msg{border-radius:9px;padding:10px 12px;font-size:.92rem;border:1px solid}
.msg.err{border-color:rgba(255,107,107,.4);background:rgba(255,107,107,.08)}
.msg.ok{border-color:rgba(61,255,162,.35);background:rgba(61,255,162,.06)}
.note{border-left:2px solid var(--warn);padding:2px 0 2px 12px;font-size:.88rem;color:var(--muted)}
.keybox{border-top:1px solid var(--line);padding-top:14px;display:flex;flex-direction:column;gap:10px}
.addr{font-family:'IBM Plex Mono',monospace;font-size:.95rem;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;word-break:break-all}
.dots{display:inline-flex;gap:5px}.dots i{width:7px;height:7px;border-radius:50%;background:var(--profit);animation:pulse 1.2s infinite ease-in-out}
.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
`;

function page(title: string, body: string, o: { refreshSec?: number } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0f0e"><meta name="robots" content="noindex">
${o.refreshSec ? `<meta http-equiv="refresh" content="${o.refreshSec}">` : ''}
<title>${esc(title)} · GridBot</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><main><div class="logo"><i></i>GridBot</div>${body}</main></body></html>`;
}

const msg = (m: { error?: string; ok?: string }) =>
  (m.error ? `<p class="msg err" role="alert">${esc(m.error)}</p>` : '') + (m.ok ? `<p class="msg ok" role="status">${esc(m.ok)}</p>` : '');

const keyNote = (host: string) => `<p class="small muted">It is stored locked (encrypted) on ${esc(host)}'s computer and used only to sign your bots' trades. ${esc(host)} runs that computer, so add a key only if you trust them with it.</p>`;
const keyInput = `<input name="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" class="mono" placeholder="64 letters and numbers">`;

export function loginPage(host: string, m: { error?: string; name?: string } = {}): string {
  return page('Log in', `<section class="card">
<h1>Log in</h1>
<p class="muted">Your own copy of GridBot${host ? `, run by ${esc(host)}` : ''}.</p>
${msg(m)}
<form method="post" action="/login">
<label>Name<input name="name" autocomplete="username" autocapitalize="words" required value="${esc(m.name ?? '')}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button class="primary" type="submit">Log in</button>
</form>
<p class="small muted">Forgot your password? Ask ${host ? esc(host) : 'whoever invited you'} for a new password link.</p>
</section>`);
}

export function invitePage(host: string, token: string, m: { error?: string; name: string }): string {
  return page(`${host} invited you`, `<section class="card">
<h1>${esc(host)} invited you</h1>
<p class="muted">Make your login. You get your own copy of GridBot, with your own bots, running on ${esc(host)}'s computer.</p>
${msg(m)}
<form method="post" action="/invite/${esc(token)}">
<label>Name <small>You log in with this.</small><input name="name" autocomplete="username" autocapitalize="words" required value="${esc(m.name)}"></label>
<label>Password <small>At least 8 characters.</small><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
<label>Password again<input name="again" type="password" autocomplete="new-password" minlength="8" required></label>
<div class="keybox">
<label>Your key <small>Optional: you can add it later under Account.</small>${keyInput}</label>
<p class="small muted">The private key of the account your bots trade from. Use an account that holds only what you want the bots to use. Without a key, bots run in paper mode: practice trades with no real money.</p>
${keyNote(host)}
</div>
<button class="primary" type="submit">Create my login</button>
</form>
</section>`);
}

export function resetPage(host: string, token: string, name: string, m: { error?: string } = {}): string {
  return page('New password', `<section class="card">
<h1>New password</h1>
<p class="muted">For ${esc(name)}. Your bots and key stay as they are.</p>
${msg(m)}
<form method="post" action="/invite/${esc(token)}">
<label>New password <small>At least 8 characters.</small><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
<label>New password again<input name="again" type="password" autocomplete="new-password" minlength="8" required></label>
<button class="primary" type="submit">Save and log in</button>
</form>
<p class="small muted">${esc(host)} made this link for you. It works once.</p>
</section>`);
}

export function linkGonePage(host: string): string {
  return page('Link expired', `<section class="card">
<h1>This link no longer works</h1>
<p class="muted">It has been used, or it is more than 7 days old. Ask ${host ? esc(host) : 'whoever sent it'} for a new one.</p>
<a class="btn" href="/login">Go to log in</a>
</section>`);
}

export interface AccountView { name: string; host: string; address: string | null; liveBots: number | null }

export function accountPage(a: AccountView, m: { error?: string; ok?: string } = {}): string {
  const keyForm = a.liveBots == null
    ? `<p class="note">Your copy isn't running right now, so your key can't be changed. Try again in a minute.</p>`
    : a.liveBots > 0
      ? `<p class="note">You have ${a.liveBots} live bot${a.liveBots === 1 ? '' : 's'}. To change or remove the key, first stop and remove ${a.liveBots === 1 ? 'it' : 'them'} in the app, so nothing is left behind with this key.</p>`
      : `<form method="post" action="/account/key">
<label>${a.address ? 'Use a different key' : 'Add your key'}${keyInput}</label>
<p class="small muted">Use an account that holds only what you want the bots to use. Saving restarts your copy, which takes a few seconds.</p>
${keyNote(a.host)}
<button class="primary" type="submit">Save key</button>
</form>${a.address ? `<form method="post" action="/account/key/remove"><button class="danger" type="submit">Remove key (paper mode only)</button></form>` : ''}`;
  return page('Account', `<section class="card">
<h1>Account</h1>
<p class="muted">Logged in as ${esc(a.name)}. Your copy runs on ${esc(a.host)}'s computer.</p>
${msg(m)}
<a class="btn" href="/">Back to the app</a>
</section>
<section class="card">
<h2>Your key</h2>
${a.address ? `<p>Your live bots trade from</p><p class="addr" title="${esc(a.address)}">${esc(a.address)}</p>` : '<p class="muted">No key yet, so every bot runs in paper mode (practice trades).</p>'}
${keyForm}
</section>
<section class="card">
<h2>Password</h2>
<form method="post" action="/account/password">
<label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
<label>New password <small>At least 8 characters. This logs you out on your other devices.</small><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
<label>New password again<input name="again" type="password" autocomplete="new-password" minlength="8" required></label>
<button type="submit">Change password</button>
</form>
</section>
<form method="post" action="/logout"><button type="submit">Log out</button></form>`);
}

/** The owner is logged in on the phone. No key form: their key stays in .env on the computer. */
export function ownerAccountPage(): string {
  return page('Your GridBot', `<section class="card">
<h1>Your GridBot</h1>
<p class="muted">This is your own app, on this computer. A friend's login never opens it.</p>
<a class="btn" href="/">Back to the app</a>
</section>
<form method="post" action="/logout"><button type="submit">Log out of this phone</button></form>
<p class="small muted">Logging out ends this phone's login. Your bots keep running.</p>`);
}

/** The owner is logged in but the host app doesn't answer. */
export function hostDownPage(): string {
  return page('Not answering', `<section class="card">
<h1>Your app isn't answering</h1>
<p class="muted">The log-in page is up, but GridBot on this computer isn't. On the computer, check that it is running, then reload.</p>
</section>`, { refreshSec: 5 });
}

/** The friend is logged in but their copy doesn't answer. */
export function copyDownPage(host: string, state: 'starting' | 'stopped' | 'crashed'): string {
  if (state === 'stopped') {
    return page('Copy stopped', `<section class="card">
<h1>Your copy is stopped</h1>
<p class="muted">${esc(host)} has stopped your copy of GridBot, so your bots aren't running. Ask them to start it again.</p>
<form method="post" action="/logout"><button type="submit">Log out</button></form>
</section>`, { refreshSec: 30 });
  }
  return page('Starting', `<section class="card">
<h1>Your copy is starting <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></h1>
<p class="muted">${state === 'crashed' ? 'It stopped unexpectedly and is starting again. ' : ''}This takes a few seconds; the page reloads by itself.</p>
</section>`, { refreshSec: 3 });
}

