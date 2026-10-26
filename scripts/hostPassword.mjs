// npm run host:password: sets the owner's gateway password. The hash is written to .env (HOST_PASSWORD_HASH),
// outside data/friends. The plaintext is never stored. Keep scrypt options in sync with src/server/friends/auth.ts.
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN = 12;
const file = '.env';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function upsert(text, key, value) {
  const lines = text.split('\n');
  let found = false;
  const next = lines.map((line) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) {
    if (next.length && next[next.length - 1] === '') next.pop();
    next.push(`${key}=${value}`);
  }
  return `${next.join('\n').replace(/\n*$/, '')}\n`;
}

function cleanLogin(raw) {
  const n = raw.trim().replace(/\s+/g, ' ');
  if (!n) return 'owner';
  if (!/^[\p{L}\p{N} ._'-]{2,32}$/u.test(n)) fail('A log-in name is 2 to 32 letters, numbers, spaces, dots or dashes.');
  return n.toLowerCase();
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

/** No echo. Requires a terminal. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    stdout.write(prompt);
    if (typeof stdin.setRawMode !== 'function') fail('Run this in a terminal so the password is not shown.');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const on = (ch) => {
      const c = String(ch);
      if (c === '\u0003') { stdout.write('\n'); process.exit(1); }
      if (c === '\r' || c === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', on);
        stdout.write('\n');
        resolve(s);
        return;
      }
      if (c === '\u007f' || c === '\b') { s = s.slice(0, -1); return; }
      if (c < ' ' ) return;
      s += c;
    };
    stdin.on('data', on);
  });
}

async function hashPassword(pw) {
  if (pw.length < MIN) fail(`Use at least ${MIN} characters.`);
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32, SCRYPT);
  return `${salt.toString('base64')}.${hash.toString('base64')}`;
}

const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const stdinMode = process.argv.includes('--stdin');
let login = 'owner';
let password = '';
if (stdinMode) {
  const line = await new Promise((resolve) => {
    const chunks = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => chunks.push(c));
    stdin.on('end', () => resolve(chunks.join('')));
  });
  password = String(line).replace(/\r?\n$/, '');
} else {
  if (!stdin.isTTY) fail('Run npm run host:password in a terminal.');
  login = cleanLogin(await ask('Log-in name [owner]: '));
  password = await askHidden('Password (at least 12 characters): ');
  const again = await askHidden('Password again: ');
  if (password !== again) fail('The two passwords are different.');
}

const hashed = await hashPassword(password);
password = '';
const prev = /^\s*HOST_SESSION\s*=\s*(\d+)/m.exec(text);
const session = prev ? String(Number(prev[1]) + 1) : '1';
let out = text;
if (!/^\s*HOST_LOGIN\s*=/m.test(out) || !stdinMode) out = upsert(out, 'HOST_LOGIN', login);
else if (!/^\s*HOST_LOGIN\s*=\s*\S/m.test(out)) out = upsert(out, 'HOST_LOGIN', login);
out = upsert(out, 'HOST_PASSWORD_HASH', hashed);
out = upsert(out, 'HOST_SESSION', session);
const existed = existsSync(file);
writeFileSync(file, out);
if (!existed) chmodSync(file, 0o600);

const writtenLogin = /^\s*HOST_LOGIN\s*=\s*(\S+)/m.exec(out)?.[1] ?? login;
const port = process.env.FRIENDS_PORT || 3850;
const needsSecret = !/^\s*FRIENDS_SECRET\s*=\s*\S/m.test(out);
console.log(`Saved the owner password to .env. Log in as "${writtenLogin}".

On this Mac:
  1. ${needsSecret ? 'npm run friends:setup, then ' : ''}npm run build
  2. npm start
  3. tailscale serve --bg ${port}

On your iPhone, open the Tailscale app (same account) and go to https://<this-mac>.<your-tailnet>.ts.net
Set GATEWAY_HOST in .env to that hostname if Tools → Friends does not already have the address, then restart.
See the readme, "Phone access".`);
